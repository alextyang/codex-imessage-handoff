#!/usr/bin/env node
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helperIdentityHash } from "./imsg-ipc-protocol.mjs";
import {
  ImsgHelperServer,
  inspectLocalImsgIdentity,
  parseLocalImsgIdentityOutput,
} from "./imsg-helper-server.mjs";

const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function parseOneJson(stdout, code, message) {
  try {
    const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length !== 1) throw new Error("invalid line count");
    const parsed = JSON.parse(lines[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed;
  } catch (error) {
    throw codedError(code, message, error);
  }
}

function runImsg(binary, args, { run = execFileSync, timeout = 15_000 } = {}) {
  try {
    return run(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw codedError("IMSG_HELPER_RUNTIME_UNAVAILABLE", "The private Messages runtime is unavailable.", error);
  }
}

function execFileText(binary, args, options) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function runImsgAsync(binary, args, {
  run = execFileText,
  timeout = 15_000,
  maxBuffer = 2 * 1024 * 1024,
  errorCode = "IMSG_HELPER_RUNTIME_UNAVAILABLE",
  errorMessage = "The private Messages runtime is unavailable.",
  signal,
} = {}) {
  try {
    const output = await run(binary, args, {
      encoding: "utf8",
      timeout,
      maxBuffer,
      signal,
    });
    return output && typeof output === "object" && !Buffer.isBuffer(output) && "stdout" in output
      ? output.stdout
      : output;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw codedError(errorCode, errorMessage, error);
  }
}

function bridgeReady(status) {
  return status?.advanced_features === true
    && status?.v2_ready === true
    && Array.isArray(status.rpc_methods)
    && status.rpc_methods.includes("watch.subscribe");
}

function bridgeStatus(binary, run) {
  return parseOneJson(
    runImsg(binary, ["status", "--json"], { run, timeout: 8_000 }),
    "IMSG_HELPER_STATUS_INVALID",
    "The private Messages bridge returned invalid status.",
  );
}

async function bridgeStatusAsync(binary, run, signal) {
  return parseOneJson(
    await runImsgAsync(binary, ["status", "--json"], {
      run,
      timeout: 8_000,
      signal,
    }),
    "IMSG_HELPER_STATUS_INVALID",
    "The private Messages bridge returned invalid status.",
  );
}

async function periodicHealthSample(config, run, signal) {
  if (!bridgeReady(await bridgeStatusAsync(config.imsgBinary, run, signal))) {
    throw codedError("IMSG_HELPER_BRIDGE_LOST", "The private Messages bridge stopped.");
  }
  const accountOutput = await runImsgAsync(config.imsgBinary, ["account", "--json"], {
    run,
    timeout: 15_000,
    maxBuffer: 512 * 1024,
    errorCode: "IMSG_ACCOUNT_UNAVAILABLE",
    errorMessage: "The live Messages account could not be inspected.",
    signal,
  });
  return parseLocalImsgIdentityOutput(accountOutput);
}

function sanitizedHealthFailure(error) {
  const rawCode = typeof error?.code === "string" ? error.code.trim() : "";
  const code = /^IMSG_[A-Z0-9_]{1,64}$/.test(rawCode)
    ? rawCode
    : "IMSG_HELPER_HEALTH_CHECK_FAILED";
  const message = code === "IMSG_HELPER_BRIDGE_LOST"
    ? "The private Messages bridge stopped."
    : code === "IMSG_HELPER_ACCOUNT_CHANGED"
      ? "The live Messages account changed."
      : "The private Messages runtime health check failed.";
  return codedError(code, message);
}

function writeHealthDiagnostic(value, write = (line) => process.stderr.write(line)) {
  const status = new Set(["retrying", "recovered", "failed"]).has(value?.status)
    ? value.status
    : "failed";
  const rawCode = typeof value?.code === "string" ? value.code.trim() : "";
  const code = /^IMSG_[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : "none";
  const consecutive = Number.isSafeInteger(value?.consecutiveFailures) && value.consecutiveFailures >= 0
    ? value.consecutiveFailures
    : 0;
  const threshold = Number.isSafeInteger(value?.failureThreshold) && value.failureThreshold > 0
    ? value.failureThreshold
    : DEFAULT_HEALTH_FAILURE_THRESHOLD;
  write(`IMSG_HELPER_HEALTH_${status.toUpperCase()}: code=${code} consecutive=${consecutive} threshold=${threshold}\n`);
}

function abortOutcome(signal, type) {
  let onAbort = null;
  const promise = signal
    ? new Promise((resolve) => {
      onAbort = () => resolve({ type });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })
    : new Promise(() => {});
  return {
    promise,
    cancel() {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function ensureDedicatedBridgeReady({
  binary,
  bridgeDylib,
  run = execFileSync,
  attempts = 80,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let status = bridgeStatus(binary, run);
  if (!bridgeReady(status)) {
    runImsg(binary, ["launch", "--json", "--dylib", bridgeDylib], { run, timeout: 30_000 });
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = bridgeStatus(binary, run);
    if (bridgeReady(status)) return status;
    if (attempt + 1 < attempts) await wait(250);
  }
  throw codedError("IMSG_HELPER_BRIDGE_NOT_READY", "The private Messages bridge did not become ready.");
}

function assertOwnedPrivateFile(file, { uid, home, executable = false } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw codedError("IMSG_HELPER_PRIVATE_PATH_INVALID", "A helper private file path is invalid.");
  }
  const original = lstatSync(file);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw codedError("IMSG_HELPER_PRIVATE_PATH_INVALID", "A helper private file must be a regular non-symlink.");
  }
  const resolved = realpathSync(file);
  const relative = path.relative(home, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw codedError("IMSG_HELPER_PRIVATE_PATH_INVALID", "A helper private file escaped the dedicated home.");
  }
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw codedError("IMSG_HELPER_PRIVATE_PATH_INVALID", "A helper private file has unsafe ownership or permissions.");
  }
  if (executable && (metadata.mode & 0o100) === 0) {
    throw codedError("IMSG_HELPER_PRIVATE_PATH_INVALID", "The private Messages runtime is not executable.");
  }
  return resolved;
}

export function readDedicatedHelperConfig(file, options = {}) {
  const uid = Number.isSafeInteger(options.uid) ? options.uid : process.getuid();
  const home = realpathSync(options.home || os.homedir());
  const configPath = assertOwnedPrivateFile(file, { uid, home });
  const metadata = lstatSync(configPath);
  if ((metadata.mode & 0o077) !== 0) throw codedError("IMSG_HELPER_CONFIG_UNSAFE", "The helper config must be mode 0600.");
  let config;
  try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch (error) {
    throw codedError("IMSG_HELPER_CONFIG_INVALID", "The helper config could not be read.", error);
  }
  if (config?.version !== 1 || typeof config.socketPath !== "string" || !path.isAbsolute(config.socketPath)
    || !/^[a-f0-9]{64}$/i.test(String(config.expectedControllerIdentityHash || ""))
    || !config.profile || typeof config.profile !== "object") {
    throw codedError("IMSG_HELPER_CONFIG_INVALID", "The helper config is incomplete.");
  }
  const expectedIdentityHash = helperIdentityHash({ uid, username: os.userInfo().username, home });
  if (config.expectedHelperIdentityHash !== expectedIdentityHash) {
    throw codedError("IMSG_HELPER_IDENTITY_MISMATCH", "The helper config belongs to a different macOS identity.");
  }
  return {
    ...config,
    expectedUid: uid,
    expectedUsername: os.userInfo().username,
    expectedHome: home,
    imsgBinary: assertOwnedPrivateFile(config.imsgBinary, { uid, home, executable: true }),
    bridgeDylib: assertOwnedPrivateFile(config.bridgeDylib, { uid, home }),
    helperPrivateKeyPath: assertOwnedPrivateFile(config.helperPrivateKeyPath, { uid, home }),
    controllerPublicKeyPath: assertOwnedPrivateFile(config.controllerPublicKeyPath, { uid, home }),
  };
}

async function healthMonitor(config, server, {
  run = execFileText,
  intervalMs = 5_000,
  failureThreshold = DEFAULT_HEALTH_FAILURE_THRESHOLD,
  onDiagnostic,
  wait,
  signal,
} = {}) {
  const threshold = Number.isSafeInteger(failureThreshold) && failureThreshold > 0
    ? failureThreshold
    : DEFAULT_HEALTH_FAILURE_THRESHOLD;
  let consecutiveFailures = 0;
  let fatalFailure = null;
  const fatalAbort = new AbortController();
  Promise.resolve(server.waitForFatal()).then(
    (error) => {
      fatalFailure = error || codedError("IMSG_RPC_CLOSED", "The supervised imsg RPC session exited.");
      fatalAbort.abort();
    },
    (error) => {
      fatalFailure = error instanceof Error
        ? error
        : codedError("IMSG_RPC_CLOSED", "The supervised imsg RPC session exited.");
      fatalAbort.abort();
    },
  );
  while (!signal?.aborted) {
    let timer = null;
    const tick = wait
      ? Promise.resolve(wait(intervalMs)).then(() => ({ type: "tick" }))
      : new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: "tick" }), intervalMs);
      });
    const stoppedTick = abortOutcome(signal, "stopped");
    const fatalTick = abortOutcome(fatalAbort.signal, "fatal");
    let tickOutcome;
    try {
      tickOutcome = await Promise.race([tick, stoppedTick.promise, fatalTick.promise]);
    } finally {
      if (timer) clearTimeout(timer);
      stoppedTick.cancel();
      fatalTick.cancel();
    }
    if (fatalAbort.signal.aborted || tickOutcome.type === "fatal") throw fatalFailure;
    if (signal?.aborted || tickOutcome.type === "stopped") return;
    const probeAbort = new AbortController();
    const stopProbe = () => probeAbort.abort();
    signal?.addEventListener("abort", stopProbe, { once: true });
    fatalAbort.signal.addEventListener("abort", stopProbe, { once: true });
    const sample = periodicHealthSample(config, run, probeAbort.signal).then(
      (live) => ({ type: "sample", live }),
      (error) => ({ type: "sample-error", error }),
    );
    const stoppedSample = abortOutcome(signal, "stopped");
    const fatalSample = abortOutcome(fatalAbort.signal, "fatal");
    let outcome;
    try {
      outcome = await Promise.race([sample, fatalSample.promise, stoppedSample.promise]);
    } finally {
      signal?.removeEventListener("abort", stopProbe);
      fatalAbort.signal.removeEventListener("abort", stopProbe);
      stoppedSample.cancel();
      fatalSample.cancel();
    }
    if (fatalAbort.signal.aborted || outcome.type === "fatal") {
      probeAbort.abort();
      throw fatalFailure;
    }
    if (outcome.type === "stopped" || signal?.aborted) {
      probeAbort.abort();
      return;
    }
    if (outcome.type === "sample-error") {
      const error = outcome.error;
      consecutiveFailures += 1;
      const sanitized = sanitizedHealthFailure(error);
      try {
        onDiagnostic?.({
          status: consecutiveFailures >= threshold ? "failed" : "retrying",
          code: sanitized.code,
          consecutiveFailures,
          failureThreshold: threshold,
        });
      } catch {}
      if (consecutiveFailures >= threshold) throw sanitized;
      continue;
    }
    const live = outcome.live;
    // A completed identity read is authoritative. A different fingerprint is
    // not a transient probe failure and must retire the helper immediately so
    // no operation can cross the pinned Messages-account boundary.
    if (live.accountFingerprint !== config.profile.accountFingerprint) {
      consecutiveFailures += 1;
      const sanitized = sanitizedHealthFailure(codedError(
        "IMSG_HELPER_ACCOUNT_CHANGED",
        "The live Messages account changed.",
      ));
      try {
        onDiagnostic?.({
          status: "failed",
          code: sanitized.code,
          consecutiveFailures,
          failureThreshold: threshold,
        });
      } catch {}
      throw sanitized;
    }
    if (consecutiveFailures > 0) {
      try {
        onDiagnostic?.({
          status: "recovered",
          code: null,
          consecutiveFailures: 0,
          failureThreshold: threshold,
        });
      } catch {}
      consecutiveFailures = 0;
    }
  }
}

export async function runDedicatedImsgHelper(options = {}) {
  const configPath = options.configPath || process.env.IMSG_HELPER_CONFIG;
  if (!configPath || !path.isAbsolute(configPath)) {
    throw codedError("IMSG_HELPER_CONFIG_INVALID", "IMSG_HELPER_CONFIG must name a private absolute path.");
  }
  const config = readDedicatedHelperConfig(configPath, options);
  await ensureDedicatedBridgeReady({
    binary: config.imsgBinary,
    bridgeDylib: config.bridgeDylib,
    run: options.run || execFileSync,
    wait: options.wait,
  });
  const live = inspectLocalImsgIdentity({ binary: config.imsgBinary, run: options.run || execFileSync });
  if (live.accountFingerprint !== config.profile.accountFingerprint) {
    throw codedError("IMSG_HELPER_ACCOUNT_CHANGED", "The live Messages account changed.");
  }
  const privateKey = createPrivateKey(readFileSync(config.helperPrivateKeyPath));
  const controllerPublicKey = readFileSync(config.controllerPublicKeyPath);
  if (createPublicKey(controllerPublicKey).asymmetricKeyType !== "ed25519") {
    throw codedError("IMSG_HELPER_KEY_INVALID", "The pinned controller key must use Ed25519.");
  }
  const server = new ImsgHelperServer({
    socketPath: config.socketPath,
    privateKey,
    controllerPublicKey,
    expectedControllerIdentityHash: config.expectedControllerIdentityHash,
    expectedUid: config.expectedUid,
    expectedUsername: config.expectedUsername,
    expectedHome: config.expectedHome,
    profile: config.profile,
    onFatal: options.onFatal,
  });
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  const onHealthDiagnostic = typeof options.onHealthDiagnostic === "function"
    ? options.onHealthDiagnostic
    : (value) => writeHealthDiagnostic(value, options.writeHealthDiagnostic);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await server.start();
    await healthMonitor(config, server, {
      run: options.healthRun || options.run || execFileText,
      intervalMs: options.healthIntervalMs,
      failureThreshold: options.healthFailureThreshold,
      onDiagnostic: onHealthDiagnostic,
      wait: options.wait,
      signal: shutdown.signal,
    });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await server.stop();
  }
}

async function main() {
  try {
    await runDedicatedImsgHelper();
  } catch (error) {
    process.stderr.write((error?.code || "IMSG_HELPER_FAILED") + ": "
      + (error instanceof Error ? error.message : "The Messages helper failed.") + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}

export const imsgHelperEntryInternals = Object.freeze({
  bridgeReady,
  bridgeStatus,
  healthMonitor,
  periodicHealthSample,
  runImsg,
  runImsgAsync,
  sanitizedHealthFailure,
  writeHealthDiagnostic,
});
