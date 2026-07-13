import assert from "node:assert/strict";
import test from "node:test";
import { RECOVERED_RUN_OBSERVATION_MS, unconfirmedRecoveryDisposition } from "../src/recovered-run-policy.mjs";

test("an unobserved restarted turn gets a persisted canonical observation window", () => {
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  const initial = unconfirmedRecoveryDisposition(null, { nowMs });
  assert.deepEqual(initial, {
    status: "observe",
    missingSince: "2026-07-13T12:00:00.000Z",
    retryAfterMs: 2_000,
  });
  const afterRestart = unconfirmedRecoveryDisposition(initial.missingSince, { nowMs: nowMs + 12_000 });
  assert.equal(afterRestart.status, "observe");
  assert.equal(afterRestart.missingSince, initial.missingSince);
});

test("an ambiguous restarted turn fails closed instead of becoming a duplicate submission", () => {
  const missingSince = "2026-07-13T12:00:00.000Z";
  const disposition = unconfirmedRecoveryDisposition(missingSince, {
    nowMs: Date.parse(missingSince) + RECOVERED_RUN_OBSERVATION_MS,
  });
  assert.deepEqual(disposition, { status: "unconfirmed", missingSince, retryAfterMs: 0 });
});

test("invalid or future persisted observation timestamps cannot skip the safety window", () => {
  const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
  for (const value of ["not-a-date", "2026-07-14T12:00:00.000Z"]) {
    const disposition = unconfirmedRecoveryDisposition(value, { nowMs });
    assert.equal(disposition.status, "observe");
    assert.equal(disposition.missingSince, "2026-07-13T12:00:00.000Z");
  }
});
