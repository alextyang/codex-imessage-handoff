import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NewThreadFlowStore } from "../src/new-thread-flow.mjs";
import {
  resumeNewProjectSelection,
  resumeNewPromptCollection,
  resumeNewThreadCreation,
} from "../src/new-thread-orchestration.mjs";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-new-thread-orchestration-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  let now = Date.parse("2026-07-13T12:00:00.000Z");
  return {
    store: () => new NewThreadFlowStore({ now: () => now }),
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    restore: () => {
      if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
      else process.env.IMESSAGE_HANDOFF_HOME = previous;
    },
  };
}

function selectedFlow(store, key = "new-flow", prompt = "Build the release.") {
  const flow = store.begin({ messageKey: key, argument: prompt });
  return store.update(flow.id, {
    stage: "reasoning",
    projectKey: "project-a",
    projectLabel: "Messaging",
    cwd: "/tmp",
    otherTask: false,
    reasoning: "high",
    threadSource: `${flow.threadSource}:project`,
  });
}

test("an ambiguously accepted reasoning poll replays its persisted project without duplicating the poll", async () => {
  const value = fixture();
  try {
    const store = value.store();
    const flow = store.begin({ messageKey: "new-project-boundary", argument: "Build it." });
    let projectResolutions = 0;
    let publishAttempts = 0;
    let nativePolls = 0;
    const acceptedScopes = new Set();
    const resolveProject = async (projectKey) => {
      projectResolutions += 1;
      return {
        projectKey,
        projectLabel: "Messaging",
        cwd: "/tmp",
        otherTask: false,
        threadSource: `${flow.threadSource}:project`,
      };
    };
    const publishReasoning = async (current) => {
      publishAttempts += 1;
      const scope = `new-thread:${current.id}:reasoning`;
      if (!acceptedScopes.has(scope)) {
        acceptedScopes.add(scope);
        nativePolls += 1;
        throw codedError("IMSG_AMBIGUOUS");
      }
    };

    await assert.rejects(
      resumeNewProjectSelection({ flow, projectKey: "project-a", store, resolveProject, publishReasoning }),
      (error) => error.code === "IMSG_AMBIGUOUS",
    );
    assert.equal(store.get(flow.id).stage, "reasoning");

    const restarted = value.store();
    const replayed = await resumeNewProjectSelection({
      flow: restarted.get(flow.id),
      projectKey: "project-a",
      store: restarted,
      resolveProject,
      publishReasoning,
    });
    assert.equal(replayed.status, "reasoning");
    assert.equal(projectResolutions, 1, "restart must reuse the persisted project selection");
    assert.equal(publishAttempts, 2);
    assert.equal(nativePolls, 1, "the stable operation scope must represent one native poll");
  } finally {
    value.restore();
  }
});

test("a reasoning vote restores prompt collection across both lease and notice crash boundaries", async () => {
  const value = fixture();
  try {
    const store = value.store();
    const flow = selectedFlow(store, "new-prompt-boundary", "");
    const action = {
      kind: "new-reasoning",
      messageKey: "reasoning-vote-guid",
      argument: "high",
      createdAt: "2026-07-13T12:00:00.000Z",
    };
    let leaseAttempts = 0;
    let leaseActive = false;
    let noticeAttempts = 0;
    let nativeNotices = 0;
    let noticeAccepted = false;
    const activatePrompt = async () => {
      leaseAttempts += 1;
      if (leaseAttempts === 1) throw codedError("DAEMON_STOPPED_BEFORE_LEASE");
      leaseActive = true;
    };
    const publishPrompt = async () => {
      noticeAttempts += 1;
      if (!noticeAccepted) {
        noticeAccepted = true;
        nativeNotices += 1;
        throw codedError("IMSG_AMBIGUOUS");
      }
    };

    await assert.rejects(
      resumeNewPromptCollection({ flow, action, reasoning: "high", store, activatePrompt, publishPrompt }),
      (error) => error.code === "DAEMON_STOPPED_BEFORE_LEASE",
    );
    assert.equal(store.get(flow.id).stage, "prompt", "the vote must be durable before lease activation");

    const firstRestart = value.store();
    await assert.rejects(
      resumeNewPromptCollection({
        flow: firstRestart.get(flow.id),
        action,
        reasoning: "high",
        store: firstRestart,
        activatePrompt,
        publishPrompt,
      }),
      (error) => error.code === "IMSG_AMBIGUOUS",
    );
    assert.equal(leaseActive, true);

    leaseActive = false;
    const secondRestart = value.store();
    const replayed = await resumeNewPromptCollection({
      flow: secondRestart.get(flow.id),
      action,
      reasoning: "high",
      store: secondRestart,
      activatePrompt,
      publishPrompt,
    });
    assert.equal(replayed.status, "prompt");
    assert.equal(leaseActive, true, "restart must restore the temporary first-message lease");
    assert.equal(noticeAttempts, 2);
    assert.equal(nativeNotices, 1, "the local-action delivery id must suppress a duplicate notice");
  } finally {
    value.restore();
  }
});

test("an ambiguously created task is reconciled after restart without another task or turn", async () => {
  const value = fixture();
  try {
    const store = value.store();
    const flow = selectedFlow(store, "new-create-ambiguous");
    const action = { kind: "new-reasoning", messageKey: "reasoning-create-guid", argument: "high" };
    const createdBySource = new Map();
    let taskVisible = false;
    let threadStarts = 0;
    let queueAdmissions = 0;
    const createThread = async (current) => {
      threadStarts += 1;
      const thread = { id: "created-thread-a", cwd: current.cwd };
      createdBySource.set(current.threadSource, thread);
      throw codedError("CODEX_TIMEOUT");
    };
    const options = {
      action,
      promptValue: flow.prompt,
      attachments: [],
      findThread: async (current) => taskVisible ? createdBySource.get(current.threadSource) || null : null,
      createThread,
      normalizeThread: (thread) => thread,
      prepareThread: async () => {},
      queuePrompt: async () => {
        queueAdmissions += 1;
        return { accepted: true, reaction: "🔍" };
      },
      reconcileDelaysMs: [0, 0, 0],
      wait: async () => {},
    };

    await assert.rejects(
      resumeNewThreadCreation({ ...options, flow, store }),
      (error) => error.code === "NEW_THREAD_CREATION_UNRESOLVED",
    );
    const creating = store.get(flow.id);
    assert.equal(creating.stage, "creating");
    assert.equal(creating.submissionKey, action.messageKey);

    taskVisible = true;
    const restarted = value.store();
    const queued = await resumeNewThreadCreation({ ...options, flow: restarted.get(flow.id), store: restarted });
    assert.equal(queued.status, "queued");
    assert.equal(queued.flow.threadId, "created-thread-a");
    assert.deepEqual(queued.admission, { accepted: true, reaction: "🔍" });
    assert.equal(threadStarts, 1);
    assert.equal(queueAdmissions, 1);
    assert.equal(restarted.get(flow.id).stage, "queued");

    const secondRestart = value.store();
    const replayed = await resumeNewThreadCreation({
      ...options,
      flow: secondRestart.get(flow.id),
      store: secondRestart,
      findThread: async () => { throw new Error("queued replay must not look up a task"); },
    });
    assert.equal(replayed.status, "queued");
    assert.equal(replayed.replayed, true);
    assert.equal(threadStarts, 1);
    assert.equal(queueAdmissions, 1, "a queued replay must not admit a second turn");
  } finally {
    value.restore();
  }
});

test("a definite transient app-server failure retries immediately without duplicating the task", async () => {
  const value = fixture();
  try {
    const store = value.store();
    const flow = selectedFlow(store, "new-create-transient");
    const action = { kind: "new-reasoning", messageKey: "reasoning-transient-guid", argument: "high" };
    const createdBySource = new Map();
    let attempts = 0;
    let actualThreads = 0;
    let queueAdmissions = 0;
    const options = {
      action,
      promptValue: flow.prompt,
      attachments: [],
      findThread: async (current) => createdBySource.get(current.threadSource) || null,
      createThread: async (current) => {
        attempts += 1;
        if (attempts === 1) throw codedError("CODEX_UNAVAILABLE");
        actualThreads += 1;
        const thread = { id: "created-after-recovery", cwd: current.cwd };
        createdBySource.set(current.threadSource, thread);
        return thread;
      },
      queuePrompt: async () => { queueAdmissions += 1; return true; },
      now: value.now,
    };

    await assert.rejects(
      resumeNewThreadCreation({ ...options, flow, store }),
      (error) => error.code === "CODEX_UNAVAILABLE",
    );
    assert.equal(store.get(flow.id).createAttemptedAt, null);

    const restarted = value.store();
    const queued = await resumeNewThreadCreation({ ...options, flow: restarted.get(flow.id), store: restarted });
    assert.equal(queued.status, "queued");
    assert.equal(attempts, 2);
    assert.equal(actualThreads, 1);
    assert.equal(queueAdmissions, 1);
  } finally {
    value.restore();
  }
});

test("an unresolved ambiguous create never issues a replacement thread/start across restarts", async () => {
  const value = fixture();
  try {
    const store = value.store();
    const flow = selectedFlow(store, "new-create-settling");
    const action = { kind: "new-reasoning", messageKey: "reasoning-settling-guid", argument: "high" };
    let attempts = 0;
    let queueAdmissions = 0;
    const createThread = async () => {
      attempts += 1;
      throw codedError("CODEX_TIMEOUT");
    };
    const options = {
      action,
      promptValue: flow.prompt,
      attachments: [],
      findThread: async () => null,
      createThread,
      queuePrompt: async () => { queueAdmissions += 1; return true; },
      reconcileDelaysMs: [0, 0],
      wait: async () => {},
    };

    await assert.rejects(
      resumeNewThreadCreation({ ...options, flow, store }),
      (error) => error.code === "NEW_THREAD_CREATION_UNRESOLVED",
    );
    const restarted = value.store();
    await assert.rejects(
      resumeNewThreadCreation({ ...options, flow: restarted.get(flow.id), store: restarted }),
      (error) => error.code === "NEW_THREAD_CREATION_UNRESOLVED",
    );
    assert.equal(attempts, 1, "restart must not race the unresolved request with another thread/start");

    value.advance(30_001);
    const settledRestart = value.store();
    await assert.rejects(
      resumeNewThreadCreation({ ...options, flow: settledRestart.get(flow.id), store: settledRestart }),
      (error) => error.code === "NEW_THREAD_CREATION_UNRESOLVED",
    );
    assert.equal(attempts, 1, "elapsed time cannot make a non-idempotent replacement safe");
    assert.equal(queueAdmissions, 0);
  } finally {
    value.restore();
  }
});
