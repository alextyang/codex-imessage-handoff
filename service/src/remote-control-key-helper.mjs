import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateJson } from "./config.mjs";
import { servicePaths } from "./paths.mjs";

export const KEY_HELPER_SCHEMA_VERSION = 1;
export const KEY_HELPER_IDENTIFIER = "com.codex.imessage-handoff.remote-control-key-helper";
export const CREATE_DEVICE_KEY_POLICY = "allow_os_protected_nonextractable";
export const DEVICE_KEY_CLASSES = Object.freeze([
  "hardware_secure_enclave",
  "hardware_tpm",
  "os_protected_nonextractable",
]);

const defaultSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "native",
  "remote-control-key-helper.swift",
);

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function defaultLocations(options = {}) {
  const paths = options.paths || servicePaths();
  return {
    sourceFile: options.sourceFile || defaultSource,
    binary: options.binary || paths.remoteControlKeyHelper || path.join(paths.home, "bin", "remote-control-key-helper"),
    manifest: options.manifest || paths.remoteControlKeyHelperManifest || path.join(paths.home, "remote-control-key-helper.json"),
    enrollmentFile: options.enrollmentFile || paths.remoteControlClient || path.join(paths.home, "remote-control-client.json"),
  };
}

function safeExecutable(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.uid === process.getuid()
      && (metadata.mode & 0o077) === 0
      && (metadata.mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

function readManifest(file) {
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.schemaVersion !== KEY_HELPER_SCHEMA_VERSION
      || value?.owner !== "codex-imessage-handoff"
      || !/^[a-f0-9]{64}$/.test(String(value?.sha256 || ""))) return null;
    return value;
  } catch {
    return null;
  }
}

export function verifyRemoteControlKeyHelper(options = {}) {
  const locations = defaultLocations(options);
  const manifest = readManifest(locations.manifest);
  if (!manifest || !safeExecutable(locations.binary) || sha256(locations.binary) !== manifest.sha256) {
    throw codedError("CODEX_REMOTE_KEY_HELPER_INVALID", "The iMessage Remote Access Keychain helper is missing or failed integrity verification.");
  }
  return { ...locations, sha256: manifest.sha256, sourceSha256: manifest.sourceSha256 || null };
}

export function ensureRemoteControlKeyHelper(options = {}) {
  const locations = defaultLocations(options);
  try {
    return { ...verifyRemoteControlKeyHelper(locations), changed: false };
  } catch (error) {
    if (existsSync(locations.enrollmentFile)) {
      throw codedError(
        "CODEX_REMOTE_KEY_HELPER_INVALID",
        "The enrolled Keychain helper changed unexpectedly. Deauthorize Remote Control before replacing it.",
        error,
      );
    }
  }
  if (!existsSync(locations.sourceFile)) {
    throw codedError("CODEX_REMOTE_KEY_HELPER_SOURCE_MISSING", "The iMessage Remote Access Keychain helper source is unavailable.");
  }
  const run = options.execFileSyncImpl || execFileSync;
  const directory = path.dirname(locations.binary);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.remote-control-key-helper-${process.pid}-${randomUUID()}`);
  try {
    run("/usr/bin/xcrun", [
      "swiftc", "-O", "-framework", "Security", "-framework", "Foundation",
      locations.sourceFile, "-o", temporary,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    run("/usr/bin/codesign", [
      "--force", "--sign", "-", "--identifier", KEY_HELPER_IDENTIFIER, temporary,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    chmodSync(temporary, 0o500);
    // Copy then atomically rename so the installed inode contains exactly the
    // signed bytes whose hash is recorded below.
    const candidate = `${temporary}.install`;
    copyFileSync(temporary, candidate);
    chmodSync(candidate, 0o500);
    renameSync(candidate, locations.binary);
    const digest = sha256(locations.binary);
    writePrivateJson(locations.manifest, {
      schemaVersion: KEY_HELPER_SCHEMA_VERSION,
      owner: "codex-imessage-handoff",
      sha256: digest,
      sourceSha256: sha256(locations.sourceFile),
      installedAt: new Date().toISOString(),
    });
    return { ...locations, sha256: digest, sourceSha256: sha256(locations.sourceFile), changed: true };
  } catch (error) {
    rmSync(locations.binary, { force: true });
    rmSync(locations.manifest, { force: true });
    throw codedError("CODEX_REMOTE_KEY_HELPER_INSTALL_FAILED", "The iMessage Remote Access Keychain helper could not be installed.", error);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(`${temporary}.install`, { force: true });
  }
}

function invoke(helper, args, options = {}) {
  let output;
  try {
    output = (options.execFileSyncImpl || execFileSync)(helper.binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs || 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw codedError("CODEX_REMOTE_DEVICE_KEY_FAILED", "The Remote Control Keychain operation failed.", error);
  }
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid output");
    return value;
  } catch (error) {
    throw codedError("CODEX_REMOTE_DEVICE_KEY_FAILED", "The Remote Control Keychain helper returned invalid output.", error);
  }
}

function validatePublicRecord(value) {
  if (!value || typeof value.keyId !== "string" || !/^[a-f0-9-]{36}$/.test(value.keyId)
    || typeof value.publicKeySpkiDerBase64 !== "string" || !value.publicKeySpkiDerBase64
    || value.algorithm !== "ecdsa_p256_sha256"
    || !DEVICE_KEY_CLASSES.includes(value.protectionClass)) {
    throw codedError("CODEX_REMOTE_DEVICE_KEY_FAILED", "The Remote Control Keychain helper returned an invalid public key.");
  }
  return value;
}

export function createRemoteControlKeyClient(options = {}) {
  const helper = verifyRemoteControlKeyHelper(options);
  return {
    async createDeviceKey(policy = CREATE_DEVICE_KEY_POLICY) {
      if (policy !== CREATE_DEVICE_KEY_POLICY) {
        throw codedError("CODEX_REMOTE_DEVICE_KEY_FAILED", "The Remote Control key policy is unsupported.");
      }
      return validatePublicRecord(invoke(helper, ["create"], options));
    },
    async deleteDeviceKey(keyId) {
      return invoke(helper, ["delete", String(keyId)], options);
    },
    async getDeviceKeyPublic(keyId) {
      return validatePublicRecord(invoke(helper, ["get", String(keyId)], options));
    },
    async signDeviceKey(keyId, payload) {
      const signedPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const result = invoke(helper, ["sign", String(keyId), signedPayload.toString("base64")], options);
      if (result.algorithm !== "ecdsa_p256_sha256" || typeof result.signatureDerBase64 !== "string" || !result.signatureDerBase64) {
        throw codedError("CODEX_REMOTE_DEVICE_KEY_FAILED", "The Remote Control Keychain helper returned an invalid signature.");
      }
      return result;
    },
  };
}
