import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalConversationRouter } from "../src/local-conversation-router.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-router-"));
  const stateFile = path.join(directory, "state.json");
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  const router = new LocalConversationRouter({ stateFile, now: () => now });
  return { router, stateFile, advance: (milliseconds) => { now += milliseconds; } };
}

function message(id, text, extras = {}) {
  return {
    id,
    guid: extras.guid || `guid-${id}`,
    text,
    created_at: extras.createdAt || "2026-07-12T12:00:00.000Z",
    ...extras,
  };
}

test("persists a prompt before acknowledgement and resumes it after restart", () => {
  const { router, stateFile } = fixture();
  router.setAwaitingPrompt("thread-a");
  const action = router.ingest(message(10, "Run the tests."));
  assert.deepEqual(action, {
    kind: "prompt",
    messageKey: "guid-10",
    threadId: "thread-a",
    body: "Run the tests.",
    guid: "guid-10",
    createdAt: "2026-07-12T12:00:00.000Z",
    fromAwaitingPrompt: true,
    attachments: [],
  });
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);

  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  assert.deepEqual(resumed.pendingActions(), [action]);
  assert.equal(resumed.ingest(message(10, "Run the tests."))?.messageKey, "guid-10");
  assert.equal(resumed.acknowledge("guid-10"), true);
  assert.equal(resumed.ingest(message(10, "Run the tests.")), null);
});

test("routes slash commands, numeric selections, project selections, and direct prompts", () => {
  const { router } = fixture();
  router.setMenu(["thread:thread-b", "project:project-c"]);

  assert.deepEqual(router.ingest(message(1, "/history 4")), {
    kind: "thread-picker",
    messageKey: "guid-1",
    command: "history",
    argument: "4",
    guid: "guid-1",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  assert.deepEqual(router.ingest(message(2, "1 (Run this.)")), {
    kind: "switch",
    messageKey: "guid-2",
    threadId: "thread-b",
    prompt: "Run this.",
    guid: "guid-2",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(router.ingest(message(3, "2")).projectKey, "project-c");
  assert.equal(router.ingest(message(4, "/projects")).kind, "projects");
  assert.equal(router.ingest(message(5, "/search formatting")).argument, "formatting");
});

test("menu references remain selectable after service restart", () => {
  const { router, stateFile } = fixture();
  router.setMenu(["thread:thread-b", "project:project-c"]);
  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(resumed.ingest(message(6, "1")).threadId, "thread-b");
  assert.equal(resumed.ingest(message(7, "2")).projectKey, "project-c");
});

test("reply targets override the active task without changing it", () => {
  const { router } = fixture();
  router.setActiveThread("thread-a");
  router.routeOutboundGuid("assistant-guid", "thread-b");
  const action = router.ingest(message(20, "Continue there.", { reply_to_guid: "assistant-guid" }));
  assert.equal(action.threadId, "thread-b");
  assert.equal(action.replyToGuid, "assistant-guid");
  assert.equal(router.activeThreadId, "thread-a");
});

test("poll votes resolve only registered, unexpired task actions", () => {
  const { router, advance } = fixture();
  router.registerPoll("poll-guid", {
    optionHigh: { kind: "control", command: "reasoning", threadId: "thread-a", argument: "high" },
    optionNone: { kind: "control", command: "reasoning", threadId: "thread-a", argument: "none" },
  }, 60_000);
  const vote = (id) => message(id, "", {
    poll: { kind: "vote", original_guid: "poll-guid", vote: { option_id: "optionHigh" } },
  });
  assert.deepEqual(router.ingest(vote(30)), {
    kind: "control",
    messageKey: "guid-30",
    threadId: "thread-a",
    command: "reasoning",
    argument: "high",
    guid: "guid-30",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  advance(61_000);
  assert.deepEqual(router.ingest(vote(31)), {
    kind: "stale-poll",
    messageKey: "guid-31",
    guid: "guid-31",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
});

test("expired and out-of-range snapshots fail closed", () => {
  const { router, advance } = fixture();
  router.setActiveThread("thread-a");
  router.setMenu(["thread:thread-b"], 1_000);
  assert.equal(router.ingest(message(40, "9")).kind, "stale-menu");
  advance(2_000);
  assert.equal(router.ingest(message(41, "1")).kind, "stale-menu");
});

test("reaction rows are ignored and activity/cursor advance only for durable actions", () => {
  const { router } = fixture();
  router.setActiveThread("thread-a");
  assert.equal(router.ingest(message(50, "Liked", { is_reaction: true })), null);
  assert.equal(router.lastRowId, 0);
  router.ingest(message(51, "Hello"));
  assert.equal(router.lastRowId, 51);
  assert.equal(router.lastUserMessageAt, "2026-07-12T12:00:00.000Z");
});

test("discard persists a synthetic inbound cursor without creating activity or work", () => {
  const { router, stateFile } = fixture();
  router.setActiveThread("thread-a");
  assert.equal(router.discard(message(52, "Internal transport notice")), true);
  assert.equal(router.lastRowId, 52);
  assert.equal(router.lastUserMessageAt, null);
  assert.deepEqual(router.pendingActions(), []);

  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.discard(message(52, "Internal transport notice")), false);
  assert.equal(resumed.ingest(message(52, "Internal transport notice")), null);
});

test("outbound echo reservations are content-free, durable, bounded, and single-use", () => {
  const { router, stateFile, advance } = fixture();
  router.setActiveThread("thread-a");
  const fingerprint = router.reserveOutboundEcho("Private service output", 2_000);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const stored = readFileSync(stateFile, "utf8");
  assert.equal(stored.includes("Private service output"), false);

  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(resumed.consumeOutboundEcho(message(56, "Private service output")), true);
  assert.equal(resumed.lastRowId, 56);
  assert.equal(resumed.lastUserMessageAt, null);
  assert.deepEqual(resumed.pendingActions(), []);
  assert.equal(resumed.consumeOutboundEcho(message(57, "Private service output")), false);

  router.reserveOutboundEcho("Expiring output", 1_000);
  advance(1_001);
  assert.equal(router.consumeOutboundEcho(message(58, "Expiring output")), false);
});

test("conversation identity changes reset chat-bound routes, activity, and pending work", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-router-scope-"));
  const stateFile = path.join(directory, "state.json");
  const first = new LocalConversationRouter({ stateFile, conversationKey: "a".repeat(64) });
  first.setActiveThread("thread-a");
  first.routeOutboundGuid("private-root", "thread-a", { root: true });
  first.ingest(message(59, "Private request"));

  const same = new LocalConversationRouter({ stateFile, conversationKey: "a".repeat(64) });
  assert.equal(same.nativeThread("thread-a").rootGuid, "private-root");
  assert.equal(same.pendingActions().length, 1);

  const switched = new LocalConversationRouter({ stateFile, conversationKey: "b".repeat(64) });
  assert.equal(switched.nativeThread("thread-a"), null);
  assert.deepEqual(switched.pendingActions(), []);
  assert.equal(switched.lastUserMessageAt, null);
  switched.setActiveThread("thread-b");
  const stored = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(stored.conversationKey, "b".repeat(64));
  assert.equal(stored.version, 5);
});

test("old conversation state is reset instead of carrying legacy routes forward", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-router-old-state-"));
  const stateFile = path.join(directory, "state.json");
  writeFileSync(stateFile, `${JSON.stringify({
    version: 4,
    mostRecentThreadId: "legacy-thread",
    pending: [{ kind: "prompt", messageKey: "legacy", threadId: "legacy-thread", body: "legacy" }],
    guidRoutes: { "legacy-root": "legacy-thread" },
  })}\n`);
  const router = new LocalConversationRouter({ stateFile });
  assert.equal(router.mostRecentThreadId, null);
  assert.equal(router.lastUserThreadId, null);
  assert.deepEqual(router.pendingActions(), []);
  assert.equal(router.nativeThread("legacy-thread"), null);
});

test("persists content-free outbound receipts and GUID routes", () => {
  const { router, stateFile } = fixture();
  router.recordOutboundReceipt("completion:thread-a:one", {
    classification: "accepted",
    guids: ["sent-guid"],
  });
  router.routeOutboundGuid("sent-guid", "thread-a");
  const resumed = new LocalConversationRouter({ stateFile });
  assert.deepEqual(resumed.outboundReceipt("completion:thread-a:one"), {
    classification: "accepted",
    updatedAt: "2026-07-12T12:00:00.000Z",
    guids: ["sent-guid"],
  });
  assert.doesNotMatch(JSON.stringify(resumed.outboundReceipt("completion:thread-a:one")), /secret body/i);
});

test("persists independent native roots, latest GUIDs, mute, listen, and activity", () => {
  const { router, stateFile, advance } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true, createdAt: "2026-07-12T12:00:00.000Z" });
  advance(1_000);
  router.routeOutboundGuid("child-a", "thread-a", { createdAt: "2026-07-12T12:00:01.000Z" });
  advance(1_000);
  router.routeOutboundGuid("root-b", "thread-b", { createdAt: "2026-07-12T12:00:02.000Z" });
  router.setThreadMuted("thread-a", true);
  router.setThreadListen("thread-a", true);

  const resumed = new LocalConversationRouter({ stateFile });
  assert.deepEqual(resumed.nativeThread("thread-a"), {
    rootGuid: "root-a",
    latestGuid: "child-a",
    muted: true,
    listen: true,
    lastActivityAt: "2026-07-12T12:00:01.000Z",
  });
  assert.equal(resumed.threadReplyTarget("thread-a"), "root-a");
  assert.equal(resumed.mostRecentThreadId, "thread-b");
  assert.equal(resumed.isThreadMuted("thread-a"), true);
  assert.equal(resumed.consumeThreadListen("thread-a"), true);
  assert.equal(resumed.consumeThreadListen("thread-a"), false);
  assert.equal(new LocalConversationRouter({ stateFile }).nativeThread("thread-a").listen, false);
});

test("routes direct parents, native thread originators, and earlier inbound GUIDs after restart", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("child-a", "thread-a");

  const direct = router.ingest(message(60, "First reply", {
    guid: "inbound-a",
    reply_to_guid: "child-a",
    thread_originator_guid: "root-a",
  }));
  assert.equal(direct.threadId, "thread-a");
  assert.equal(direct.replyToGuid, "child-a");
  assert.equal(direct.threadOriginatorGuid, "root-a");
  router.acknowledge(direct.messageKey);

  const resumed = new LocalConversationRouter({ stateFile });
  const byOrigin = resumed.ingest(message(61, "Origin-only reply", {
    thread_originator_guid: "root-a",
  }));
  assert.equal(byOrigin.threadId, "thread-a");
  resumed.acknowledge(byOrigin.messageKey);

  const byEarlierInbound = resumed.ingest(message(62, "Reply to my earlier message", {
    reply_to_guid: "inbound-a",
  }));
  assert.equal(byEarlierInbound.threadId, "thread-a");
  assert.equal(resumed.nativeThread("thread-a").latestGuid, "guid-62");
});

test("explicit inbound route registration persists the message, parent, and originator", () => {
  const { router, stateFile } = fixture();
  router.routeInboundGuid("inbound-child", "thread-a", {
    replyToGuid: "assistant-child",
    threadOriginatorGuid: "assistant-root",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.nativeThread("thread-a").rootGuid, "assistant-root");
  assert.equal(resumed.nativeThread("thread-a").latestGuid, "inbound-child");
  assert.equal(resumed.ingest(message(63, "Reply again", { reply_to_guid: "inbound-child" })).threadId, "thread-a");
  assert.equal(resumed.ingest(message(64, "Reply at root", { reply_to_guid: "assistant-root" })).threadId, "thread-a");
  assert.equal(resumed.ingest(message(65, "Reply at parent", { reply_to_guid: "assistant-child" })).threadId, "thread-a");
});

test("background output cannot redirect an unthreaded prompt away from the last user task", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true, createdAt: "2026-07-12T11:59:58.000Z" });
  const initial = router.ingest(message(69, "Work here.", { reply_to_guid: "root-a" }));
  router.acknowledge(initial.messageKey);
  router.routeOutboundGuid("root-b", "thread-b", { createdAt: "2026-07-12T12:00:01.000Z" });
  assert.equal(router.mostRecentThreadId, "thread-b");
  const action = router.ingest(message(70, "Continue my task."));
  assert.equal(action.kind, "prompt");
  assert.equal(action.threadId, "thread-a");
  assert.equal(router.mostRecentThreadId, "thread-a");
  assert.equal(router.lastUserThreadId, "thread-a");
});

test("structured poll actions support projects, task selection, pages, and command pickers", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("directory-poll", {
    projectOption: { kind: "project", projectKey: "project-a", page: 2 },
    threadOption: { kind: "switch", threadId: "thread-b" },
    muteOption: { kind: "thread-picker", command: "mute" },
  });
  const vote = (id, optionId) => message(id, "", {
    poll: { kind: "vote", original_guid: "directory-poll", vote: { option_id: optionId } },
  });

  assert.deepEqual(router.ingest(vote(80, "projectOption")), {
    kind: "project",
    messageKey: "guid-80",
    projectKey: "project-a",
    page: 2,
    guid: "guid-80",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  router.acknowledge("guid-80");
  const selected = router.ingest(vote(81, "threadOption"));
  assert.equal(selected.kind, "switch");
  assert.equal(selected.threadId, "thread-b");
  assert.equal(selected.awaitingPrompt, true);
  assert.equal(router.incomingPaused, true);
  assert.equal(router.shouldPauseIncoming("thread-b"), true);
  assert.equal(router.shouldPauseIncoming("thread-a"), false);
  assert.equal(router.isAwaitingPromptFor("thread-b"), true);
  assert.equal(router.isAwaitingPromptFor("thread-a"), false);
  router.acknowledge("guid-81");

  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  assert.deepEqual(resumed.awaitingPrompt, {
    threadId: "thread-b",
    selectedAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:05:00.000Z",
  });
  const prompt = resumed.ingest(message(82, "Now run the tests."));
  assert.equal(prompt.kind, "prompt");
  assert.equal(prompt.threadId, "thread-b");
  assert.equal(prompt.fromAwaitingPrompt, true);
  assert.equal(resumed.incomingPaused, false);
  resumed.acknowledge("guid-82");

  const picker = resumed.ingest(vote(83, "muteOption"));
  assert.deepEqual(picker, {
    kind: "thread-picker",
    messageKey: "guid-83",
    command: "mute",
    guid: "guid-83",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
});

test("all task commands require native reply context or a picker", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a");

  const listen = router.ingest(message(90, "/listen", { reply_to_guid: "root-a" }));
  assert.equal(listen.kind, "control");
  assert.equal(listen.command, "listen");
  assert.equal(listen.threadId, "thread-a");
  router.acknowledge(listen.messageKey);

  const mutePicker = router.ingest(message(91, "/mute"));
  assert.equal(mutePicker.kind, "thread-picker");
  assert.equal(mutePicker.command, "mute");
  assert.equal(mutePicker.threadId, undefined);
  router.acknowledge(mutePicker.messageKey);

  const unmute = router.ingest(message(92, "/unmute", { thread_originator_guid: "root-a" }));
  assert.equal(unmute.kind, "control");
  assert.equal(unmute.command, "unmute");
  assert.equal(unmute.threadId, "thread-a");

  let id = 93;
  for (const command of ["thread", "request", "message", "turn", "history", "reasoning", "retry", "dismiss", "cancel", "link"]) {
    const action = router.ingest(message(id++, `/${command}`));
    assert.equal(action.kind, "thread-picker", command);
    assert.equal(action.command, command);
    router.acknowledge(action.messageKey);
  }
});

test("awaiting-prompt pause is task-local, expiring, and explicitly clearable", () => {
  const { router, stateFile, advance } = fixture();
  assert.equal(router.setAwaitingPrompt("thread-a", undefined, 1_000), true);
  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(resumed.clearAwaitingPrompt("thread-b"), false);
  assert.equal(resumed.incomingPaused, true);
  assert.equal(resumed.shouldPauseIncoming("thread-a"), true);
  assert.equal(resumed.shouldPauseIncoming("thread-b"), false);
  assert.equal(resumed.clearAwaitingPrompt("thread-a"), true);
  assert.equal(resumed.incomingPaused, false);
  router.setAwaitingPrompt("thread-a", undefined, 1_000);
  advance(1_001);
  assert.equal(router.awaitingPrompt, null);
  assert.equal(router.shouldPauseIncoming("thread-a"), false);
});

test("v5 state persists the last user task independently from background activity", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  const action = router.ingest(message(110, "Reply", { reply_to_guid: "root-a" }));
  router.acknowledge(action.messageKey);
  router.routeOutboundGuid("root-b", "thread-b", { root: true });
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.lastUserThreadId, "thread-a");
  assert.equal(resumed.mostRecentThreadId, "thread-b");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).version, 5);
});
