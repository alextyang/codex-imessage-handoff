import assert from "node:assert/strict";
import test from "node:test";
import { admitClaimedJob } from "../src/claimed-job-admission.mjs";

test("claimed-job admission makes one persistence attempt and exposes a retryable boundary", async () => {
  let persistenceAttempts = 0;
  let enqueued = 0;
  await assert.rejects(
    admitClaimedJob({
      persist: () => {
        persistenceAttempts += 1;
        throw new Error("read-only filesystem");
      },
      enqueue: () => { enqueued += 1; return true; },
    }),
    (error) => error?.code === "CLAIMED_STORE_UNAVAILABLE",
  );
  assert.equal(persistenceAttempts, 1);
  assert.equal(enqueued, 0);
});

test("claimed-job admission persists before cancellation, catalog checks, or enqueue", async () => {
  const events = [];
  const result = await admitClaimedJob({
    persist: () => { events.push("persist"); },
    cancelled: () => { events.push("cancel-check"); return false; },
    threadExists: () => { events.push("thread-check"); return true; },
    enqueue: () => { events.push("enqueue"); return true; },
  });
  assert.equal(result, "queued");
  assert.deepEqual(events, ["persist", "cancel-check", "thread-check", "enqueue"]);
});

test("cancelled and missing-thread jobs are discarded after durable admission", async () => {
  const cancelled = [];
  assert.equal(await admitClaimedJob({
    persist: () => {},
    cancelled: () => true,
    discard: () => { cancelled.push("discard"); },
    enqueue: () => true,
  }), "cancelled");
  assert.deepEqual(cancelled, ["discard"]);

  const missing = [];
  assert.equal(await admitClaimedJob({
    persist: () => {},
    threadExists: () => false,
    missingThread: () => { missing.push("notice"); },
    discard: () => { missing.push("discard"); },
    enqueue: () => true,
  }), "missing-thread");
  assert.deepEqual(missing, ["notice", "discard"]);
});
