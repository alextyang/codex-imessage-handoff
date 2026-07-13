#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { desktopSyncPaths, verifyDesktopSyncProxy } from "./desktop-sync.mjs";
import { inspectDesktopSharedConnection } from "./desktop-connection.mjs";
import { servicePaths } from "./paths.mjs";
import { readSharedBackendLease } from "./shared-backend-lease.mjs";
import { sharedBackendRecoveryDisposition } from "./shared-backend-policy.mjs";

const OWNER = "codex-imessage-handoff";
const SCHEMA_VERSION = 1;
const ENVIRONMENT_NAME = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";
const ENVIRONMENT_VALUE = "1";
function durationFromEnvironment(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

const STARTUP_PROBE_INTERVAL_MS = durationFromEnvironment("IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_PROBE_MS", 500, 25);
const STARTUP_TIMEOUT_MS = durationFromEnvironment("IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_TIMEOUT_MS", 12_000, 250);
const HEALTH_INTERVAL_MS = durationFromEnvironment("IMESSAGE_HANDOFF_SUPERVISOR_HEALTH_INTERVAL_MS", 30_000, 100);
const PROBE_TIMEOUT_MS = durationFromEnvironment("IMESSAGE_HANDOFF_SUPERVISOR_PROBE_TIMEOUT_MS", 5_000, 100);
const HEALTHY_ACTIVATION_STREAK = 3;
const ACTIVATION_SOAK_MS = durationFromEnvironment("IMESSAGE_HANDOFF_SUPERVISOR_ACTIVATION_SOAK_MS", 10_000, 100);
const HARD_FAILURE_STREAK = 3;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60_000;
const CIRCUIT_OPEN_MS = 5 * 60_000;
const STABLE_RESET_MS = 5 * 60_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_LOG_CHUNK_BYTES = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function rotateManagedLog(file, incomingBytes = 0) {
  let bytes = 0;
  try { bytes = statSync(file).size; } catch {}
  if (bytes + incomingBytes <= MAX_LOG_BYTES) return;
  rmSync(`${file}.2`, { force: true });
  if (existsSync(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`);
  if (existsSync(file)) renameSync(file, `${file}.1`);
}

function appendManagedLog(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const source = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const chunk = source.byteLength > MAX_LOG_CHUNK_BYTES
    ? source.subarray(source.byteLength - MAX_LOG_CHUNK_BYTES)
    : source;
  rotateManagedLog(file, chunk.byteLength);
  appendFileSync(file, chunk, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function log(message) {
  appendManagedLog(paths.sharedBackendSupervisorStdoutLog, `${nowIso()} ${message}\n`);
}

function logError(message) {
  appendManagedLog(paths.sharedBackendSupervisorStderrLog, `${nowIso()} ${message}\n`);
}

function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readOwnedState(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value?.owner === OWNER && value?.schemaVersion === SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

function readSupervisorConfig() {
  try {
    const value = JSON.parse(readFileSync(paths.sharedBackendSupervisorConfig, "utf8"));
    return value?.owner === OWNER
      && value?.schemaVersion === SCHEMA_VERSION
      && value?.instanceId === instanceId
      && value?.buildFingerprint === buildFingerprint
      ? value
      : null;
  } catch {
    return null;
  }
}

function writeSupervisorConfig(value) {
  atomicWriteJson(paths.sharedBackendSupervisorConfig, {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    ...value,
    instanceId,
    updatedAt: nowIso(),
  });
}

function launchctlGet() {
  try {
    return String(execFileSync(process.env.IMESSAGE_HANDOFF_LAUNCHCTL_BIN || "launchctl", ["getenv", ENVIRONMENT_NAME], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }) || "").trim();
  } catch {
    return "";
  }
}

function launchctlSet(enabled) {
  execFileSync(process.env.IMESSAGE_HANDOFF_LAUNCHCTL_BIN || "launchctl", enabled
    ? ["setenv", ENVIRONMENT_NAME, ENVIRONMENT_VALUE]
    : ["unsetenv", ENVIRONMENT_NAME], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3_000,
  });
}

function processRows() {
  try {
    return String(execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    })).split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
  } catch {
    return [];
  }
}

function executableIdentity(command) {
  const executable = String(command || "").split(/\s+/)[0];
  if (!executable || !path.isAbsolute(executable)) return null;
  try { return realpathSync(executable); } catch { return path.resolve(executable); }
}

function unixAppServerRows(binary, childPid) {
  let canonicalBinary;
  try { canonicalBinary = realpathSync(binary); } catch { canonicalBinary = path.resolve(binary); }
  return processRows().filter((row) => (
    row.pid !== process.pid
    && row.pid !== childPid
    && executableIdentity(row.command) === canonicalBinary
    && /(?:^|\s)app-server(?:\s|$)/.test(row.command)
    && /(?:^|\s)--listen(?:=|\s+)unix:\/\//.test(row.command)
  ));
}

function hasOtherUnixAppServer(binary, childPid) {
  return unixAppServerRows(binary, childPid).length > 0;
}

function isMatchingUnixAppServer(pid, binary) {
  return Number.isSafeInteger(pid)
    && pid > 0
    && processRows().some((row) => row.pid === pid)
    && unixAppServerRows(binary, null).some((row) => row.pid === pid);
}

function discoverExternalAppServer() {
  if (isMatchingUnixAppServer(adoptedChildPid, binary)) return adoptedChildPid;
  const rows = unixAppServerRows(binary, child?.pid || null);
  return rows.length === 1 ? rows[0].pid : null;
}

function rawSocketAccepts(socketPath, timeoutMs = 750) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function restartBackoff(attempt, randomImpl = Math.random) {
  const base = BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)];
  const jitter = 0.8 + Math.max(0, Math.min(1, randomImpl())) * 0.4;
  return Math.round(base * jitter);
}

export function renderSupervisorStatus(state) {
  return {
    phase: state.phase,
    healthy: state.healthy === true,
    childPid: Number.isSafeInteger(state.childPid) ? state.childPid : null,
    consecutiveFailures: Number(state.consecutiveFailures || 0),
    circuitOpenUntil: state.circuitOpenUntil || null,
    activationOwned: state.activationOwned === true,
    activationEnabled: state.activationEnabled === true,
    lastHealthyAt: state.lastHealthyAt || null,
    lastFailureAt: state.lastFailureAt || null,
    buildFingerprint: state.buildFingerprint || null,
  };
}

const paths = servicePaths();
const syncPaths = desktopSyncPaths();
const binary = path.resolve(process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex");
const instanceId = String(process.env.IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE || "").trim();
const buildFingerprint = String(process.env.IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT || "").trim().toLowerCase();
const stateFile = paths.sharedBackendSupervisorState;
if (!instanceId) throw new Error("The shared app-server supervisor instance id is missing.");
if (!/^[a-f0-9]{64}$/.test(buildFingerprint)) throw new Error("The shared app-server supervisor build fingerprint is missing or invalid.");
mkdirSync(syncPaths.codexHome, { recursive: true, mode: 0o700 });
mkdirSync(path.dirname(syncPaths.socket), { recursive: true, mode: 0o700 });
rotateManagedLog(paths.sharedBackendSupervisorStdoutLog, 1);
rotateManagedLog(paths.sharedBackendSupervisorStderrLog, 1);

let previous = readOwnedState(stateFile);
let state = {
  schemaVersion: SCHEMA_VERSION,
  owner: OWNER,
  pid: process.pid,
  instanceId,
  buildFingerprint,
  binary,
  socket: syncPaths.socket,
  phase: "starting",
  healthy: false,
  childPid: null,
  consecutiveFailures: 0,
  activationOwned: previous?.instanceId === instanceId
    && previous?.buildFingerprint === buildFingerprint
    && previous?.activationOwned === true,
  activationEnabled: launchctlGet() === ENVIRONMENT_VALUE,
  startedAt: nowIso(),
  lastHealthyAt: previous?.lastHealthyAt || null,
  lastFailureAt: previous?.lastFailureAt || null,
  circuitOpenUntil: previous?.circuitOpenUntil || null,
};
let child = null;
let adoptedChildPid = previous?.instanceId === instanceId
  && previous?.buildFingerprint === buildFingerprint
  && isMatchingUnixAppServer(previous?.childPid, binary)
  ? previous.childPid
  : null;
let stopping = false;
let probeInFlight = false;
let healthyStreak = 0;
let healthySinceMs = 0;
let restartAttempt = 0;
let restartTimes = [];
let restartTimer = null;
let healthTimer = null;
let startupGraceUntil = 0;

function saveState(patch = {}) {
  state = { ...state, ...patch, pid: process.pid, updatedAt: nowIso() };
  atomicWriteJson(stateFile, state);
}

function enableActivation() {
  const config = readSupervisorConfig();
  if (!config?.activationRequested || config.failOpenLatched === true) return false;
  const current = launchctlGet();
  if (current === ENVIRONMENT_VALUE && state.activationOwned !== true) {
    saveState({ activationEnabled: false, activationConflict: true, phase: "healthy-activation-conflict" });
    return false;
  }
  if (current && current !== ENVIRONMENT_VALUE) {
    saveState({ activationEnabled: false, activationConflict: true, phase: "healthy-activation-conflict" });
    return false;
  }
  if (!current) {
    launchctlSet(true);
    state.activationOwned = true;
  }
  const enabled = launchctlGet() === ENVIRONMENT_VALUE;
  saveState({ activationEnabled: enabled, activationConflict: false });
  return enabled;
}

function protectDesktopRouting(reason) {
  const current = launchctlGet();
  if (state.activationOwned && current === ENVIRONMENT_VALUE) {
    try { launchctlSet(false); } catch (error) { log(`Could not protect future Desktop launches: ${error.message}`); }
  }
  saveState({
    activationOwned: false,
    activationEnabled: launchctlGet() === ENVIRONMENT_VALUE,
    routingProtectionReason: reason,
    routingProtectedAt: nowIso(),
  });
}

function failOpenActivation(reason) {
  protectDesktopRouting(reason);
  saveState({
    failOpenReason: reason,
    failOpenAt: nowIso(),
  });
  const config = readSupervisorConfig();
  if (config) writeSupervisorConfig({
    ...config,
    activationRequested: false,
    failOpenLatched: true,
    disabledReason: reason,
    disabledAt: nowIso(),
  });
}

async function protocolProbe() {
  return verifyDesktopSyncProxy({ binary, proxyTimeoutMs: PROBE_TIMEOUT_MS });
}

async function quarantineProvablyStaleSocket() {
  if (!existsSync(syncPaths.socket)) return null;
  let stats;
  try { stats = lstatSync(syncPaths.socket); } catch { return null; }
  if (!stats.isSocket() || stats.uid !== process.getuid()) return null;
  if (await rawSocketAccepts(syncPaths.socket)) return null;
  if (hasOtherUnixAppServer(binary, child?.pid || null)) return null;
  const quarantine = `${syncPaths.socket}.stale.${Date.now()}.${process.pid}`;
  renameSync(syncPaths.socket, quarantine);
  log(`Quarantined a provably stale control socket at ${path.basename(quarantine)}.`);
  return quarantine;
}

function backendArguments() {
  return [
    "-c", "features.code_mode_host=true",
    "app-server",
    "--listen", "unix://",
    "--analytics-default-enabled",
  ];
}

async function recordHealthy() {
  healthyStreak += 1;
  state.consecutiveFailures = 0;
  if (!healthySinceMs) healthySinceMs = Date.now();
  const config = readSupervisorConfig();
  const activationReady = config?.activationRequested === true
    && config?.failOpenLatched !== true
    && healthyStreak >= HEALTHY_ACTIVATION_STREAK
    && Date.now() - healthySinceMs >= ACTIVATION_SOAK_MS;
  let activated = false;
  let activationConflict = false;
  if (activationReady) {
    activated = enableActivation();
  } else if (config?.activationRequested === true && state.activationOwned === true) {
    activated = launchctlGet() === ENVIRONMENT_VALUE;
  } else if (config?.activationRequested !== true) {
    const current = launchctlGet();
    if (state.activationOwned === true && current === ENVIRONMENT_VALUE) {
      try { launchctlSet(false); } catch {}
    } else if (current === ENVIRONMENT_VALUE) {
      activationConflict = true;
    }
  }
  saveState({
    phase: activationConflict
      ? "healthy-activation-conflict"
      : activated
      ? "healthy-active"
      : config?.activationRequested
        ? "healthy-soaking"
        : "healthy-standby",
    healthy: true,
    childPid: child?.pid || adoptedChildPid || null,
    consecutiveFailures: 0,
    activationEnabled: activated,
    activationOwned: activated ? state.activationOwned === true : false,
    activationConflict,
    lastHealthyAt: nowIso(),
    circuitOpenUntil: null,
    lastFailure: null,
    lastStartupProbe: null,
    nextRestartAt: null,
    failOpenReason: null,
    routingProtectionReason: null,
  });
  if (Date.now() - healthySinceMs >= STABLE_RESET_MS) {
    restartAttempt = 0;
    restartTimes = [];
  }
}

async function recordFailure(error) {
  healthyStreak = 0;
  healthySinceMs = 0;
  const failures = Number(state.consecutiveFailures || 0) + 1;
  saveState({
    phase: "degraded",
    healthy: false,
    consecutiveFailures: failures,
    lastFailureAt: nowIso(),
    lastFailure: String(error?.message || error || "health probe failed").slice(0, 300),
  });
}

async function checkHealth() {
  // A protocol-ready server can predate this supervisor (for example during a
  // safe live upgrade). Such a server may not have had a PID in the previous
  // state. Keep probing it instead of treating one successful handshake as a
  // permanent health result.
  if (probeInFlight || stopping || restartTimer
    || (!child && !adoptedChildPid && state.healthy !== true)
    || Date.now() < startupGraceUntil) return;
  probeInFlight = true;
  try {
    await protocolProbe();
    if (!child) adoptedChildPid = discoverExternalAppServer();
    await recordHealthy();
  } catch (error) {
    await recordFailure(error);
    if (Number(state.consecutiveFailures || 0) < HARD_FAILURE_STREAK) return;
    const lease = readSharedBackendLease(paths.sharedBackendTurnLease);
    const socketAccepts = await rawSocketAccepts(syncPaths.socket);
    const desktop = inspectDesktopSharedConnection();
    const disposition = sharedBackendRecoveryDisposition({
      activeTurnLease: Boolean(lease),
      socketAccepts,
      desktopRunning: desktop.desktopRunning,
      privateDesktopBackend: desktop.privateAppServerChild,
    });
    if (disposition === "defer-active-turn") {
      saveState({
        phase: "degraded-active-imessage-turn",
        restartDeferredAt: nowIso(),
      });
      return;
    }
    if (disposition === "fail-open-preserve-desktop") {
      // The environment only affects future Desktop launches. Latch it off now
      // without touching the current child; the current Desktop connection may
      // still be usable even though new protocol handshakes are wedged.
      failOpenActivation("degraded-desktop-client");
      saveState({ phase: "degraded-desktop-client", restartDeferredAt: nowIso() });
      return;
    }
    failOpenActivation("protocol-health-check-failed");
    log("The app server failed repeated protocol checks while idle; restarting it.");
    if (child && child.exitCode === null) {
      stopChildForRecovery();
    } else if (adoptedChildPid && isMatchingUnixAppServer(adoptedChildPid, binary)) {
      try { process.kill(adoptedChildPid, "SIGTERM"); } catch {}
      saveState({ phase: "stopping-owned-orphan", adoptedChildPid });
      adoptedChildPid = null;
      scheduleRestart();
    } else {
      adoptedChildPid = null;
      scheduleRestart();
    }
  } finally {
    probeInFlight = false;
  }
}

function openCircuit() {
  if (readSharedBackendLease(paths.sharedBackendTurnLease)) {
    saveState({ phase: "circuit-waiting-for-turn-release", healthy: false, childPid: null });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      openCircuit();
    }, 1_000);
    restartTimer.unref?.();
    return;
  }
  const until = Date.now() + CIRCUIT_OPEN_MS;
  failOpenActivation("restart-circuit-open");
  saveState({
    phase: "circuit-open",
    healthy: false,
    childPid: null,
    circuitOpenUntil: new Date(until).toISOString(),
  });
  log("App-server restart circuit opened for five minutes after repeated crashes.");
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartAttempt = 0;
    spawnBackend();
  }, CIRCUIT_OPEN_MS);
  restartTimer.unref?.();
}

function scheduleRestart() {
  if (stopping || restartTimer) return;
  const now = Date.now();
  restartTimes = restartTimes.filter((value) => now - value < RESTART_WINDOW_MS);
  if (restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
    openCircuit();
    return;
  }
  const delay = restartBackoff(restartAttempt++);
  saveState({ phase: "restart-backoff", nextRestartAt: new Date(now + delay).toISOString() });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnBackend();
  }, delay);
  restartTimer.unref?.();
}

function stopChildForRecovery() {
  if (!child || child.exitCode !== null) return;
  const target = child;
  target.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child === target && target.exitCode === null) target.kill("SIGKILL");
  }, 5_000);
  force.unref?.();
}

async function spawnBackend() {
  if (stopping || child) return;
  const circuitUntil = Date.parse(String(state.circuitOpenUntil || ""));
  if (Number.isFinite(circuitUntil) && circuitUntil > Date.now()) {
    const delay = circuitUntil - Date.now();
    restartTimer = setTimeout(() => { restartTimer = null; spawnBackend(); }, delay);
    restartTimer.unref?.();
    return;
  }

  try {
    await protocolProbe();
    startupGraceUntil = 0;
    if (!adoptedChildPid
      && previous?.instanceId === instanceId
      && previous?.buildFingerprint === buildFingerprint
      && isMatchingUnixAppServer(previous?.childPid, binary)) {
      adoptedChildPid = previous.childPid;
    }
    if (!adoptedChildPid) adoptedChildPid = discoverExternalAppServer();
    log("Adopting an already healthy local app server without starting a duplicate.");
    saveState({ phase: "healthy-external", healthy: true, childPid: adoptedChildPid, adoptedChildPid });
    for (let index = 0; index < HEALTHY_ACTIVATION_STREAK; index += 1) await recordHealthy();
    return;
  } catch {}

  await quarantineProvablyStaleSocket();
  if (hasOtherUnixAppServer(binary, null)) {
    saveState({ phase: "waiting-for-existing-server", healthy: false, childPid: null });
    log("Another Unix app-server process exists; waiting instead of starting a duplicate.");
    return;
  }

  restartTimes.push(Date.now());
  startupGraceUntil = Date.now() + STARTUP_TIMEOUT_MS;
  saveState({ phase: "launching", healthy: false, childPid: null, launchAt: nowIso() });
  try {
    child = spawn(binary, backendArguments(), {
      env: {
        ...process.env,
        [ENVIRONMENT_NAME]: "0",
        CODEX_HOME: syncPaths.codexHome,
        CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
        LOG_FORMAT: "json",
        RUST_LOG: process.env.RUST_LOG || "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    child = null;
    startupGraceUntil = 0;
    protectDesktopRouting("app-server-spawn-failed");
    await recordFailure(error);
    scheduleRestart();
    return;
  }
  const launched = child;
  launched.stdout?.on("data", (chunk) => appendManagedLog(paths.sharedBackendSupervisorStdoutLog, chunk));
  launched.stderr?.on("data", (chunk) => appendManagedLog(paths.sharedBackendSupervisorStderrLog, chunk));
  let launchTerminalHandled = false;
  saveState({ phase: "starting", childPid: launched.pid, launchAt: nowIso() });
  launched.once("error", async (error) => {
    if (launchTerminalHandled || child !== launched) return;
    launchTerminalHandled = true;
    child = null;
    startupGraceUntil = 0;
    protectDesktopRouting("app-server-child-error");
    await recordFailure(error);
    if (!stopping) scheduleRestart();
  });
  launched.once("exit", async (code, signal) => {
    if (launchTerminalHandled || child !== launched) return;
    launchTerminalHandled = true;
    child = null;
    startupGraceUntil = 0;
    if (stopping) {
      saveState({ childPid: null, lastExitCode: code, lastExitSignal: signal || null, lastExitAt: nowIso() });
      return;
    }
    protectDesktopRouting("app-server-child-exited");
    await recordFailure(new Error(`app-server exited (${signal || (code ?? "unknown")})`));
    saveState({ childPid: null, lastExitCode: code, lastExitSignal: signal || null, lastExitAt: nowIso() });
    if (!stopping) scheduleRestart();
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!stopping && child === launched && launched.exitCode === null && Date.now() < deadline) {
    try {
      await protocolProbe();
      await recordHealthy();
      if (healthyStreak >= HEALTHY_ACTIVATION_STREAK) break;
    } catch (error) {
      saveState({ phase: "starting", lastStartupProbe: String(error?.message || error).slice(0, 200) });
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_PROBE_INTERVAL_MS));
  }
  if (child === launched && launched.exitCode === null && healthyStreak < HEALTHY_ACTIVATION_STREAK) {
    protectDesktopRouting("app-server-startup-timeout");
    await recordFailure(new Error("app-server did not become protocol-ready before the startup deadline"));
    stopChildForRecovery();
  }
  startupGraceUntil = 0;
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (healthTimer) clearInterval(healthTimer);
  protectDesktopRouting(`supervisor-${String(signal).toLowerCase()}`);
  saveState({ phase: "stopping", healthy: false, stoppedBy: signal, stoppedAt: nowIso() });
  if (!child || child.exitCode !== null) process.exit(0);
  const target = child;
  target.once("exit", () => process.exit(0));
  target.kill("SIGTERM");
  setTimeout(() => {
    if (target.exitCode === null) target.kill("SIGKILL");
    process.exit(0);
  }, 5_000).unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", (error) => {
  logError(`Supervisor error: ${error?.stack || error}`);
  failOpenActivation("supervisor-uncaught-exception");
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  logError(`Supervisor rejection: ${error?.stack || error}`);
  failOpenActivation("supervisor-unhandled-rejection");
  shutdown("unhandledRejection");
});

healthTimer = setInterval(() => {
  checkHealth()
    .then(() => {
      if (!child && !restartTimer && !stopping && state.healthy !== true) return spawnBackend();
      return null;
    })
    .catch((error) => log(`Health loop failed: ${error?.message || error}`));
}, HEALTH_INTERVAL_MS);
healthTimer.unref?.();

if (state.activationOwned && state.activationEnabled) protectDesktopRouting("supervisor-restarted");
else saveState();
log(`Starting shared app-server supervisor with ${binary}.`);
await spawnBackend();
// Keep the process alive even if a future refactor accidentally unrefs all
// recovery timers. launchd remains the outer crash supervisor.
setInterval(() => {}, 60 * 60_000);

export const sharedBackendSupervisorValues = Object.freeze({
  owner: OWNER,
  schemaVersion: SCHEMA_VERSION,
  environmentName: ENVIRONMENT_NAME,
  environmentValue: ENVIRONMENT_VALUE,
});
