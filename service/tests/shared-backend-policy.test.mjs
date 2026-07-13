import assert from "node:assert/strict";
import test from "node:test";
import { sharedBackendRecoveryDisposition } from "../src/shared-backend-policy.mjs";

test("active shared turns defer recovery without changing their backend", () => {
  assert.equal(sharedBackendRecoveryDisposition({ activeTurnLease: true }), "defer-active-turn");
});

test("a wedged accepting socket fails open without killing a possible Desktop client", () => {
  assert.equal(sharedBackendRecoveryDisposition({
    socketAccepts: true,
    desktopRunning: true,
    privateDesktopBackend: false,
  }), "fail-open-preserve-desktop");
});

test("private or absent Desktop sessions allow recovery restart", () => {
  assert.equal(sharedBackendRecoveryDisposition({
    socketAccepts: true,
    desktopRunning: true,
    privateDesktopBackend: true,
  }), "restart");
  assert.equal(sharedBackendRecoveryDisposition({ socketAccepts: true }), "restart");
  assert.equal(sharedBackendRecoveryDisposition({ desktopRunning: true }), "restart");
});
