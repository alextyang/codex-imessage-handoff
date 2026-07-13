import assert from "node:assert/strict";
import test from "node:test";
import { RunManager } from "../src/run-manager.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

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
