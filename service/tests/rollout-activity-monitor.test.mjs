import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { RolloutActivityMonitor } from "../src/rollout-activity-monitor.mjs";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("rollout activity coalesces JSONL events and ignores unrelated files", async () => {
  const watcher = new EventEmitter();
  watcher.close = () => watcher.emit("close");
  let listener;
  const observations = [];
  const monitor = new RolloutActivityMonitor({
    root: "/tmp/codex-sessions",
    existsImpl: () => true,
    watchImpl: (_root, options, callback) => {
      assert.deepEqual(options, { recursive: true, persistent: false });
      listener = callback;
      return watcher;
    },
    debounceMs: 10,
    fallbackMs: 60_000,
    onActivity: (event) => observations.push(event),
  }).start();

  listener("change", "one.jsonl");
  listener("change", "two.jsonl");
  listener("change", "ignore.sqlite");
  await wait(25);
  assert.deepEqual(observations, [{
    source: "filesystem",
    watching: true,
    paths: [
      "/tmp/codex-sessions/one.jsonl",
      "/tmp/codex-sessions/two.jsonl",
    ],
    unknownPath: false,
  }]);
  monitor.stop();
});

test("rollout activity retains unknown paths so callers can request a full fallback", async () => {
  const watcher = new EventEmitter();
  watcher.close = () => watcher.emit("close");
  let listener;
  const observations = [];
  const monitor = new RolloutActivityMonitor({
    root: "/tmp/codex-sessions",
    existsImpl: () => true,
    watchImpl: (_root, _options, callback) => {
      listener = callback;
      return watcher;
    },
    debounceMs: 10,
    fallbackMs: 60_000,
    onActivity: (event) => observations.push(event),
  }).start();

  listener("rename", null);
  listener("change", "known.jsonl");
  await wait(25);
  assert.deepEqual(observations, [{
    source: "filesystem",
    watching: true,
    paths: ["/tmp/codex-sessions/known.jsonl"],
    unknownPath: true,
  }]);
  monitor.stop();
});

test("stop discards a pending debounce and restart watches with a clean path set", async () => {
  const listeners = [];
  const observations = [];
  const monitor = new RolloutActivityMonitor({
    root: "/tmp/codex-sessions",
    existsImpl: () => true,
    watchImpl: (_root, _options, callback) => {
      listeners.push(callback);
      const watcher = new EventEmitter();
      watcher.close = () => watcher.emit("close");
      return watcher;
    },
    debounceMs: 10,
    fallbackMs: 60_000,
    onActivity: (event) => observations.push(event),
  }).start();

  listeners[0]("change", "before-stop.jsonl");
  monitor.stop();
  monitor.start();
  listeners[1]("change", "after-restart.jsonl");
  await wait(25);
  assert.deepEqual(observations.map((event) => event.paths), [["/tmp/codex-sessions/after-restart.jsonl"]]);
  monitor.stop();
});

test("fallback remains active when the filesystem watcher is unavailable", async () => {
  let observations = 0;
  const monitor = new RolloutActivityMonitor({
    root: "/tmp/missing-codex-sessions",
    existsImpl: () => false,
    fallbackMs: 10,
    onActivity: () => { observations += 1; },
  }).start();
  assert.equal(monitor.watching, false);
  await wait(25);
  assert.ok(observations >= 1);
  monitor.stop();
});
