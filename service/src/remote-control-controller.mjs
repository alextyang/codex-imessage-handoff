import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { writePrivateJson } from "./config.mjs";
import {
  CREATE_DEVICE_KEY_POLICY,
  DEVICE_KEY_CLASSES,
  createRemoteControlKeyClient,
} from "./remote-control-key-helper.mjs";

const require = createRequire(import.meta.url);

export const REMOTE_CONTROL_PROTOCOL_VERSION = 3;
export const REMOTE_CONTROL_SCOPE = "remote_control_controller_websocket";
export const REMOTE_CONTROL_ENROLL_SCOPE = "codex.remote_control.enroll";
export const REMOTE_CONTROL_API_BASE = "https://chatgpt.com/backend-api";
export const REMOTE_CONTROL_WEBSOCKET_URL = `${REMOTE_CONTROL_API_BASE.replace(/^http/, "ws")}/codex/remote/control/client`;
export const REMOTE_CONTROL_ORIGINATOR = "Codex Desktop";
export const DEVICE_KEY_SIGNING_DOMAIN = "codex-device-key-sign-payload/v1";
export const DEVICE_KEY_PROTECTION_CLASS = CREATE_DEVICE_KEY_POLICY;
export const DEFAULT_CHATGPT_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
export const CONTROLLER_STATE_SCHEMA_VERSION = 1;
export const SUPPORTED_CODEX_APP_VERSION = "26.707.72221";
export const SUPPORTED_CODEX_BUILD_VERSION = "5307";
export const SUPPORTED_APP_SERVER_VERSION = "0.144.2";
export const SUPPORTED_DEVICE_KEY_SHA256 = "fc96fe2cd44fbd1612ce5a0864899c97e4e3ae4035112c174c8337e228c7441b";
export const SUPPORTED_APP_ASAR_SHA256 = "b5da51e5df6e996076e4cb19045cec46dd4c08cf61c19cdbc5cb426b8413b73c";
export const OPENAI_APPLE_TEAM_ID = "2DC432GLL2";

const EXPECTED_DEVICE_ALGORITHM = "ecdsa_p256_sha256";
const SESSION_SCOPES = Object.freeze([REMOTE_CONTROL_SCOPE]);
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_CALLBACK_PORTS = Object.freeze([1455, 1457]);
const OAUTH_CALLBACK_PATH = "/auth/callback";
const MANUAL_PAIRING_CODE_PATTERN = /^[A-Z0-9]{8}$/u;

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function normalizeManualPairingCode(value) {
  const compact = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, 8);
  if (!MANUAL_PAIRING_CODE_PATTERN.test(compact)) {
    throw codedError(
      "CODEX_REMOTE_PAIRING_CODE_INVALID",
      "Enter the 8-character pairing code shown by Codex Desktop.",
    );
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function withEnrollmentLock(file, callback) {
  const lockFile = `${file}.lock`;
  const token = randomBytes(24).toString("base64url");
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let descriptor = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockFile, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      closeSync(descriptor);
      descriptor = null;
      break;
    } catch (error) {
      if (descriptor !== null) { try { closeSync(descriptor); } catch {} descriptor = null; }
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const value = JSON.parse(readFileSync(lockFile, "utf8"));
        const age = Date.now() - Date.parse(String(value.createdAt || ""));
        const pid = Number(value.pid);
        stale = !Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)
          || (Number.isFinite(age) && age > 15 * 60_000);
      } catch { stale = true; }
      if (!stale || attempt > 0) {
        throw codedError("CODEX_REMOTE_AUTH_IN_PROGRESS", "Remote Control setup is already in progress.");
      }
      rmSync(lockFile, { force: true });
    }
  }
  if (!existsSync(lockFile)) throw codedError("CODEX_REMOTE_AUTH_IN_PROGRESS", "Remote Control setup lock could not be acquired.");
  try {
    return await callback();
  } finally {
    try {
      const value = JSON.parse(readFileSync(lockFile, "utf8"));
      if (value.token === token) rmSync(lockFile, { force: true });
    } catch {}
  }
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2 || !parts[1]) throw codedError("CODEX_AUTH_REQUIRED", "Codex sign-in is unavailable.");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (error) {
    throw codedError("CODEX_AUTH_REQUIRED", "Codex sign-in is invalid.", error);
  }
}

function authIdentity(token, configuredAccountId = null) {
  const payload = parseJwt(token);
  const auth = payload?.["https://api.openai.com/auth"] || {};
  const accountId = auth.chatgpt_account_id || auth.account_id || configuredAccountId || null;
  const accountUserId = auth.chatgpt_account_user_id || auth.account_user_id || null;
  const authUserId = auth.user_id || null;
  const expiresAt = Number(payload.exp || 0);
  if (!accountId || !accountUserId || !expiresAt || expiresAt <= Math.floor(Date.now() / 1000) + 15) {
    throw codedError("CODEX_AUTH_REQUIRED", "Codex sign-in must be refreshed in the Codex app.");
  }
  return { accessToken: token, accountId, accountUserId, authUserId, expiresAt, payload };
}

function identityMatchesAccountUser(identity, accountUserId) {
  return accountUserId === identity.accountUserId
    || (Boolean(identity.authUserId) && accountUserId === identity.authUserId);
}

function identityFingerprint(identity) {
  return createHash("sha256").update(JSON.stringify({
    accessToken: identity.accessToken,
    accountId: identity.accountId,
    accountUserId: identity.accountUserId,
  })).digest("base64url");
}

export function readCodexAuth(options = {}) {
  const authFile = options.authFile || path.join(options.codexHome || path.join(os.homedir(), ".codex"), "auth.json");
  let metadata;
  let value;
  try {
    metadata = lstatSync(authFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      throw new Error("unsafe auth file");
    }
    value = JSON.parse(readFileSync(authFile, "utf8"));
  } catch (error) {
    throw codedError("CODEX_AUTH_REQUIRED", "Sign in to Codex in the Codex app before using iMessage remote access.", error);
  }
  const token = value?.tokens?.access_token;
  if (typeof token !== "string" || !token) {
    throw codedError("CODEX_AUTH_REQUIRED", "Sign in to Codex in the Codex app before using iMessage remote access.");
  }
  return authIdentity(token, value?.tokens?.account_id || null);
}

function readJsonObject(file, code, message) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw codedError(code, message, error);
  }
}

export function readDesktopRemoteIdentity(options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), ".codex");
  const stateFile = options.globalStateFile || path.join(codexHome, ".codex-global-state.json");
  const state = readJsonObject(stateFile, "CODEX_HOST_UNAVAILABLE", "Codex Remote Control has not been enabled in the Codex app.");
  const envId = String(state["electron-local-remote-control-environment-id"] || "").trim();
  const installationId = String(state["electron-local-remote-control-installation-id"] || "").trim();
  if (!envId || !installationId) {
    throw codedError("CODEX_HOST_UNAVAILABLE", "Enable Remote Control in the Codex app before using iMessage remote access.");
  }
  return { envId, installationId };
}

function normalizeEnrollment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = {
    schemaVersion: Number(value.schemaVersion),
    accountUserId: String(value.accountUserId || "").trim(),
    clientId: String(value.clientId || "").trim(),
    keyId: String(value.keyId || "").trim(),
    publicKeySpkiDerBase64: String(value.publicKeySpkiDerBase64 || "").trim(),
    algorithm: String(value.algorithm || "").trim(),
    protectionClass: String(value.protectionClass || "").trim(),
    createdAt: String(value.createdAt || "").trim() || null,
  };
  if (record.schemaVersion !== CONTROLLER_STATE_SCHEMA_VERSION
    || !record.accountUserId || !record.clientId || !record.keyId || !record.publicKeySpkiDerBase64
    || record.algorithm !== EXPECTED_DEVICE_ALGORITHM
    || !DEVICE_KEY_CLASSES.includes(record.protectionClass)) return null;
  return record;
}

export function readControllerEnrollment(file) {
  if (!existsSync(file)) return null;
  let metadata;
  try {
    metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) return null;
    return normalizeEnrollment(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function saveControllerEnrollment(file, enrollment) {
  const normalized = normalizeEnrollment({
    ...enrollment,
    schemaVersion: CONTROLLER_STATE_SCHEMA_VERSION,
    createdAt: enrollment.createdAt || new Date().toISOString(),
  });
  if (!normalized) throw codedError("CODEX_REMOTE_ENROLLMENT_INVALID", "The Remote Control enrollment is invalid.");
  writePrivateJson(file, normalized);
  chmodSync(file, 0o600);
  return normalized;
}

function regularNativeAddon(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function loadDeviceKeyClient(options = {}) {
  const resourcesPath = realpathSync(options.resourcesPath || DEFAULT_CHATGPT_RESOURCES);
  if (options.allowUnverifiedBundle !== true) {
    const appPath = realpathSync(options.appPath || "/Applications/ChatGPT.app");
    if (resourcesPath !== path.join(appPath, "Contents", "Resources")) {
      throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The Remote Control device-key module is outside the verified Codex app bundle.");
    }
    const run = options.spawnSyncImpl || spawnSync;
    const verified = run("/usr/bin/codesign", ["--verify", appPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const details = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (verified.status !== 0 || details.status !== 0
      || !String(details.stderr || "").includes(`TeamIdentifier=${OPENAI_APPLE_TEAM_ID}`)) {
      throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The installed Codex app signature could not be verified.");
    }
  }
  const addonPath = path.join(resourcesPath, "native", "remote-control-device-key.node");
  if (!regularNativeAddon(addonPath)) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "This Codex version does not provide the required Remote Control device-key support.");
  }
  if (options.allowUnverifiedBundle !== true) {
    const addonHash = createHash("sha256").update(readFileSync(addonPath)).digest("hex");
    if (addonHash !== SUPPORTED_DEVICE_KEY_SHA256) {
      throw codedError("CODEX_REMOTE_UPDATE_REQUIRED", "Codex was updated and iMessage Remote Access must be updated before reconnecting.");
    }
  }
  let addon;
  try {
    addon = (options.requireImpl || require)(addonPath);
  } catch (error) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The Codex Remote Control device-key module is incompatible.", error);
  }
  for (const method of ["createDeviceKey", "deleteDeviceKey", "getDeviceKeyPublic", "signDeviceKey"]) {
    if (typeof addon?.[method] !== "function") {
      throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The Codex Remote Control device-key module is incomplete.");
    }
  }
  return {
    createDeviceKey: (protectionClass = DEVICE_KEY_PROTECTION_CLASS) => addon.createDeviceKey(protectionClass),
    deleteDeviceKey: (keyId) => addon.deleteDeviceKey(keyId),
    getDeviceKeyPublic: (keyId) => addon.getDeviceKeyPublic(keyId),
    async signDeviceKey(keyId, payload) {
      const signedPayload = encodeSignedDevicePayload(payload);
      const signature = await addon.signDeviceKey(keyId, signedPayload);
      return { ...signature, signedPayloadBase64: signedPayload.toString("base64") };
    },
  };
}

export function loadServiceDeviceKeyClient(options = {}) {
  const helper = createRemoteControlKeyClient(options);
  return {
    createDeviceKey: (policy = CREATE_DEVICE_KEY_POLICY) => helper.createDeviceKey(policy),
    deleteDeviceKey: (keyId) => helper.deleteDeviceKey(keyId),
    getDeviceKeyPublic: (keyId) => helper.getDeviceKeyPublic(keyId),
    async signDeviceKey(keyId, payload) {
      const signedPayload = encodeSignedDevicePayload(payload);
      const signature = await helper.signDeviceKey(keyId, signedPayload);
      return { ...signature, signedPayloadBase64: signedPayload.toString("base64") };
    },
  };
}

function assertDigest(value, label) {
  if (!NONCE_PATTERN.test(value) || Buffer.from(value, "base64url").length !== 32) {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", `The Remote Control ${label} is invalid.`);
  }
}

function assertNonce(value) {
  if (!NONCE_PATTERN.test(value) || Buffer.from(value, "base64url").length < 32) {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control nonce is invalid.");
  }
}

export function encodeSignedDevicePayload(value) {
  let payload;
  if (value?.type === "remoteControlClientConnection") {
    assertNonce(value.nonce);
    assertDigest(value.tokenSha256Base64url, "session token digest");
    if (value.audience !== "remote_control_client_websocket"
      || value.scopes?.length !== 1 || value.scopes[0] !== REMOTE_CONTROL_SCOPE) {
      throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control connection challenge is invalid.");
    }
    payload = {
      accountUserId: value.accountUserId,
      audience: value.audience,
      clientId: value.clientId,
      nonce: value.nonce,
      scopes: value.scopes,
      sessionId: value.sessionId,
      targetOrigin: value.targetOrigin,
      targetPath: value.targetPath,
      tokenExpiresAt: value.tokenExpiresAt,
      tokenSha256Base64url: value.tokenSha256Base64url,
      type: value.type,
    };
  } else if (value?.type === "remoteControlClientEnrollment") {
    assertNonce(value.nonce);
    assertDigest(value.deviceIdentitySha256Base64url, "device identity digest");
    if (value.audience !== "remote_control_client_enrollment") {
      throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control enrollment challenge is invalid.");
    }
    payload = {
      accountUserId: value.accountUserId,
      audience: value.audience,
      challengeExpiresAt: value.challengeExpiresAt,
      challengeId: value.challengeId,
      clientId: value.clientId,
      deviceIdentitySha256Base64url: value.deviceIdentitySha256Base64url,
      nonce: value.nonce,
      targetOrigin: value.targetOrigin,
      targetPath: value.targetPath,
      type: value.type,
    };
  } else {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control device-key payload is unsupported.");
  }
  return Buffer.from(JSON.stringify({ domain: DEVICE_KEY_SIGNING_DOMAIN, payload }), "utf8");
}

function deviceIdentityHash(enrollment) {
  return createHash("sha256").update(JSON.stringify({
    algorithm: enrollment.algorithm,
    keyId: enrollment.keyId,
    protectionClass: enrollment.protectionClass,
    publicKeySpkiDerBase64: enrollment.publicKeySpkiDerBase64,
  })).digest("base64url");
}

function targetForUrl(value) {
  const url = new URL(value);
  return { targetOrigin: url.origin, targetPath: url.pathname };
}

function targetForWebSocketUrl(value) {
  const url = new URL(value);
  const protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : null;
  if (!protocol) throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control WebSocket URL is invalid.");
  return { targetOrigin: `${protocol}//${url.host}`, targetPath: url.pathname };
}

function apiHeaders(identity, appVersion) {
  return {
    Authorization: `Bearer ${identity.accessToken}`,
    "ChatGPT-Account-Id": identity.accountId,
    originator: REMOTE_CONTROL_ORIGINATOR,
    "User-Agent": `Codex Desktop/${appVersion} (Mac OS; ${process.arch})`,
  };
}

function normalizeAppVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The installed Codex app version could not be verified.");
  }
  return version;
}

export function installedCodexAppVersion(options = {}) {
  if (options.appVersion) return normalizeAppVersion(options.appVersion);
  const appPath = options.appPath || "/Applications/ChatGPT.app";
  try {
    return normalizeAppVersion((options.execFileSyncImpl || execFileSync)("/usr/bin/plutil", [
      "-extract", "CFBundleShortVersionString", "raw", path.join(appPath, "Contents", "Info.plist"),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim());
  } catch (error) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The installed Codex app version could not be verified.", error);
  }
}

export function installedCodexAppServerVersion(options = {}) {
  if (options.appServerVersion) return normalizeAppVersion(options.appServerVersion);
  const codexBin = options.codexBin || "/Applications/ChatGPT.app/Contents/Resources/codex";
  try {
    const output = (options.execFileSyncImpl || execFileSync)(codexBin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    return normalizeAppVersion(/^codex-cli\s+(\S+)/.exec(output)?.[1] || "");
  } catch (error) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The installed Codex app-server version could not be verified.", error);
  }
}

export function installedCodexBuildVersion(options = {}) {
  if (options.buildVersion) return String(options.buildVersion).trim();
  const appPath = options.appPath || "/Applications/ChatGPT.app";
  try {
    const build = (options.execFileSyncImpl || execFileSync)("/usr/bin/plutil", [
      "-extract", "CFBundleVersion", "raw", path.join(appPath, "Contents", "Info.plist"),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
    if (!/^\d+$/.test(build)) throw new Error("invalid build");
    return build;
  } catch (error) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The installed Codex build could not be verified.", error);
  }
}

function verifyCodexBundle(options = {}) {
  if (options.allowUnverifiedBundle === true) return;
  const appPath = realpathSync(options.appPath || "/Applications/ChatGPT.app");
  const resourcesPath = realpathSync(options.resourcesPath || DEFAULT_CHATGPT_RESOURCES);
  if (resourcesPath !== path.join(appPath, "Contents", "Resources")) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The Codex resources directory is outside the signed app bundle.");
  }
  const run = options.spawnSyncImpl || spawnSync;
  const verified = run("/usr/bin/codesign", ["--verify", appPath], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  const details = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  const asar = path.join(resourcesPath, "app.asar");
  if (verified.status !== 0 || details.status !== 0
    || !String(details.stderr || "").includes(`TeamIdentifier=${OPENAI_APPLE_TEAM_ID}`)
    || createHash("sha256").update(readFileSync(asar)).digest("hex") !== SUPPORTED_APP_ASAR_SHA256) {
    throw codedError("CODEX_REMOTE_UPDATE_REQUIRED", "Codex was updated and iMessage Remote Access must be updated before reconnecting.");
  }
}

async function fetchJson(fetchImpl, url, init, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(options.timeoutMs || 15_000),
    });
  } catch (error) {
    throw codedError("CODEX_REMOTE_UNAVAILABLE", "Codex Remote Control is temporarily unavailable.", error);
  }
  if (!response.ok) {
    const status = Number(response.status);
    let detail = "";
    try {
      const text = typeof response.text === "function" ? await response.text() : "";
      if (text) {
        try { detail = String(JSON.parse(text)?.detail || ""); } catch { detail = String(text); }
      }
    } catch {}
    const mapped = typeof options.mapHttpError === "function"
      ? options.mapHttpError(status, detail)
      : null;
    if (mapped?.code && mapped?.message) {
      throw Object.assign(codedError(mapped.code, mapped.message), { status });
    }
    const enrollmentInvalid = /enrollment is incomplete|client has been revoked|key material missing/i.test(detail);
    const code = enrollmentInvalid || status === 404 ? "CODEX_REMOTE_ENROLLMENT_REQUIRED"
      : status === 401 ? "CODEX_AUTH_REQUIRED"
        : status === 403 ? "CODEX_REMOTE_FORBIDDEN"
          : "CODEX_REMOTE_UNAVAILABLE";
    throw Object.assign(codedError(code, code === "CODEX_REMOTE_ENROLLMENT_REQUIRED" || status === 403
        ? "Authorize this Mac for Codex Remote Control."
        : status === 401
          ? "Codex sign-in must be refreshed in the Codex app."
        : "Codex Remote Control is temporarily unavailable."), { status });
  }
  try {
    return await response.json();
  } catch (error) {
    throw codedError("CODEX_REMOTE_PROTOCOL_ERROR", "Codex Remote Control returned an invalid response.", error);
  }
}

function pairingHttpError(status) {
  if (status === 401) {
    return {
      code: "CODEX_AUTH_REQUIRED",
      message: "Codex sign-in must be refreshed in the Codex app.",
    };
  }
  if (status === 403) {
    return {
      code: "CODEX_REMOTE_PAIRING_FORBIDDEN",
      message: "This Codex account is not permitted to pair the Remote Control client.",
    };
  }
  if (status === 404) {
    return {
      code: "CODEX_REMOTE_PAIRING_UNAVAILABLE",
      message: "Manual Codex Remote Control pairing is not available for this account or app build.",
    };
  }
  return {
    code: "CODEX_REMOTE_PAIRING_FAILED",
    message: "Codex could not pair this Remote Control client.",
  };
}

function validatePinnedEnvironment(environment, expected, appServerVersion, { requireOnline = true } = {}) {
  if (!environment || environment.env_id !== expected.envId) {
    throw codedError(
      "CODEX_REMOTE_PAIRING_REQUIRED",
      "Pair this Remote Control client with Codex Desktop before starting iMessage remote access.",
    );
  }
  if (environment.installation_id !== expected.installationId) {
    throw codedError("CODEX_REMOTE_HOST_MISMATCH", "Remote Control resolved a different Codex installation.");
  }
  if (environment.client_type !== "CODEX_DESKTOP_APP") {
    throw codedError("CODEX_REMOTE_HOST_MISMATCH", "Remote Control resolved a non-Desktop Codex host.");
  }
  if (environment.app_server_version !== appServerVersion) {
    throw codedError("CODEX_REMOTE_INCOMPATIBLE", "The Codex app and its Remote Control host are different versions.");
  }
  if (requireOnline && environment.online !== true) {
    throw codedError("CODEX_HOST_OFFLINE", "Open Codex on this Mac to continue from iMessage.");
  }
  return { envId: expected.envId, environment };
}

function writeCallbackResponse(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType, Connection: "close" });
  response.end(body);
}

async function createOAuthCallbackServer(options = {}) {
  const expectedState = options.state;
  const timeoutMs = options.timeoutMs || 10 * 60_000;
  let settle;
  let reject;
  let settled = false;
  const authorizationCode = new Promise((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  // The authorization task may be cancelled before its caller begins awaiting
  // the callback. Keep that early rejection observed without hiding it from
  // the returned promise.
  authorizationCode.catch(() => {});
  let server = null;
  let selectedPort = null;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  const handler = (request, response) => {
    try {
      const url = new URL(request.url || "", `http://localhost:${selectedPort}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        writeCallbackResponse(response, 404, "Not Found");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        writeCallbackResponse(response, 400, "State mismatch");
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        const description = url.searchParams.get("error_description");
        writeCallbackResponse(response, 400, "Remote control authorization failed");
        finish(() => reject(codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", description || oauthError)));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        writeCallbackResponse(response, 400, "Missing authorization code");
        return;
      }
      writeCallbackResponse(response, 200, `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Remote access authorized</title><style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:90vh;background:#212121;color:#f5f5f5}main{max-width:34rem;text-align:center;padding:2rem}h1{font-size:1.7rem}</style><main><h1>Remote access authorized</h1><p>You can close this page and return to Codex.</p></main>`, "text/html; charset=utf-8");
      finish(() => settle(code));
    } catch (error) {
      writeCallbackResponse(response, 400, "Bad Request");
      finish(() => reject(error));
    }
  };
  for (const port of options.ports || OAUTH_CALLBACK_PORTS) {
    const candidate = http.createServer(handler);
    try {
      await new Promise((resolve, rejectListen) => {
        candidate.once("error", rejectListen);
        candidate.listen(port, "localhost", () => {
          candidate.off("error", rejectListen);
          resolve();
        });
      });
      server = candidate;
      selectedPort = port;
      break;
    } catch (error) {
      candidate.close();
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  if (!server || !selectedPort) {
    throw codedError("CODEX_REMOTE_AUTH_CALLBACK_UNAVAILABLE", "Remote Control authorization callback ports 1455 and 1457 are in use.");
  }
  const timer = setTimeout(() => {
    finish(() => reject(codedError("CODEX_REMOTE_AUTH_TIMEOUT", "Timed out waiting for Remote Control authorization.")));
  }, timeoutMs);
  timer.unref?.();
  return {
    redirectUri: `http://localhost:${selectedPort}${OAUTH_CALLBACK_PATH}`,
    authorizationCode,
    close() {
      server?.close();
      finish(() => reject(codedError("CODEX_REMOTE_AUTH_CANCELLED", "Remote Control authorization was cancelled.")));
    },
  };
}

function buildAuthorizationUrl({ issuer = OAUTH_ISSUER, redirectUri, codeChallenge, state, accountId }) {
  const url = new URL("/oauth/authorize", issuer.replace(/\/+$/, ""));
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: REMOTE_CONTROL_ENROLL_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    originator: REMOTE_CONTROL_ORIGINATOR,
    reauth: "remote_control",
    max_age: "0",
    codex_cli_simplified_flow: "true",
    ...(accountId ? { allowed_workspace_id: accountId, current_workspace_id: accountId } : {}),
  });
  return url.toString();
}

async function requestEnrollmentStepUpToken({ identity, fetchImpl = globalThis.fetch, openExternal, timeoutMs, issuer = OAUTH_ISSUER }) {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const callback = await createOAuthCallbackServer({ state, timeoutMs });
  try {
    const authorizationUrl = buildAuthorizationUrl({
      issuer,
      redirectUri: callback.redirectUri,
      codeChallenge,
      state,
      accountId: identity.accountId,
    });
    await openExternal(authorizationUrl);
    const code = await callback.authorizationCode;
    const response = await fetchImpl(new URL("/oauth/token", issuer.replace(/\/+$/, "")).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callback.redirectUri,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", `Remote Control authorization exchange failed (${response.status}).`);
    }
    const value = await response.json();
    if (typeof value?.access_token !== "string" || !value.access_token) {
      throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", "Remote Control authorization did not return a step-up token.");
    }
    return value.access_token;
  } finally {
    callback.close();
  }
}

function validateStepUpToken(token, expectedAccountUserId) {
  const payload = parseJwt(token);
  const auth = payload?.["https://api.openai.com/auth"] || {};
  const accountUserIds = new Set([
    auth.chatgpt_account_user_id,
    auth.account_user_id,
    auth.user_id,
  ].filter((value) => typeof value === "string" && value));
  const scopes = new Set([
    ...String(payload.scope || "").split(/\s+/).filter(Boolean),
    ...(Array.isArray(payload.scp) ? payload.scp.filter((value) => typeof value === "string" && value) : []),
  ]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!accountUserIds.has(expectedAccountUserId)
    || !Number.isFinite(payload.iat) || nowSeconds - payload.iat > 300 || payload.iat - nowSeconds > 30
    || !Number.isFinite(payload.pwd_auth_time) || Date.now() - payload.pwd_auth_time > 300_000
    || scopes.size !== 1 || !scopes.has(REMOTE_CONTROL_ENROLL_SCOPE)) {
    throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", "Remote Control authorization is not fresh or belongs to a different Codex account.");
  }
  return true;
}

function validatePublicKey(actual, enrollment) {
  return actual?.keyId === enrollment.keyId
    && actual?.publicKeySpkiDerBase64 === enrollment.publicKeySpkiDerBase64
    && actual?.algorithm === enrollment.algorithm
    && actual?.protectionClass === enrollment.protectionClass;
}

async function signEnrollmentChallenge({ challenge, enrollment, deviceKeyClient, expectedUrl, requireIdentityHash }) {
  const target = targetForUrl(expectedUrl);
  if (challenge?.purpose !== "remote_control_client_enrollment"
    || challenge?.audience !== "remote_control_client_enrollment"
    || challenge?.account_user_id !== enrollment.accountUserId
    || challenge?.client_id !== enrollment.clientId
    || challenge?.target_origin !== target.targetOrigin
    || challenge?.target_path !== target.targetPath) {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control enrollment challenge does not match this client.");
  }
  const expectedHash = deviceIdentityHash(enrollment);
  if (requireIdentityHash && !challenge.device_identity_hash) {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control enrollment challenge is incomplete.");
  }
  const identityHash = challenge.device_identity_hash || expectedHash;
  if (identityHash !== expectedHash) {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control enrollment challenge does not match this device.");
  }
  const signature = await deviceKeyClient.signDeviceKey(enrollment.keyId, {
    type: "remoteControlClientEnrollment",
    nonce: challenge.nonce,
    audience: challenge.audience,
    challengeId: challenge.challenge_id,
    targetOrigin: challenge.target_origin,
    targetPath: challenge.target_path,
    accountUserId: challenge.account_user_id,
    clientId: challenge.client_id,
    deviceIdentitySha256Base64url: identityHash,
    challengeExpiresAt: challenge.challenge_expires_at,
  });
  if (signature.algorithm !== enrollment.algorithm) {
    throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control signature algorithm changed unexpectedly.");
  }
  return {
    challenge_token: challenge.challenge_token,
    key_id: enrollment.keyId,
    signature_der_base64: signature.signatureDerBase64,
    signed_payload_base64: signature.signedPayloadBase64,
    algorithm: signature.algorithm,
  };
}

function validateSessionResponse(value, enrollment) {
  if (value?.client_id !== enrollment.clientId || value?.account_user_id !== enrollment.accountUserId) {
    throw codedError("CODEX_REMOTE_PROTOCOL_ERROR", "Codex returned a session for a different Remote Control client.");
  }
  const token = String(value.remote_control_token || "");
  const tokenExpiresAt = Math.floor(Date.parse(value.expires_at) / 1000);
  if (!token || !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Math.floor(Date.now() / 1000)
    || value.scopes?.length !== 1 || value.scopes[0] !== REMOTE_CONTROL_SCOPE) {
    throw codedError("CODEX_REMOTE_PROTOCOL_ERROR", "Codex returned an invalid Remote Control session.");
  }
  return { token, tokenExpiresAt, scopes: [...SESSION_SCOPES] };
}

export class RemoteControlController {
  constructor(options = {}) {
    this.codexHome = options.codexHome || path.join(os.homedir(), ".codex");
    this.authFile = options.authFile || path.join(this.codexHome, "auth.json");
    this.globalStateFile = options.globalStateFile || path.join(this.codexHome, ".codex-global-state.json");
    this.enrollmentFile = options.enrollmentFile || path.join(this.codexHome, "imessage-handoff", "remote-control-client.json");
    this.apiBase = String(options.apiBase || REMOTE_CONTROL_API_BASE).replace(/\/+$/, "");
    this.websocketUrl = options.websocketUrl || `${this.apiBase.replace(/^http/, "ws")}/codex/remote/control/client`;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    verifyCodexBundle(options);
    this.deviceKeyClient = options.deviceKeyClient || loadServiceDeviceKeyClient(options);
    this.appVersion = installedCodexAppVersion(options);
    this.buildVersion = installedCodexBuildVersion(options);
    this.appServerVersion = installedCodexAppServerVersion(options);
    if (options.allowUnverifiedBundle !== true
      && (this.appVersion !== SUPPORTED_CODEX_APP_VERSION
        || this.buildVersion !== SUPPORTED_CODEX_BUILD_VERSION
        || this.appServerVersion !== SUPPORTED_APP_SERVER_VERSION)) {
      throw codedError("CODEX_REMOTE_UPDATE_REQUIRED", "Codex was updated and iMessage Remote Access must be updated before reconnecting.");
    }
    this.cachedSession = null;
    this.cachedSessionIdentity = null;
    this.refreshPromise = null;
    this.authorizationPromise = null;
    this.pairingPromise = null;
  }

  identity() {
    return readCodexAuth({ authFile: this.authFile, codexHome: this.codexHome });
  }

  enrollment(required = true) {
    const record = readControllerEnrollment(this.enrollmentFile);
    if (!record && required) {
      throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", "Authorize iMessage Remote Access from this Mac once before using it.");
    }
    return record;
  }

  desktopIdentity() {
    return readDesktopRemoteIdentity({ codexHome: this.codexHome, globalStateFile: this.globalStateFile });
  }

  async verifyEnrollment(enrollment = this.enrollment()) {
    const identity = this.identity();
    if (!identityMatchesAccountUser(identity, enrollment.accountUserId)) {
      throw codedError("CODEX_REMOTE_ACCOUNT_MISMATCH", "The Remote Control client belongs to a different Codex account.");
    }
    let publicKey;
    try {
      publicKey = await this.deviceKeyClient.getDeviceKeyPublic(enrollment.keyId);
    } catch (error) {
      throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", "The Remote Control device key is no longer available; authorize this Mac again.", error);
    }
    if (!validatePublicKey(publicKey, enrollment)) {
      throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", "The Remote Control device key no longer matches this client.");
    }
    return { identity, enrollment };
  }

  async api(pathname, { method = "GET", body, identity = this.identity() } = {}) {
    const request = async (currentIdentity) => {
      const headers = apiHeaders(currentIdentity, this.appVersion);
      if (body !== undefined) headers["content-type"] = "application/json";
      return fetchJson(this.fetchImpl, `${this.apiBase}/${String(pathname).replace(/^\/+/, "")}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    try {
      return await request(identity);
    } catch (error) {
      if (error?.status !== 401) throw error;
      const latest = this.identity();
      if (latest.accessToken === identity.accessToken) {
        throw codedError("CODEX_AUTH_STALE", "Refresh Codex sign-in in the Codex app before using iMessage remote access.", error);
      }
      return request(latest);
    }
  }

  async listEnvironments(clientId = this.enrollment().clientId) {
    if (!clientId) {
      throw codedError("CODEX_REMOTE_ENROLLMENT_REQUIRED", "Authorize iMessage Remote Access before pairing it.");
    }
    const result = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const prefix = `/codex/remote/control/clients/${encodeURIComponent(clientId)}/environments`;
      const response = await this.api(`${prefix}?${query}`);
      if (!Array.isArray(response?.items)) {
        throw codedError("CODEX_REMOTE_PROTOCOL_ERROR", "Codex returned an invalid environment directory.");
      }
      result.push(...response.items);
      cursor = typeof response.cursor === "string" && response.cursor ? response.cursor : null;
      if (!cursor) return result;
    }
    throw codedError("CODEX_REMOTE_PROTOCOL_ERROR", "Codex returned too many environment pages.");
  }

  async resolveEnvironment(enrollment = this.enrollment(), options = {}) {
    const expected = this.desktopIdentity();
    const environments = await this.listEnvironments(enrollment.clientId);
    const environment = environments.find((item) => item?.env_id === expected.envId);
    return validatePinnedEnvironment(environment, expected, this.appServerVersion, options);
  }

  async pairEnvironment(manualPairingCode) {
    if (this.pairingPromise) return this.pairingPromise;
    const operation = withEnrollmentLock(
      this.enrollmentFile,
      () => this.#pairEnvironment(manualPairingCode),
    );
    this.pairingPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.pairingPromise === operation) this.pairingPromise = null;
    }
  }

  async #pairEnvironment(manualPairingCode) {
    const code = normalizeManualPairingCode(manualPairingCode);
    const { identity, enrollment } = await this.verifyEnrollment();
    const expected = this.desktopIdentity();
    const claimed = await fetchJson(
      this.fetchImpl,
      `${this.apiBase}/wham/remote/control/client/pair`,
      {
        method: "POST",
        headers: { ...apiHeaders(identity, this.appVersion), "content-type": "application/json" },
        body: JSON.stringify({ client_id: enrollment.clientId, manual_pairing_code: code }),
      },
      { mapHttpError: pairingHttpError },
    );
    if (claimed?.environment_id !== expected.envId) {
      throw codedError("CODEX_REMOTE_HOST_MISMATCH", "Codex paired the client with a different Desktop environment.");
    }
    const environments = await this.listEnvironments(enrollment.clientId);
    const environment = environments.find((item) => item?.env_id === expected.envId);
    const resolved = validatePinnedEnvironment(environment, expected, this.appServerVersion, { requireOnline: false });
    this.cachedSession = null;
    this.cachedSessionIdentity = null;
    return {
      paired: true,
      environmentId: resolved.envId,
      hostOnline: resolved.environment.online === true,
    };
  }

  async #refreshEnrollment(enrollment, identity = this.identity()) {
    if (!identityMatchesAccountUser(identity, enrollment.accountUserId)) {
      throw codedError("CODEX_REMOTE_ACCOUNT_MISMATCH", "The Remote Control client belongs to a different Codex account.");
    }
    const finishUrl = `${this.apiBase}/codex/remote/control/client/refresh/finish`;
    const started = await this.api("/codex/remote/control/client/refresh/start", {
      method: "POST",
      body: { client_id: enrollment.clientId },
      identity,
    });
    if (started?.account_user_id !== enrollment.accountUserId || started?.client_id !== enrollment.clientId) {
      throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "Codex returned a refresh challenge for a different client.");
    }
    const proof = await signEnrollmentChallenge({
      challenge: started.device_key_challenge,
      enrollment,
      deviceKeyClient: this.deviceKeyClient,
      expectedUrl: finishUrl,
      requireIdentityHash: true,
    });
    const finished = await this.api("/codex/remote/control/client/refresh/finish", {
      method: "POST",
      body: { client_id: enrollment.clientId, device_key_proof: proof },
      identity,
    });
    const token = validateSessionResponse(finished, enrollment);
    const latestIdentity = this.identity();
    if (!identityMatchesAccountUser(latestIdentity, enrollment.accountUserId)) {
      throw codedError("CODEX_REMOTE_ACCOUNT_MISMATCH", "The Codex account changed while Remote Control was connecting.");
    }
    return { identity: latestIdentity, token };
  }

  async #refreshSession(requestedIdentity) {
    const { identity, enrollment } = await this.verifyEnrollment();
    if (identity.accountId !== requestedIdentity.accountId) {
      throw codedError("CODEX_REMOTE_ACCOUNT_MISMATCH", "The Codex account changed while Remote Control was connecting.");
    }
    const refreshed = await this.#refreshEnrollment(enrollment, identity);
    const host = await this.resolveEnvironment(enrollment);
    const finalIdentity = this.identity();
    if (!identityMatchesAccountUser(finalIdentity, enrollment.accountUserId)) {
      throw codedError("CODEX_REMOTE_ACCOUNT_MISMATCH", "The Codex account changed while Remote Control was connecting.");
    }
    this.cachedSession = {
      clientId: enrollment.clientId,
      envId: host.envId,
      headers: {
        ...apiHeaders(finalIdentity, this.appVersion),
        "x-codex-client-session-token": `Bearer ${refreshed.token.token}`,
      },
      tokenExpiresAt: refreshed.token.tokenExpiresAt,
      scopes: refreshed.token.scopes,
      websocketUrl: this.websocketUrl,
    };
    this.cachedSessionIdentity = identityFingerprint(finalIdentity);
    return this.cachedSession;
  }

  async #removeEnrollment(enrollment) {
    this.cachedSession = null;
    this.cachedSessionIdentity = null;
    if (enrollment?.keyId) await this.deviceKeyClient.deleteDeviceKey(enrollment.keyId);
    rmSync(this.enrollmentFile, { force: true });
  }

  async refreshSession({ force = false } = {}) {
    const requestedIdentity = this.identity();
    const requestedFingerprint = identityFingerprint(requestedIdentity);
    const cacheIsFresh = this.cachedSession?.tokenExpiresAt > Math.floor(Date.now() / 1000) + 45
      && this.cachedSessionIdentity === requestedFingerprint;
    if (!force && cacheIsFresh) return this.cachedSession;
    if (force || !cacheIsFresh) {
      this.cachedSession = null;
      this.cachedSessionIdentity = null;
    }

    if (this.refreshPromise) {
      const session = await this.refreshPromise;
      const latestFingerprint = identityFingerprint(this.identity());
      if (this.cachedSessionIdentity === latestFingerprint) return session;
      return this.refreshSession({ force: true });
    }

    const operation = this.#refreshSession(requestedIdentity, requestedFingerprint);
    this.refreshPromise = operation;
    try {
      return await operation;
    } catch (error) {
      this.cachedSession = null;
      this.cachedSessionIdentity = null;
      throw error;
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    }
  }

  async authorize(options = {}) {
    if (this.authorizationPromise) return this.authorizationPromise;
    const operation = withEnrollmentLock(this.enrollmentFile, () => this.#authorize(options));
    this.authorizationPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.authorizationPromise === operation) this.authorizationPromise = null;
    }
  }

  async #authorize(options = {}) {
    const existing = this.enrollment(false);
    if (existing) {
      try {
        await this.verifyEnrollment(existing);
        await this.#refreshEnrollment(existing);
        return { authorized: true, changed: false, clientId: existing.clientId };
      } catch (error) {
        if (error?.code !== "CODEX_REMOTE_ENROLLMENT_REQUIRED") throw error;
        await this.#removeEnrollment(existing);
      }
    }
    const identity = this.identity();
    const started = await this.api("/codex/remote/control/client/enroll/start", {
      method: "POST",
      body: {},
      identity,
    });
    if (!started?.client_id || !started?.account_user_id || !started?.device_key_challenge
      || !identityMatchesAccountUser(identity, started.account_user_id)) {
      throw codedError("CODEX_REMOTE_ACCOUNT_MISMATCH", "Codex returned a Remote Control enrollment for a different account.");
    }
    let key = null;
    let enrollment = null;
    try {
      key = await this.deviceKeyClient.createDeviceKey(DEVICE_KEY_PROTECTION_CLASS);
      enrollment = normalizeEnrollment({
        schemaVersion: CONTROLLER_STATE_SCHEMA_VERSION,
        accountUserId: started.account_user_id,
        clientId: started.client_id,
        keyId: key?.keyId,
        publicKeySpkiDerBase64: key?.publicKeySpkiDerBase64,
        algorithm: key?.algorithm,
        protectionClass: key?.protectionClass,
        createdAt: new Date().toISOString(),
      });
      if (!enrollment) {
        throw codedError("CODEX_REMOTE_INCOMPATIBLE", "Codex created an unsupported Remote Control device key.");
      }
      const openExternal = options.openExternal || (async (url) => {
        (options.execFileSyncImpl || execFileSync)("/usr/bin/open", [url], {
          encoding: "utf8",
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 10_000,
        });
      });
      const stepUpToken = options.stepUpToken || await requestEnrollmentStepUpToken({
        identity,
        fetchImpl: this.fetchImpl,
        openExternal,
        timeoutMs: options.timeoutMs,
        issuer: options.issuer,
      });
      validateStepUpToken(stepUpToken, enrollment.accountUserId);
      const finishUrl = `${this.apiBase}/codex/remote/control/client/enroll/finish`;
      const proof = await signEnrollmentChallenge({
        challenge: started.device_key_challenge,
        enrollment,
        deviceKeyClient: this.deviceKeyClient,
        expectedUrl: finishUrl,
        requireIdentityHash: false,
      });
      const finished = await this.api("/codex/remote/control/client/enroll/finish", {
        method: "POST",
        body: {
          client_id: enrollment.clientId,
          step_up_token: stepUpToken,
          device_identity: {
            key_id: enrollment.keyId,
            public_key_spki_der_base64: enrollment.publicKeySpkiDerBase64,
            algorithm: enrollment.algorithm,
            protection_class: enrollment.protectionClass,
          },
          device_key_proof: proof,
        },
        identity,
      });
      validateSessionResponse(finished, enrollment);
      saveControllerEnrollment(this.enrollmentFile, enrollment);
      this.cachedSession = null;
      this.cachedSessionIdentity = null;
      return { authorized: true, changed: true, clientId: enrollment.clientId };
    } catch (error) {
      if (key?.keyId) await this.deviceKeyClient.deleteDeviceKey(key.keyId).catch(() => {});
      throw error;
    }
  }

  async deauthorize() {
    if (this.authorizationPromise) {
      return this.authorizationPromise.catch(() => {}).then(() => this.deauthorize());
    }
    const operation = withEnrollmentLock(this.enrollmentFile, async () => {
      const enrollment = this.enrollment(false);
      await this.#removeEnrollment(enrollment);
      return { authorized: false, changed: Boolean(enrollment) };
    });
    this.authorizationPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.authorizationPromise === operation) this.authorizationPromise = null;
    }
  }

  async authorizeDeviceChallenge(challenge, session = this.cachedSession) {
    const { enrollment } = await this.verifyEnrollment();
    if (!session || challenge?.purpose !== "remote_control_client_websocket"
      || challenge?.audience !== "remote_control_client_websocket"
      || challenge?.accountUserId !== enrollment.accountUserId
      || challenge?.clientId !== enrollment.clientId) {
      throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control connection challenge does not match this client.");
    }
    const target = targetForWebSocketUrl(this.websocketUrl);
    const header = session.headers?.["x-codex-client-session-token"] || "";
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] || "";
    const digest = createHash("sha256").update(token, "utf8").digest("base64url");
    if (challenge.targetOrigin !== target.targetOrigin || challenge.targetPath !== target.targetPath
      || challenge.tokenSha256Base64url !== digest
      || challenge.tokenExpiresAt !== session.tokenExpiresAt
      || challenge.tokenExpiresAt <= Math.floor(Date.now() / 1000)
      || challenge.scopes?.length !== 1 || challenge.scopes[0] !== REMOTE_CONTROL_SCOPE) {
      throw codedError("CODEX_REMOTE_CHALLENGE_INVALID", "The Remote Control connection challenge does not match this session.");
    }
    const signature = await this.deviceKeyClient.signDeviceKey(enrollment.keyId, {
      type: "remoteControlClientConnection",
      nonce: challenge.nonce,
      audience: challenge.audience,
      sessionId: challenge.sessionId,
      targetOrigin: challenge.targetOrigin,
      targetPath: challenge.targetPath,
      accountUserId: challenge.accountUserId,
      clientId: challenge.clientId,
      tokenSha256Base64url: challenge.tokenSha256Base64url,
      tokenExpiresAt: challenge.tokenExpiresAt,
      scopes: challenge.scopes,
    });
    return {
      type: "device_key_proof",
      keyId: enrollment.keyId,
      signatureDerBase64: signature.signatureDerBase64,
      signedPayloadBase64: signature.signedPayloadBase64,
      algorithm: signature.algorithm,
    };
  }

  async status({ network = false } = {}) {
    const result = {
      available: false,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      appVersion: this.appVersion,
      buildVersion: this.buildVersion,
      appServerVersion: this.appServerVersion,
      authenticated: false,
      enrolled: false,
      paired: null,
      hostConfigured: false,
      hostOnline: null,
    };
    let identity;
    try {
      identity = this.identity();
      result.authenticated = true;
    } catch (error) {
      return { ...result, code: error.code || "CODEX_AUTH_REQUIRED" };
    }
    try {
      this.desktopIdentity();
      result.hostConfigured = true;
    } catch (error) {
      return { ...result, code: error.code || "CODEX_HOST_UNAVAILABLE" };
    }
    const enrollment = this.enrollment(false);
    if (!enrollment || !identityMatchesAccountUser(identity, enrollment.accountUserId)) {
      return { ...result, code: "CODEX_REMOTE_ENROLLMENT_REQUIRED" };
    }
    try {
      await this.verifyEnrollment(enrollment);
      result.enrolled = true;
    } catch (error) {
      return { ...result, code: error.code || "CODEX_REMOTE_ENROLLMENT_REQUIRED" };
    }
    if (!network) return result;
    try {
      const host = await this.resolveEnvironment(enrollment, { requireOnline: false });
      result.paired = true;
      result.hostOnline = host.environment.online === true;
      if (!result.hostOnline) {
        return { ...result, code: "CODEX_HOST_OFFLINE" };
      }
      await this.refreshSession({ force: true });
      result.available = true;
      return result;
    } catch (error) {
      if ([
        "CODEX_REMOTE_PAIRING_REQUIRED",
        "CODEX_REMOTE_HOST_MISMATCH",
        "CODEX_REMOTE_INCOMPATIBLE",
      ].includes(error?.code)) result.paired = false;
      return { ...result, code: error.code || "CODEX_REMOTE_UNAVAILABLE" };
    }
  }
}

export const remoteControlInternals = Object.freeze({
  apiHeaders,
  authIdentity,
  deviceIdentityHash,
  signEnrollmentChallenge,
  targetForUrl,
  targetForWebSocketUrl,
  validatePublicKey,
  validateSessionResponse,
  buildAuthorizationUrl,
  createOAuthCallbackServer,
  requestEnrollmentStepUpToken,
  validateStepUpToken,
});
