import assert from "node:assert/strict";
import test from "node:test";
import {
  isImmediateLocalAction,
  isTerminalLocalActionFailure,
  LocalActionDispatch,
} from "../src/local-action-dispatch.mjs";

test("ambiguous sends remain retryable while structural delivery failures fail closed", () => {
  assert.equal(isTerminalLocalActionFailure("AMBIGUOUS"), false);
  assert.equal(isTerminalLocalActionFailure("IMSG_IPC_DISCONNECTED"), false);
  for (const code of ["NO_POLL", "POLL_GUID_MISSING", "POLL_OPTIONS_MISSING", "ROOT_GUID_MISSING", "UNSUPPORTED"]) {
    assert.equal(isTerminalLocalActionFailure(code), true, code);
  }
});

test("coalesces live and recovery copies while preserving ordered actions and later retries", async () => {
  const started = [];
  const releases = new Map();
  const dispatch = new LocalActionDispatch(async (action) => {
    started.push(action.messageKey);
    await new Promise((resolve) => { releases.set(action.messageKey, resolve); });
  });

  const first = dispatch.enqueue({ messageKey: "first" });
  const recoveryCopy = dispatch.enqueue({ messageKey: "first" });
  const second = dispatch.enqueue({ messageKey: "second" });
  assert.equal(recoveryCopy, first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);

  releases.get("first")();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  releases.get("second")();
  await second;

  const retry = dispatch.enqueue({ messageKey: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second", "first"]);
  releases.get("first")();
  await retry;
});

test("an emphasis stop action is immediate", () => {
  assert.equal(isImmediateLocalAction({ kind: "reaction-control", command: "stop" }), true);
  assert.equal(isImmediateLocalAction({ kind: "controller-response" }), true);
  assert.equal(isImmediateLocalAction({ kind: "controller-cancel" }), true);
  assert.equal(isImmediateLocalAction({ kind: "reaction-control", command: "inspect" }), false);
  assert.equal(isImmediateLocalAction({ kind: "control", command: "cancel" }), false);
});

test("an immediate stop bypasses an unrelated blocked action but remains deduplicated", async () => {
  const started = [];
  let releaseBlocked;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const dispatch = new LocalActionDispatch(async (action) => {
    started.push(action.messageKey);
    if (action.messageKey === "blocked") await blocked;
  });

  const first = dispatch.enqueue({ messageKey: "blocked" });
  await new Promise((resolve) => setImmediate(resolve));
  const stop = dispatch.enqueue({ messageKey: "stop" }, { immediate: true });
  const duplicateStop = dispatch.enqueue({ messageKey: "stop" }, { immediate: true });
  assert.equal(duplicateStop, stop);
  await stop;
  assert.deepEqual(started, ["blocked", "stop"]);
  releaseBlocked();
  await first;
});

test("a failed prompt admission releases the ordinary queue for later actions", async () => {
  const started = [];
  const dispatch = new LocalActionDispatch(async (action) => {
    started.push(action.messageKey);
    if (action.messageKey === "store-failure") {
      throw Object.assign(new Error("disk unavailable"), { code: "CLAIMED_STORE_UNAVAILABLE" });
    }
  });

  const failed = dispatch.enqueue({ messageKey: "store-failure" });
  const later = dispatch.enqueue({ messageKey: "later-unmute" });
  await assert.rejects(failed, /disk unavailable/);
  await later;
  assert.deepEqual(started, ["store-failure", "later-unmute"]);
});

test("named controller backpressure preserves its FIFO without blocking task actions", async () => {
  const started = [];
  let releaseController;
  const controllerGate = new Promise((resolve) => { releaseController = resolve; });
  const dispatch = new LocalActionDispatch(async (action) => {
    started.push(action.messageKey);
    if (action.messageKey === "controller-full") await controllerGate;
  });

  const controllerFull = dispatch.enqueue(
    { kind: "controller-prompt", messageKey: "controller-full" },
    { lane: "controller" },
  );
  const controllerNext = dispatch.enqueue(
    { kind: "controller-prompt", messageKey: "controller-next" },
    { lane: "controller" },
  );
  const taskAction = dispatch.enqueue(
    { kind: "prompt", messageKey: "task-reply" },
    { lane: "default" },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ["controller-full", "task-reply"]);
  await taskAction;
  assert.equal(started.includes("controller-next"), false,
    "the second controller action must stay behind controller capacity");

  releaseController();
  await controllerFull;
  await controllerNext;
  assert.deepEqual(started, ["controller-full", "task-reply", "controller-next"]);
});

test("a failed named lane releases only that lane and does not poison either queue", async () => {
  const started = [];
  const dispatch = new LocalActionDispatch(async (action) => {
    started.push(action.messageKey);
    if (action.messageKey === "controller-failure") throw new Error("controller store failed");
  });

  const failure = dispatch.enqueue(
    { kind: "controller-prompt", messageKey: "controller-failure" },
    { lane: "controller" },
  );
  const controllerRetry = dispatch.enqueue(
    { kind: "controller-prompt", messageKey: "controller-retry" },
    { lane: "controller" },
  );
  const task = dispatch.enqueue(
    { kind: "prompt", messageKey: "task-independent" },
    { lane: "default" },
  );

  await assert.rejects(failure, /controller store failed/);
  await Promise.all([controllerRetry, task]);
  assert.equal(started[0], "controller-failure");
  assert.ok(started.includes("task-independent"));
  assert.ok(started.indexOf("controller-retry") > started.indexOf("controller-failure"));
});
