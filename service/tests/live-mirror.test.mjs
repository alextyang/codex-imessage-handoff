import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveMirror } from "../src/live-mirror.mjs";

function fixture(name = "thread-a", options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-live-mirror-"));
  const rolloutPath = path.join(directory, `${name}.jsonl`);
  const stateFile = path.join(directory, "private", "live-mirror-state.json");
  writeFileSync(rolloutPath, options.initial ?? "", "utf8");
  return { directory, rolloutPath, stateFile, thread: { id: name, rolloutPath } };
}

function record(type, payload, timestamp = "2026-07-12T01:00:00.000Z") {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

function started(turnId) {
  return record("event_msg", { type: "task_started", turn_id: turnId });
}

function user(body) {
  return record("event_msg", { type: "user_message", message: body });
}

function response(role, body, phase = "commentary", extra = {}) {
  return record("response_item", {
    type: "message",
    role,
    phase,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text: body }],
    ...extra,
  });
}

function commentary(body) {
  return response("assistant", body, "commentary");
}

function append(file, ...values) {
  appendFileSync(file, values.join(""), "utf8");
}

test("new activation baselines history and mirrors only canonical user/commentary records", async () => {
  const item = fixture("thread-canonical", {
    initial: `${started("old-turn")}${user("Old request")}${commentary("Old progress")}`,
  });
  const mirror = new LiveMirror(item.stateFile);
  const activated = mirror.activate(item.thread);
  assert.equal(activated.baselined, true);
  assert.equal(activated.resumed, false);
  assert.equal(mirror.activeThreadId, item.thread.id);
  assert.equal(statSync(item.stateFile).mode & 0o777, 0o600);
  chmodSync(item.stateFile, 0o644);
  new LiveMirror(item.stateFile);
  assert.equal(statSync(item.stateFile).mode & 0o777, 0o600, "an existing cursor is repaired to private permissions");

  append(item.rolloutPath,
    started("turn-visible"),
    user("Local Codex request"),
    response("user", "Ambient UI context must not mirror"),
    record("event_msg", { type: "agent_message", message: "Duplicate commentary", phase: "commentary" }),
    record("response_item", { type: "reasoning", summary: ["Private reasoning"] }),
    response("assistant", "Finals use completion delivery", "final_answer"),
    response("system", "System message"),
    response("developer", "Developer message"),
    commentary("Canonical progress update"),
    record("event_msg", { type: "token_count", info: { total_token_usage: 12 } }));

  const delivered = [];
  const result = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event);
      return { sent: true };
    },
  });
  assert.equal(result.delivered, 2);
  assert.deepEqual(delivered.map(({ role, phase, body, turnId }) => ({ role, phase, body, turnId })), [
    { role: "user", phase: "user_message", body: "Local Codex request", turnId: "turn-visible" },
    { role: "assistant", phase: "commentary", body: "Canonical progress update", turnId: "turn-visible" },
  ]);
  assert.ok(delivered.every((event) => /^[a-f0-9]{64}$/.test(event.deliveryId)));
  assert.notEqual(delivered[0].deliveryId, delivered[1].deliveryId);
  const persisted = readFileSync(item.stateFile, "utf8");
  assert.doesNotMatch(persisted, /Local Codex request|Canonical progress update|Private reasoning/);

  await mirror.reconcile(item.thread, { deliver: async (event) => delivered.push(event) });
  assert.equal(delivered.length, 2, "terminal deliveries advance the durable cursor");
});

test("same persisted selection resumes while switches baseline accumulated history", async () => {
  const item = fixture("thread-resume");
  let mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  append(item.rolloutPath, started("turn-after-startup"), commentary("Written before restart"));

  mirror = new LiveMirror(item.stateFile);
  const resumed = mirror.activate(item.thread);
  assert.equal(resumed.resumed, true);
  const bodies = [];
  await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      bodies.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(bodies, ["Written before restart"]);

  const secondPath = path.join(item.directory, "thread-second.jsonl");
  const second = { id: "thread-second", rolloutPath: secondPath };
  writeFileSync(secondPath, `${started("historical-fork")}${commentary("Fork history")}`, "utf8");
  mirror.activate(second);
  assert.equal(mirror.activeThreadId, second.id);
  await mirror.reconcile(second, { deliver: async (event) => bodies.push(event.body) });
  assert.deepEqual(bodies, ["Written before restart"], "newly selected fork history is not replayed");

  append(item.rolloutPath, commentary("Accumulated while unselected"));
  mirror.activate(item.thread);
  await mirror.reconcile(item.thread, { deliver: async (event) => bodies.push(event.body) });
  assert.deepEqual(bodies, ["Written before restart"], "returning to a previously unselected task takes a fresh baseline");
});

test("a partial record present at activation is delivered only after its newline arrives", async () => {
  const item = fixture("thread-activation-tail", { initial: started("old-complete") });
  const partial = commentary("Finished after selection").trimEnd();
  append(item.rolloutPath, partial.slice(0, -1));
  const mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const delivered = [];
  await mirror.reconcile(item.thread, { deliver: async (event) => delivered.push(event.body) });
  assert.deepEqual(delivered, []);
  append(item.rolloutPath, `${partial.slice(-1)}\n`);
  await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event);
      return { sent: true };
    },
  });
  assert.equal(delivered[0].body, "Finished after selection");
  assert.equal(delivered[0].turnId, "old-complete", "mid-turn activation retains the baseline task boundary");
});

test("one-shot persisted user suppression prevents iMessage prompt echo only once", async () => {
  const item = fixture("thread-suppression");
  let mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  assert.equal(mirror.suppressUser("another-thread", "Prompt"), null);
  const token = mirror.suppressUser(item.thread.id, "  Prompt\r\n");
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(readFileSync(item.stateFile, "utf8"), /Prompt/);
  append(item.rolloutPath, started("turn-suppressed"), user("Prompt\n"), user("Prompt"));

  mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const delivered = [];
  const result = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.equal(result.suppressed, 1);
  assert.deepEqual(delivered, ["Prompt"]);
  assert.doesNotMatch(readFileSync(item.stateFile, "utf8"), /Prompt/);
});

test("clearing a suppression before its rollout match prevents a later genuine message from being swallowed", async () => {
  const item = fixture("thread-clear-suppression");
  const mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const token = mirror.suppressUser(item.thread.id, "A request that failed before Codex received it");
  assert.equal(mirror.clearSuppression(token), true);
  assert.equal(mirror.clearSuppression(token), false, "suppression tokens are one-shot capabilities");
  append(item.rolloutPath, started("turn-local"), user("A request that failed before Codex received it"));
  const delivered = [];
  const result = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.equal(result.suppressed, 0);
  assert.deepEqual(delivered, ["A request that failed before Codex received it"]);
});

test("legacy hash-only suppression state migrates safely and still consumes exactly once", async () => {
  const item = fixture("thread-legacy-suppression");
  let mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  mirror.suppressUser(item.thread.id, "Legacy prompt");
  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  const legacyHash = persisted.active.suppressions[0].bodyHash;
  persisted.active.suppressions = [legacyHash];
  writeFileSync(item.stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  append(item.rolloutPath, started("turn-legacy"), user("Legacy prompt"), user("Legacy prompt"));
  const delivered = [];
  const result = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.equal(result.suppressed, 1);
  assert.deepEqual(delivered, ["Legacy prompt"]);
  const migrated = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.deepEqual(migrated.active.suppressions, []);
});

test("retryable delivery holds the cursor and deterministic id, preserving strict order", async () => {
  const item = fixture("thread-retry");
  let mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  append(item.rolloutPath, started("turn-retry"), commentary("First"), commentary("Second"));

  const attempts = [];
  const first = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      attempts.push(event);
      throw new Error("temporary provider failure containing no message data");
    },
  });
  assert.equal(first.retryable, 1);
  assert.deepEqual(attempts.map((event) => event.body), ["First\n\nSecond"]);
  assert.doesNotMatch(readFileSync(item.stateFile, "utf8"), /First|Second/);

  append(item.rolloutPath, commentary("Third, appended after the failed attempt"));

  mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const held = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      attempts.push(event);
      return { status: "TEMPORARY", notification: { sent: false, status: "IN_PROGRESS" } };
    },
  });
  assert.equal(held.retryable, 1);
  assert.equal(attempts[0].deliveryId, attempts[1].deliveryId);

  const second = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      attempts.push(event);
      return attempts.length === 3 ? { status: "TEMPORARY", notification: { status: "DUPLICATE" } } : { notification: { sent: true } };
    },
  });
  assert.equal(attempts[0].deliveryId, attempts[2].deliveryId);
  assert.deepEqual(attempts.map((event) => event.body), [
    "First\n\nSecond",
    "First\n\nSecond",
    "First\n\nSecond",
    "Third, appended after the failed attempt",
  ]);
  assert.equal(second.discarded, 1, "a nested terminal status is not shadowed by a top-level transient status");
  assert.equal(second.delivered, 1);
});

test("consecutive commentary is bucketed across private records and stops at visible boundaries", async () => {
  const item = fixture("thread-buckets");
  const mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  append(item.rolloutPath,
    started("turn-one"),
    commentary("First reasoning bucket"),
    record("response_item", { type: "reasoning", summary: ["Private reasoning"] }),
    commentary("Second reasoning bucket"),
    response("assistant", "Completion owns this response", "final_answer"),
    commentary("After final"),
    user("A local user boundary"),
    commentary("After user"),
    record("event_msg", { type: "task_complete", turn_id: "turn-one" }),
    started("turn-two"),
    commentary("After turn boundary"));

  const delivered = [];
  const result = await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event);
      return { sent: true };
    },
  });

  assert.equal(result.delivered, 5);
  assert.deepEqual(delivered.map(({ role, body, turnId }) => ({ role, body, turnId })), [
    { role: "assistant", body: "First reasoning bucket\n\nSecond reasoning bucket", turnId: "turn-one" },
    { role: "assistant", body: "After final", turnId: "turn-one" },
    { role: "user", body: "A local user boundary", turnId: "turn-one" },
    { role: "assistant", body: "After user", turnId: "turn-one" },
    { role: "assistant", body: "After turn boundary", turnId: "turn-two" },
  ]);
  assert.equal(new Set(delivered.map((event) => event.deliveryId)).size, delivered.length);
  const persisted = readFileSync(item.stateFile, "utf8");
  assert.doesNotMatch(persisted, /reasoning bucket|Private reasoning|After final|After user/);
});

test("all specified terminal provider outcomes advance exactly once", async () => {
  const item = fixture("thread-terminal");
  const mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const terminal = [
    { sent: true },
    { notification: { sent: true } },
    { status: "SENT" },
    { status: "duplicate" },
    { notification: { status: "inactive" } },
    { code: "STALE_SELECTION" },
    { status: "NO_BINDING" },
  ];
  const messages = terminal.flatMap((_, index) => [
    commentary(`Message ${index}`),
    response("assistant", `Final boundary ${index}`, "final_answer"),
  ]);
  append(item.rolloutPath, started("turn-terminal"), ...messages);
  let calls = 0;
  const first = await mirror.reconcile(item.thread, { deliver: async () => terminal[calls++] });
  assert.equal(calls, terminal.length);
  assert.equal(first.delivered, 3);
  assert.equal(first.discarded, 4);
  await mirror.reconcile(item.thread, { deliver: async () => { calls += 1; } });
  assert.equal(calls, terminal.length);
});

test("complete-line cursor and active turn survive a partial tail and process restart", async () => {
  const item = fixture("thread-partial");
  let mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const incomplete = commentary("Complete after restart").trimEnd();
  append(item.rolloutPath, started("turn-partial"), incomplete.slice(0, -1));
  const before = await mirror.reconcile(item.thread, { deliver: async () => assert.fail("partial line was delivered") });
  assert.equal(before.partial, true);

  mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  append(item.rolloutPath, `${incomplete.slice(-1)}\n`);
  const delivered = [];
  await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      delivered.push(event);
      return { sent: true };
    },
  });
  assert.equal(delivered[0].body, "Complete after restart");
  assert.equal(delivered[0].turnId, "turn-partial");
});

test("inode rotation and same-thread path changes take a complete EOF baseline", async () => {
  const item = fixture("thread-rotation");
  const mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  const bodies = [];
  append(item.rolloutPath, started("before-rotation"), commentary("Before rotation"));
  await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      bodies.push(event.body);
      return { sent: true };
    },
  });

  renameSync(item.rolloutPath, `${item.rolloutPath}.old`);
  writeFileSync(item.rolloutPath, `${started("rotated-history")}${commentary("Rotated history")}`, "utf8");
  const rotated = await mirror.reconcile(item.thread, { deliver: async (event) => bodies.push(event.body) });
  assert.equal(rotated.baselined, 1);
  assert.deepEqual(bodies, ["Before rotation"]);
  append(item.rolloutPath, commentary("After rotation"));
  await mirror.reconcile(item.thread, {
    deliver: async (event) => {
      bodies.push(`${event.turnId}:${event.body}`);
      return { sent: true };
    },
  });

  const movedPath = path.join(item.directory, "moved.jsonl");
  writeFileSync(movedPath, `${started("moved-history")}${commentary("Moved history")}`, "utf8");
  const movedThread = { ...item.thread, rolloutPath: movedPath };
  const moved = await mirror.reconcile(movedThread, { deliver: async (event) => bodies.push(event.body) });
  assert.equal(moved.baselined, 1);
  append(movedPath, commentary("After path change"));
  await mirror.reconcile(movedThread, {
    deliver: async (event) => {
      bodies.push(`${event.turnId}:${event.body}`);
      return { sent: true };
    },
  });
  assert.deepEqual(bodies, [
    "Before rotation",
    "rotated-history:After rotation",
    "moved-history:After path change",
  ]);
});

test("bounded reads discard an oversized canonical record without losing following messages", async () => {
  const item = fixture("thread-bounded");
  const mirror = new LiveMirror({ stateFile: item.stateFile, maxReadBytes: 256 });
  mirror.activate(item.thread);
  append(item.rolloutPath, user("x".repeat(700)), started("turn-bounded"), commentary("Visible after oversized noise"));
  const delivered = [];
  let ignored = 0;
  for (let poll = 0; poll < 10 && delivered.length === 0; poll += 1) {
    const result = await mirror.reconcile(item.thread, {
      deliver: async (event) => {
        delivered.push(event);
        return { sent: true };
      },
    });
    ignored += result.ignored;
  }
  assert.equal(delivered[0].body, "Visible after oversized noise");
  assert.equal(delivered[0].turnId, "turn-bounded");
  assert.ok(ignored >= 2, "oversized record and task boundary were ignored safely");
});

test("an in-flight delivery cannot overwrite a newly activated selection", async () => {
  const first = fixture("thread-inflight");
  const secondPath = path.join(first.directory, "thread-new.jsonl");
  const second = { id: "thread-new", rolloutPath: secondPath };
  writeFileSync(secondPath, "", "utf8");
  const mirror = new LiveMirror(first.stateFile);
  mirror.activate(first.thread);
  append(first.rolloutPath, started("turn-inflight"), commentary("In flight"));
  let resolveDelivery;
  const waiting = new Promise((resolve) => { resolveDelivery = resolve; });
  const reconciliation = mirror.reconcile(first.thread, { deliver: async () => waiting });
  await new Promise((resolve) => setImmediate(resolve));
  mirror.activate(second);
  resolveDelivery({ sent: true });
  const result = await reconciliation;
  assert.equal(result.reason, "STALE_SELECTION");
  assert.equal(mirror.activeThreadId, second.id);
  const state = JSON.parse(readFileSync(first.stateFile, "utf8"));
  assert.equal(state.active.threadId, second.id);
});

test("deactivation clears the private selection and forces a fresh baseline after re-pairing", async () => {
  const item = fixture("thread-deactivate");
  const mirror = new LiveMirror(item.stateFile);
  mirror.activate(item.thread);
  append(item.rolloutPath, started("while-paired"), commentary("Written before unpairing"));
  assert.equal(mirror.deactivate(), true);
  assert.equal(mirror.deactivate(), false);
  assert.equal(mirror.activeThreadId, null);
  assert.equal(JSON.parse(readFileSync(item.stateFile, "utf8")).active, null);

  let calls = 0;
  const stale = await mirror.reconcile(item.thread, { deliver: async () => { calls += 1; } });
  assert.equal(stale.reason, "STALE_SELECTION");
  assert.equal(calls, 0);
  const activated = mirror.activate(item.thread);
  assert.equal(activated.resumed, false);
  await mirror.reconcile(item.thread, { deliver: async () => { calls += 1; } });
  assert.equal(calls, 0, "messages accumulated without a binding are baselined, not replayed");
});
