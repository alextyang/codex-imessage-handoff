import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalConversationRouter } from "../src/local-conversation-router.mjs";
import { settleLocalActionOutcome } from "../src/local-action-settlement.mjs";
import { NewThreadFlowStore } from "../src/new-thread-flow.mjs";
import { resumeNewThreadCreation } from "../src/new-thread-orchestration.mjs";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

test("daemon settlement removes new-task state only after durable inbound acceptance", async () => {
  const calls = [];
  const outcome = {
    reaction: "✨",
    newThreadCompletion: {
      flowId: "flow-a",
      threadId: "thread-a",
      updatedAt: "2026-07-13T12:00:00.000Z",
    },
  };
  assert.equal(await settleLocalActionOutcome({ messageKey: "message-a" }, outcome, {
    acceptInbound: async (_action, options) => {
      calls.push(["accept", options.newThreadCompletion.threadId]);
      return true;
    },
    newThreadFlows: { remove: (flowId) => calls.push(["remove", flowId]) },
    router: {
      clearAwaitingNewPrompt: (flowId) => calls.push(["clear-awaiting", flowId]),
      clearActiveNewFlow: (flowId) => calls.push(["clear-active", flowId]),
    },
    scheduleSynchronize: () => calls.push(["synchronize"]),
  }), true);
  assert.deepEqual(calls, [
    ["accept", "thread-a"],
    ["clear-awaiting", "flow-a"],
    ["clear-active", "flow-a"],
    ["remove", "flow-a"],
    ["synchronize"],
  ]);
});

test("/new recovers a crash after durable queue admission without admitting a second turn", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-new-thread-queue-boundary-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  try {
    const flows = new NewThreadFlowStore({ now: () => now });
    const begun = flows.begin({ messageKey: "new-command-queue-boundary", argument: "Ship it." });
    const flow = flows.update(begun.id, {
      stage: "prompt",
      projectKey: "project-a",
      projectLabel: "Messaging",
      cwd: "/tmp",
      reasoning: "high",
    });
    const action = {
      kind: "new-prompt",
      messageKey: "new-prompt-queue-boundary",
      body: "Ship it.",
      attachments: [],
    };
    const thread = { id: "created-queue-boundary", cwd: "/tmp" };
    let durableQueueAdmission = false;
    let admissionCalls = 0;
    let actualTurns = 0;
    const queuePrompt = async () => {
      admissionCalls += 1;
      if (!durableQueueAdmission) {
        durableQueueAdmission = true;
        actualTurns += 1;
        throw codedError("DAEMON_EXIT_AFTER_QUEUE_ADMISSION");
      }
      return true;
    };

    await assert.rejects(
      resumeNewThreadCreation({
        flow,
        action,
        store: flows,
        findThread: async () => null,
        createThread: async () => thread,
        queuePrompt,
      }),
      (error) => error.code === "DAEMON_EXIT_AFTER_QUEUE_ADMISSION",
    );
    assert.equal(flows.get(flow.id).stage, "creating");
    assert.equal(flows.get(flow.id).threadId, thread.id);

    const restarted = new NewThreadFlowStore({ now: () => now });
    const recovered = await resumeNewThreadCreation({
      flow: restarted.get(flow.id),
      action,
      store: restarted,
      findThread: async () => thread,
      createThread: async () => { throw new Error("must not create twice"); },
      queuePrompt,
    });
    assert.equal(recovered.status, "queued");
    assert.equal(admissionCalls, 2, "replay may check the exact durable admission");
    assert.equal(actualTurns, 1, "the exact claimed reply must represent one Codex turn");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("/new retains a queued tombstone through failed acceptance and leaves acceptance-before-cleanup crash-safe", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-new-thread-daemon-boundary-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  const stateFile = path.join(home, "router-state.json");
  try {
    const flows = new NewThreadFlowStore({ now: () => now });
    const begun = flows.begin({ messageKey: "new-command-guid" });
    const waiting = flows.update(begun.id, {
      stage: "prompt",
      projectKey: "project-a",
      projectLabel: "Messaging",
      cwd: "/tmp",
      reasoning: "high",
      promptSetupKey: "reasoning-vote-guid",
    });
    const router = new LocalConversationRouter({ stateFile, now: () => now });
    router.setActiveNewFlow(waiting.id);
    router.setAwaitingNewPrompt(waiting.id);
    const action = router.ingest({
      id: 1,
      guid: "new-task-prompt-guid",
      text: "Build the durable task.",
      created_at: "2026-07-13T12:00:00.000Z",
    });
    assert.equal(action.kind, "new-prompt");

    let starts = 0;
    let queueAdmissions = 0;
    const creationOptions = {
      action,
      promptValue: action.body,
      attachments: action.attachments,
      findThread: async () => null,
      createThread: async () => {
        starts += 1;
        return { id: "created-task-a", cwd: "/tmp" };
      },
      queuePrompt: async () => {
        queueAdmissions += 1;
        return true;
      },
    };
    const created = await resumeNewThreadCreation({
      ...creationOptions,
      flow: waiting,
      store: flows,
    });
    assert.equal(created.status, "queued");
    assert.equal(router.setDefaultThread(created.flow.threadId, action.createdAt), true);
    const outcome = {
      reaction: "✨",
      newThreadCompletion: {
        flowId: created.flow.id,
        threadId: created.flow.threadId,
        updatedAt: action.createdAt,
      },
    };

    await assert.rejects(
      settleLocalActionOutcome(action, outcome, {
        acceptInbound: async () => { throw Object.assign(new Error("restart"), { code: "IMSG_DISCONNECTED" }); },
        newThreadFlows: flows,
        router,
      }),
      (error) => error.code === "IMSG_DISCONNECTED",
    );
    assert.equal(flows.get(waiting.id).stage, "queued", "failed acceptance must retain replay state");

    const restartedFlows = new NewThreadFlowStore({ now: () => now });
    const restartedRouter = new LocalConversationRouter({ stateFile, now: () => now });
    assert.equal(restartedRouter.pendingActions().length, 1);
    const replayed = await resumeNewThreadCreation({
      ...creationOptions,
      flow: restartedFlows.get(waiting.id),
      store: restartedFlows,
      findThread: async () => { throw new Error("queued replay must not reconcile again"); },
      createThread: async () => { throw new Error("queued replay must not create again"); },
    });
    assert.equal(replayed.replayed, true);
    assert.equal(starts, 1);
    assert.equal(queueAdmissions, 1);

    // Simulate a process dying after pending -> seen was committed but before
    // the daemon could delete the separate flow-state tombstone.
    const acceptanceOptions = [];
    await assert.rejects(
      settleLocalActionOutcome(action, outcome, {
        acceptInbound: async (pendingAction, options) => {
          acceptanceOptions.push(options);
          const accepted = restartedRouter.acknowledgeWithConfirmation(
            pendingAction.messageKey,
            { messageGuid: pendingAction.guid, reaction: options.reaction },
            { newThreadCompletion: options.newThreadCompletion },
          );
          assert.equal(accepted, true);
          throw Object.assign(new Error("simulated process exit"), { code: "DAEMON_EXIT" });
        },
        newThreadFlows: restartedFlows,
        router: restartedRouter,
      }),
      (error) => error.code === "DAEMON_EXIT",
    );
    assert.equal(acceptanceOptions[0].newThreadCompletion.threadId, "created-task-a");

    const afterCrashFlows = new NewThreadFlowStore({ now: () => now });
    const afterCrashRouter = new LocalConversationRouter({ stateFile, now: () => now });
    assert.deepEqual(afterCrashRouter.pendingActions(), []);
    assert.equal(afterCrashRouter.activeNewFlowId, null);
    assert.equal(afterCrashRouter.awaitingNewPrompt, null);
    assert.equal(afterCrashRouter.lastUserThreadId, "created-task-a");
    assert.equal(afterCrashFlows.get(waiting.id).stage, "queued", "the leftover tombstone is inert and replay-safe");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});
