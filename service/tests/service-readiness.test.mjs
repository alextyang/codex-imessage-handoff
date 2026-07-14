import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectServiceLaunchdReadiness, ServiceReadiness } from "../src/service-readiness.mjs";

function launchd(pid, state = "running") {
  return `service = com.codex.imessage-handoff\nstate = ${state}\npid = ${pid}\n`;
}

function harness(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-readiness-"));
  const file = path.join(directory, "ready.json");
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  let heartbeat = null;
  let healthy = options.healthy !== false;
  const lease = new ServiceReadiness(file, {
    pid: 4242,
    ownerId: "owner-a",
    now: () => now,
    setIntervalImpl(callback) {
      heartbeat = callback;
      return { unref() {} };
    },
    clearIntervalImpl() {
      heartbeat = null;
    },
    ...(options.healthCheck ? { healthCheck: () => ({ healthy, activeWatch: healthy }) } : {}),
  });
  return {
    file,
    lease,
    tick(ms) { now += ms; },
    now() { return now; },
    heartbeat() { return heartbeat?.(); },
    setHealthy(value) { healthy = value === true; },
  };
}

test("service becomes healthy only after initialization publishes a fresh PID-matched heartbeat", () => {
  const state = harness();
  state.lease.markStarting();
  let status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.jobRunning, true);
  assert.equal(status.running, false);
  assert.equal(status.readiness.status, "starting");

  state.lease.markReady();
  status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.running, true);
  assert.equal(status.readiness.ready, true);

  state.tick(5_000);
  state.heartbeat();
  assert.equal(JSON.parse(readFileSync(state.file, "utf8")).heartbeatAt, "2026-07-12T12:00:05.000Z");
});

test("launchd crash loops cannot reuse a stale or different-PID ready state", () => {
  const state = harness();
  state.lease.markStarting();
  state.lease.markReady();

  assert.equal(inspectServiceLaunchdReadiness(launchd(9001), state.file, { now: state.now() }).running, false);
  assert.equal(inspectServiceLaunchdReadiness(launchd(4242, "spawn scheduled"), state.file, { now: state.now() }).running, false);

  state.tick(20_000);
  const stale = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(stale.running, false);
  assert.equal(stale.readiness.fresh, false);
});

test("legacy readiness without an active-watch health proof fails closed", () => {
  const state = harness();
  state.lease.markStarting();
  state.lease.markReady();
  const value = JSON.parse(readFileSync(state.file, "utf8"));
  delete value.health;
  writeFileSync(state.file, `${JSON.stringify(value)}\n`);

  const status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.jobRunning, true);
  assert.equal(status.running, false);
  assert.equal(status.readiness.healthHealthy, false);
});

test("an exiting old daemon cannot overwrite or remove a newer daemon's readiness", () => {
  const state = harness();
  state.lease.markStarting();
  state.lease.markReady();

  const newer = new ServiceReadiness(state.file, {
    pid: 4343,
    ownerId: "owner-b",
    now: state.now,
    setIntervalImpl: () => ({ unref() {} }),
  });
  newer.markStarting();
  newer.markReady();

  assert.equal(state.heartbeat(), false);
  state.lease.markStopped();
  const status = inspectServiceLaunchdReadiness(launchd(4343), state.file, { now: state.now() });
  assert.equal(status.running, true);
  assert.equal(status.readiness.pid, 4343);

  newer.markStopped();
  assert.equal(inspectServiceLaunchdReadiness(launchd(4343), state.file, { now: state.now() }).running, false);
});

test("readiness degrades while the authenticated watch is down and recovers with it", () => {
  const state = harness({ healthCheck: true });
  state.lease.markStarting();
  state.lease.markReady();
  assert.equal(inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() }).running, true);

  state.setHealthy(false);
  state.tick(5_000);
  assert.equal(state.heartbeat(), false);
  let status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.running, false);
  assert.equal(status.readiness.status, "degraded");
  assert.equal(status.readiness.health.activeWatch, false);

  state.setHealthy(true);
  state.tick(5_000);
  assert.equal(state.heartbeat(), true);
  status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.running, true);
  assert.equal(status.readiness.status, "ready");
  assert.equal(status.readiness.health.activeWatch, true);
});

test("Remote Control degradation is exposed separately and never blocks local Messages readiness", () => {
  const state = harness({ healthCheck: true });
  let remoteControl = {
    status: "degraded",
    available: false,
    hostStatus: "offline",
    code: "CODEX_HOST_OFFLINE",
  };
  state.lease.markStarting();
  state.lease.setCapabilityCheck(() => ({ remoteControl }));
  state.lease.markReady();

  let status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.running, true, "an offline Codex host must not stop the Messages receiver");
  assert.equal(status.readiness.status, "ready");
  assert.equal(status.readiness.healthHealthy, true);
  assert.deepEqual(status.readiness.capabilities.remoteControl, remoteControl);

  remoteControl = {
    status: "available",
    available: true,
    hostStatus: "online",
    code: null,
  };
  assert.equal(state.lease.refreshCapabilities(), true);
  status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.running, true);
  assert.equal(status.readiness.capabilities.remoteControl.status, "available");
});

test("a failing optional capability check cannot make the core service unhealthy", () => {
  const state = harness({ healthCheck: true });
  state.lease.markStarting();
  state.lease.setCapabilityCheck(() => { throw new Error("diagnostic failed"); });
  state.lease.markReady();

  const status = inspectServiceLaunchdReadiness(launchd(4242), state.file, { now: state.now() });
  assert.equal(status.running, true);
  assert.equal(status.readiness.capabilities.error, "CAPABILITY_CHECK_FAILED");
});
