import assert from "node:assert/strict";
import test from "node:test";
import { RunManager } from "../src/run-manager.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let now = Date.parse("2026-07-14T12:00:00.000Z");
  let sequence = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimeoutImpl(callback, delay) {
      const timer = { callback, at: now + delay, sequence: sequence++, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timers.delete(timer); },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers]
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = target;
    },
  };
}

test("runs different threads concurrently and queues each thread in order", async () => {
  const releases = new Map();
  const started = [];
  const manager = new RunManager({
    maxConcurrent: 2,
    run: (event) => new Promise((resolve) => {
      started.push(event.replyId);
      releases.set(event.replyId, resolve);
    }),
  });
  manager.enqueue({ threadId: "a", replyId: "a1", claimed: { reply: { body: "First request" } } });
  manager.enqueue({ threadId: "a", replyId: "a2", claimed: { reply: { body: "Second request" } } });
  manager.enqueue({ threadId: "b", replyId: "b1", claimed: { reply: { body: "Other request" } } });
  await tick();
  assert.deepEqual(started, ["a1", "b1"]);
  assert.equal(manager.state("a").status, "working");
  assert.equal(manager.state("a").pendingCount, 1);
  assert.equal(manager.state("a").request, "First request");
  assert.equal(manager.state("a").latestRequest, "Second request");
  assert.equal(manager.has("a2"), true);
  releases.get("a1")();
  await tick();
  await tick();
  assert.deepEqual(started, ["a1", "b1", "a2"]);
  releases.get("a2")();
  releases.get("b1")();
});

test("cancel is immediate and discards queued replies", async () => {
  let cancelCalled = false;
  const discarded = [];
  const manager = new RunManager({
    maxConcurrent: 1,
    run: (_event, context) => new Promise((resolve) => {
      context.setCancel(() => { cancelCalled = true; resolve(); });
    }),
    discard: async (event) => discarded.push(event.replyId),
  });
  manager.enqueue({ threadId: "a", replyId: "a1" });
  manager.enqueue({ threadId: "a", replyId: "a2" });
  await tick();
  const result = await manager.cancel("a");
  assert.deepEqual(result, { active: true, pending: 1 });
  assert.equal(cancelCalled, true);
  assert.deepEqual([...discarded].sort(), ["a1", "a2"]);
});

test("targeted cancellation never stops work admitted after the durable snapshot", async () => {
  const releases = new Map();
  const cancelled = [];
  const discarded = [];
  const manager = new RunManager({
    maxConcurrent: 1,
    run: (event, context) => new Promise((resolve) => {
      releases.set(event.replyId, resolve);
      context.setCancel(() => {
        cancelled.push(event.replyId);
        resolve();
      });
    }),
    discard: async (event) => discarded.push(event.replyId),
  });
  manager.enqueue({ threadId: "controller", replyId: "old-active" });
  manager.enqueue({ threadId: "controller", replyId: "old-pending" });
  await tick();
  manager.enqueue({ threadId: "controller", replyId: "new-after-snapshot" });

  const result = await manager.cancel("controller", {
    replyIds: ["old-active", "old-pending"],
  });
  assert.deepEqual(result, { active: true, pending: 1 });
  assert.deepEqual(cancelled, ["old-active"]);
  assert.equal(manager.has("new-after-snapshot"), true);
  await tick();
  await tick();
  assert.equal(discarded.includes("new-after-snapshot"), false);
  assert.equal(releases.has("new-after-snapshot"), true);
  releases.get("new-after-snapshot")();
});

test("cancellation commits its durable snapshot synchronously before queued discard awaits", async () => {
  let releaseActive;
  let releaseDiscard;
  const order = [];
  const manager = new RunManager({
    maxConcurrent: 1,
    run: (_event, context) => new Promise((resolve) => {
      releaseActive = resolve;
      context.setCancel(resolve);
    }),
    discard: (event) => event.replyId === "queued" ? new Promise((resolve) => {
      order.push(`discard:${event.replyId}`);
      releaseDiscard = resolve;
    }) : Promise.resolve(order.push(`discard:${event.replyId}`)),
  });
  manager.enqueue({ threadId: "controller", replyId: "active" });
  manager.enqueue({ threadId: "controller", replyId: "queued" });
  await tick();

  const cancellation = manager.cancel("controller", {
    replyIds: ["active", "queued"],
    onRequested: (outcome) => order.push(`commit:${outcome.active}:${outcome.pending}`),
  });
  assert.deepEqual(order, ["commit:true:1", "discard:queued"]);
  releaseDiscard();
  await cancellation;
  await tick();
  releaseActive?.();
});

test("cancel requested before a run installs its handler is not lost", async () => {
  let launched = false;
  let cancelCalled = false;
  const manager = new RunManager({
    run: async (_event, context) => {
      launched = true;
      context.setCancel(() => { cancelCalled = true; });
    },
  });
  manager.enqueue({ threadId: "race", replyId: "race-1" });
  const result = await manager.cancel("race");
  await tick();
  assert.deepEqual(result, { active: true, pending: 0 });
  assert.equal(launched, true);
  assert.equal(cancelCalled, true);
});

test("cancel wins over a deferred retry and discards the reply", async () => {
  let release;
  let starts = 0;
  const discarded = [];
  const manager = new RunManager({
    run: async (_event, context) => {
      starts += 1;
      context.defer(1000);
      await new Promise((resolve) => { release = resolve; });
    },
    discard: async (event) => { discarded.push(event.replyId); },
  });
  manager.enqueue({ threadId: "defer", replyId: "defer-1" });
  await tick();
  await manager.cancel("defer");
  release();
  await tick();
  await tick();
  assert.equal(starts, 1);
  assert.deepEqual(discarded, ["defer-1"]);
  assert.equal(manager.state("defer"), null);
});

test("pending state carries the exact queued request for thread detail", async () => {
  let release;
  const manager = new RunManager({
    maxConcurrent: 1,
    run: () => new Promise((resolve) => { release = resolve; }),
  });
  manager.enqueue({ threadId: "active", replyId: "active-1", claimed: { reply: { body: "Running" } } });
  manager.enqueue({ threadId: "pending", replyId: "pending-1", claimed: { reply: { body: "Queued from iMessage" } } });
  await tick();
  assert.equal(manager.state("pending").status, "pending");
  assert.equal(manager.state("pending").request, "Queued from iMessage");
  assert.equal(manager.state("pending").pendingCount, 1);
  release();
});

test("service shutdown detaches without interrupting or discarding active iMessage work", async () => {
  let release;
  let cancelCalled = false;
  const discarded = [];
  const started = [];
  const manager = new RunManager({
    maxConcurrent: 1,
    run: (event, context) => new Promise((resolve) => {
      started.push(event.replyId);
      context.setCancel(() => { cancelCalled = true; });
      release = resolve;
    }),
    discard: async (event) => { discarded.push(event.replyId); },
  });
  manager.enqueue({ threadId: "active", replyId: "active-1" });
  manager.enqueue({ threadId: "queued", replyId: "queued-1" });
  await tick();

  assert.deepEqual(manager.shutdown(), { active: 1, pending: 1 });
  assert.equal(cancelCalled, false);
  assert.deepEqual(discarded, []);
  assert.equal(manager.has("active-1"), true);
  assert.equal(manager.has("queued-1"), true);
  assert.equal(manager.enqueue({ threadId: "later", replyId: "later-1" }), false);

  release();
  await tick();
  await tick();
  assert.deepEqual(started, ["active-1"], "shutdown must not start another queued turn");
  assert.deepEqual(discarded, []);
});

test("deferred retries use durable exponential backoff without admitting a duplicate turn", async () => {
  const clock = fakeClock();
  const retries = [];
  const entries = [];
  let starts = 0;
  let active = 0;
  let maxActive = 0;
  const manager = new RunManager({
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    run: async (event, context) => {
      starts += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      entries.push(event);
      if (starts <= 3) {
        retries.push(context.deferWithBackoff("codex-availability", {
          initialMs: 1_000,
          maxMs: 4_000,
        }));
      }
      active -= 1;
    },
  });

  assert.equal(manager.enqueue({ threadId: "task", replyId: "reply-1" }), true);
  await tick();
  await tick();
  assert.deepEqual(retries, [{ attempt: 1, delayMs: 1_000 }]);
  assert.equal(manager.has("reply-1"), true);
  assert.equal(manager.enqueue({ threadId: "task", replyId: "reply-1" }), false);

  clock.advance(999);
  await tick();
  assert.equal(starts, 1);
  clock.advance(1);
  await tick();
  await tick();
  assert.deepEqual(retries.at(-1), { attempt: 2, delayMs: 2_000 });

  clock.advance(2_000);
  await tick();
  await tick();
  assert.deepEqual(retries.at(-1), { attempt: 3, delayMs: 4_000 });

  clock.advance(4_000);
  await tick();
  await tick();
  assert.equal(starts, 4);
  assert.equal(manager.has("reply-1"), false);
  assert.equal(maxActive, 1);
  assert.equal(new Set(entries).size, 1, "every retry must reuse the same admitted entry");
  assert.equal("deferredRetries" in entries[0], false, "completion resets the backoff state");
});

test("restored deferred-retry attempts retain their cap and can be reset after Codex succeeds", async () => {
  const clock = fakeClock();
  const observed = [];
  let starts = 0;
  const manager = new RunManager({
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    run: async (event, context) => {
      starts += 1;
      if (starts === 1) {
        observed.push(context.deferWithBackoff("codex-pairing", {
          initialMs: 120_000,
          maxMs: 480_000,
        }));
        return;
      }
      context.resetDeferBackoff();
      observed.push(context.deferWithBackoff("delivery-after-success", {
        initialMs: 1_000,
        maxMs: 8_000,
      }));
    },
  });
  manager.enqueue({
    threadId: "task",
    replyId: "reply-restored",
    deferredRetries: {
      "codex-pairing": { attempt: 3, delayMs: 480_000 },
    },
  });
  await tick();
  await tick();
  assert.deepEqual(observed[0], { attempt: 4, delayMs: 480_000 });

  clock.advance(480_000);
  await tick();
  await tick();
  assert.deepEqual(observed[1], { attempt: 1, delayMs: 1_000 });
  manager.shutdown();
});

test("cancelling a deferred retry removes its long block from later messages", async () => {
  const clock = fakeClock();
  const started = [];
  const discarded = [];
  const manager = new RunManager({
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    discard: async (event) => { discarded.push(event.replyId); },
    run: async (event, context) => {
      started.push(event.replyId);
      if (event.replyId === "pairing") {
        context.deferWithBackoff("codex-setup", {
          initialMs: 30 * 60_000,
          maxMs: 30 * 60_000,
        });
      }
    },
  });
  manager.enqueue({ threadId: "task", replyId: "pairing" });
  await tick();
  await tick();
  assert.equal(manager.state("task").status, "pending");

  assert.deepEqual(await manager.cancel("task"), { active: false, pending: 1 });
  assert.deepEqual(discarded, ["pairing"]);
  assert.equal(manager.enqueue({ threadId: "task", replyId: "after-pairing" }), true);
  await tick();
  await tick();
  assert.deepEqual(started, ["pairing", "after-pairing"]);
});
