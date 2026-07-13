import assert from "node:assert/strict";
import test from "node:test";
import {
  isManualSelectionLeaseCurrent,
  manualSelectionCancellationNotice,
  manualSelectionLease,
  presentManualSelection,
} from "../src/manual-selection-flow.mjs";

const leaseA = Object.freeze({
  threadId: "thread-a",
  selectedAt: "2026-07-13T12:00:00.000Z",
  expiresAt: "2026-07-13T12:02:00.000Z",
});

test("a manual-selection action captures only its exact persisted lease", () => {
  assert.deepEqual(
    manualSelectionLease({ threadId: "thread-a", createdAt: leaseA.selectedAt }, leaseA),
    leaseA,
  );
  assert.equal(
    manualSelectionLease({ threadId: "thread-a", createdAt: "2026-07-13T12:00:01.000Z" }, leaseA),
    null,
    "an older queued action must not borrow a newer lease for the same task",
  );
  assert.equal(
    manualSelectionLease({ threadId: "thread-b", createdAt: leaseA.selectedAt }, leaseA),
    null,
  );
  assert.equal(manualSelectionLease({ threadId: "thread-a" }, leaseA), null);
});

test("manual-selection lease comparison includes its generation timestamps", () => {
  assert.equal(isManualSelectionLeaseCurrent(leaseA, { ...leaseA }), true);
  assert.equal(isManualSelectionLeaseCurrent(leaseA, null), false);
  assert.equal(isManualSelectionLeaseCurrent(leaseA, { ...leaseA, threadId: "thread-b" }), false);
  assert.equal(isManualSelectionLeaseCurrent(leaseA, {
    ...leaseA,
    selectedAt: "2026-07-13T12:00:01.000Z",
  }), false);
  assert.equal(isManualSelectionLeaseCurrent(leaseA, {
    ...leaseA,
    expiresAt: "2026-07-13T12:02:01.000Z",
  }), false);
});

test("cancelling only a pending manual selection confirms the selection instead of claiming no work existed", () => {
  assert.deepEqual(manualSelectionCancellationNotice({ selectionCleared: true }), {
    code: "cancelled",
    body: "Task selection cancelled.",
  });
  assert.deepEqual(manualSelectionCancellationNotice(), {
    code: "needs-attention",
    body: "There is no iMessage-started work to cancel.",
  });
});

test("cancellation notices preserve active and queued run behavior", () => {
  assert.equal(manualSelectionCancellationNotice({ selectionCleared: true, active: true }), null);
  assert.deepEqual(manualSelectionCancellationNotice({
    selectionCleared: true,
    pending: 2,
    claiming: 1,
  }), {
    code: "cancelled",
    body: "Removed 3 pending messages.",
  });
});

function selectionHarness(cancelAt = null, replacement = null) {
  let current = { ...leaseA };
  const events = [];
  const transition = (stage) => {
    if (cancelAt !== stage) return;
    current = replacement ? { ...replacement } : null;
  };
  return {
    events,
    run: () => presentManualSelection({
      lease: leaseA,
      currentLease: () => current,
      buildDetail: async () => {
        events.push("build-detail");
        transition("build-detail");
        return { thread: { id: "thread-a" }, reasoningEffort: "high" };
      },
      sendHeader: async () => {
        events.push("header");
        transition("header");
      },
      buildTurn: async () => {
        events.push("build-turn");
        transition("build-turn");
        return { id: "turn-a" };
      },
      sendTurn: async () => {
        events.push("turn");
        transition("turn");
      },
      sendPrompt: async () => {
        events.push("prompt");
      },
    }),
  };
}

test("an unchanged manual-selection lease presents header, last turn, then prompt", async () => {
  const harness = selectionHarness();
  assert.deepEqual(await harness.run(), { status: "sent", stage: "complete" });
  assert.deepEqual(harness.events, ["build-detail", "header", "build-turn", "turn", "prompt"]);
});

test("cancellation while building detail prevents every selection message", async () => {
  const harness = selectionHarness("build-detail");
  assert.deepEqual(await harness.run(), { status: "stale", stage: "before-header" });
  assert.deepEqual(harness.events, ["build-detail"]);
});

test("cancellation while sending the header prevents the stale turn and prompt", async () => {
  const harness = selectionHarness("header");
  assert.deepEqual(await harness.run(), { status: "stale", stage: "before-turn-build" });
  assert.deepEqual(harness.events, ["build-detail", "header"]);
});

test("cancellation while building the last turn prevents the stale turn and prompt", async () => {
  const harness = selectionHarness("build-turn");
  assert.deepEqual(await harness.run(), { status: "stale", stage: "before-turn" });
  assert.deepEqual(harness.events, ["build-detail", "header", "build-turn"]);
});

test("cancellation while sending the turn prevents the stale send-message prompt", async () => {
  const harness = selectionHarness("turn");
  assert.deepEqual(await harness.run(), { status: "stale", stage: "before-prompt" });
  assert.deepEqual(harness.events, ["build-detail", "header", "build-turn", "turn"]);
});

test("a newer selection for the same task invalidates the older presentation", async () => {
  const replacement = {
    threadId: "thread-a",
    selectedAt: "2026-07-13T12:00:30.000Z",
    expiresAt: "2026-07-13T12:02:30.000Z",
  };
  const harness = selectionHarness("header", replacement);
  assert.deepEqual(await harness.run(), { status: "stale", stage: "before-turn-build" });
  assert.deepEqual(harness.events, ["build-detail", "header"]);
});
