import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteControlAvailability,
  remoteControlPresenceState,
} from "../src/remote-control-availability.mjs";

test("Remote Control availability starts unknown and becomes available only from runtime proof", () => {
  const availability = new RemoteControlAvailability({
    now: () => Date.parse("2026-07-14T12:00:00.000Z"),
  });
  assert.deepEqual(availability.snapshot(), {
    status: "unknown",
    available: null,
    hostStatus: "unknown",
    code: null,
    checkedAt: null,
  });

  const value = availability.observeAvailable();
  assert.equal(value.status, "available");
  assert.equal(value.available, true);
  assert.equal(value.hostStatus, "online");
  assert.equal(remoteControlPresenceState(value), "online");
});

test("auth and pairing failures degrade Remote Control without claiming the Codex host is offline", () => {
  const availability = new RemoteControlAvailability();
  for (const code of ["CODEX_AUTH_REQUIRED", "CODEX_REMOTE_PAIRING_REQUIRED", "CODEX_TIMEOUT"]) {
    const value = availability.observeFailure({ code });
    assert.equal(value.status, "degraded");
    assert.equal(value.available, false);
    assert.equal(value.hostStatus, "unknown");
    assert.equal(value.code, code);
    assert.equal(remoteControlPresenceState(value), null);
  }
});

test("only an explicit host-offline result produces offline presence evidence", () => {
  const availability = new RemoteControlAvailability();
  const value = availability.observeFailure({ code: "CODEX_HOST_OFFLINE" });
  assert.equal(value.status, "degraded");
  assert.equal(value.hostStatus, "offline");
  assert.equal(remoteControlPresenceState(value), "offline");
});
