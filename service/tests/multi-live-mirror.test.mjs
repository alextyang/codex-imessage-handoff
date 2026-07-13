import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { MultiLiveMirror } from "../src/multi-live-mirror.mjs";

function record(type, payload, timestamp = "2026-07-12T01:00:00.000Z") {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

function started(turnId) {
  return record("event_msg", { type: "task_started", turn_id: turnId });
}

function user(body) {
  return record("event_msg", { type: "user_message", message: body });
}

function commentary(body) {
  return record("response_item", {
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: body }],
  });
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "multi-live-mirror-"));
  const stateDirectory = path.join(directory, "private", "live-mirrors");
  const thread = (id, initial = "") => {
    const rolloutPath = path.join(directory, `${id}.jsonl`);
    writeFileSync(rolloutPath, initial, "utf8");
    return { id, rolloutPath };
  };
  return { directory, stateDirectory, thread };
}

function append(thread, ...records) {
  appendFileSync(thread.rolloutPath, records.join(""), "utf8");
}

test("activates a deduplicated catalog and persists one private cursor per task", async () => {
  const item = fixture();
  const first = item.thread("thread-a", `${started("old-a")}${commentary("Historical A")}`);
  const second = item.thread("thread-b", `${started("old-b")}${commentary("Historical B")}`);
  let mirrors = new MultiLiveMirror(item.stateDirectory);

  const activations = mirrors.activateCatalog([second, first, first]);
  assert.deepEqual(activations.map((entry) => entry.threadId), ["thread-a", "thread-b"]);
  assert.ok(activations.every((entry) => entry.baselined));
  assert.deepEqual(mirrors.activeThreadIds, ["thread-a", "thread-b"]);
  assert.equal(statSync(item.stateDirectory).mode & 0o777, 0o700);

  append(first, started("visible-a"), user("Request A"), commentary("Progress A"));
  append(second, started("visible-b"), commentary("Progress B"));
  const delivered = [];
  const result = await mirrors.reconcileAll([second, first, first], {
    deliver: async (event, thread) => {
      delivered.push([thread.id, event.role, event.body]);
      return { sent: true };
    },
  });

  assert.deepEqual(delivered, [
    ["thread-a", "user", "Request A"],
    ["thread-a", "assistant", "Progress A"],
    ["thread-b", "assistant", "Progress B"],
  ]);
  assert.equal(result.delivered, 3);
  assert.deepEqual(result.threads.map((entry) => entry.threadId), ["thread-a", "thread-b"]);
  const stateFiles = readdirSync(item.stateDirectory);
  assert.equal(stateFiles.length, 2);
  assert.ok(stateFiles.every((name) => /^thread-[a-f0-9]{64}\.json$/.test(name)));
  assert.ok(stateFiles.every((name) => !name.includes("thread-a") && !name.includes("thread-b")));
  assert.ok(stateFiles.every((name) => (statSync(path.join(item.stateDirectory, name)).mode & 0o777) === 0o600));
  assert.doesNotMatch(stateFiles.map((name) => readFileSync(path.join(item.stateDirectory, name), "utf8")).join("\n"), /Request A|Progress A|Progress B/);

  append(first, commentary("After restart"));
  mirrors = new MultiLiveMirror(item.stateDirectory);
  const resumed = mirrors.activateCatalog([first, second]);
  assert.ok(resumed.every((entry) => entry.resumed));
  const afterRestart = [];
  await mirrors.reconcileAll([first, second], {
    deliver: async (event) => {
      afterRestart.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(afterRestart, ["After restart"]);
});

test("suppression capabilities encode their task and can be cleared after restart", async () => {
  const item = fixture();
  const first = item.thread("thread-sensitive");
  let mirrors = new MultiLiveMirror(item.stateDirectory);
  mirrors.activateCatalog([first]);

  const clearedToken = mirrors.suppressUser(first.id, "Prompt that never reached Codex");
  assert.match(clearedToken, /^mlm1\.[a-f0-9]{64}\.[a-f0-9]{32}$/);
  assert.doesNotMatch(clearedToken, /thread-sensitive/);

  mirrors = new MultiLiveMirror(item.stateDirectory);
  assert.equal(mirrors.clearSuppression(clearedToken), true);
  assert.equal(mirrors.clearSuppression(clearedToken), false);
  assert.equal(mirrors.clearSuppression("invalid"), false);
  append(first, started("turn-clear"), user("Prompt that never reached Codex"));
  const clearedDelivery = [];
  await mirrors.drain(first, {
    deliver: async (event) => {
      clearedDelivery.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(clearedDelivery, ["Prompt that never reached Codex"]);

  const consumedToken = mirrors.suppressUser(first.id, "Remote prompt");
  assert.match(consumedToken, /^mlm1\./);
  append(first, user("Remote prompt"), user("Remote prompt"));
  mirrors = new MultiLiveMirror(item.stateDirectory);
  mirrors.activateCatalog([first]);
  const delivered = [];
  const drained = await mirrors.drain(first, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.equal(drained.suppressed, 1);
  assert.deepEqual(delivered, ["Remote prompt"]);
});

test("drains and clears tasks independently without replaying activity accumulated while cleared", async () => {
  const item = fixture();
  const first = item.thread("thread-drain-a");
  const second = item.thread("thread-drain-b");
  const mirrors = new MultiLiveMirror(item.stateDirectory);
  mirrors.activateCatalog([first, second]);
  append(first, started("turn-a"), commentary("Only A"));
  append(second, started("turn-b"), commentary("Only B"));

  const delivered = [];
  const drained = await mirrors.drain(first, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.equal(drained.pending, false);
  assert.deepEqual(delivered, ["Only A"]);

  await mirrors.reconcile(second, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(delivered, ["Only A", "Only B"]);

  assert.equal(mirrors.clearThread(first.id), true);
  assert.equal(mirrors.clearThread(first.id), false);
  append(first, commentary("Written while cleared"));
  const activation = mirrors.activate(first);
  assert.equal(activation.resumed, false);
  await mirrors.drain(first, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(delivered, ["Only A", "Only B"]);
});

test("serializes individual and catalog reconciliation through one scheduler", async () => {
  const item = fixture();
  const first = item.thread("thread-serial-a");
  const second = item.thread("thread-serial-b");
  const mirrors = new MultiLiveMirror(item.stateDirectory);
  mirrors.activateCatalog([first, second]);
  append(first, started("turn-a"), commentary("First delivery"));
  append(second, started("turn-b"), commentary("Second delivery"));

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  const firstRun = mirrors.reconcile(first, {
    deliver: async (event) => {
      order.push(event.body);
      await gate;
      return { sent: true };
    },
  });
  const secondRun = mirrors.reconcileAll([second], {
    deliver: async (event) => {
      order.push(event.body);
      return { sent: true };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["First delivery"]);
  release();
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(order, ["First delivery", "Second delivery"]);
});
