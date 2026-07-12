import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getHistory,
  getLatestRequest,
  getThreadDetail,
  getThreadState,
  getTurn,
  readThreadHistory,
} from "../src/thread-history.mjs";

function record(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function message(timestamp, role, turnId, text, phase) {
  return record(timestamp, "response_item", {
    type: "message",
    role,
    ...(phase ? { phase } : {}),
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  });
}

test("detail snapshots stop at an exact rollout offset for lossless live handoff", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-offset-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const before = [
    record("2026-07-12T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-offset" }),
    message("2026-07-12T00:00:00.010Z", "user", "turn-offset", "Original request"),
    message("2026-07-12T00:00:01.000Z", "assistant", "turn-offset", "Visible at baseline.", "commentary"),
  ].join("\n") + "\n";
  const after = `${message("2026-07-12T00:00:02.000Z", "assistant", "turn-offset", "Must remain in the live tail.", "commentary")}\n`;
  writeFileSync(rollout, before + after, "utf8");

  const detail = getThreadDetail({ id: "thread-offset", rolloutPath: rollout }, { endOffset: Buffer.byteLength(before) });
  assert.deepEqual(detail.commentary, ["Visible at baseline."]);
});

test("history exposes exact completed output and every current commentary message", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-history-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const completedRequest = "  Keep this request exactly.\nSecond line.  ";
  const completedFinal = "Full final response.\n\nNothing was trimmed.\n";
  const currentRequest = "Continue with the next part and preserve this whole request.";
  const lines = [
    record("2026-07-12T01:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_783_817_200_000 }),
    message("2026-07-12T01:00:00.010Z", "user", "turn-1", completedRequest),
    record("2026-07-12T01:00:00.011Z", "event_msg", { type: "user_message", message: completedRequest }),
    message("2026-07-12T01:00:01.000Z", "assistant", "turn-1", "First progress update.", "commentary"),
    message("2026-07-12T01:00:02.000Z", "assistant", "turn-1", "A fallback final.", "final_answer"),
    record("2026-07-12T01:00:02.100Z", "event_msg", { type: "task_complete", turn_id: "turn-1", completed_at: 1_783_817_202_100, last_agent_message: completedFinal }),
    record("2026-07-12T01:01:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-2", started_at: 1_783_817_260_000 }),
    message("2026-07-12T01:01:00.010Z", "user", "turn-2", currentRequest),
    record("2026-07-12T01:01:00.011Z", "event_msg", { type: "user_message", message: currentRequest }),
    record("2026-07-12T01:01:00.900Z", "event_msg", { type: "agent_message", message: "Inspecting the project.", phase: "commentary" }),
    message("2026-07-12T01:01:01.000Z", "assistant", "turn-2", "Inspecting the project.", "commentary"),
    message("2026-07-12T01:01:02.000Z", "assistant", "turn-2", "Running focused checks.", "commentary"),
    record("2026-07-12T01:01:03.000Z", "event_msg", { type: "agent_message", message: "Checking deployment state.", phase: "commentary" }),
  ];
  writeFileSync(rollout, `${lines.join("\n")}\n{"timestamp":`, "utf8");

  const parsed = readThreadHistory(rollout);
  assert.equal(parsed.state, "running");
  assert.equal(parsed.malformedTail, true);
  assert.equal(parsed.currentTurn.request, currentRequest);
  assert.deepEqual(parsed.currentTurn.commentary, ["Inspecting the project.", "Running focused checks.", "Checking deployment state."]);
  assert.equal(parsed.currentTurn.lastMessage, "Checking deployment state.");
  assert.equal(parsed.currentTurn.assistantMessages.length, 3, "response/event duplicates are collapsed");
  assert.equal(parsed.latestCompletedTurn.request, completedRequest);
  assert.equal(parsed.latestCompletedTurn.finalResponse, completedFinal);
  assert.equal(parsed.turnCount, 2);
  assert.equal(parsed.turnCountLowerBound, false);

  assert.equal(getThreadState(rollout).state, "running");
  assert.equal(getLatestRequest({ rolloutPath: rollout }), currentRequest);
  assert.equal(getTurn({ rolloutPath: rollout }).id, "turn-2");
  assert.equal(getHistory({ rolloutPath: rollout }, 1)[0].finalResponse, completedFinal);

  const detail = getThreadDetail(
    { id: "thread-1", rolloutPath: rollout, reasoningEffort: "medium" },
    { stateOverride: "pending", reasoningEffort: "high", userPreviewLimit: 24, historyLimit: 1 },
  );
  assert.equal(detail.state, "pending");
  assert.equal(detail.observedState, "running");
  assert.equal(detail.reasoningEffort, "high");
  assert.equal(detail.fullRequest, currentRequest);
  assert.match(detail.requestPreview, /…$/);
  assert.equal(detail.history[0].finalResponse, completedFinal);
});

test("bounded tail parsing tolerates a cut prefix and rollback removes reverted turns", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-tail-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const filler = `${"x".repeat(200)}\n`.repeat(100);
  const lines = [
    record("2026-07-12T02:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-old", started_at: 1_783_820_800_000 }),
    message("2026-07-12T02:00:00.010Z", "user", "turn-old", "Old request"),
    record("2026-07-12T02:00:01.000Z", "event_msg", { type: "task_complete", turn_id: "turn-old", completed_at: 1_783_820_801_000, last_agent_message: "Old response" }),
    record("2026-07-12T02:01:00.000Z", "event_msg", { type: "thread_rolled_back", num_turns: 1 }),
    record("2026-07-12T02:02:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-new", started_at: 1_783_820_920_000 }),
    message("2026-07-12T02:02:00.010Z", "user", "turn-new", "New request"),
    record("2026-07-12T02:02:01.000Z", "event_msg", { type: "task_complete", turn_id: "turn-new", completed_at: 1_783_820_921_000, last_agent_message: "New response" }),
  ];
  writeFileSync(rollout, `${filler}${lines.join("\n")}\n`, "utf8");

  const parsed = readThreadHistory(rollout, { maxBytes: 8_000, maxLines: 100 });
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.state, "idle");
  assert.equal(parsed.completedTurns.length, 1);
  assert.equal(parsed.completedTurns[0].id, "turn-new");
  assert.equal(parsed.completedTurns[0].finalResponse, "New response");
  assert.equal(parsed.turnCount, 1);
  assert.equal(parsed.turnCountLowerBound, true);
});

test("automatic continuation starts retain the logical request and visible messages", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-continuation-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const lines = [
    record("2026-07-12T04:00:00.000Z", "event_msg", { type: "task_started", turn_id: "backend-1" }),
    message("2026-07-12T04:00:00.010Z", "user", "backend-1", "Complete the whole migration."),
    record("2026-07-12T04:00:01.000Z", "event_msg", { type: "agent_message", message: "Migration applied.", phase: "commentary" }),
    record("2026-07-12T04:01:00.000Z", "event_msg", { type: "task_started", turn_id: "backend-2" }),
    record("2026-07-12T04:01:01.000Z", "event_msg", { type: "agent_message", message: "Verifying the service.", phase: "commentary" }),
  ];
  writeFileSync(rollout, `${lines.join("\n")}\n`, "utf8");
  const turn = getTurn(rollout);
  assert.equal(turn.id, "backend-2");
  assert.equal(turn.request, "Complete the whole migration.");
  assert.deepEqual(turn.commentary, ["Migration applied.", "Verifying the service."]);
});

test("state lookup expands its tail until it finds a long-running turn boundary", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-state-tail-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const start = record("2026-07-12T05:00:00.000Z", "event_msg", { type: "task_started", turn_id: "long-turn" });
  const noise = Array.from({ length: 2500 }, (_, index) => record(
    "2026-07-12T05:00:01.000Z",
    "event_msg",
    { type: "token_count", index, padding: "x".repeat(180) },
  ));
  writeFileSync(rollout, `${start}\n${noise.join("\n")}\n`, "utf8");
  assert.equal(getThreadState(rollout).state, "running");
});

test("recent rollout metadata without a turn does not become recent turn activity", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-no-turn-"));
  const rollout = path.join(directory, "rollout.jsonl");
  writeFileSync(rollout, `${record("2026-07-12T06:00:00.000Z", "session_meta", { id: "placeholder" })}\n`, "utf8");
  const history = readThreadHistory(rollout);
  const state = getThreadState(rollout);
  assert.equal(history.activityAt, "2026-07-12T06:00:00.000Z");
  assert.equal(history.hasTurn, false);
  assert.equal(history.lastTurnAt, null);
  assert.equal(state.hasTurn, false);
  assert.equal(state.lastTurnAt, null);
});
