import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExclusiveProcessLease } from "../src/exclusive-process-lease.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-lease-"));
  return path.join(directory, "private-service.lease");
}

test("a live private-service owner excludes a second instance without touching Codex", async () => {
  const lockPath = fixture();
  const first = new ExclusiveProcessLease({ lockPath });
  const second = new ExclusiveProcessLease({ lockPath });

  await first.acquire({ timeoutMs: 0 });
  await assert.rejects(second.acquire({ timeoutMs: 0 }), { code: "SERVICE_LEASE_BUSY" });
  const owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(owner.version, 2);
  assert.equal(owner.pid, process.pid);
  assert.match(owner.processIdentity, /^(?:linux:|ps-(?:lstart|start):)/u);
  assert.equal(first.release(), true);

  await second.acquire({ timeoutMs: 0 });
  assert.equal(second.release(), true);
  assert.equal(existsSync(lockPath), false);
});

test("a dead process lease is atomically reclaimed and an old owner cannot delete the replacement", async () => {
  const lockPath = fixture();
  const crashed = new ExclusiveProcessLease({ lockPath, pid: 987_654_321 });
  await crashed.acquire({ timeoutMs: 0 });

  const replacement = new ExclusiveProcessLease({
    lockPath,
    ownerAlive: () => false,
  });
  await replacement.acquire({ timeoutMs: 0 });
  assert.equal(crashed.release(), false);
  assert.equal(existsSync(lockPath), true);
  assert.equal(replacement.release(), true);
  assert.equal(existsSync(lockPath), false);
});

test("a reused live PID with a different process incarnation cannot pin a stale lease", async () => {
  const lockPath = fixture();
  const reusedPid = 432_101;
  const crashed = new ExclusiveProcessLease({
    lockPath,
    pid: reusedPid,
    ownerAlive: () => true,
    processInspector: () => ({
      identity: "test-boot-a:process-start-a",
      startedAt: "2026-07-14T08:00:00.000Z",
    }),
  });
  await crashed.acquire({ timeoutMs: 0 });

  const replacement = new ExclusiveProcessLease({
    lockPath,
    pid: reusedPid,
    ownerAlive: () => true,
    processInspector: () => ({
      identity: "test-boot-b:process-start-b",
      startedAt: "2026-07-15T08:00:00.000Z",
    }),
  });
  await replacement.acquire({ timeoutMs: 0 });
  assert.equal(crashed.release(), false);
  assert.equal(replacement.release(), true);
});

test("a pre-identity lease is reclaimed when its PID now names a newer process", async () => {
  const lockPath = fixture();
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
    version: 1,
    pid: 432_102,
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-14T08:00:00.000Z",
  })}\n`, { mode: 0o600 });

  const replacement = new ExclusiveProcessLease({
    lockPath,
    ownerAlive: () => true,
    processInspector: () => ({
      identity: "test-boot-b:process-start-b",
      startedAt: "2026-07-15T08:00:00.000Z",
    }),
  });
  await replacement.acquire({ timeoutMs: 0 });
  assert.equal(replacement.release(), true);
});
