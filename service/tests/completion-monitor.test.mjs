import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompletionMonitor } from "../src/completion-monitor.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-completion-monitor-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const stateFile = path.join(directory, "private", "completion-state.json");
  writeFileSync(rolloutPath, "", "utf8");
  return { directory, rolloutPath, stateFile, thread: { id: "thread-a", rolloutPath } };
}

function complete(turnId, body, timestamp = "2026-07-12T01:00:00.000Z") {
  return `${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, completed_at: timestamp, last_agent_message: body },
  })}\n`;
}

function append(file, ...records) {
  appendFileSync(file, records.join(""), "utf8");
}

test("first use baselines existing history and newly discovered threads", async () => {
  const first = fixture();
  append(first.rolloutPath, complete("old-turn", "Historical final"));
  const monitor = new CompletionMonitor(first.stateFile);
  const bodies = [];
  const initial = await monitor.reconcile([first.thread], { deliver: async (event) => bodies.push(event.body) });
  assert.equal(initial.baselined, 1);
  assert.deepEqual(bodies, []);

  const secondRollout = path.join(first.directory, "second.jsonl");
  writeFileSync(secondRollout, complete("also-old", "Newly discovered historical final"), "utf8");
  await monitor.reconcile([first.thread, { id: "thread-b", rolloutPath: secondRollout }], {
    deliver: async (event) => bodies.push(event.body),
  });
  assert.deepEqual(bodies, []);
});

test("a task created after startup can complete before its first catalog discovery", async () => {
  const first = fixture();
  let now = Date.parse("2026-07-12T01:00:00.000Z");
  const monitor = new CompletionMonitor({ stateFile: first.stateFile, now: () => now });
  await monitor.reconcile([first.thread], { deliver: async () => ({ sent: true }) });

  now += 60_000;
  const rolloutPath = path.join(first.directory, "new-task.jsonl");
  writeFileSync(rolloutPath, complete("new-turn", "New task final", "2026-07-12T01:00:30.000Z"), "utf8");
  const delivered = [];
  await monitor.reconcile([{ id: "thread-new", rolloutPath, createdAt: "2026-07-12T01:00:15.000Z" }], {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(delivered, ["New task final"]);
});

test("new completion sends its exact final once and ignores blank or incomplete records", async () => {
  const item = fixture();
  const monitor = new CompletionMonitor(item.stateFile);
  const delivered = [];
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  append(item.rolloutPath,
    complete("blank", "  \n"),
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "missing-body" } })}\n`,
    complete("turn-1", "  Exact final.\n\nDo not trim me.  "));

  const result = await monitor.reconcile([item.thread], {
    deliver: async (event) => {
      delivered.push(event);
      return { sent: true };
    },
  });
  assert.equal(result.observed, 1);
  assert.equal(result.delivered, 1);
  assert.equal(delivered[0].body, "  Exact final.\n\nDo not trim me.  ");
  assert.equal(delivered[0].turnId, "turn-1");
  assert.match(delivered[0].completionId, /^[a-f0-9]{64}$/);
  await monitor.reconcile([item.thread], { deliver: async (event) => delivered.push(event) });
  assert.equal(delivered.length, 1);
});

test("multiple completions appended between polls are each delivered", async () => {
  const item = fixture();
  const monitor = new CompletionMonitor(item.stateFile);
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  append(item.rolloutPath,
    complete("turn-1", "First final", "2026-07-12T01:00:00.000Z"),
    complete("turn-2", "Second final", "2026-07-12T01:01:00.000Z"));
  const turns = [];
  await monitor.reconcile([item.thread], {
    deliver: async (event) => {
      turns.push(event.turnId);
      return { sent: true };
    },
  });
  assert.deepEqual(turns, ["turn-1", "turn-2"]);
});

test("provider failures remain durable and retry after restart", async () => {
  const item = fixture();
  let now = Date.parse("2026-07-12T01:00:00.000Z");
  let monitor = new CompletionMonitor({ stateFile: item.stateFile, now: () => now });
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  append(item.rolloutPath, complete("turn-retry", "Retry this exact final"));
  const first = await monitor.reconcile([item.thread], { deliver: async () => { throw new Error("provider unavailable"); } });
  assert.equal(first.retryable, 1);
  assert.equal(first.pending, 1);

  monitor = new CompletionMonitor({ stateFile: item.stateFile, now: () => now });
  const delivered = [];
  await monitor.reconcile([item.thread], {
    deliverPending: false,
    deliver: async (event) => delivered.push(event.body),
  });
  assert.deepEqual(delivered, [], "startup observation does not block service connection on pending delivery");
  now += 6_000;
  const retried = await monitor.reconcile([item.thread], {
    deliver: async (event) => {
      delivered.push(event.body);
      return { notification: { sent: true } };
    },
  });
  assert.deepEqual(delivered, ["Retry this exact final"]);
  assert.equal(retried.pending, 0);
  await monitor.reconcile([item.thread], { deliver: async (event) => delivered.push(event.body) });
  assert.equal(delivered.length, 1);
});

test("inactive terminal statuses discard rather than backlog completions", async () => {
  for (const status of ["INACTIVE", "NO_BINDING", "SUPPRESSED_INACTIVE"]) {
    const item = fixture();
    let monitor = new CompletionMonitor(item.stateFile);
    await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
    append(item.rolloutPath, complete(`turn-${status}`, `Final for ${status}`));
    const result = await monitor.reconcile([item.thread], { deliver: async () => ({ status }) });
    assert.equal(result.pending, 0);
    assert.equal(result.suppressed, 1);
    monitor = new CompletionMonitor(item.stateFile);
    let calls = 0;
    await monitor.reconcile([item.thread], { deliver: async () => { calls += 1; } });
    assert.equal(calls, 0);
  }
});

test("managed threads and persisted hash suppressions deduplicate direct iMessage runs", async () => {
  const item = fixture();
  let now = Date.parse("2026-07-12T01:00:00.000Z");
  let monitor = new CompletionMonitor({ stateFile: item.stateFile, now: () => now });
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  monitor.manage(item.thread.id, "2026-07-12T01:00:00.000Z");
  append(item.rolloutPath, complete("managed-turn", "Managed final", "2026-07-12T01:01:00.000Z"));
  let calls = 0;
  const managed = await monitor.reconcile([item.thread], { deliver: async () => { calls += 1; } });
  assert.equal(managed.suppressed, 1);
  assert.equal(calls, 0);
  assert.equal(monitor.suppressNext(item.thread.id, "Managed final", "2026-07-12T01:00:00.000Z"), false,
    "late suppressNext consumes the already observed managed completion instead of becoming stale");
  assert.equal(monitor.suppressNext(item.thread.id, "Managed final", "2026-07-12T01:00:00.000Z"), false,
    "a direct-delivery retry does not add a stale second suppression");
  monitor.unmanage(item.thread.id);

  monitor.suppressNext(item.thread.id, "Persisted direct final", "2026-07-12T01:02:00.000Z");
  monitor = new CompletionMonitor({ stateFile: item.stateFile, now: () => now });
  append(item.rolloutPath, complete("suppressed-turn", " \nPersisted direct final\n ", "2026-07-12T01:03:00.000Z"));
  const suppressed = await monitor.reconcile([item.thread], { deliver: async () => { calls += 1; } });
  assert.equal(suppressed.suppressed, 1);
  assert.equal(calls, 0);

  append(item.rolloutPath, complete("later-turn", "Persisted direct final", "2026-07-12T01:04:00.000Z"));
  await monitor.reconcile([item.thread], {
    deliver: async () => {
      calls += 1;
      return { sent: true };
    },
  });
  assert.equal(calls, 1, "suppression is one-shot");
});

test("state is private and offsets survive restart, including a partial final line", async () => {
  const item = fixture();
  let monitor = new CompletionMonitor(item.stateFile);
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  assert.equal(statSync(item.stateFile).mode & 0o777, 0o600);

  const record = complete("partial-turn", "Completed after restart").trimEnd();
  append(item.rolloutPath, record.slice(0, -1));
  await monitor.reconcile([item.thread], { deliver: async () => { throw new Error("must not deliver partial JSON"); } });
  const before = JSON.parse(readFileSync(item.stateFile, "utf8"));
  const offsetBefore = before.threads[item.thread.id].offset;

  monitor = new CompletionMonitor(item.stateFile);
  append(item.rolloutPath, `${record.slice(-1)}\n`);
  const delivered = [];
  await monitor.reconcile([item.thread], {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(delivered, ["Completed after restart"]);
  const after = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.ok(after.threads[item.thread.id].offset > offsetBefore);
  assert.equal(statSync(item.stateFile).mode & 0o777, 0o600);
});

test("first startup baselines only complete lines and later observes a finishing tail", async () => {
  const item = fixture();
  const record = complete("startup-partial", "Do not lose this completion").trimEnd();
  append(item.rolloutPath, record.slice(0, -1));
  const monitor = new CompletionMonitor(item.stateFile);
  const delivered = [];
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  append(item.rolloutPath, `${record.slice(-1)}\n`);
  await monitor.reconcile([item.thread], {
    deliver: async (event) => {
      delivered.push(event.body);
      return { sent: true };
    },
  });
  assert.deepEqual(delivered, ["Do not lose this completion"]);
});

test("no-op scans do not rewrite state and corrupt optional state is quarantined", async () => {
  const item = fixture();
  let monitor = new CompletionMonitor(item.stateFile);
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  const old = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(item.stateFile, old, old);
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  assert.equal(statSync(item.stateFile).mtime.toISOString(), old.toISOString());

  writeFileSync(item.stateFile, "not valid json", { mode: 0o600 });
  monitor = new CompletionMonitor(item.stateFile);
  await monitor.reconcile([item.thread], { deliver: async () => ({ sent: true }) });
  assert.ok(readdirSync(path.dirname(item.stateFile)).some((name) => name.startsWith("completion-state.json.invalid-")));
  assert.equal(statSync(item.stateFile).mode & 0o777, 0o600);
});
