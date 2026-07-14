import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SERVICE_READINESS_HEARTBEAT_MS = 5_000;
export const SERVICE_READINESS_STALE_AFTER_MS = 20_000;

function timestamp(now) {
  return new Date(now()).toISOString();
}

function readState(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeState(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function removeServiceReadinessState(file) {
  rmSync(file, { force: true });
}

/**
 * Interpret launchd's current job record together with the daemon's durable
 * readiness lease. A launchd process is healthy only when the lease belongs to
 * that exact PID and its heartbeat is fresh.
 */
export function inspectServiceLaunchdReadiness(output, file, options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? SERVICE_READINESS_STALE_AFTER_MS;
  const launchdOutput = String(output || "");
  const pid = Number(launchdOutput.match(/\bpid = (\d+)/)?.[1] || 0) || null;
  const jobLoaded = launchdOutput.trim().length > 0;
  const jobRunning = /\bstate = running\b/.test(launchdOutput);
  const state = readState(file);
  const statePid = Number(state?.pid || 0) || null;
  const heartbeatAtMs = Date.parse(String(state?.heartbeatAt || ""));
  const fresh = Number.isFinite(heartbeatAtMs)
    && now >= heartbeatAtMs
    && now - heartbeatAtMs < staleAfterMs;
  const pidMatches = Boolean(pid && statePid === pid);
  // A readiness lease from an older daemon did not prove that a real Messages
  // watch was active. Missing health is therefore degraded, not implicitly
  // healthy.
  const healthHealthy = state?.health?.healthy === true;
  const ready = state?.schemaVersion === 1
    && state?.status === "ready"
    && jobRunning
    && pidMatches
    && fresh
    && healthHealthy;
  return {
    running: ready,
    jobLoaded,
    jobRunning,
    pid,
    readiness: {
      ready,
      status: typeof state?.status === "string" ? state.status : "missing",
      pid: statePid,
      pidMatches,
      fresh,
      healthHealthy,
      health: state?.health && typeof state.health === "object" ? state.health : null,
      capabilities: state?.capabilities && typeof state.capabilities === "object" ? state.capabilities : null,
      heartbeatAt: typeof state?.heartbeatAt === "string" ? state.heartbeatAt : null,
      readyAt: typeof state?.readyAt === "string" ? state.readyAt : null,
    },
  };
}

/**
 * PID- and owner-bound durable readiness lease for the local service daemon.
 * An older overlapping process can neither overwrite nor remove a newer
 * daemon's state.
 */
export class ServiceReadiness {
  constructor(file, options = {}) {
    this.file = file;
    this.pid = options.pid ?? process.pid;
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? SERVICE_READINESS_HEARTBEAT_MS;
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
    this.healthCheck = typeof options.healthCheck === "function" ? options.healthCheck : null;
    this.capabilityCheck = typeof options.capabilityCheck === "function" ? options.capabilityCheck : null;
    this.timer = null;
    this.value = null;
  }

  markStarting() {
    this.#clearTimer();
    const startedAt = timestamp(this.now);
    this.value = {
      schemaVersion: 1,
      status: "starting",
      pid: this.pid,
      ownerId: this.ownerId,
      startedAt,
      readyAt: null,
      heartbeatAt: null,
      health: { healthy: false, checkedAt: startedAt },
      capabilities: this.#checkCapabilities(startedAt),
    };
    writeState(this.file, this.value);
    return this.value;
  }

  markReady() {
    if (!this.value || this.value.status !== "starting" || !this.#ownsState()) {
      throw new Error("Service readiness must be owned and starting before it can become ready.");
    }
    const readyAt = timestamp(this.now);
    const health = this.#checkHealth(readyAt);
    if (!health.healthy) throw new Error("Service readiness requires a healthy active transport watch.");
    const capabilities = this.#checkCapabilities(readyAt);
    this.value = { ...this.value, status: "ready", readyAt, heartbeatAt: readyAt, health, capabilities };
    writeState(this.file, this.value);
    this.timer = this.setIntervalImpl(() => this.heartbeat(), this.intervalMs);
    this.timer?.unref?.();
    return this.value;
  }

  heartbeat() {
    if (!this.value || !["ready", "degraded"].includes(this.value.status) || !this.#ownsState()) {
      this.#clearTimer();
      this.value = null;
      return false;
    }
    const heartbeatAt = timestamp(this.now);
    const health = this.#checkHealth(heartbeatAt);
    const capabilities = this.#checkCapabilities(heartbeatAt);
    const recovered = this.value.status === "degraded" && health.healthy;
    this.value = {
      ...this.value,
      status: health.healthy ? "ready" : "degraded",
      heartbeatAt,
      health,
      capabilities,
      ...(recovered ? { recoveredAt: heartbeatAt } : {}),
    };
    writeState(this.file, this.value);
    return health.healthy;
  }

  setHealthCheck(check) {
    this.healthCheck = typeof check === "function" ? check : null;
    if (this.value && ["ready", "degraded"].includes(this.value.status)) this.heartbeat();
    return this;
  }

  setCapabilityCheck(check) {
    this.capabilityCheck = typeof check === "function" ? check : null;
    if (this.value && ["ready", "degraded"].includes(this.value.status)) this.heartbeat();
    else this.refreshCapabilities();
    return this;
  }

  refreshCapabilities() {
    if (!this.value || !this.#ownsState()) return false;
    const checkedAt = timestamp(this.now);
    this.value = { ...this.value, capabilities: this.#checkCapabilities(checkedAt) };
    writeState(this.file, this.value);
    return true;
  }

  markStopped() {
    this.#clearTimer();
    if (this.#ownsState()) removeServiceReadinessState(this.file);
    this.value = null;
  }

  #ownsState() {
    const current = readState(this.file);
    return current?.schemaVersion === 1
      && current?.pid === this.pid
      && current?.ownerId === this.ownerId;
  }

  #checkHealth(checkedAt = timestamp(this.now)) {
    if (!this.healthCheck) return { healthy: true, checkedAt };
    try {
      const result = this.healthCheck();
      if (result && typeof result === "object") {
        return {
          ...result,
          healthy: result.healthy === true,
          checkedAt,
        };
      }
      return { healthy: result === true, checkedAt };
    } catch {
      return { healthy: false, checkedAt };
    }
  }

  #checkCapabilities(checkedAt = timestamp(this.now)) {
    if (!this.capabilityCheck) return null;
    try {
      const result = this.capabilityCheck();
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return { checkedAt, error: "CAPABILITY_CHECK_INVALID" };
      }
      return { ...result, checkedAt };
    } catch {
      // Capability inspection can never make the core Messages service fail
      // readiness. It is surfaced independently for diagnostics instead.
      return { checkedAt, error: "CAPABILITY_CHECK_FAILED" };
    }
  }

  #clearTimer() {
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }
}
