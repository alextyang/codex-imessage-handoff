import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClaimedJobs, markClaimedJobState, removeClaimedJob, removeClaimedJobs, saveClaimedJob } from "../src/claimed-store.mjs";

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
      mirrorSuppressionToken: "token-123",
      imsgGuid: "native-reply-guid",
      backendNoticeSent: true,
      reconcileRunning: true,
      recoveredTurnId: "turn-recovered",
      recoveryMissingSince: "2026-07-12T00:00:10.000Z",
    }, "queued");
    assert.equal(statSync(path.join(home, "run-state.json")).mode & 0o777, 0o600);
    assert.equal(loadClaimedJobs()[0].claimed.reply.body, "Exact private prompt");
    assert.equal(loadClaimedJobs()[0].claimed.userMirrorMode, "mirror");
    assert.equal(loadClaimedJobs()[0].mirrorSuppressionToken, "token-123");
    assert.equal(loadClaimedJobs()[0].imsgGuid, "native-reply-guid");
    assert.equal(loadClaimedJobs()[0].backendNoticeSent, true);
    assert.equal(loadClaimedJobs()[0].reconcileRunning, true);
    assert.equal(loadClaimedJobs()[0].recoveredTurnId, "turn-recovered");
    assert.equal(loadClaimedJobs()[0].recoveryMissingSince, "2026-07-12T00:00:10.000Z");
    assert.equal(markClaimedJobState("reply-a", "running").state, "running");
    assert.equal(loadClaimedJobs()[0].state, "running");
    saveClaimedJob({ ...event, delivery: { body: "Completed response", generatedImages: [] } }, "delivering");
    assert.equal(loadClaimedJobs()[0].delivery.body, "Completed response");
    assert.equal(removeClaimedJob("reply-a"), true);
    assert.deepEqual(loadClaimedJobs(), []);
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
    assert.equal(upgraded.version, 2);
    assert.equal(upgraded.jobs.legacy.claimed.reply.body, "Legacy request");
    assert.equal(upgraded.jobs.legacy.state, "running");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});
