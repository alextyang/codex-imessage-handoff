import assert from "node:assert/strict";
import test from "node:test";
import { RelayClient } from "../src/relay-client.mjs";
import {
  parseMenuSelection,
  parseSlashCommand,
  relativeTime,
  renderHelp,
  renderOutboundEvent,
  renderThreadDirectory,
  renderThreadMenu,
} from "../../protocol/presentation.ts";

test("thread output has a distinct project/task namespace without modifying its body", () => {
  const body = "The tests pass.\n\nNext: deploy.";
  assert.equal(renderOutboundEvent({
    kind: "thread.output",
    thread: { title: "Fix metadata", projectLabel: "Music crawler" },
    body,
  }), `CODEX THREAD · MUSIC CRAWLER\n────────────────────────\n\nFix metadata\n\nRESULT\n${body}`);
});

test("grouped directory expands task rows and keeps recent projects compact", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  const rendered = renderThreadDirectory({
    groups: [
      {
        projectKey: "music",
        projectLabel: "Music crawler",
        threadCount: 3,
        hiddenCount: 1,
        threads: [
          { index: 1, title: "Fix album metadata", current: true, status: "idle", activityAt: "2026-07-12T07:55:00.000Z" },
          { index: 2, title: "Retry imports", status: "working", stateSince: "2026-07-12T07:58:00.000Z" },
        ],
      },
    ],
    collapsedProjects: [
      { index: 3, projectKey: "site", projectLabel: "Personal site", threadCount: 4, status: "idle", activityAt: "2026-07-12T07:00:00.000Z" },
    ],
    note: "Reply with a number to open.\n\n/recent · /search · /help",
  }, { now });

  assert.equal(rendered, [
    "CODEX CONTROL · THREADS\n────────────────────────",
    "7 TASKS · UPDATED NOW",
    "PROJECT · MUSIC CRAWLER · 3 TASKS\n\n1. Fix album metadata\n   [SELECTED] [IDLE] 5m ago\n\n2. Retry imports\n   [WORKING] 2m\n   +1 more task",
    "RECENT PROJECTS\n\n3. Personal site\n   4 tasks · [IDLE] 1h ago",
    "REPLY\nReply with a number to open.\n\nOPTIONS\n/recent · /search · /help",
  ].join("\n\n"));
});

test("local directory renders recent criteria, user previews, pending counts, and Other tasks", () => {
  const rendered = renderOutboundEvent({
    kind: "service.directory",
    directory: {
      label: "THREADS",
      totalTasks: 3,
      criteria: "pending + activity in last 48h",
      groups: [
        {
          projectKey: "music",
          projectLabel: "Music crawler",
          threads: [
            { id: "pending", index: 1, title: "Retry imports", status: "pending", pendingCount: 2, stateSince: "2026-07-12T07:48:00.000Z", requestPreview: "Rerun the failed import." },
            { id: "working", index: 2, title: "Fix metadata", status: "working", pendingCount: 1, stateSince: "2026-07-12T07:58:00.000Z", requestPreview: "Normalize album dates.\nThen test." },
          ],
        },
        {
          projectKey: "other-tasks",
          projectLabel: "Other tasks",
          threads: [
            { id: "other", index: 3, title: "Compare providers", status: "idle", activityAt: "2026-07-12T06:00:00.000Z", requestPreview: "Which provider supports richer interactions?" },
          ],
        },
      ],
      note: "Reply with a number to open.",
    },
  });

  assert.match(rendered, /^CODEX CONTROL · THREADS/);
  assert.match(rendered, /────────────────────────/);
  assert.match(rendered, /3 TASKS · UPDATED NOW\nPending \+ activity in last 48h/);
  assert.match(rendered, /PROJECT · MUSIC CRAWLER · 2 TASKS/);
  assert.match(rendered, /1\. Retry imports\n   \[PENDING\] \d+[smhd] ago · 2 QUEUED\n   › Rerun the failed import\./);
  assert.match(rendered, /2\. Fix metadata\n   \[WORKING\] \d+[smhd] · 1 QUEUED\n   › Normalize album dates\. Then test\./);
  assert.match(rendered, /OTHER TASKS · 1 TASK\n\n3\. Compare providers/);
  assert.match(rendered, /REPLY\nReply with a number to open\./);
});

test("thread detail exposes state, commands, request expansion, and the full final response", () => {
  const now = Date.now();
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: { title: "Fix album metadata", projectLabel: "Music crawler" },
    state: "idle",
    activityAt: new Date(now - 5 * 60_000).toISOString(),
    reasoningEffort: "high",
    requestPreview: { body: "Normalize all album fields…", at: new Date(now - 7 * 60_000).toISOString(), truncated: true },
    assistantMessages: [{ body: "Full final response.\n\nAll 42 tests pass.", at: new Date(now - 5 * 60_000).toISOString() }],
  });
  assert.match(rendered, /^CODEX THREAD · MUSIC CRAWLER\n─+\n\nFix album metadata/);
  assert.match(rendered, /\[IDLE\] 5m ago · REASONING HIGH/);
  assert.match(rendered, /\n\nACTIONS\n/);
  assert.match(rendered, /\/request · \/turn · \/history · \/reasoning/);
  assert.match(rendered, /TIP · \/request shows the full message\./);
  assert.match(rendered, /Full final response\.\n\nAll 42 tests pass\.$/);
});

test("working detail includes every visible message from the current turn", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: { title: "Retry imports", projectLabel: "Music crawler" },
    state: "working",
    stateSince: new Date(Date.now() - 2 * 60_000).toISOString(),
    requestPreview: { body: "Fix duplicate imports." },
    assistantMessages: [
      { body: "I found two discovery sources." },
      { body: "The deduplication tests pass." },
    ],
  });
  assert.match(rendered, /\[WORKING\] 2m/);
  assert.match(rendered, /I found two discovery sources\.[\s\S]*The deduplication tests pass\./);
  assert.match(rendered, /\/cancel · \/threads/);
});

test("failed detail keeps the request visible and offers retry", () => {
  const rendered = renderOutboundEvent({
    kind: "thread.detail",
    thread: { title: "Retry imports", projectLabel: "Music crawler" },
    state: "error",
    requestPreview: { body: "Run the failed import again." },
  });
  assert.match(rendered, /\[ERROR\]/);
  assert.match(rendered, /Run the failed import again\./);
  assert.match(rendered, /\/retry · \/dismiss · \/threads/);
  assert.match(rendered, /did not produce a final response/);
});

test("history renders exact final responses and reasoning is a command menu", () => {
  const turn = renderOutboundEvent({
    kind: "thread.turn",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    turn: {
      request: "Review the service.",
      assistantMessages: [{ body: "I found one remaining issue." }],
      finalResponse: "Fixed. All checks pass.",
      completedAt: new Date().toISOString(),
    },
  });
  assert.match(turn, /I found one remaining issue\.[\s\S]*Fixed\. All checks pass\./);

  const history = renderOutboundEvent({
    kind: "thread.history",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    turns: [{ request: "Remove duplicates.", finalResponse: "Done. Two root tasks remain.", completedAt: new Date().toISOString() }],
  });
  assert.match(history, /YOU\nRemove duplicates\.[\s\S]*CODEX\nDone\. Two root tasks remain\./);

  const reasoning = renderOutboundEvent({
    kind: "service.reasoning",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    current: "high",
    options: [{ value: "medium", label: "Medium" }, { value: "high", label: "High", selected: true }],
    note: "Applies to the next turn.",
  });
  assert.match(reasoning, /^CODEX CONTROL · REASONING/);
  assert.match(reasoning, /OPTIONS\n\[ \] Medium · \/reasoning medium\n\[SELECTED\] High · \/reasoning high/);

  const reset = renderOutboundEvent({
    kind: "service.reasoning",
    thread: { title: "Service UX", projectLabel: "iMessage handoff" },
    current: "medium",
    changed: true,
    options: [
      { value: "default", label: "Use task default", selected: true },
      { value: "medium", label: "Medium", selected: false },
    ],
  });
  assert.match(reset, /\[UPDATED\] Task default · Medium/);
  assert.equal((reset.match(/\[SELECTED\]/g) || []).length, 1);
});

test("legacy menus remain grouped and selection syntax is snapshot friendly", () => {
  const rendered = renderThreadMenu([
    { title: "Service redesign", projectLabel: "imessage", current: true, status: "idle" },
    { title: "Music crawler", projectLabel: "crawler", status: "pending" },
  ]);
  assert.match(rendered, /PROJECT · IMESSAGE · 1 TASK\n\n1\. Service redesign/);
  assert.match(rendered, /PROJECT · CRAWLER · 1 TASK\n\n2\. Music crawler/);
  assert.deepEqual(parseMenuSelection("2"), { index: 1, prompt: null });
  assert.deepEqual(parseMenuSelection("2: run the tests"), { index: 1, prompt: "run the tests" });
  assert.equal(parseMenuSelection("status"), null);
});

test("relative recency and all local-control commands parse without consuming ordinary text", () => {
  const now = new Date("2026-07-12T08:00:00.000Z");
  assert.equal(relativeTime("2026-07-12T07:55:00.000Z", now), "5m ago");
  assert.deepEqual(parseSlashCommand("/search music crawler"), { command: "search", argument: "music crawler" });
  assert.deepEqual(parseSlashCommand("/history 4"), { command: "history", argument: "4" });
  assert.deepEqual(parseSlashCommand("/reasoning xhigh"), { command: "reasoning", argument: "xhigh" });
  assert.deepEqual(parseSlashCommand("/request"), { command: "request", argument: null });
  assert.deepEqual(parseSlashCommand("/dismiss"), { command: "dismiss", argument: null });
  assert.deepEqual(parseSlashCommand("/refresh"), { command: "refresh", argument: null });
  assert.equal(parseSlashCommand("threads"), null);
  assert.equal(parseSlashCommand("status"), null);
  assert.match(renderHelp(), /^CODEX CONTROL · COMMANDS/);
  assert.match(renderHelp(), /BROWSE[\s\S]*CURRENT TASK[\s\S]*WORK[\s\S]*MENU REPLIES/);
  assert.match(renderHelp(), /\/refresh · Refresh the task list/);
  assert.match(renderHelp(), /\/retry · Retry the oldest failed request/);
});

test("proactive completion and Mac presence notices have distinct compact headers", () => {
  const completion = renderOutboundEvent({
    kind: "thread.completed",
    completionId: "completion-presentation",
    thread: { title: "Ship the service", projectLabel: "iMessage handoff" },
    completedAt: new Date().toISOString(),
    body: "Deployed and verified.",
  });
  assert.match(completion, /^CODEX THREAD · IMESSAGE HANDOFF\n─+\n\nShip the service\n\[COMPLETED\] now\n\nRESULT\nDeployed and verified\.$/);
  assert.equal(renderOutboundEvent({ kind: "service.presence", state: "online" }),
    "CODEX CONTROL · ONLINE\n────────────────────────\n\n[ONLINE] MAC CONNECTED\n\nReady for new task messages.");
  assert.equal(renderOutboundEvent({ kind: "service.presence", state: "offline" }),
    "CODEX CONTROL · OFFLINE\n────────────────────────\n\n[OFFLINE] MAC DISCONNECTED\n\nNew task messages will wait until it reconnects.");

  const notice = renderOutboundEvent({
    kind: "service.notice",
    code: "needs-attention",
    body: "The request needs attention.\n\n/retry · /dismiss",
  });
  assert.match(notice, /DETAILS\nThe request needs attention\.\n\nACTIONS\n\/retry · \/dismiss$/);
});

test("live messages use compact speaker and phase labels", () => {
  assert.equal(renderOutboundEvent({
    kind: "thread.live-message",
    messageId: "live-user-1",
    thread: { id: "thread-1", title: "Mirror this task", projectLabel: "iMessage handoff" },
    role: "user",
    phase: "user_message",
    body: "Show this local message remotely.",
  }), [
    "CODEX LIVE · YOU\n────────────────────────",
    "IMESSAGE HANDOFF · Mirror this task\n[MESSAGE] now",
    "Show this local message remotely.",
  ].join("\n\n"));

  const commentary = renderOutboundEvent({
    kind: "thread.live-message",
    messageId: "live-codex-1",
    thread: { id: "thread-1", title: "Mirror this task", projectLabel: "iMessage handoff" },
    role: "assistant",
    phase: "commentary",
    body: "I found the relay path and I’m checking delivery.",
    at: new Date().toISOString(),
  });
  assert.match(commentary, /^CODEX LIVE · CODEX\n─+\n\nIMESSAGE HANDOFF · Mirror this task\n\[COMMENTARY\] now/);
  assert.match(commentary, /I found the relay path and I’m checking delivery\.$/);
});

test("fork switches explain that the service is following the active fork", () => {
  const switched = renderOutboundEvent({
    kind: "service.switched",
    reason: "fork",
    thread: { id: "fork-2", title: "Continue implementation", projectLabel: "iMessage handoff" },
  });
  assert.match(switched, /^CODEX CONTROL · FOLLOWING FORK/);
  assert.match(switched, /\[SELECTED\] Following the active fork of this task\./);

  const manual = renderOutboundEvent({
    kind: "service.switched",
    thread: { id: "thread-1", title: "Original task", projectLabel: "iMessage handoff" },
  });
  assert.match(manual, /^CODEX CONTROL · SWITCHED/);
  assert.match(manual, /\[SELECTED\] Context is active\./);

  const context = renderOutboundEvent({
    kind: "thread.detail",
    deliveryId: "follow-context-1",
    reason: "fork",
    thread: { id: "fork-2", title: "Continue implementation", projectLabel: "iMessage handoff" },
    state: "working",
    requestPreview: { body: "Finish the live mirror.", at: new Date().toISOString() },
    assistantMessages: [{ body: "Checking the rollout cursor.", phase: "commentary", at: new Date().toISOString() }],
  });
  assert.match(context, /^CODEX CONTROL · FOLLOWING FORK/);
  assert.match(context, /ACTIONS\n\/request · \/turn · \/history · \/reasoning/);
  assert.match(context, /YOU · now\nFinish the live mirror\./);
  assert.match(context, /CODEX · now\nChecking the rollout cursor\./);
});

test("relay client advertises live mirroring and follows tasks with compare-and-set", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, switched: true, currentThreadId: "fork-2" }), { status: 200 });
  };
  try {
    const relay = new RelayClient({ apiBaseUrl: "https://relay.test", token: "secret", clientId: "client-1" });
    await relay.register();
    await relay.followThread("fork-2", "thread-1");
    assert.ok(calls[0].body.capabilities.includes("live-mirror-v1"));
    assert.deepEqual(calls[1], {
      url: "https://relay.test/service/active-thread",
      body: { threadId: "fork-2", expectedThreadId: "thread-1" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
