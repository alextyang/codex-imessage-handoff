import assert from "node:assert/strict";
import test from "node:test";
import { authorizeRemoteControlAndActivate } from "../src/remote-control-setup.mjs";

function fixture({ changed = true, paired = false, authorizeError = null, statusError = null } = {}) {
  const events = [];
  const installs = [];
  const rotations = [];
  const controller = {
    async authorize() {
      events.push("authorize");
      if (authorizeError) throw authorizeError;
      return { authorized: true, changed, clientId: "client-id" };
    },
    async status(options) {
      events.push(["status", options]);
      if (statusError) throw statusError;
      return { enrolled: true, paired };
    },
  };
  return {
    events,
    installs,
    rotations,
    options: {
      controller,
      async rotateServiceProcess() {
        events.push("rotate");
        rotations.push(true);
        return { rotated: true, previousPid: 40, pid: 41 };
      },
      hasVerifiedHelperConfig() {
        events.push("config");
        return true;
      },
      installService(options) {
        events.push(["install", options]);
        installs.push(options);
        return { installed: true, changed: true };
      },
    },
  };
}

test("changed unpaired authorization replaces the old client before network status", async () => {
  const run = fixture({ changed: true, paired: false });
  const result = await authorizeRemoteControlAndActivate(run.options);
  assert.equal(result.paired, false);
  assert.deepEqual(run.installs, [{ forceRestart: true }]);
  assert.deepEqual(run.events, [
    "authorize",
    "rotate",
    "config",
    ["install", { forceRestart: true }],
    ["status", { network: true }],
  ]);
});

test("changed authorization replaces the old client even when network status fails", async () => {
  const failure = new Error("network unavailable");
  const run = fixture({ changed: true, statusError: failure });
  await assert.rejects(authorizeRemoteControlAndActivate(run.options), failure);
  assert.deepEqual(run.installs, [{ forceRestart: true }]);
  assert.deepEqual(run.events.slice(0, 3), [
    "authorize",
    "rotate",
    "config",
  ]);
  assert.deepEqual(run.events[3], ["install", { forceRestart: true }]);
});

test("unchanged authorization status failure leaves the service untouched", async () => {
  const failure = new Error("network unavailable");
  const run = fixture({ changed: false, statusError: failure });
  await assert.rejects(authorizeRemoteControlAndActivate(run.options), failure);
  assert.deepEqual(run.installs, []);
});

test("authorization failure leaves the service untouched", async () => {
  const failure = new Error("authorization cancelled");
  const run = fixture({ authorizeError: failure });
  await assert.rejects(authorizeRemoteControlAndActivate(run.options), failure);
  assert.deepEqual(run.installs, []);
  assert.deepEqual(run.events, ["authorize"]);
});

test("unchanged paired authorization transactionally activates after status", async () => {
  const run = fixture({ changed: false, paired: true });
  const result = await authorizeRemoteControlAndActivate(run.options);
  assert.equal(result.paired, true);
  assert.deepEqual(run.installs, [{ forceRestart: true }]);
  assert.deepEqual(run.events, [
    "authorize",
    "config",
    ["status", { network: true }],
    ["install", { forceRestart: true }],
  ]);
});

test("a config verification failure happens only after changed authority is rotated", async () => {
  const failure = new Error("config invalid");
  const run = fixture({ changed: true });
  run.options.hasVerifiedHelperConfig = () => {
    run.events.push("config");
    throw failure;
  };
  await assert.rejects(authorizeRemoteControlAndActivate(run.options), failure);
  assert.deepEqual(run.rotations, [true]);
  assert.deepEqual(run.installs, []);
  assert.deepEqual(run.events, ["authorize", "rotate", "config"]);
});

test("a missing config still rotates changed authority before reporting pairing", async () => {
  const run = fixture({ changed: true, paired: false });
  run.options.hasVerifiedHelperConfig = () => {
    run.events.push("config");
    return false;
  };
  const result = await authorizeRemoteControlAndActivate(run.options);
  assert.equal(result.configured, false);
  assert.deepEqual(run.rotations, [true]);
  assert.deepEqual(run.installs, []);
  assert.deepEqual(run.events, ["authorize", "rotate", "config", ["status", { network: true }]]);
});

test("a deployment preflight failure occurs only after changed authority is rotated", async () => {
  const failure = new Error("preflight failed");
  const run = fixture({ changed: true, paired: false });
  run.options.installService = (options) => {
    run.events.push(["install", options]);
    throw failure;
  };
  await assert.rejects(authorizeRemoteControlAndActivate(run.options), failure);
  assert.deepEqual(run.rotations, [true]);
  assert.deepEqual(run.events, [
    "authorize",
    "rotate",
    "config",
    ["install", { forceRestart: true }],
  ]);
});
