import assert from "node:assert/strict";
import test from "node:test";
import { RolloutReconcileScheduler } from "../src/rollout-reconcile-scheduler.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function thread(id) {
  return { id, rolloutPath: `/tmp/codex-sessions/${id}.jsonl` };
}

test("changed rollout paths reconcile only their tasks and burst events coalesce", async () => {
  const calls = [];
  const first = thread("first");
  const second = thread("second");
  const scheduler = new RolloutReconcileScheduler({
    runThread: async (item) => { calls.push(item.id); },
  }).replaceCatalog([first, second]);

  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath, first.rolloutPath] });
  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  await scheduler.whenIdle();
  assert.deepEqual(calls, ["first"]);
});

test("activity arriving during a task pass is not missed and remains task-ordered", async () => {
  const first = thread("first");
  const firstPass = deferred();
  const entered = deferred();
  const calls = [];
  const scheduler = new RolloutReconcileScheduler({
    runThread: async (item) => {
      calls.push(`${item.id}:${calls.length + 1}`);
      if (calls.length === 1) {
        entered.resolve();
        await firstPass.promise;
      }
    },
  }).replaceCatalog([first]);

  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  await entered.promise;
  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  firstPass.resolve();
  await scheduler.whenIdle();
  assert.deepEqual(calls, ["first:1", "first:2"]);
});

test("unknown paths and fallback activity reconcile the full catalog with bounded concurrency", async () => {
  const threads = [thread("first"), thread("second"), thread("third")];
  const gate = deferred();
  const twoStarted = deferred();
  const calls = [];
  let active = 0;
  let peak = 0;
  const scheduler = new RolloutReconcileScheduler({
    maxConcurrent: 2,
    runThread: async (item) => {
      calls.push(item.id);
      active += 1;
      peak = Math.max(peak, active);
      if (calls.length === 2) twoStarted.resolve();
      await gate.promise;
      active -= 1;
    },
  }).replaceCatalog(threads);

  const scheduled = scheduler.schedule({
    source: "filesystem",
    paths: [threads[0].rolloutPath, "/tmp/codex-sessions/not-cataloged.jsonl"],
  });
  assert.deepEqual(scheduled, { scheduled: 3, full: true, unknownPaths: 1 });
  await twoStarted.promise;
  assert.equal(peak, 2);
  gate.resolve();
  await scheduler.whenIdle();
  assert.deepEqual([...calls].sort(), ["first", "second", "third"]);
});

test("unrelated tasks run concurrently while repeated work for one task stays serial", async () => {
  const first = thread("first");
  const second = thread("second");
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const secondFinished = deferred();
  const order = [];
  let firstRuns = 0;
  const scheduler = new RolloutReconcileScheduler({
    maxConcurrent: 2,
    runThread: async (item) => {
      if (item.id === "first") {
        firstRuns += 1;
        order.push(`first-${firstRuns}-start`);
        if (firstRuns === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        order.push(`first-${firstRuns}-end`);
        return;
      }
      order.push("second-start");
      order.push("second-end");
      secondFinished.resolve();
    },
  }).replaceCatalog([first, second]);

  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath, second.rolloutPath] });
  await firstStarted.promise;
  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  await secondFinished.promise;
  assert.deepEqual(order, ["first-1-start", "second-start", "second-end"]);
  releaseFirst.resolve();
  await scheduler.whenIdle();
  assert.deepEqual(order, [
    "first-1-start",
    "second-start",
    "second-end",
    "first-1-end",
    "first-2-start",
    "first-2-end",
  ]);
});

test("filesystem work jumps ahead of queued fallback scans", async () => {
  const threads = [thread("first"), thread("second"), thread("third")];
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order = [];
  const scheduler = new RolloutReconcileScheduler({
    maxConcurrent: 1,
    runThread: async (item) => {
      order.push(item.id);
      if (item.id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    },
  }).replaceCatalog(threads);

  scheduler.schedule({ source: "fallback" });
  await firstStarted.promise;
  scheduler.schedule({ source: "filesystem", paths: [threads[2].rolloutPath] });
  releaseFirst.resolve();
  await scheduler.whenIdle();
  assert.deepEqual(order, ["first", "third", "second"]);
});

test("bounded foreground bursts let fallback work progress under sustained filesystem activity", async () => {
  const hot = thread("hot");
  const background = thread("background");
  const calls = [];
  let hotRuns = 0;
  let scheduler;
  scheduler = new RolloutReconcileScheduler({
    maxConcurrent: 1,
    maxForegroundBurst: 2,
    runThread: async (item) => {
      calls.push(item.id);
      if (item.id !== hot.id) return;
      hotRuns += 1;
      if (hotRuns < 7) {
        scheduler.schedule({ source: "filesystem", paths: [hot.rolloutPath] });
      }
    },
  }).replaceCatalog([hot, background]);

  scheduler.schedule({ source: "fallback" });
  await scheduler.whenIdle();
  assert.deepEqual(calls.slice(0, 4), ["hot", "hot", "hot", "background"]);
  assert.equal(calls.filter((id) => id === "background").length, 1);
  assert.equal(calls.filter((id) => id === "hot").length, 7);
});

test("a targeted background retry wakes only its task and obeys scheduler lifecycle", async () => {
  const first = thread("first");
  const second = thread("second");
  const calls = [];
  const scheduler = new RolloutReconcileScheduler({
    runThread: async (item) => { calls.push(item.id); },
  }).replaceCatalog([first, second]);

  assert.equal(scheduler.scheduleThread(first.id), true);
  assert.equal(scheduler.scheduleThread("missing"), false);
  await scheduler.whenIdle();
  assert.deepEqual(calls, ["first"]);
  scheduler.stop();
  assert.equal(scheduler.scheduleThread(second.id), false);
});

test("a task-local retry never gates an unrelated dirty task", async () => {
  const retrying = thread("retrying");
  const dirty = thread("dirty");
  const releaseRetry = deferred();
  const retryStarted = deferred();
  const dirtyFinished = deferred();
  const calls = [];
  const scheduler = new RolloutReconcileScheduler({
    maxConcurrent: 2,
    runThread: async (item) => {
      calls.push(item.id);
      if (item.id === retrying.id) {
        retryStarted.resolve();
        await releaseRetry.promise;
      } else {
        dirtyFinished.resolve();
      }
    },
  }).replaceCatalog([retrying, dirty]);

  scheduler.scheduleThread(retrying.id);
  await retryStarted.promise;
  scheduler.schedule({ source: "filesystem", paths: [dirty.rolloutPath] });
  await dirtyFinished.promise;
  assert.deepEqual(calls, ["retrying", "dirty"]);
  releaseRetry.resolve();
  await scheduler.whenIdle();
});

test("stop drops queued reruns and restart performs a recovering full pass", async () => {
  const first = thread("first");
  const second = thread("second");
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const calls = [];
  const scheduler = new RolloutReconcileScheduler({
    maxConcurrent: 1,
    runThread: async (item) => {
      calls.push(item.id);
      if (calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    },
  }).replaceCatalog([first, second]);

  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  await firstStarted.promise;
  scheduler.schedule({ source: "filesystem", paths: [first.rolloutPath] });
  scheduler.stop();
  releaseFirst.resolve();
  await scheduler.whenIdle();
  assert.deepEqual(calls, ["first"]);

  scheduler.start();
  await scheduler.whenIdle();
  assert.deepEqual(calls, ["first", "first", "second"]);
});

test("catalog replacement maps a newly created task immediately", async () => {
  const first = thread("first");
  const created = thread("created");
  const calls = [];
  const scheduler = new RolloutReconcileScheduler({
    runThread: async (item) => { calls.push(item.id); },
  }).replaceCatalog([first]);

  scheduler.replaceCatalog([first, created]);
  const scheduled = scheduler.schedule({ source: "filesystem", paths: [created.rolloutPath] });
  await scheduler.whenIdle();
  assert.deepEqual(scheduled, { scheduled: 1, full: false, unknownPaths: 0 });
  assert.deepEqual(calls, ["created"]);
});
