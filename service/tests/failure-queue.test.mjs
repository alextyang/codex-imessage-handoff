import assert from "node:assert/strict";
import test from "node:test";
import { FailureQueue } from "../src/failure-queue.mjs";

test("failed messages remain FIFO and later success clears only its own failure", () => {
  const failures = new FailureQueue();
  failures.record("thread-a", { replyId: "later", queuedAt: "2026-07-12T02:00:00.000Z", body: "Later" });
  failures.record("thread-a", { replyId: "first", queuedAt: "2026-07-12T01:00:00.000Z", body: "First" });
  assert.deepEqual(failures.list("thread-a").map((item) => item.replyId), ["first", "later"]);
  assert.equal(failures.next("thread-a").replyId, "first");
  assert.equal(failures.markRetrying("thread-a", "first"), true);
  assert.equal(failures.next("thread-a").replyId, "later");

  failures.remove("thread-a", "unrelated-success");
  assert.equal(failures.has("thread-a"), true);
  failures.record("thread-a", { replyId: "first", queuedAt: "2026-07-12T01:00:00.000Z", body: "First again" });
  assert.equal(failures.next("thread-a").replyId, "first");
  failures.remove("thread-a", "first");
  assert.deepEqual(failures.list("thread-a").map((item) => item.replyId), ["later"]);
});
