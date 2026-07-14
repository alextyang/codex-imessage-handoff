import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalConversationRouter } from "../src/local-conversation-router.mjs";

function fixture(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-router-"));
  const stateFile = path.join(directory, "state.json");
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  const router = new LocalConversationRouter({ stateFile, now: () => now, ...options });
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

test("a newly created task can become the durable default without opening a selection pause", () => {
  const { router, stateFile } = fixture();
  router.setAwaitingPrompt("thread-old");
  router.clearAwaitingPrompt("thread-old");

  assert.equal(router.setDefaultThread("thread-new", "2026-07-12T12:00:01.000Z"), true);
  assert.equal(router.awaitingPrompt, null);
  assert.equal(router.lastUserThreadId, "thread-new");

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:01.000Z"),
  });
  assert.equal(resumed.lastUserThreadId, "thread-new");
  assert.equal(resumed.recentDefaultThreadId, "thread-new");
  const action = resumed.ingest(message(11, "Continue the new task.", {
    createdAt: "2026-07-12T12:00:02.000Z",
  }));
  assert.equal(action.kind, "prompt");
  assert.equal(action.threadId, "thread-new");
});

test("atomically acknowledges an action with a durable deterministic confirmation", () => {
  const { router, stateFile } = fixture();
  router.setActiveThread("thread-a");
  const inbound = message(10_001, "/mute");
  const action = router.ingest(inbound);

  assert.equal(router.acknowledgeWithConfirmation(action.messageKey, {
    messageGuid: action.guid,
    reaction: "🔕",
  }), true);
  assert.deepEqual(router.pendingActions(), []);
  const [confirmation] = router.pendingConfirmations();
  assert.deepEqual({
    messageKey: confirmation.messageKey,
    messageGuid: confirmation.messageGuid,
    reaction: confirmation.reaction,
    remove: confirmation.remove,
  }, {
    messageKey: "guid-10001",
    messageGuid: "guid-10001",
    reaction: "🔕",
    remove: false,
  });
  assert.match(confirmation.operationId, /^confirmation:[a-f0-9]{64}$/);

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  assert.deepEqual(resumed.pendingActions(), []);
  assert.deepEqual(resumed.pendingConfirmations(), [confirmation]);
  assert.equal(resumed.ingest(inbound), null, "the accepted command must never replay while confirmation is pending");
  assert.equal(resumed.completeConfirmation("confirmation:missing"), false);
  assert.equal(resumed.completeConfirmation(confirmation.operationId), true);
  assert.deepEqual(new LocalConversationRouter({ stateFile }).pendingConfirmations(), []);
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
  const create = router.ingest(message(5_001, "/new Build this"));
  assert.deepEqual({ kind: create.kind, argument: create.argument }, { kind: "new", argument: "Build this" });
  assert.equal(router.ingest(message(5_002, "/defaultreasoning high")).kind, "defaultreasoning");
});

test("menu references remain selectable after service restart", () => {
  const { router, stateFile } = fixture();
  router.setMenu(["thread:thread-b", "project:project-c"]);
  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  assert.equal(resumed.ingest(message(6, "1")).threadId, "thread-b");
  assert.equal(resumed.ingest(message(7, "2")).projectKey, "project-c");
});

test("native originators route replies while incidental reply parents do not change the default task", () => {
  const { router } = fixture();
  router.setActiveThread("thread-a");
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("root-b", "thread-b", { root: true });
  const seed = router.ingest(message(19, "Work in A.", { thread_originator_guid: "root-a" }));
  router.acknowledge(seed.messageKey);

  const topLevel = router.ingest(message(20, "Continue my default.", { reply_to_guid: "root-b" }));
  assert.equal(topLevel.threadId, "thread-a");
  assert.equal(topLevel.replyToGuid, "root-b");
  router.acknowledge(topLevel.messageKey);

  const nativeReply = router.ingest(message(21, "Actually reply in B.", {
    thread_originator_guid: "root-b",
    reply_to_guid: "root-a",
  }));
  assert.equal(nativeReply.threadId, "thread-b");
  assert.equal(nativeReply.threadOriginatorGuid, "root-b");
  assert.equal(router.activeThreadId, "thread-a");
});

test("authoritative native Reply context outranks an active numeric menu", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.setMenu(["thread:thread-b", "project:project-c"]);

  const numericReply = router.ingest(message(2_900, "1", {
    thread_originator_guid: "root-a",
    reply_to_guid: "hostile-menu-parent",
  }));
  assert.equal(numericReply.kind, "prompt");
  assert.equal(numericReply.threadId, "thread-a");
  assert.equal(numericReply.body, "1");
  assert.equal(numericReply.threadOriginatorGuid, "root-a");
  assert.equal(router.nativeThread("thread-b"), null);
  assert.equal(router.incomingPaused, false);
  router.acknowledge(numericReply.messageKey);

  const resumed = new LocalConversationRouter({ stateFile });
  const legacySelectionShape = resumed.ingest(message(2_901, "1 (Run this exactly.)", {
    thread_originator_guid: "root-a",
    reply_to_guid: "another-hostile-parent",
  }));
  assert.equal(legacySelectionShape.kind, "prompt");
  assert.equal(legacySelectionShape.threadId, "thread-a");
  assert.equal(legacySelectionShape.body, "1 (Run this exactly.)");
  assert.equal(resumed.nativeThread("thread-b"), null);
  assert.equal(resumed.nativeThread("thread-a").rootGuid, "root-a");
});

test("stress: numeric reply bodies cannot cross task roots while menus and restarts interleave", () => {
  const { router, stateFile } = fixture();
  const threadIds = ["thread-a", "thread-b", "thread-c"];
  const roots = ["root-a", "root-b", "root-c"];
  for (const [index, threadId] of threadIds.entries()) {
    router.routeOutboundGuid(roots[index], threadId, { root: true });
  }
  router.setMenu(["thread:menu-one", "thread:menu-two", "project:menu-project"]);

  let current = router;
  for (let index = 0; index < 90; index += 1) {
    if (index === 31 || index === 63) {
      current = new LocalConversationRouter({
        stateFile,
        now: () => Date.parse("2026-07-12T12:00:00.000Z"),
      });
    }
    const targetIndex = (index * 5) % threadIds.length;
    const hostileIndex = (targetIndex + 1) % threadIds.length;
    const body = index % 2 === 0 ? String((index % 3) + 1) : `${(index % 3) + 1} (literal task input ${index})`;
    const action = current.ingest(message(3_300 + index, body, {
      thread_originator_guid: roots[targetIndex],
      reply_to_guid: roots[hostileIndex],
      createdAt: new Date(Date.parse("2026-07-12T12:00:00.000Z") + index * 1_000).toISOString(),
    }));
    assert.equal(action.kind, "prompt", `numeric reply ${index} became a menu action`);
    assert.equal(action.threadId, threadIds[targetIndex], `numeric reply ${index} crossed task roots`);
    assert.equal(action.body, body);
    assert.equal(current.acknowledge(action.messageKey), true);
  }

  const resumed = new LocalConversationRouter({ stateFile });
  for (const [index, threadId] of threadIds.entries()) {
    assert.equal(resumed.nativeThread(threadId).rootGuid, roots[index]);
  }
  assert.equal(resumed.nativeThread("menu-one"), null);
  assert.equal(resumed.nativeThread("menu-two"), null);
});

test("stress: interleaved native descendants keep command and prompt context across restarts and hostile reply parents", () => {
  const { router, stateFile } = fixture();
  const threadIds = ["thread-a", "thread-b", "thread-c"];
  const roots = ["root-a", "root-b", "root-c"];
  for (const [index, threadId] of threadIds.entries()) {
    router.routeOutboundGuid(roots[index], threadId, { root: true });
    for (let descendant = 0; descendant < 12; descendant += 1) {
      router.routeOutboundGuid(`${threadId}-descendant-${descendant}`, threadId);
    }
  }
  const messages = [
    "Continue this task.",
    "/thread",
    "/request",
    "/message",
    "/turn",
    "/history 5",
    "/reasoning high",
    "/listen",
    "/link",
    "/mute",
    "/unmute",
    "/retry",
    "/dismiss",
    "/cancel",
    "/not-a-command",
  ];
  let current = router;
  let expectedLastThread = null;
  for (let index = 0; index < 120; index += 1) {
    if (index === 47 || index === 89) {
      current = new LocalConversationRouter({
        stateFile,
        now: () => Date.parse("2026-07-12T12:00:00.000Z"),
      });
    }
    const targetIndex = (index * 7) % threadIds.length;
    const otherIndex = (targetIndex + 1) % threadIds.length;
    const threadId = threadIds[targetIndex];
    const originator = index % 4 === 0
      ? roots[targetIndex]
      : `${threadId}-descendant-${index % 12}`;
    const hostileParent = index % 2 === 0
      ? roots[otherIndex]
      : `${threadIds[otherIndex]}-descendant-${index % 12}`;
    const action = current.ingest(message(3_000 + index, messages[index % messages.length], {
      thread_originator_guid: originator,
      reply_to_guid: hostileParent,
      createdAt: new Date(Date.parse("2026-07-12T12:00:00.000Z") + index * 1_000).toISOString(),
    }));
    assert.ok(action, `stress action ${index} was dropped`);
    assert.equal(action.threadId, threadId, `stress action ${index} crossed native task context`);
    assert.equal(action.threadOriginatorGuid, originator);
    assert.equal(action.replyToGuid, hostileParent);
    assert.ok(!["stale-reply-context", "ambiguous-reply-context"].includes(action.kind));
    assert.equal(current.acknowledge(action.messageKey), true);
    expectedLastThread = threadId;
  }

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:02:01.000Z"),
  });
  assert.equal(resumed.lastUserThreadId, expectedLastThread);
  const topLevel = resumed.ingest(message(3_200, "Continue the default task.", {
    reply_to_guid: roots[(threadIds.indexOf(expectedLastThread) + 1) % roots.length],
    createdAt: "2026-07-12T12:02:01.000Z",
  }));
  assert.equal(topLevel.kind, "prompt");
  assert.equal(topLevel.threadId, expectedLastThread);
});

test("unknown and corrupt native originators fail closed without falling back to the default task", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  const seed = router.ingest(message(22, "Seed A", { thread_originator_guid: "root-a" }));
  router.acknowledge(seed.messageKey);

  const stale = router.ingest(message(23, "Must not reach A", {
    thread_originator_guid: "deleted-native-root",
    reply_to_guid: "root-a",
  }));
  assert.equal(stale.kind, "stale-reply-context");
  assert.equal(stale.threadId, undefined);
  assert.equal(router.lastUserThreadId, "thread-a");
  router.acknowledge(stale.messageKey);

  const invalid = router.ingest(message(24, "Also must not reach A", {
    thread_originator_guid: "x".repeat(300),
  }));
  assert.equal(invalid.kind, "stale-reply-context");
  assert.equal(invalid.threadId, undefined);
  router.acknowledge(invalid.messageKey);

  const stored = JSON.parse(readFileSync(stateFile, "utf8"));
  stored.threads["thread-b"] = {
    rootGuid: "root-a",
    latestGuid: null,
    muted: false,
    listen: false,
    lastActivityAt: "2026-07-12T12:00:00.000Z",
  };
  writeFileSync(stateFile, `${JSON.stringify(stored)}\n`);
  const corrupted = new LocalConversationRouter({ stateFile });
  const ambiguous = corrupted.ingest(message(25, "Do not guess", { thread_originator_guid: "root-a" }));
  assert.equal(ambiguous.kind, "ambiguous-reply-context");
  assert.equal(ambiguous.threadId, undefined);
});

test("unknown commands preserve an authoritative native task context", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("root-b", "thread-b", { root: true });
  const action = router.ingest(message(26, "/not-a-command", {
    thread_originator_guid: "root-a",
    reply_to_guid: "root-b",
  }));
  assert.equal(action.kind, "unknown-command");
  assert.equal(action.threadId, "thread-a");
  assert.equal(action.threadOriginatorGuid, "root-a");
});

test("poll votes resolve registered actions and refresh stale reasoning context", () => {
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
  assert.deepEqual(router.ingest(message(31, "", {
    poll: { kind: "vote", original_guid: "poll-guid", vote: { option_id: "not-registered" } },
  })), {
    kind: "control",
    messageKey: "guid-31",
    threadId: "thread-a",
    command: "reasoning",
    guid: "guid-31",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  advance(61_000);
  assert.deepEqual(router.ingest(vote(32)), {
    kind: "control",
    messageKey: "guid-32",
    threadId: "thread-a",
    command: "reasoning",
    guid: "guid-32",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
});

test("expired command pickers preserve command arguments across restart", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("history-picker", {
    alpha: { kind: "control", command: "history", threadId: "thread-a", argument: "5" },
    beta: { kind: "control", command: "history", threadId: "thread-b", argument: "5" },
  }, {
    ttlMs: 1_000,
    addChoiceCommand: "history",
    addChoiceArgument: "5",
  });
  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:02.000Z"),
  });
  assert.deepEqual(resumed.ingest(message(3_200, "", {
    poll: { kind: "vote", original_guid: "history-picker", vote: { option_id: "alpha" } },
  })), {
    kind: "thread-picker",
    messageKey: "guid-3200",
    command: "history",
    argument: "5",
    guid: "guid-3200",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
});

test("expired generic directory polls retain the safe directory fallback", () => {
  const { router, advance } = fixture();
  router.registerPoll("directory-picker", {
    projects: { kind: "projects" },
    threads: { kind: "threads" },
  }, 1_000);
  advance(2_000);
  assert.equal(router.ingest(message(3_201, "", {
    poll: { kind: "vote", original_guid: "directory-picker", vote: { option_id: "threads" } },
  })).kind, "stale-poll");
});

test("cross-device poll votes resolve by one unique stable option UUID and survive restart", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("local-poll-guid", {
    "stable-option-high": { kind: "control", command: "reasoning", threadId: "thread-a", argument: "high" },
    "stable-option-low": { kind: "control", command: "reasoning", threadId: "thread-a", argument: "low" },
  }, 60_000);
  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  const action = resumed.ingest(message(33, "", {
    poll: {
      kind: "vote",
      original_guid: "different-guid-on-sender-device",
      vote: { option_id: "stable-option-high" },
    },
  }));
  assert.deepEqual(action, {
    kind: "control",
    messageKey: "guid-33",
    threadId: "thread-a",
    command: "reasoning",
    argument: "high",
    guid: "guid-33",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
});

test("cross-device poll option collisions and unknown UUIDs fail closed", () => {
  const { router } = fixture();
  router.registerPoll("local-poll-a", {
    collision: { kind: "control", command: "reasoning", threadId: "thread-a", argument: "high" },
  }, 60_000);
  router.registerPoll("local-poll-b", {
    collision: { kind: "control", command: "reasoning", threadId: "thread-b", argument: "low" },
  }, 60_000);
  assert.equal(router.ingest(message(34, "", {
    poll: {
      kind: "vote",
      original_guid: "different-guid-on-sender-device",
      vote: { option_id: "collision" },
    },
  })), null);
  assert.equal(router.ingest(message(35, "", {
    poll: {
      kind: "vote",
      original_guid: "another-foreign-guid",
      vote: { option_id: "unknown-option" },
    },
  })), null);
  assert.equal(router.lastRowId, 35);
  assert.deepEqual(router.pendingActions(), []);
});

test("foreign native poll creation snapshots and votes are durably ignored", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("known-task-root", "thread-a", { root: true });

  // Messages emits the poll's initial choices as a `created` snapshot. These
  // are not Add Choice search terms unless we previously registered the poll.
  const initialSnapshot = message(32, "Weekend plans", {
    thread_originator_guid: "foreign-poll-root",
    poll: {
      kind: "created",
      original_guid: "foreign-poll",
      options: [
        { option_id: "foreign-a", text: "Dinner" },
        { option_id: "foreign-b", text: "Movie" },
      ],
    },
  });
  assert.equal(router.ingest(initialSnapshot), null);
  assert.equal(router.lastRowId, 32);
  assert.deepEqual(router.pendingActions(), []);

  const unknownVote = message(33, "Voted for Dinner", {
    thread_originator_guid: "foreign-poll-root",
    poll: {
      kind: "vote",
      original_guid: "foreign-poll",
      vote: { option_id: "foreign-a" },
    },
  });
  assert.equal(router.ingest(unknownVote), null);
  assert.equal(router.lastRowId, 33);
  assert.deepEqual(router.pendingActions(), []);

  // Both events were durably consumed and cannot replay after restart.
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.ingest(initialSnapshot), null);
  assert.equal(resumed.ingest(unknownVote), null);
  assert.equal(resumed.lastRowId, 33);
  assert.deepEqual(resumed.pendingActions(), []);
});

test("explicitly enabled native Add Choice updates become durable search actions after restart", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("browse-poll", {
    recent: { kind: "switch", threadId: "thread-a" },
    projects: { kind: "projects" },
  }, {
    ttlMs: 60_000,
    allowAddedChoiceSearch: true,
    optionLabels: { recent: "Recent tasks", projects: "Projects" },
  });

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  const update = message(32, "", {
    poll: {
      kind: "created",
      original_guid: "browse-poll",
      options: [
        { option_id: "recent", text: "Recent tasks" },
        { option_id: "projects", text: "Projects" },
        { option_id: "added-search", text: "router timeout" },
      ],
    },
  });
  assert.deepEqual(resumed.ingest(update), {
    kind: "search",
    messageKey: "guid-32",
    command: "search",
    argument: "router timeout",
    guid: "guid-32",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  const pendingAfterRestart = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  assert.equal(pendingAfterRestart.pendingActions()[0].argument, "router timeout");
  pendingAfterRestart.acknowledge("guid-32");

  // A later full poll snapshot containing the same added option is a no-op,
  // but still advances the durable watch cursor so it cannot replay forever.
  const duplicate = message(33, "", {
    poll: {
      kind: "created",
      original_guid: "browse-poll",
      options: [{ option_id: "added-search", text: "router timeout" }],
    },
  });
  assert.equal(pendingAfterRestart.ingest(duplicate), null);
  assert.equal(pendingAfterRestart.lastRowId, 33);
  assert.equal(new LocalConversationRouter({ stateFile }).lastRowId, 33);
});

test("Add Choice preserves supported command-picker intent instead of opening generic search results", () => {
  const { router, stateFile } = fixture();
  const commands = ["mute", "unmute", "reasoning"];
  for (const command of commands) {
    router.registerPoll(`picker-${command}`, {
      [`${command}-thread-a`]: { kind: "control", command, threadId: "thread-a" },
      [`${command}-thread-b`]: { kind: "control", command, threadId: "thread-b" },
      [`${command}-recent`]: { kind: "threads" },
    }, {
      ttlMs: 60_000,
      allowAddedChoiceSearch: true,
      optionLabels: {
        [`${command}-thread-a`]: "Alpha task",
        [`${command}-thread-b`]: "Beta task",
        [`${command}-recent`]: "Recent tasks",
      },
    });
  }

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  for (const [index, command] of commands.entries()) {
    const id = 40 + index;
    const action = resumed.ingest(message(id, "", {
      poll: {
        kind: "created",
        original_guid: `picker-${command}`,
        options: [
          { option_id: `${command}-thread-a`, text: "Alpha task" },
          { option_id: `${command}-thread-b`, text: "Beta task" },
          { option_id: `${command}-recent`, text: "Recent tasks" },
          { option_id: `${command}-query`, text: `find ${command} target` },
        ],
      },
    }));
    assert.equal(action.kind, "search");
    assert.equal(action.command, command);
    assert.equal(action.argument, `find ${command} target`);
    assert.equal(resumed.acknowledge(action.messageKey), true);
  }
});

test("Add Choice preserves a command picker's argument across restart", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("picker-history-five", {
    "history-thread-a": { kind: "control", command: "history", threadId: "thread-a", argument: "5" },
    "history-thread-b": { kind: "control", command: "history", threadId: "thread-b", argument: "5" },
  }, {
    ttlMs: 60_000,
    allowAddedChoiceSearch: true,
    addChoiceCommand: "history",
    addChoiceArgument: "5",
    optionLabels: {
      "history-thread-a": "Alpha task",
      "history-thread-b": "Beta task",
    },
  });

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  const action = resumed.ingest(message(48, "", {
    poll: {
      kind: "created",
      original_guid: "picker-history-five",
      options_diff: [{ option_id: "history-query", text: "older rollout" }],
    },
  }));
  assert.deepEqual({
    kind: action.kind,
    command: action.command,
    argument: action.argument,
    commandArgument: action.commandArgument,
  }, {
    kind: "search",
    command: "history",
    argument: "older rollout",
    commandArgument: "5",
  });
  assert.equal(new LocalConversationRouter({ stateFile }).pendingActions()[0].commandArgument, "5");
});

test("cross-device Add Choice resolves by a unique known option UUID and survives restart", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("local-directory-guid", {
    "stable-task-option": { kind: "switch", threadId: "thread-a" },
    "stable-projects-option": { kind: "projects" },
  }, {
    ttlMs: 60_000,
    allowAddedChoiceSearch: true,
    optionLabels: {
      "stable-task-option": "Alpha task",
      "stable-projects-option": "Projects",
    },
  });

  const resumed = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  });
  assert.deepEqual(resumed.ingest(message(44, "", {
    poll: {
      kind: "created",
      original_guid: "different-guid-on-sender-device",
      options: [
        { id: "stable-task-option", text: "Alpha task" },
        { id: "stable-projects-option", text: "Projects" },
        { id: "new-search-option", text: "native reply routing" },
      ],
    },
  })), {
    kind: "search",
    messageKey: "guid-44",
    command: "search",
    argument: "native reply routing",
    guid: "guid-44",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
});

test("cross-device Add Choice collisions, unknown UUIDs, and missing origins fail closed", () => {
  const { router, stateFile } = fixture();
  for (const [guid, threadId] of [["local-picker-a", "thread-a"], ["local-picker-b", "thread-b"]]) {
    router.registerPoll(guid, {
      "colliding-stable-option": { kind: "control", command: "mute", threadId },
    }, {
      ttlMs: 60_000,
      allowAddedChoiceSearch: true,
      optionLabels: { "colliding-stable-option": `${threadId} task` },
    });
  }

  const ambiguous = message(45, "", {
    poll: {
      kind: "created",
      original_guid: "remote-ambiguous-guid",
      options: [
        { id: "colliding-stable-option", text: "thread-a task" },
        { id: "ambiguous-query", text: "must not run" },
      ],
    },
  });
  const foreign = message(46, "", {
    poll: {
      kind: "created",
      original_guid: "foreign-guid",
      options: [
        { id: "foreign-stable-option", text: "Foreign choice" },
        { id: "foreign-query", text: "also must not run" },
      ],
    },
  });
  const missingOrigin = message(47, "", {
    poll: {
      kind: "created",
      options: [
        { id: "colliding-stable-option", text: "thread-a task" },
        { id: "originless-query", text: "still must not run" },
      ],
    },
  });
  assert.equal(router.ingest(ambiguous), null);
  assert.equal(router.ingest(foreign), null);
  assert.equal(router.ingest(missingOrigin), null);
  assert.equal(router.lastRowId, 47);
  assert.deepEqual(router.pendingActions(), []);

  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.ingest(ambiguous), null);
  assert.equal(resumed.ingest(foreign), null);
  assert.equal(resumed.ingest(missingOrigin), null);
  assert.equal(resumed.lastRowId, 47);
});

test("Add Choice is ignored unless enabled and non-action poll updates are durably discarded", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("reasoning-poll", {
    high: { kind: "control", command: "reasoning", threadId: "thread-a", argument: "high" },
  }, 60_000);
  const created = message(34, "", {
    poll: {
      kind: "created",
      original_guid: "reasoning-poll",
      options: [{ option_id: "search", text: "must not search" }],
    },
  });
  assert.equal(router.ingest(created), null);
  assert.equal(router.lastRowId, 34);
  assert.deepEqual(router.pendingActions(), []);

  const unvote = message(35, "", {
    poll: {
      kind: "unvote",
      original_guid: "reasoning-poll",
      vote: { option_id: "high" },
    },
  });
  assert.equal(router.ingest(unvote), null);
  assert.equal(router.lastRowId, 35);
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.ingest(unvote), null);
  assert.equal(resumed.lastRowId, 35);
});

test("expired and out-of-range snapshots fail closed", () => {
  const { router, advance } = fixture();
  router.setActiveThread("thread-a");
  router.setMenu(["thread:thread-b"], 1_000);
  assert.equal(router.ingest(message(40, "9")).kind, "stale-menu");
  advance(2_000);
  assert.equal(router.ingest(message(41, "1")).kind, "stale-menu");
});

test("reaction add/remove events become durable task controls and preserve the reply root", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });

  const listenOn = router.ingest(message(50, "Liked", {
    is_reaction: true,
    reaction_type: "like",
    is_reaction_add: true,
    reacted_to_guid: "root-a",
  }));
  assert.deepEqual(listenOn, {
    kind: "reaction-control",
    messageKey: "guid-50",
    threadId: "thread-a",
    command: "listen",
    guid: "guid-50",
    createdAt: "2026-07-12T12:00:00.000Z",
    enabled: true,
  });
  assert.equal(router.lastUserThreadId, "thread-a");
  assert.equal(router.lastUserMessageAt, "2026-07-12T12:00:00.000Z");
  assert.equal(router.nativeThread("thread-a").rootGuid, "root-a");
  assert.equal(router.nativeThread("thread-a").latestGuid, "root-a");

  const resumed = new LocalConversationRouter({ stateFile });
  assert.deepEqual(resumed.pendingActions(), [listenOn]);
  assert.equal(resumed.acknowledge(listenOn.messageKey), true);
  const listenOff = resumed.ingest(message(51, "Removed a like", {
    isReaction: true,
    reactionType: "LIKE",
    isReactionAdd: false,
    reactedToGuid: "root-a",
  }));
  assert.equal(listenOff.kind, "reaction-control");
  assert.equal(listenOff.command, "listen");
  assert.equal(listenOff.enabled, false);
  assert.equal(listenOff.threadId, "thread-a");
  assert.equal(new LocalConversationRouter({ stateFile }).pendingActions()[0].enabled, false);
});

test("dislike, question, and emphasis reactions map to mute, inspect, and stop", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  const reaction = (id, reactionType, isReactionAdd) => router.ingest(message(id, "reaction", {
    is_reaction: true,
    reaction_type: reactionType,
    is_reaction_add: isReactionAdd,
    reacted_to_guid: "root-a",
  }));

  const mute = reaction(52, "dislike", true);
  assert.deepEqual({ kind: mute.kind, command: mute.command, threadId: mute.threadId }, {
    kind: "reaction-control",
    command: "mute",
    threadId: "thread-a",
  });
  router.acknowledge(mute.messageKey);
  const unmute = reaction(53, "dislike", false);
  assert.equal(unmute.command, "unmute");
  router.acknowledge(unmute.messageKey);
  const inspect = reaction(54, "question", true);
  assert.equal(inspect.command, "inspect");
  router.acknowledge(inspect.messageKey);
  const stop = reaction(55, "emphasize", true);
  assert.deepEqual({ kind: stop.kind, command: stop.command, threadId: stop.threadId }, {
    kind: "reaction-control",
    command: "stop",
    threadId: "thread-a",
  });
});

test("question removal, unsupported, unmapped, malformed, and ambiguous reactions fail closed", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("ambiguous-root", "thread-a", { root: true });
  router.routeOutboundGuid("ambiguous-root", "thread-b", { root: true });
  const reaction = (id, extras) => message(id, "reaction", { is_reaction: true, ...extras });

  assert.equal(router.ingest(reaction(56, {
    reaction_type: "question",
    is_reaction_add: false,
    reacted_to_guid: "root-a",
  })), null);
  assert.equal(router.ingest(reaction(57, {
    reaction_type: "emphasize",
    is_reaction_add: false,
    reacted_to_guid: "root-a",
  })), null);
  assert.equal(router.ingest(reaction(58, {
    reaction_type: "love",
    is_reaction_add: true,
    reacted_to_guid: "root-a",
  })), null);
  assert.equal(router.ingest(reaction(59, {
    reaction_type: "like",
    is_reaction_add: true,
    reacted_to_guid: "unknown-root",
  })), null);
  assert.equal(router.ingest(reaction(60, {
    reaction_type: "like",
    reacted_to_guid: "root-a",
  })), null);
  assert.equal(router.ingest(reaction(61, {
    reaction_type: "like",
    is_reaction_add: true,
    reacted_to_guid: "ambiguous-root",
  })), null);
  assert.equal(router.lastRowId, 61);
  assert.equal(router.lastUserMessageAt, null);
  assert.deepEqual(router.pendingActions(), []);
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.ingest(reaction(61, {
    reaction_type: "like",
    is_reaction_add: true,
    reacted_to_guid: "ambiguous-root",
  })), null);
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
  router.routeOutboundGuid("root-a", "thread-a", {
    root: true,
    createdAt: "2026-07-12T12:00:00.000Z",
    headerTitleFingerprint: "a".repeat(64),
    headerRevision: 7,
  });
  advance(1_000);
  router.routeOutboundGuid("child-a", "thread-a", { createdAt: "2026-07-12T12:00:01.000Z" });
  advance(1_000);
  router.routeOutboundGuid("root-b", "thread-b", { createdAt: "2026-07-12T12:00:02.000Z" });
  router.setThreadMuted("thread-a", true);
  router.setThreadListen("thread-a", true);

  const resumed = new LocalConversationRouter({ stateFile });
  assert.deepEqual(resumed.nativeThread("thread-a"), {
    rootGuid: "root-a",
    headerTitleFingerprint: "a".repeat(64),
    headerRevision: 7,
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

test("routes native thread originators and preserves their inbound descendants after restart", () => {
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
    thread_originator_guid: "root-a",
  }));
  assert.equal(byEarlierInbound.threadId, "thread-a");
  assert.equal(resumed.nativeThread("thread-a").latestGuid, "guid-62");
});

test("explicit inbound route registration persists the message and authoritative originator only", () => {
  const { router, stateFile } = fixture();
  router.routeInboundGuid("inbound-child", "thread-a", {
    replyToGuid: "assistant-child",
    threadOriginatorGuid: "assistant-root",
    createdAt: "2026-07-12T12:00:00.000Z",
  });
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.nativeThread("thread-a").rootGuid, "assistant-root");
  assert.equal(resumed.nativeThread("thread-a").latestGuid, "inbound-child");
  assert.equal(resumed.ingest(message(63, "Reply again", {
    thread_originator_guid: "assistant-root",
    reply_to_guid: "inbound-child",
  })).threadId, "thread-a");
  resumed.acknowledge("guid-63");
  assert.equal(resumed.ingest(message(64, "Reply at root", { thread_originator_guid: "assistant-root" })).threadId, "thread-a");
  resumed.acknowledge("guid-64");
  const incidentalParent = resumed.ingest(message(65, "Top-level parent metadata", { reply_to_guid: "assistant-child" }));
  assert.equal(incidentalParent.threadId, "thread-a");
  assert.equal(resumed.ingest(message(66, "Unknown parent remains top-level", { reply_to_guid: "not-routed" })).threadId, "thread-a");
});

test("a conflicting originator can never become another task's native root", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeInboundGuid("inbound-b", "thread-b", {
    threadOriginatorGuid: "root-a",
    replyToGuid: "incidental-parent",
    createdAt: "2026-07-12T12:00:00.000Z",
  });

  assert.equal(router.nativeThread("thread-a").rootGuid, "root-a");
  assert.equal(router.nativeThread("thread-b").rootGuid, null);
  assert.equal(router.nativeThread("thread-b").latestGuid, "inbound-b");

  const resumed = new LocalConversationRouter({ stateFile });
  const reply = resumed.ingest(message(2_902, "Still belongs to A.", {
    thread_originator_guid: "root-a",
    reply_to_guid: "inbound-b",
  }));
  assert.equal(reply.kind, "prompt");
  assert.equal(reply.threadId, "thread-a");
  assert.equal(resumed.nativeThread("thread-b").rootGuid, null);
});

test("remembering an inbound message never turns its incidental parent into reply context", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("root-b", "thread-b", { root: true });
  router.routeInboundGuid("inbound-a", "thread-a", {
    replyToGuid: "incidental-unmapped-parent",
    threadOriginatorGuid: "root-a",
  });
  const seedDefault = router.ingest(message(67, "Use B by default", { thread_originator_guid: "root-b" }));
  router.acknowledge(seedDefault.messageKey);
  const topLevel = router.ingest(message(68, "Still B", { reply_to_guid: "incidental-unmapped-parent" }));
  assert.equal(topLevel.threadId, "thread-b");
});

test("background output cannot redirect an unthreaded prompt away from the last user task", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true, createdAt: "2026-07-12T11:59:58.000Z" });
  const initial = router.ingest(message(69, "Work here.", { thread_originator_guid: "root-a" }));
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
    expiresAt: "2026-07-12T12:02:00.000Z",
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

test("task commands prefer native reply then recent default context before a picker", () => {
  const { router, advance } = fixture();
  router.routeOutboundGuid("root-a", "thread-a");

  const listen = router.ingest(message(90, "/listen", {
    thread_originator_guid: "root-a",
    reply_to_guid: "unrelated-latest-message",
  }));
  assert.equal(listen.kind, "control");
  assert.equal(listen.command, "listen");
  assert.equal(listen.threadId, "thread-a");
  router.acknowledge(listen.messageKey);

  const mute = router.ingest(message(91, "/mute"));
  assert.equal(mute.kind, "control");
  assert.equal(mute.command, "mute");
  assert.equal(mute.threadId, "thread-a");
  router.acknowledge(mute.messageKey);

  advance(5 * 60 * 1000 + 1);
  const mutePicker = router.ingest(message(92, "/unmute"));
  assert.equal(mutePicker.kind, "thread-picker");
  assert.equal(mutePicker.command, "unmute");
  assert.equal(mutePicker.threadId, undefined);
  router.acknowledge(mutePicker.messageKey);

  const unmute = router.ingest(message(93, "/unmute", { thread_originator_guid: "root-a" }));
  assert.equal(unmute.kind, "control");
  assert.equal(unmute.command, "unmute");
  assert.equal(unmute.threadId, "thread-a");
  router.acknowledge(unmute.messageKey);

  let id = 94;
  for (const command of ["thread", "open", "request", "message", "turn", "history", "reasoning", "status", "retry", "dismiss"]) {
    const action = router.ingest(message(id++, `/${command}`));
    assert.equal(action.kind, "thread-picker", command);
    assert.equal(action.command, command);
    router.acknowledge(action.messageKey);
  }
});

test("command default context has an inclusive configurable TTL while ordinary prompts remain indefinite", () => {
  const { router, advance } = fixture({ commandContextTtlMs: 1_000 });
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  const seed = router.ingest(message(120, "Work here.", { thread_originator_guid: "root-a" }));
  router.acknowledge(seed.messageKey);

  advance(1_000);
  const atBoundary = router.ingest(message(121, "/thread"));
  assert.equal(atBoundary.kind, "control");
  assert.equal(atBoundary.threadId, "thread-a");
  router.acknowledge(atBoundary.messageKey);

  advance(1);
  const expired = router.ingest(message(122, "/history"));
  assert.equal(expired.kind, "thread-picker");
  assert.equal(expired.threadId, undefined);
  router.acknowledge(expired.messageKey);

  advance(60 * 60 * 1000);
  const prompt = router.ingest(message(123, "Continue despite the old context."));
  assert.equal(prompt.kind, "prompt");
  assert.equal(prompt.threadId, "thread-a");
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

test("manual selection defaults to a 120 second pause with exact expiry semantics", () => {
  const { router, advance } = fixture();
  router.setMenu(["thread:thread-a"]);
  const selected = router.ingest(message(100, "1"));
  assert.equal(selected.kind, "switch");
  assert.equal(router.awaitingPrompt.expiresAt, "2026-07-12T12:02:00.000Z");
  advance(119_999);
  assert.equal(router.shouldPauseIncoming("thread-a"), true);
  advance(2);
  assert.equal(router.shouldPauseIncoming("thread-a"), false);
  assert.equal(router.awaitingPrompt, null);
});

test("a native reply prompt to the manually selected task consumes the pause durably", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("root-b", "thread-b", { root: true });
  router.setAwaitingPrompt("thread-a");

  const other = router.ingest(message(101, "Work in B", { thread_originator_guid: "root-b" }));
  assert.equal(other.threadId, "thread-b");
  assert.equal(router.shouldPauseIncoming("thread-a"), true);
  router.acknowledge(other.messageKey);

  const selected = router.ingest(message(102, "Now work in A", {
    thread_originator_guid: "root-a",
    reply_to_guid: "root-b",
  }));
  assert.equal(selected.kind, "prompt");
  assert.equal(selected.threadId, "thread-a");
  assert.equal(selected.fromAwaitingPrompt, true);
  assert.equal(router.incomingPaused, false);
  assert.equal(new LocalConversationRouter({ stateFile }).incomingPaused, false);
});

test("link and task cancel commands are unavailable and cannot release a manual selection", () => {
  const { router, stateFile } = fixture();
  router.setAwaitingPrompt("thread-a");
  const cancel = router.ingest(message(103, "/cancel", { reply_to_guid: "incidental-parent" }));
  assert.equal(cancel.kind, "unknown-command");
  assert.equal(cancel.threadId, "thread-a");
  router.acknowledge(cancel.messageKey);
  const link = router.ingest(message(104, "/link"));
  assert.equal(link.kind, "unknown-command");
  assert.equal(router.incomingPaused, true);
  assert.equal(new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-12T12:00:00.000Z"),
  }).incomingPaused, true);
});

test("v5 state persists the last user task independently from background activity", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  const action = router.ingest(message(110, "Reply", { thread_originator_guid: "root-a" }));
  router.acknowledge(action.messageKey);
  router.routeOutboundGuid("root-b", "thread-b", { root: true });
  const resumed = new LocalConversationRouter({ stateFile });
  assert.equal(resumed.lastUserThreadId, "thread-a");
  assert.equal(resumed.mostRecentThreadId, "thread-b");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).version, 5);
});

test("new-task and default-reasoning commands stay global inside and outside native replies", () => {
  const { router } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  const topLevel = router.ingest(message(9_000, "/new Build a new task."));
  assert.equal(topLevel.kind, "new");
  assert.equal(topLevel.argument, "Build a new task.");
  assert.equal(topLevel.threadId, undefined);
  router.acknowledge(topLevel.messageKey);

  const replied = router.ingest(message(9_001, "/defaultreasoning high", {
    thread_originator_guid: "root-a",
  }));
  assert.equal(replied.kind, "defaultreasoning");
  assert.equal(replied.argument, "high");
  assert.equal(replied.threadId, undefined);
});

test("new-task project and reasoning polls persist and Add Choice becomes project search", () => {
  const { router, stateFile } = fixture();
  router.registerPoll("project-poll", {
    "project-option": { kind: "new-project", flowId: "flow-a", projectKey: "project-a" },
  }, {
    allowAddedChoiceSearch: true,
    addedChoiceAction: { kind: "new-project-search", flowId: "flow-a" },
    knownOptionIds: ["project-option"],
    optionLabels: { "project-option": "Messaging" },
  });
  const resumed = new LocalConversationRouter({ stateFile, now: () => Date.parse("2026-07-12T12:00:00.000Z") });
  const vote = resumed.ingest(message(9_010, "", {
    poll: { kind: "vote", original_guid: "project-poll", vote: { option_id: "project-option" } },
  }));
  assert.deepEqual({ kind: vote.kind, flowId: vote.flowId, projectKey: vote.projectKey }, {
    kind: "new-project",
    flowId: "flow-a",
    projectKey: "project-a",
  });
  resumed.acknowledge(vote.messageKey);

  const added = resumed.ingest(message(9_011, "", {
    poll: {
      kind: "created",
      original_guid: "project-poll",
      options_diff: [{ id: "added-option", text: "Release tooling" }],
    },
  }));
  assert.deepEqual({ kind: added.kind, flowId: added.flowId, argument: added.argument }, {
    kind: "new-project-search",
    flowId: "flow-a",
    argument: "Release tooling",
  });
});

test("new-task prompt lease lasts 120 seconds, yields to explicit replies, and cancels atomically", () => {
  const { router, advance } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  assert.equal(router.setAwaitingNewPrompt("flow-a"), true);
  assert.equal(router.incomingPaused, true);
  assert.equal(router.shouldPauseIncoming("thread-a"), true);
  assert.equal(router.shouldPauseIncoming("thread-b"), true);
  const explicit = router.ingest(message(9_020, "Keep working in A.", { thread_originator_guid: "root-a" }));
  assert.equal(explicit.kind, "prompt");
  assert.equal(explicit.threadId, "thread-a");
  assert.equal(router.awaitingNewPrompt.flowId, "flow-a");
  assert.equal(router.shouldPauseIncoming("thread-b"), true);
  router.acknowledge(explicit.messageKey);

  const first = router.ingest(message(9_021, "Create the new task."));
  assert.equal(first.kind, "new-prompt");
  assert.equal(first.flowId, "flow-a");
  assert.equal(router.awaitingNewPrompt, null);
  assert.equal(router.incomingPaused, false);
  router.acknowledge(first.messageKey);

  router.setAwaitingNewPrompt("flow-b");
  const cancel = router.ingest(message(9_022, "/cancel"));
  assert.equal(cancel.kind, "new-cancel");
  assert.equal(cancel.flowId, "flow-b");
  assert.equal(router.awaitingNewPrompt, null);
  router.acknowledge(cancel.messageKey);

  router.setAwaitingNewPrompt("flow-c");
  advance(120_001);
  assert.equal(router.awaitingNewPrompt, null);
  const afterExpiry = router.ingest(message(9_023, "Continue the old default."));
  assert.equal(afterExpiry.kind, "prompt");
  assert.equal(afterExpiry.threadId, "thread-a");
});
