import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";
import { execFileSync as nodeExecFileSync } from "node:child_process";
import { servicePaths } from "./paths.mjs";

const STATE_SCHEMA_VERSION = 1;
const STATE_OWNER = "codex-imessage-handoff";
const DESKTOP_ENVIRONMENT_NAME = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";
const DESKTOP_ENVIRONMENT_VALUE = "1";
const MAX_PROTOCOL_BYTES = 1024 * 1024;

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function lstat(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function linkTarget(file) {
  const target = readlinkSync(file);
  return path.resolve(path.dirname(file), target);
}

function timestamp(options) {
  return new Date((options.nowImpl || Date.now)()).toISOString();
}

function freshState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, owner: STATE_OWNER };
}

function validateState(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== STATE_SCHEMA_VERSION || value.owner !== STATE_OWNER) {
    throw codedError("DESKTOP_SYNC_STATE_CONFLICT", "The desktop-sync state file is not owned by iMessage Handoff.");
  }
  return value;
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

function parseJsonOutput(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // A daemon command can print an informational line before its JSON result.
    }
  }
  throw codedError("DESKTOP_SYNC_PROTOCOL", "The managed Codex daemon did not return valid version information.");
}

function commandEnvironment(paths, options) {
  return {
    ...process.env,
    ...(options.env || {}),
    CODEX_HOME: paths.codexHome,
  };
}

function daemonCommand(binary, command, paths, options) {
  const execFileSyncImpl = options.execFileSyncImpl || nodeExecFileSync;
  return execFileSyncImpl(binary, ["app-server", "daemon", command], {
    encoding: "utf8",
    env: commandEnvironment(paths, options),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.commandTimeoutMs || 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function inspectDaemon(binary, paths, options) {
  try {
    const versions = parseJsonOutput(daemonCommand(binary, "version", paths, options));
    return { running: true, versions };
  } catch (error) {
    return { running: false, versions: null, error };
  }
}

function launchctlGet(options) {
  const execFileSyncImpl = options.execFileSyncImpl || nodeExecFileSync;
  try {
    return String(execFileSyncImpl("launchctl", ["getenv", DESKTOP_ENVIRONMENT_NAME], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.commandTimeoutMs || 30_000,
    }) || "").trim();
  } catch {
    return "";
  }
}

function launchctlChange(action, options) {
  const execFileSyncImpl = options.execFileSyncImpl || nodeExecFileSync;
  const args = action === "set"
    ? ["setenv", DESKTOP_ENVIRONMENT_NAME, DESKTOP_ENVIRONMENT_VALUE]
    : ["unsetenv", DESKTOP_ENVIRONMENT_NAME];
  execFileSyncImpl("launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.commandTimeoutMs || 30_000,
  });
}

function stateStandaloneRecord(state) {
  const record = state?.preparation?.standalone;
  return record && typeof record === "object" ? record : null;
}

function safeStateForWrite(options) {
  return readDesktopSyncState(options) || freshState();
}

function resolveSourceBinary(paths, options) {
  const candidates = [
    options.codexBin,
    options.env?.CODEX_BIN,
    process.env.CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  const candidate = candidates.find(executable);
  if (!candidate) {
    if (executable(paths.standalone)) return realpathSync(paths.standalone);
    throw codedError("CODEX_NOT_FOUND", "An executable Codex binary could not be found.");
  }
  return realpathSync(candidate);
}

function installStandaloneLink(paths, source, state, options) {
  const existing = lstat(paths.standalone);
  const record = stateStandaloneRecord(state);
  const recordedHere = record?.owned === true
    && samePath(record.path || "", paths.standalone)
    && typeof record.target === "string";

  if (existing && !existing.isSymbolicLink()) {
    if (!executable(paths.standalone)) {
      throw codedError("STANDALONE_CONFLICT", `The existing standalone Codex path is not executable: ${paths.standalone}`);
    }
    return { path: paths.standalone, target: realpathSync(paths.standalone), owned: false, changed: false };
  }

  if (existing?.isSymbolicLink()) {
    const target = linkTarget(paths.standalone);
    if (recordedHere && !samePath(target, record.target)) {
      throw codedError("STANDALONE_OWNERSHIP_LOST", "The managed standalone Codex link changed outside iMessage Handoff; it was left untouched.");
    }
    if (!executable(paths.standalone)) {
      throw codedError("STANDALONE_CONFLICT", "The existing standalone Codex symlink is not executable and was left untouched.");
    }
    return {
      path: paths.standalone,
      target: realpathSync(paths.standalone),
      owned: recordedHere,
      changed: false,
    };
  }

  mkdirSync(path.dirname(paths.standalone), { recursive: true, mode: 0o700 });
  const temporary = `${paths.standalone}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    symlinkSync(source, temporary, "file");
    renameSync(temporary, paths.standalone);
  } finally {
    rmSync(temporary, { force: true });
  }
  const installed = { path: paths.standalone, target: source, owned: true, changed: true };
  const next = {
    ...state,
    preparation: {
      ...(state.preparation || {}),
      codexHome: paths.codexHome,
      standalone: {
        path: paths.standalone,
        target: source,
        owned: true,
        installedAt: timestamp(options),
      },
    },
  };
  try {
    writeDesktopSyncState(next, options);
  } catch (error) {
    const current = lstat(paths.standalone);
    if (current?.isSymbolicLink() && samePath(linkTarget(paths.standalone), source)) rmSync(paths.standalone, { force: true });
    throw error;
  }
  return installed;
}

function preparationBinary(state, paths) {
  const recorded = stateStandaloneRecord(state);
  if (recorded?.path && samePath(recorded.path, paths.standalone) && executable(paths.standalone)) return paths.standalone;
  if (executable(paths.standalone)) return paths.standalone;
  return null;
}

function publicProbeResult(result) {
  return {
    userAgent: typeof result?.userAgent === "string" ? result.userAgent.slice(0, 160) : null,
    platformFamily: typeof result?.platformFamily === "string" ? result.platformFamily.slice(0, 80) : null,
    platformOs: typeof result?.platformOs === "string" ? result.platformOs.slice(0, 80) : null,
    codexHome: typeof result?.codexHome === "string" ? result.codexHome : null,
  };
}

/** Paths are deliberately rooted in the canonical ~/.codex tree. CODEX_HOME is not consulted. */
export function desktopSyncPaths(options = {}) {
  const homeDirectory = path.resolve(options.homeDir || os.homedir());
  const codexHome = path.join(homeDirectory, ".codex");
  const configured = servicePaths();
  return {
    codexHome,
    standalone: path.join(codexHome, "packages", "standalone", "current", "codex"),
    socket: path.join(codexHome, "app-server-control", "app-server-control.sock"),
    stateFile: options.stateFile || configured.desktopSyncState || path.join(configured.home, "desktop-sync-state.json"),
  };
}

export function readDesktopSyncState(options = {}) {
  const file = desktopSyncPaths(options).stateFile;
  if (!existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw codedError("DESKTOP_SYNC_STATE_INVALID", "The desktop-sync state file is invalid.", error);
  }
  return validateState(value);
}

export function writeDesktopSyncState(value, options = {}) {
  validateState(value);
  atomicWriteJson(desktopSyncPaths(options).stateFile, value);
  return value;
}

/**
 * Verify that `codex app-server proxy` reaches the managed daemon and completes
 * the normal initialize/initialized exchange. The child is only a probe client.
 */
export function verifyDesktopSyncProxy(options = {}) {
  const paths = desktopSyncPaths(options);
  const binary = options.binary || paths.standalone;
  if (!options.spawnImpl) return verifyDesktopSyncWebSocket(paths, options);
  const spawnImpl = options.spawnImpl;
  const timeoutMs = options.proxyTimeoutMs || 10_000;

  return new Promise((resolve, reject) => {
    let child;
    let buffer = "";
    let settled = false;
    const id = "desktop-sync-initialize";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.exitCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(codedError("DESKTOP_SYNC_PROXY_TIMEOUT", "The managed Codex proxy did not initialize in time."));
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawnImpl(binary, ["app-server", "proxy", "--sock", paths.socket], {
        env: commandEnvironment(paths, options),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(codedError("DESKTOP_SYNC_PROXY_UNAVAILABLE", "The managed Codex proxy could not be started.", error));
      return;
    }

    child.once("error", (error) => finish(codedError("DESKTOP_SYNC_PROXY_UNAVAILABLE", "The managed Codex proxy could not be started.", error)));
    child.once("close", () => finish(codedError("DESKTOP_SYNC_PROXY_CLOSED", "The managed Codex proxy closed before initialization.")));
    child.stderr?.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > MAX_PROTOCOL_BYTES) {
        finish(codedError("DESKTOP_SYNC_PROTOCOL", "The managed Codex proxy returned an oversized response."));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (String(message?.id) !== id || message.method) continue;
        if (message.error) {
          finish(codedError("DESKTOP_SYNC_PROXY_REJECTED", "The managed Codex proxy rejected initialization."));
          return;
        }
        const result = publicProbeResult(message.result);
        if (result.codexHome && !samePath(result.codexHome, paths.codexHome)) {
          finish(codedError("DESKTOP_SYNC_WRONG_HOME", "The managed Codex proxy is using a non-canonical Codex home."));
          return;
        }
        try {
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        } catch {}
        finish(null, result);
        return;
      }
    });
    child.stdin.on?.("error", (error) => finish(codedError("DESKTOP_SYNC_PROXY_CLOSED", "The managed Codex proxy connection closed.", error)));
    child.stdin.write(`${JSON.stringify({
      id,
      method: "initialize",
      params: {
        clientInfo: { name: "imessage-handoff-setup", title: "iMessage Handoff Setup", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    })}\n`);
  });
}

function verifyDesktopSyncWebSocket(paths, options) {
  const timeoutMs = options.proxyTimeoutMs || 10_000;
  const factory = options.webSocketFactory || ((url, webSocketOptions) => new WebSocket(url, webSocketOptions));
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const id = "desktop-sync-initialize";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== 3) {
        try { socket.close(); } catch { socket.terminate?.(); }
      }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(codedError("DESKTOP_SYNC_PROXY_TIMEOUT", "The managed Codex proxy did not initialize in time."));
    }, timeoutMs);
    timer.unref?.();

    try {
      socket = factory("ws://localhost/rpc", {
        createConnection: (_socketOptions, callback) => net.createConnection(paths.socket, callback),
        perMessageDeflate: false,
      });
    } catch (error) {
      finish(codedError("DESKTOP_SYNC_PROXY_UNAVAILABLE", "The managed Codex proxy could not be started.", error));
      return;
    }
    socket.on("open", () => {
      socket.send(JSON.stringify({
        id,
        method: "initialize",
        params: {
          clientInfo: { name: "imessage-handoff-setup", title: "iMessage Handoff Setup", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      }));
    });
    socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (String(message?.id) !== id || message.method) return;
      if (message.error) {
        finish(codedError("DESKTOP_SYNC_PROXY_REJECTED", "The managed Codex proxy rejected initialization."));
        return;
      }
      const result = publicProbeResult(message.result);
      if (result.codexHome && !samePath(result.codexHome, paths.codexHome)) {
        finish(codedError("DESKTOP_SYNC_WRONG_HOME", "The managed Codex proxy is using a non-canonical Codex home."));
        return;
      }
      try { socket.send(JSON.stringify({ method: "initialized" })); } catch {}
      finish(null, result);
    });
    socket.on("error", (error) => finish(codedError("DESKTOP_SYNC_PROXY_UNAVAILABLE", "The managed Codex proxy could not be started.", error)));
    socket.on("close", () => finish(codedError("DESKTOP_SYNC_PROXY_CLOSED", "The managed Codex proxy closed before initialization.")));
  });
}

async function probeBackend(binary, paths, options) {
  const daemon = inspectDaemon(binary, paths, options);
  if (!daemon.running) throw codedError("DESKTOP_SYNC_DAEMON_UNAVAILABLE", "The managed Codex daemon is not running.", daemon.error);
  const proxy = options.proxyProbeImpl
    ? await options.proxyProbeImpl({ binary, paths, env: commandEnvironment(paths, options) })
    : await verifyDesktopSyncProxy({ ...options, binary });
  return { daemon, proxy: publicProbeResult(proxy) };
}

/**
 * Prepare the shared backend without changing launchctl, restarting Desktop, or
 * restarting the iMessage service.
 */
export async function prepareDesktopSync(options = {}) {
  const paths = desktopSyncPaths(options);
  let state = safeStateForWrite(options);
  const source = resolveSourceBinary(paths, options);
  const previouslyRunning = executable(paths.standalone)
    ? inspectDaemon(paths.standalone, paths, options).running
    : false;
  const standalone = installStandaloneLink(paths, source, state, options);
  state = safeStateForWrite(options);

  try {
    daemonCommand(standalone.path, "bootstrap", paths, options);
    daemonCommand(standalone.path, "start", paths, options);
    const ready = await probeBackend(standalone.path, paths, options);
    const completedAt = timestamp(options);
    const next = {
      ...state,
      preparation: {
        ...(state.preparation || {}),
        codexHome: paths.codexHome,
        standalone: {
          path: standalone.path,
          target: standalone.target,
          owned: standalone.owned,
          installedAt: state.preparation?.standalone?.installedAt || (standalone.owned ? completedAt : null),
        },
        daemon: {
          running: true,
          startedByUs: !previouslyRunning,
          versions: ready.daemon.versions,
          verifiedAt: completedAt,
        },
        proxy: { ...ready.proxy, verifiedAt: completedAt },
        preparedAt: completedAt,
      },
    };
    writeDesktopSyncState(next, options);
    return { prepared: true, paths, standalone, daemon: ready.daemon, proxy: ready.proxy };
  } catch (error) {
    const failed = {
      ...safeStateForWrite(options),
      preparation: {
        ...(safeStateForWrite(options).preparation || {}),
        codexHome: paths.codexHome,
        standalone: {
          path: standalone.path,
          target: standalone.target,
          owned: standalone.owned,
          installedAt: state.preparation?.standalone?.installedAt || null,
        },
        lastFailureAt: timestamp(options),
      },
    };
    writeDesktopSyncState(failed, options);
    throw error;
  }
}

export async function desktopSyncStatus(options = {}) {
  const paths = desktopSyncPaths(options);
  const state = readDesktopSyncState(options);
  const existing = lstat(paths.standalone);
  const recorded = stateStandaloneRecord(state);
  let standalone = { present: Boolean(existing), executable: false, owned: false, unchanged: false, target: null };
  if (existing?.isSymbolicLink()) {
    const target = linkTarget(paths.standalone);
    standalone = {
      present: true,
      executable: executable(paths.standalone),
      owned: recorded?.owned === true && samePath(recorded.path || "", paths.standalone),
      unchanged: recorded?.owned === true && samePath(recorded.path || "", paths.standalone) && samePath(recorded.target || "", target),
      target,
    };
  } else if (existing) {
    standalone = { present: true, executable: executable(paths.standalone), owned: false, unchanged: false, target: realpathSync(paths.standalone) };
  }

  let daemon = { running: false, versions: null };
  let proxy = { ready: false, details: null };
  if (standalone.executable) {
    daemon = inspectDaemon(paths.standalone, paths, options);
    if (daemon.running && options.probeProxy !== false) {
      try {
        const details = options.proxyProbeImpl
          ? await options.proxyProbeImpl({ binary: paths.standalone, paths, env: commandEnvironment(paths, options) })
          : await verifyDesktopSyncProxy({ ...options, binary: paths.standalone });
        proxy = { ready: true, details: publicProbeResult(details) };
      } catch {
        proxy = { ready: false, details: null };
      }
    } else if (daemon.running && state?.preparation?.proxy?.verifiedAt) {
      proxy = { ready: null, details: publicProbeResult(state.preparation.proxy) };
    }
  }
  const desktopEnvironment = launchctlGet(options);
  return {
    paths,
    state,
    standalone,
    daemon: { running: daemon.running, versions: daemon.versions },
    proxy,
    activation: {
      currentValue: desktopEnvironment || null,
      enabled: desktopEnvironment === DESKTOP_ENVIRONMENT_VALUE,
      owned: state?.activation?.owned === true && state.activation.value === desktopEnvironment,
      conflict: Boolean(desktopEnvironment && desktopEnvironment !== DESKTOP_ENVIRONMENT_VALUE),
      desktopRestartRequired: desktopEnvironment === DESKTOP_ENVIRONMENT_VALUE && state?.activation?.desktopVerified !== true,
    },
    ready: daemon.running && proxy.ready === true,
  };
}

/** Set the Desktop launch environment only after re-verifying the shared backend. */
export async function beginDesktopSyncActivation(options = {}) {
  const paths = desktopSyncPaths(options);
  const state = safeStateForWrite(options);
  const binary = preparationBinary(state, paths);
  if (!binary || state.preparation?.codexHome !== paths.codexHome || !state.preparation?.preparedAt) {
    throw codedError("DESKTOP_SYNC_NOT_PREPARED", "Desktop sync must be prepared successfully before activation.");
  }
  await probeBackend(binary, paths, options);

  const current = launchctlGet(options);
  if (current && current !== DESKTOP_ENVIRONMENT_VALUE) {
    throw codedError("DESKTOP_SYNC_ENV_CONFLICT", `${DESKTOP_ENVIRONMENT_NAME} already has a conflicting launchctl value; it was left untouched.`);
  }
  if (current === DESKTOP_ENVIRONMENT_VALUE) {
    if (state.activation?.value !== DESKTOP_ENVIRONMENT_VALUE) {
      writeDesktopSyncState({
        ...state,
        activation: {
          environment: DESKTOP_ENVIRONMENT_NAME,
          value: DESKTOP_ENVIRONMENT_VALUE,
          owned: false,
          reusedAt: timestamp(options),
        },
      }, options);
    }
    return {
      changed: false,
      enabled: true,
      owned: state.activation?.owned === true && state.activation.value === DESKTOP_ENVIRONMENT_VALUE,
      desktopRestartRequired: true,
    };
  }

  launchctlChange("set", options);
  if (launchctlGet(options) !== DESKTOP_ENVIRONMENT_VALUE) {
    throw codedError("DESKTOP_SYNC_ACTIVATION_FAILED", "launchctl did not retain the desktop-sync environment value.");
  }
  const next = {
    ...state,
    activation: {
      environment: DESKTOP_ENVIRONMENT_NAME,
      value: DESKTOP_ENVIRONMENT_VALUE,
      owned: true,
      setAt: timestamp(options),
    },
  };
  try {
    writeDesktopSyncState(next, options);
  } catch (error) {
    if (launchctlGet(options) === DESKTOP_ENVIRONMENT_VALUE) launchctlChange("unset", options);
    throw error;
  }
  return { changed: true, enabled: true, owned: true, desktopRestartRequired: true };
}

/**
 * Record the post-restart phase only when a caller-supplied verifier has proved
 * Desktop is connected to the shared daemon. Process inspection is intentionally
 * kept outside this setup module so an unverifiable guess can never clear the
 * restart-required flag.
 */
export async function markDesktopSyncActive(options = {}) {
  if (typeof options.desktopVerifierImpl !== "function") {
    throw codedError("DESKTOP_SYNC_VERIFIER_REQUIRED", "A Desktop shared-daemon verifier is required.");
  }
  const paths = desktopSyncPaths(options);
  const state = safeStateForWrite(options);
  if (launchctlGet(options) !== DESKTOP_ENVIRONMENT_VALUE || state.activation?.value !== DESKTOP_ENVIRONMENT_VALUE) {
    throw codedError("DESKTOP_SYNC_NOT_ACTIVATING", "Desktop sync activation has not begun.");
  }
  const verification = await options.desktopVerifierImpl({ paths, state });
  if (verification !== true && verification?.shared !== true) {
    throw codedError("DESKTOP_SYNC_DESKTOP_NOT_SHARED", "Codex Desktop is not verified on the shared daemon.");
  }
  const activeAt = timestamp(options);
  const next = {
    ...state,
    activation: {
      ...state.activation,
      activeAt,
      desktopVerified: true,
    },
  };
  writeDesktopSyncState(next, options);
  return { active: true, activeAt, desktopRestartRequired: false };
}

export function rollbackDesktopSyncActivation(options = {}) {
  const state = readDesktopSyncState(options);
  const activation = state?.activation;
  if (!activation?.owned || activation.environment !== DESKTOP_ENVIRONMENT_NAME || activation.value !== DESKTOP_ENVIRONMENT_VALUE) {
    return { changed: false, reason: "not-owned" };
  }
  const current = launchctlGet(options);
  if (current && current !== activation.value) return { changed: false, reason: "environment-changed" };
  if (current === activation.value) launchctlChange("unset", options);
  const next = { ...state };
  delete next.activation;
  writeDesktopSyncState(next, options);
  return { changed: current === activation.value, reason: current ? "removed" : "already-absent" };
}

/**
 * Remove only our unchanged standalone link, and only after activation and the
 * managed daemon are both inactive. Bootstrap artifacts are intentionally not
 * guessed at or deleted.
 */
export function rollbackDesktopSyncPreparation(options = {}) {
  const paths = desktopSyncPaths(options);
  const state = readDesktopSyncState(options);
  const record = stateStandaloneRecord(state);
  if (!record?.owned || !samePath(record.path || "", paths.standalone)) return { changed: false, reason: "not-owned" };
  if (launchctlGet(options) === DESKTOP_ENVIRONMENT_VALUE) return { changed: false, reason: "activation-enabled" };
  if (executable(paths.standalone) && inspectDaemon(paths.standalone, paths, options).running) {
    return { changed: false, reason: "daemon-running" };
  }
  // A failed version probe is not proof that a daemon is gone. A remaining
  // control socket makes teardown ambiguous, so preserve the owned link.
  if (existsSync(paths.socket)) return { changed: false, reason: "daemon-status-unknown" };
  const existing = lstat(paths.standalone);
  if (!existing) {
    const next = { ...state, preparation: { ...(state.preparation || {}), standalone: { ...record, owned: false, removedAt: timestamp(options) } } };
    writeDesktopSyncState(next, options);
    return { changed: false, reason: "already-absent" };
  }
  if (!existing.isSymbolicLink() || !samePath(linkTarget(paths.standalone), record.target || "")) {
    return { changed: false, reason: "standalone-changed" };
  }
  rmSync(paths.standalone, { force: true });
  const next = { ...state, preparation: { ...(state.preparation || {}), standalone: { ...record, owned: false, removedAt: timestamp(options) } } };
  writeDesktopSyncState(next, options);
  return { changed: true, reason: "removed", daemonStopped: false };
}

export const desktopSyncValues = Object.freeze({
  stateSchemaVersion: STATE_SCHEMA_VERSION,
  stateOwner: STATE_OWNER,
  environmentName: DESKTOP_ENVIRONMENT_NAME,
  environmentValue: DESKTOP_ENVIRONMENT_VALUE,
});
