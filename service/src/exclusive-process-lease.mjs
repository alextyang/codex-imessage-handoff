import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

const OWNER_FILE = "owner.json";
const DEFAULT_POLL_MS = 50;
const CORRUPT_OWNER_GRACE_MS = 5_000;
const LEGACY_START_TIME_SKEW_MS = 1_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code, attempted: false });
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function normalizeProcessSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = typeof value.identity === "string" ? value.identity.trim() : "";
  const startedAt = typeof value.startedAt === "string" ? value.startedAt.trim() : "";
  return {
    identity: identity && identity.length <= 512 ? identity : null,
    startedAt: Number.isFinite(Date.parse(startedAt)) ? new Date(Date.parse(startedAt)).toISOString() : null,
  };
}

function procProcessIdentity(pid) {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/u) : [];
    // After the parenthesized command, index 0 is field 3 (`state`), so index
    // 19 is field 22 (`starttime`, in ticks since this boot).
    const startTicks = fields[19];
    if (/^[0-9a-f-]{36}$/iu.test(bootId) && /^\d+$/u.test(startTicks || "")) {
      return `linux:${bootId.toLowerCase()}:${startTicks}`;
    }
  } catch {}
  return null;
}

function psProcessStart(pid) {
  try {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 4 * 1024,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\s+/gu, " ").trim();
    if (!output) return null;
    const startedMs = Date.parse(output);
    const startedAt = Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null;
    return {
      // Canonicalize the local-time ps display to UTC. The same live process
      // must retain its identity if the Mac's configured time zone changes.
      identity: startedAt ? `ps-start:${startedAt}` : `ps-lstart:${output}`,
      startedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Return an identity tied to one OS process incarnation, not merely its PID.
 * Linux exposes an exact boot-id/start-tick pair. Darwin and other supported
 * Unix hosts use ps's absolute process start time. A null snapshot is safe:
 * recovery then falls back to the conservative PID-only behavior rather than
 * stealing a lease whose live owner could not be inspected.
 */
function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const ps = psProcessStart(pid);
  const procIdentity = procProcessIdentity(pid);
  if (!ps && !procIdentity) return null;
  return {
    identity: procIdentity || ps.identity,
    startedAt: ps?.startedAt || null,
  };
}

function readOwner(lockPath) {
  try {
    const value = JSON.parse(readFileSync(path.join(lockPath, OWNER_FILE), "utf8"));
    const pid = Number(value?.pid);
    const token = typeof value?.token === "string" ? value.token.trim() : "";
    const createdAt = typeof value?.createdAt === "string" ? value.createdAt.trim() : "";
    const version = Number(value?.version);
    const processIdentity = typeof value?.processIdentity === "string"
      ? value.processIdentity.trim()
      : "";
    if (![1, 2].includes(version) || !Number.isSafeInteger(pid) || pid <= 0
      || !/^[0-9a-f-]{36}$/iu.test(token) || !Number.isFinite(Date.parse(createdAt))) return null;
    if (version === 2 && processIdentity.length > 512) return null;
    return {
      version,
      pid,
      token,
      createdAt,
      processIdentity: processIdentity || null,
    };
  } catch {
    return null;
  }
}

function removeTree(directory) {
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
}

/**
 * A filesystem-scoped, process-owned lease. It protects only this service's
 * private state; it never touches or locks Codex Desktop, its app server, or a
 * task rollout. Atomic directory publication avoids half-written owners, and
 * a serialized recovery gate makes dead-process reclamation race-safe.
 */
export class ExclusiveProcessLease {
  constructor({
    lockPath,
    pid = process.pid,
    now = Date.now,
    sleepImpl = sleep,
    ownerAlive = processAlive,
    processInspector = inspectProcess,
    pollMs = DEFAULT_POLL_MS,
  } = {}) {
    if (!lockPath || !path.isAbsolute(lockPath)) {
      throw new TypeError("ExclusiveProcessLease requires an absolute lockPath.");
    }
    this.lockPath = path.resolve(lockPath);
    this.recoveryPath = `${this.lockPath}.recovery`;
    this.pid = Number(pid);
    this.now = now;
    this.sleep = sleepImpl;
    this.ownerAlive = ownerAlive;
    this.processInspector = processInspector;
    this.pollMs = Math.max(5, Number(pollMs) || DEFAULT_POLL_MS);
    this.token = randomUUID();
    this.acquired = false;
    this.processSnapshot = normalizeProcessSnapshot(this.processInspector(this.pid));
  }

  async acquire({ timeoutMs = 30_000 } = {}) {
    if (this.acquired) return this;
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    const deadline = this.now() + timeout;
    do {
      if (this.#tryPublish()) {
        this.acquired = true;
        return this;
      }
      this.#recoverDeadOwner();
      if (this.#tryPublish()) {
        this.acquired = true;
        return this;
      }
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(this.pollMs, Math.max(1, deadline - this.now())));
    } while (this.now() <= deadline);
    throw codedError("SERVICE_LEASE_BUSY", "Another iMessage handoff service process owns this private lease.");
  }

  release() {
    if (!this.acquired) return false;
    const owner = readOwner(this.lockPath);
    if (!owner || owner.token !== this.token || owner.pid !== this.pid) {
      this.acquired = false;
      return false;
    }
    const retired = `${this.lockPath}.released-${this.pid}-${this.token}`;
    try {
      renameSync(this.lockPath, retired);
      this.acquired = false;
      removeTree(retired);
      return true;
    } catch {
      this.acquired = false;
      return false;
    }
  }

  #tryPublish() {
    if (existsSync(this.recoveryPath)) return false;
    const parent = path.dirname(this.lockPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.lockPath}.candidate-${this.pid}-${this.token}`;
    removeTree(temporary);
    try {
      mkdirSync(temporary, { mode: 0o700 });
      writeFileSync(path.join(temporary, OWNER_FILE), `${JSON.stringify({
        version: 2,
        pid: this.pid,
        token: this.token,
        createdAt: new Date(this.now()).toISOString(),
        processIdentity: this.processSnapshot?.identity || null,
      })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (existsSync(this.recoveryPath)) return false;
      renameSync(temporary, this.lockPath);
      return true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)) throw error;
      return false;
    } finally {
      removeTree(temporary);
    }
  }

  #recoverDeadOwner() {
    if (!existsSync(this.lockPath)) return false;
    try {
      mkdirSync(this.recoveryPath, { mode: 0o700 });
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
      throw error;
    }
    try {
      const owner = readOwner(this.lockPath);
      if (owner && this.#sameLiveProcess(owner)) return false;
      if (!owner) {
        let changedMs = this.now();
        try { changedMs = statSync(this.lockPath).mtimeMs; } catch {}
        if (this.now() - changedMs < CORRUPT_OWNER_GRACE_MS) return false;
      }
      // The recovery directory blocks a new publisher while the stale owner is
      // rechecked. If the live holder released first, rename simply loses the
      // race and no newer lease can be removed here.
      const rechecked = readOwner(this.lockPath);
      if (owner?.token !== rechecked?.token || owner?.pid !== rechecked?.pid) return false;
      const retired = `${this.lockPath}.stale-${this.pid}-${this.token}`;
      renameSync(this.lockPath, retired);
      removeTree(retired);
      return true;
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
      throw error;
    } finally {
      removeTree(this.recoveryPath);
    }
  }

  #sameLiveProcess(owner) {
    if (!this.ownerAlive(owner.pid)) return false;
    const observed = normalizeProcessSnapshot(this.processInspector(owner.pid));
    if (owner.processIdentity && observed?.identity) {
      return owner.processIdentity === observed.identity;
    }
    // Version-1 leases predate process-incarnation identities. If a currently
    // live process started after the lease was created, this is necessarily a
    // reused PID (most commonly after reboot), not the original owner.
    if (owner.version === 1 && observed?.startedAt) {
      const createdMs = Date.parse(owner.createdAt);
      const startedMs = Date.parse(observed.startedAt);
      if (Number.isFinite(createdMs) && Number.isFinite(startedMs)
        && startedMs > createdMs + LEGACY_START_TIME_SKEW_MS) return false;
    }
    // If the platform cannot inspect identity, preserve mutual exclusion. A
    // false busy result is safer than deleting a lease held by a live process.
    return true;
  }
}

export const exclusiveProcessLeaseInternals = Object.freeze({
  inspectProcess,
  normalizeProcessSnapshot,
  processAlive,
  readOwner,
});
