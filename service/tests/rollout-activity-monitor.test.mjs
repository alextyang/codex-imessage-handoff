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
  assert.deepEqual(observations, [{ source: "filesystem", watching: true }]);
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
