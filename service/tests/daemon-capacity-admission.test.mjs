import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { admitClaimedJob } from "../src/claimed-job-admission.mjs";
import {
  loadClaimedJobs,
  markClaimedJobState,
  removeClaimedJob,
  saveClaimedJob,
} from "../src/claimed-store.mjs";
import { RunManager } from "../src/run-manager.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testsDirectory, "../..");

async function eventually(assertion, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

test("an idle task reply is durably queued behind three unrelated runs and starts once in FIFO order", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-daemon-capacity-"));
  const previousHome = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;

  const starts = [];
  const startCounts = new Map();
  const releases = new Map();
  const errors = [];
  const manager = new RunManager({
    maxConcurrent: 3,
    onError: (error) => errors.push(error),
    run: async (event) => {
      starts.push(event.replyId);
      startCounts.set(event.replyId, (startCounts.get(event.replyId) || 0) + 1);
      markClaimedJobState(event.replyId, "running");
      await new Promise((resolve) => { releases.set(event.replyId, resolve); });
      removeClaimedJob(event.replyId);
    },
  });

  const event = (threadId, replyId, queuedAt) => ({
    threadId,
    replyId,
    queuedAt,
    receivedAtMs: Date.parse(queuedAt),
    claimed: { reply: { id: replyId, body: `request-${replyId}`, media: [] }, images: [] },
  });
  const admit = (entry) => admitClaimedJob({
    persist: () => saveClaimedJob(entry, "queued"),
    threadExists: () => true,
    enqueue: () => manager.enqueue(entry),
  });

  try {
    for (const entry of [
      event("task-a", "a-1", "2026-07-15T12:00:00.000Z"),
      event("task-b", "b-1", "2026-07-15T12:00:01.000Z"),
      event("task-c", "c-1", "2026-07-15T12:00:02.000Z"),
    ]) {
      assert.equal(await admit(entry), "queued");
    }
    await eventually(() => assert.deepEqual(starts, ["a-1", "b-1", "c-1"]));

    const firstIdleReply = event("task-idle", "idle-1", "2026-07-15T12:00:03.000Z");
    const secondIdleReply = event("task-idle", "idle-2", "2026-07-15T12:00:04.000Z");
    assert.equal(await admit(firstIdleReply), "queued", "capacity must not reject the idle task reply");
    assert.equal(await admit(secondIdleReply), "queued", "a same-task follower must also be durably admitted");

    assert.deepEqual(starts, ["a-1", "b-1", "c-1"]);
    assert.deepEqual(manager.state("task-idle"), {
      status: "pending",
      stateSince: "2026-07-15T12:00:03.000Z",
      pendingCount: 2,
      request: "request-idle-1",
      requestAt: "2026-07-15T12:00:03.000Z",
      latestRequest: "request-idle-2",
      latestRequestAt: "2026-07-15T12:00:04.000Z",
    });
    const durableIdle = loadClaimedJobs().filter((job) => job.threadId === "task-idle");
    assert.deepEqual(durableIdle.map((job) => [job.replyId, job.state]), [
      ["idle-1", "queued"],
      ["idle-2", "queued"],
    ]);
    assert.ok(durableIdle[0].admissionOrder < durableIdle[1].admissionOrder);

    const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
    assert.match(daemon, /Queued behind earlier iMessage work\. Codex will start this message automatically\./);
    assert.doesNotMatch(daemon, /(?:no|free) (?:run )?slots?|run slot is free/i);

    releases.get("b-1")();
    await eventually(() => assert.deepEqual(starts, ["a-1", "b-1", "c-1", "idle-1"]));
    assert.equal(startCounts.get("idle-1"), 1, "the admitted reply starts exactly once");
    assert.equal(startCounts.get("idle-2"), undefined, "the same-task follower cannot overtake it");
    assert.deepEqual(loadClaimedJobs()
      .filter((job) => job.threadId === "task-idle")
      .map((job) => [job.replyId, job.state]), [
      ["idle-1", "running"],
      ["idle-2", "queued"],
    ]);

    releases.get("idle-1")();
    await eventually(() => assert.deepEqual(starts, ["a-1", "b-1", "c-1", "idle-1", "idle-2"]));
    assert.equal(startCounts.get("idle-1"), 1);
    assert.equal(startCounts.get("idle-2"), 1);

    for (const replyId of ["a-1", "c-1", "idle-2"]) releases.get(replyId)();
    await eventually(() => assert.equal(manager.states().size, 0));
    assert.deepEqual(loadClaimedJobs(), []);
    assert.deepEqual(errors, []);
  } finally {
    manager.shutdown();
    if (previousHome === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
