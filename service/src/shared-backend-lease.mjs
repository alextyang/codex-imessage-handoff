import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const OWNER = "codex-imessage-handoff";
const SCHEMA_VERSION = 1;

function atomicWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readSharedBackendLease(file, options = {}) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.owner !== OWNER || value?.schemaVersion !== SCHEMA_VERSION) return null;
    const heartbeatAt = Date.parse(String(value.heartbeatAt || ""));
    const now = (options.nowImpl || Date.now)();
    const staleAfterMs = options.staleAfterMs || 30_000;
    if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > staleAfterMs) return null;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    const processAlive = options.processAliveImpl || ((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    return processAlive(value.pid) ? value : null;
  } catch {
    return null;
  }
}

export class SharedBackendTurnLease {
  constructor(file, options = {}) {
    this.file = file;
    this.nowImpl = options.nowImpl || Date.now;
    this.intervalMs = options.intervalMs || 5_000;
    this.timer = null;
    this.value = null;
  }

  acquire(threadId) {
    if (this.value) throw new Error("A shared backend turn lease is already active.");
    const startedAt = new Date(this.nowImpl()).toISOString();
    this.value = {
      schemaVersion: SCHEMA_VERSION,
      owner: OWNER,
      pid: process.pid,
      threadId: String(threadId || ""),
      startedAt,
      heartbeatAt: startedAt,
    };
    this.#write();
    this.timer = setInterval(() => this.#heartbeat(), this.intervalMs);
    this.timer.unref?.();
    return this.value;
  }

  release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const value = this.value;
    this.value = null;
    if (!value) return false;
    try {
      const current = JSON.parse(readFileSync(this.file, "utf8"));
      if (current?.owner === OWNER && current?.pid === process.pid && current?.startedAt === value.startedAt) {
        rmSync(this.file, { force: true });
      }
    } catch {
      // A missing or replaced lease is already released from our perspective.
    }
    return true;
  }

  #heartbeat() {
    if (!this.value) return;
    this.value = { ...this.value, heartbeatAt: new Date(this.nowImpl()).toISOString() };
    try { this.#write(); } catch {}
  }

  #write() {
    atomicWrite(this.file, this.value);
  }
}

export const sharedBackendLeaseValues = Object.freeze({ owner: OWNER, schemaVersion: SCHEMA_VERSION });
