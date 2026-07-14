import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalConversationRouter } from "../src/local-conversation-router.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-e2e-routing-"));
  const stateFile = path.join(directory, "state.json");
  let now = Date.parse("2026-07-13T12:00:00.000Z");
  const router = new LocalConversationRouter({ stateFile, now: () => now });
  return {
    router,
    stateFile,
    advance: (milliseconds) => { now += milliseconds; },
    resume: () => new LocalConversationRouter({ stateFile, now: () => now }),
  };
}

function message(id, text = "", extras = {}) {
  return {
    id,
    guid: extras.guid || `regression-${id}`,
    text,
    created_at: extras.createdAt || "2026-07-13T12:00:00.000Z",
    ...extras,
  };
}

test("/new retains up to five attachments in the durable inbound action", () => {
  const { router, resume } = fixture();
  const attachments = Array.from({ length: 6 }, (_, index) => ({
    path: `/tmp/new-${index}.png`,
    mime_type: "image/png",
  }));

  const action = router.ingest(message(1, "/new Review these screenshots.", { attachments }));
  assert.equal(action.kind, "new");
  assert.equal(action.argument, "Review these screenshots.");
  assert.deepEqual(action.attachments, attachments.slice(0, 5));
  assert.deepEqual(resume().pendingActions(), [action]);
});

test("/cancel terminates a durable active new-task flow before prompt collection begins", () => {
  const { router, resume } = fixture();
  assert.equal(router.setActiveNewFlow("flow-before-prompt"), true);
  assert.equal(router.awaitingNewPrompt, null);

  const restarted = resume();
  assert.equal(restarted.activeNewFlowId, "flow-before-prompt");
  const action = restarted.ingest(message(2, "/cancel"));
  assert.deepEqual({ kind: action.kind, flowId: action.flowId }, {
    kind: "new-cancel",
    flowId: "flow-before-prompt",
  });
  assert.equal(restarted.activeNewFlowId, null);
  assert.equal(restarted.awaitingNewPrompt, null);
  assert.deepEqual(resume().pendingActions(), [action]);
});

test("expired new-task polls return their flow-specific refresh action after restart", () => {
  const { router, advance, resume } = fixture();
  router.registerPoll("new-project-poll", {
    "project-a": { kind: "new-project", flowId: "flow-project", projectKey: "project-a" },
  }, {
    ttlMs: 1_000,
    refreshAction: { kind: "new-project-search", flowId: "flow-project" },
  });
  router.registerPoll("new-reasoning-poll", {
    high: { kind: "new-reasoning", flowId: "flow-reasoning", argument: "high" },
  }, {
    ttlMs: 1_000,
    refreshAction: { kind: "new-reasoning-refresh", flowId: "flow-reasoning" },
  });
  advance(1_001);

  const restarted = resume();
  const project = restarted.ingest(message(3, "", {
    poll: { kind: "vote", original_guid: "new-project-poll", vote: { option_id: "project-a" } },
  }));
  assert.deepEqual({ kind: project.kind, flowId: project.flowId }, {
    kind: "new-project-search",
    flowId: "flow-project",
  });
  restarted.acknowledge(project.messageKey);

  const reasoning = restarted.ingest(message(4, "", {
    poll: { kind: "vote", original_guid: "new-reasoning-poll", vote: { option_id: "high" } },
  }));
  assert.deepEqual({ kind: reasoning.kind, flowId: reasoning.flowId }, {
    kind: "new-reasoning-refresh",
    flowId: "flow-reasoning",
  });
});

test("a reaction on an evicted descendant routes through its durable native thread originator", () => {
  const { router, stateFile } = fixture();
  router.routeOutboundGuid("root-a", "thread-a", { root: true });
  router.routeOutboundGuid("old-descendant-a", "thread-a");
  router.routeOutboundGuid("latest-a", "thread-a");

  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.guidRoutes = Object.fromEntries([
    ["old-descendant-a", "thread-a"],
    ...Array.from({ length: 4_096 }, (_, index) => [`filler-${index}`, `filler-thread-${index}`]),
  ]);
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const restarted = new LocalConversationRouter({
    stateFile,
    now: () => Date.parse("2026-07-13T12:00:00.000Z"),
  });
  const action = restarted.ingest(message(5, "Liked", {
    is_reaction: true,
    reaction_type: "like",
    is_reaction_add: true,
    reacted_to_guid: "old-descendant-a",
    thread_originator_guid: "root-a",
  }));

  assert.deepEqual({ kind: action.kind, command: action.command, enabled: action.enabled, threadId: action.threadId }, {
    kind: "reaction-control",
    command: "listen",
    enabled: true,
    threadId: "thread-a",
  });
});
