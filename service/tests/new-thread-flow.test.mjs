import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NewThreadFlowStore, newThreadFlowInternals } from "../src/new-thread-flow.mjs";

function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-new-thread-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  let now = Date.parse("2026-07-13T12:00:00.000Z");
  const store = new NewThreadFlowStore({ now: () => now });
  return {
    home,
    store,
    advance: (milliseconds) => { now += milliseconds; },
    restore: () => {
      if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
      else process.env.IMESSAGE_HANDOFF_HOME = previous;
    },
  };
}

test("new-task setup is private, durable, idempotent, and restart-safe", () => {
  const value = fixture();
  try {
    const action = { messageKey: "inbound-new-guid", guid: "inbound-new-guid", argument: "Build the release." };
    const flow = value.store.begin(action);
    assert.equal(flow.stage, "project");
    assert.equal(flow.prompt, "Build the release.");
    assert.match(flow.threadSource, /^imessage-handoff:new:[a-f0-9]{32}$/);
    assert.deepEqual(value.store.begin(action), flow, "replaying /new must reuse its flow");

    const selected = value.store.update(flow.id, {
      stage: "reasoning",
      projectKey: "project-a",
      projectLabel: "Messaging",
      cwd: "/tmp",
      reasoning: "high",
      threadSource: `${flow.threadSource}:project`,
    });
    assert.equal(selected.reasoning, "high");
    const resumed = new NewThreadFlowStore({ now: () => Date.parse("2026-07-13T12:00:01.000Z") });
    assert.equal(resumed.get(flow.id).cwd, "/tmp");

    const file = path.join(value.home, "new-thread-state.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /phone|recipient|sender/i);
    assert.equal(resumed.remove(flow.id), true);
    assert.equal(resumed.get(flow.id), null);
  } finally {
    value.restore();
  }
});

test("new-task attachments survive idempotent begin, updates, and restart without retaining caller references", () => {
  const value = fixture();
  try {
    const attachments = Array.from({ length: 6 }, (_, index) => ({
      path: `/tmp/attachment-${index}.png`,
      metadata: { index },
    }));
    const flow = value.store.begin({
      messageKey: "new-with-attachments",
      guid: "new-with-attachments",
      argument: "Inspect these files.",
      attachments,
    });

    assert.deepEqual(flow.attachments, attachments.slice(0, 5));
    attachments[0].metadata.index = 99;
    attachments[1].path = "/tmp/mutated.png";
    assert.equal(flow.attachments[0].metadata.index, 0);
    assert.equal(flow.attachments[1].path, "/tmp/attachment-1.png");

    const replayed = value.store.begin({
      messageKey: "new-with-attachments",
      attachments: [{ path: "/tmp/replay-must-not-replace.png" }],
    });
    assert.deepEqual(replayed.attachments, flow.attachments);

    value.store.update(flow.id, { stage: "reasoning", reasoning: "high" });
    const resumed = new NewThreadFlowStore({ now: () => Date.parse("2026-07-13T12:00:01.000Z") });
    assert.deepEqual(resumed.get(flow.id).attachments, flow.attachments);
  } finally {
    value.restore();
  }
});

test("expired flows are ignored and malformed state is never overwritten", () => {
  const value = fixture();
  try {
    const flow = value.store.begin({ messageKey: "expires" });
    value.advance(newThreadFlowInternals.flowTtlMs + 1);
    assert.equal(value.store.get(flow.id), null);

    const file = path.join(value.home, "new-thread-state.json");
    writeFileSync(file, "{broken", { mode: 0o600 });
    assert.throws(() => value.store.begin({ messageKey: "new" }), (error) => error.code === "INVALID_NEW_THREAD_STATE");
    assert.equal(readFileSync(file, "utf8"), "{broken");
  } finally {
    value.restore();
  }
});
