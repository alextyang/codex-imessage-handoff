import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSharedBackendLease, SharedBackendTurnLease } from "../src/shared-backend-lease.mjs";

test("shared backend turn lease is live only while its owner heartbeats", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shared-backend-lease-"));
  const file = path.join(directory, "lease.json");
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  const lease = new SharedBackendTurnLease(file, { nowImpl: () => now, intervalMs: 60_000 });
  lease.acquire("thread-1");
  assert.equal(readSharedBackendLease(file, {
    nowImpl: () => now,
    processAliveImpl: (pid) => pid === process.pid,
  }).threadId, "thread-1");

  now += 31_000;
  assert.equal(readSharedBackendLease(file, {
    nowImpl: () => now,
    processAliveImpl: () => true,
  }), null);
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
});

test("shared backend turn lease ignores dead and foreign state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "shared-backend-lease-invalid-"));
  const file = path.join(directory, "lease.json");
  const lease = new SharedBackendTurnLease(file);
  lease.acquire("thread-2");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(readSharedBackendLease(file, { processAliveImpl: () => false }), null);
  raw.owner = "someone-else";
  writeFileSync(file, JSON.stringify(raw), "utf8");
  assert.equal(readSharedBackendLease(file, { processAliveImpl: () => true }), null);
  lease.release();
});
