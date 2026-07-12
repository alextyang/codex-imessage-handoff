import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClaimedJobs, markClaimedJobState, removeClaimedJob, saveClaimedJob } from "../src/claimed-store.mjs";

test("claimed prompts survive restart state privately until completion", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-claimed-state-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    const event = {
      threadId: "thread-a",
      replyId: "reply-a",
      queuedAt: "2026-07-12T00:00:00.000Z",
      claimed: { reply: { body: "Exact private prompt", media: [{ url: "https://example.test/image" }] }, images: ["/tmp/image.png"] },
    };
    saveClaimedJob({ ...event, mirrorSuppressionToken: "token-123" }, "queued");
    assert.equal(statSync(path.join(home, "run-state.json")).mode & 0o777, 0o600);
    assert.equal(loadClaimedJobs()[0].claimed.reply.body, "Exact private prompt");
    assert.equal(loadClaimedJobs()[0].mirrorSuppressionToken, "token-123");
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
