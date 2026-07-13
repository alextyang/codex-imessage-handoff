#!/usr/bin/env node
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helperIdentityHash } from "./imsg-ipc-protocol.mjs";
import { ImsgHelperServer, inspectLocalImsgIdentity } from "./imsg-helper-server.mjs";

const HEALTH_STOPPED = Symbol("health-stopped");

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
  run = execFileSync,
  intervalMs = 5_000,
  wait,
  signal,
} = {}) {
  while (!signal?.aborted) {
    const fatal = server.waitForFatal();
    const tick = wait
      ? Promise.resolve(wait(intervalMs)).then(() => signal?.aborted ? HEALTH_STOPPED : null)
      : new Promise((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(null);
        }, intervalMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(HEALTH_STOPPED);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    const failure = await Promise.race([fatal, tick]);
    if (failure === HEALTH_STOPPED || signal?.aborted) return;
    if (failure) throw failure;
    if (!bridgeReady(bridgeStatus(config.imsgBinary, run))) {
      throw codedError("IMSG_HELPER_BRIDGE_LOST", "The private Messages bridge stopped.");
    }
    const live = inspectLocalImsgIdentity({ binary: config.imsgBinary, run });
    if (live.accountFingerprint !== config.profile.accountFingerprint) {
      throw codedError("IMSG_HELPER_ACCOUNT_CHANGED", "The live Messages account changed.");
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
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await server.start();
    await healthMonitor(config, server, {
      run: options.run || execFileSync,
      intervalMs: options.healthIntervalMs,
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

export const imsgHelperEntryInternals = Object.freeze({ bridgeReady, bridgeStatus, healthMonitor, runImsg });
