import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimedClientUserMessageId,
  loadClaimedJobs,
  markClaimedJobState,
  removeClaimedJob,
  removeClaimedJobs,
  saveClaimedJob,
} from "../src/claimed-store.mjs";

test("claimed prompts survive restart state privately until completion", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-state-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const event = {
      threadId: "thread-a",
      replyId: "reply-a",
      queuedAt: "2026-07-12T00:00:00.000Z",
      claimed: {
        reply: { body: "Exact private prompt", media: [{ url: "https://example.test/image" }] },
        images: ["/tmp/image.png"],
        userMirrorMode: "mirror",
      },
    };
    saveClaimedJob({
      ...event,
      reasoningEffort: "high",
      mirrorSuppressionToken: "token-123",
      imsgGuid: "native-reply-guid",
      backendNoticeSent: true,
      reconcileRunning: true,
      recoveredTurnId: "turn-recovered",
      recoveryMissingSince: "2026-07-12T00:00:10.000Z",
      threadCheckpoint: {
        turnId: "turn-before-claim",
        activityAt: "2026-07-11T23:59:00.000Z",
        capturedAt: "2026-07-12T00:00:00.000Z",
      },
    }, "queued");
    const stableClientId = claimedClientUserMessageId("thread-a", "reply-a");
    assert.equal(statSync(path.join(home, "run-state.json")).mode & 0o777, 0o600);
    assert.equal(event.clientUserMessageId, undefined, "saving a copied event does not mutate the caller's original object");
    assert.equal(loadClaimedJobs()[0].clientUserMessageId, stableClientId);
    assert.equal(loadClaimedJobs()[0].claimed.reply.body, "Exact private prompt");
    assert.equal(loadClaimedJobs()[0].claimed.userMirrorMode, "mirror");
    assert.equal(loadClaimedJobs()[0].reasoningEffort, "high");
    assert.equal(loadClaimedJobs()[0].mirrorSuppressionToken, "token-123");
    assert.equal(loadClaimedJobs()[0].imsgGuid, "native-reply-guid");
    assert.equal(loadClaimedJobs()[0].backendNoticeSent, true);
    assert.equal(loadClaimedJobs()[0].reconcileRunning, true);
    assert.equal(loadClaimedJobs()[0].recoveredTurnId, "turn-recovered");
    assert.equal(loadClaimedJobs()[0].recoveryMissingSince, "2026-07-12T00:00:10.000Z");
    assert.deepEqual(loadClaimedJobs()[0].threadCheckpoint, {
      turnId: "turn-before-claim",
      activityAt: "2026-07-11T23:59:00.000Z",
      capturedAt: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(markClaimedJobState("reply-a", "running").state, "running");
    assert.equal(loadClaimedJobs()[0].state, "running");
    assert.equal(loadClaimedJobs()[0].reasoningEffort, "high", "claiming the queued job must retain its reasoning snapshot");
    const recovered = loadClaimedJobs()[0];
    saveClaimedJob({ ...recovered, delivery: { body: "Completed response", generatedImages: [] } }, "delivering");
    assert.equal(loadClaimedJobs()[0].delivery.body, "Completed response");
    assert.equal(loadClaimedJobs()[0].clientUserMessageId, stableClientId, "recovery and delivery reuse the original protocol id");
    assert.equal(removeClaimedJob("reply-a"), true);
    assert.deepEqual(loadClaimedJobs(), []);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("later same-task claims retain durable predecessor client ids when Messages timestamps tie", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-predecessors-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const first = {
      threadId: "thread-fifo",
      replyId: "first",
      queuedAt: "2026-07-12T00:00:00.000Z",
      receivedAtMs: 100,
      claimed: { reply: { body: "First", media: [] }, images: [] },
    };
    const second = {
      threadId: "thread-fifo",
      replyId: "second",
      queuedAt: "2026-07-12T00:00:00.000Z",
      receivedAtMs: 100,
      claimed: { reply: { body: "Second", media: [] }, images: [] },
    };
    saveClaimedJob(first, "running");
    saveClaimedJob(second, "queued");
    assert.deepEqual(second.predecessorClientUserMessageIds, [first.clientUserMessageId]);
    assert.equal(first.admissionOrder, 1);
    assert.equal(second.admissionOrder, 2);

    // Re-saving the earlier job after the later one exists must not reverse
    // the predecessor relationship.
    saveClaimedJob(first, "running");
    assert.deepEqual(loadClaimedJobs().find((job) => job.replyId === "first").predecessorClientUserMessageIds, []);
    assert.deepEqual(loadClaimedJobs().find((job) => job.replyId === "second").predecessorClientUserMessageIds,
      [first.clientUserMessageId]);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("persisted admission order survives restart and orders later same-millisecond claims", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-admission-order-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const claim = (replyId) => ({
      threadId: "thread-restart-fifo",
      replyId,
      queuedAt: "2026-07-12T00:00:00.000Z",
      receivedAtMs: 100,
      claimed: { reply: { body: replyId, media: [] }, images: [] },
    });
    const first = claim("first");
    const second = claim("second");
    saveClaimedJob(first, "running");
    saveClaimedJob(second, "queued");

    const persisted = JSON.parse(readFileSync(path.join(home, "run-state.json"), "utf8"));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.jobs.first.admissionOrder, 1);
    assert.equal(persisted.jobs.second.admissionOrder, 2);
    assert.equal(persisted.nextAdmissionOrder, 3);

    // Each public operation reloads the file, matching a new daemon process.
    const restored = loadClaimedJobs();
    assert.deepEqual(restored.map((job) => job.replyId), ["first", "second"]);
    const third = claim("third");
    saveClaimedJob(third, "queued");
    assert.equal(third.admissionOrder, 3);
    assert.deepEqual(third.predecessorClientUserMessageIds, [
      first.clientUserMessageId,
      second.clientUserMessageId,
    ]);

    // Re-saving an earlier claim cannot make it a successor of later work.
    saveClaimedJob({ ...restored[0] }, "running");
    const final = loadClaimedJobs();
    assert.deepEqual(final.find((job) => job.replyId === "first").predecessorClientUserMessageIds, []);
    assert.deepEqual(final.map((job) => job.admissionOrder), [1, 2, 3]);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("a retry keeps the persisted client user-message id instead of minting a new turn identity", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-retry-id-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const first = {
      threadId: "thread-retry",
      replyId: "native-guid-retry",
      claimed: { reply: { body: "Run once", media: [] }, images: [] },
    };
    saveClaimedJob(first, "running");
    const firstId = first.clientUserMessageId;
    assert.match(firstId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

    const restored = loadClaimedJobs()[0];
    saveClaimedJob({
      threadId: restored.threadId,
      replyId: restored.replyId,
      clientUserMessageId: "attempted-replacement",
      claimed: restored.claimed,
      retryOf: restored.replyId,
    }, "queued");

    assert.equal(loadClaimedJobs()[0].clientUserMessageId, firstId);
    assert.equal(claimedClientUserMessageId("thread-retry", "native-guid-retry"), firstId);
    assert.notEqual(claimedClientUserMessageId("thread-retry", "another-guid"), firstId);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("bulk cleanup removes an exact deduplicated set in one store update", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-bulk-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const job = (replyId) => ({
      threadId: "thread-a",
      replyId,
      claimed: { reply: { body: replyId, media: [] }, images: [] },
    });
    saveClaimedJob(job("one"));
    saveClaimedJob(job("two"));
    saveClaimedJob(job("keep"));
    assert.equal(removeClaimedJobs(["one", "two", "one", "missing"]), 2);
    assert.deepEqual(loadClaimedJobs().map((entry) => entry.replyId), ["keep"]);
    assert.equal(removeClaimedJobs([]), 0);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("legacy version 1 state is read without mutation and upgrades on the next write", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-legacy-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const file = path.join(home, "run-state.json");
    const legacy = `${JSON.stringify({
      version: 1,
      jobs: {
        legacy: {
          threadId: "legacy-thread",
          replyId: "legacy",
          queuedAt: "2026-07-11T00:00:00.000Z",
          claimed: { reply: { body: "Legacy request", media: [] }, images: [] },
          state: "queued",
        },
      },
    }, null, 2)}\n`;
    writeFileSync(file, legacy, { mode: 0o600 });

    assert.equal(loadClaimedJobs()[0].claimed.reply.body, "Legacy request");
    assert.equal(readFileSync(file, "utf8"), legacy, "a read-only load must not rewrite live state");

    assert.equal(markClaimedJobState("legacy", "running").state, "running");
    const upgraded = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(upgraded.version, 3);
    assert.equal(upgraded.jobs.legacy.admissionOrder, 1);
    assert.equal(upgraded.nextAdmissionOrder, 2);
    assert.equal(upgraded.jobs.legacy.claimed.reply.body, "Legacy request");
    assert.equal(upgraded.jobs.legacy.state, "running");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});
