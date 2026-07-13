#!/usr/bin/env node
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalImsgIdentity as protocolCanonicalImsgIdentity,
  createHelperAttestation,
  extractImsgAccountIdentities,
  helperIdentityHash,
  imsgAccountFingerprint,
  imsgIdentityHashes,
  imsgProfileHash,
  ipcPublicKeyFingerprint,
} from "./imsg-ipc-protocol.mjs";

export const DEDICATED_HELPER_INSTALL_VERSION = 2;
export const DEDICATED_HELPER_LABEL = "com.codex.imessage-handoff.imsg-helper";

const privilegedGroupIds = new Set([0, 79, 80, 81, 98, 204, 250, 395, 398, 399, 400]);
const broadGroupIds = new Set([0, 12, 20, 61, 79, 80, 81]);
const broadGroupNames = new Set(["wheel", "everyone", "staff", "admin", "localaccounts", "_appserverusr", "_appserveradm"]);

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function helperSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function helperCanonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(helperCanonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + helperCanonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function canonicalImsgIdentity(value) {
  return protocolCanonicalImsgIdentity(value);
}

export function imsgIdentityHash(value) {
  return imsgIdentityHashes(value)[0] || null;
}

export function helperUserIdentityHash({ uid, username, home } = {}) {
  const numericUid = Number(uid);
  const name = typeof username === "string" ? username.trim() : "";
  const resolvedHome = typeof home === "string" && path.isAbsolute(home) ? path.resolve(home) : "";
  if (!Number.isSafeInteger(numericUid) || numericUid < 0 || !/^[A-Za-z0-9._-]{1,80}$/.test(name) || !resolvedHome) {
    throw codedError("HELPER_IDENTITY_INVALID", "The dedicated helper identity is invalid.");
  }
  return helperIdentityHash({ uid: numericUid, username: name, home: resolvedHome });
}

function normalizedGroupIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((item) => Number.isSafeInteger(item) && item >= 0))].sort((a, b) => a - b);
}

function normalizedGroup(group = {}) {
  const name = typeof group.name === "string" ? group.name.trim() : "";
  const gid = Number(group.gid);
  const members = [...new Set(Array.isArray(group.members)
    ? group.members.map((value) => String(value || "").trim()).filter(Boolean)
    : [])].sort();
  const nestedGroups = Array.isArray(group.nestedGroups) ? group.nestedGroups.filter(Boolean) : [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)
    || name.startsWith("_") || name.toLowerCase().startsWith("com.apple.")
    || broadGroupNames.has(name.toLowerCase()) || !Number.isSafeInteger(gid) || gid < 500
    || broadGroupIds.has(gid) || nestedGroups.length !== 0 || members.length !== 2) {
    throw codedError("HELPER_SHARED_GROUP_UNSAFE", "The helper exchange group is not a dedicated two-account group.");
  }
  return { name, gid, members, nestedGroups: [] };
}

export function inspectMacGroup(name, { run = execFileSync } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(name || ""))) {
    throw codedError("HELPER_SHARED_GROUP_UNSAFE", "The helper exchange group name is invalid.");
  }
  let output;
  try {
    output = run("/usr/bin/dscl", [".", "-read", `/Groups/${name}`, "PrimaryGroupID", "GroupMembership", "NestedGroups"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    throw codedError("HELPER_SHARED_GROUP_UNAVAILABLE", "The dedicated helper group could not be verified.", error);
  }
  const fields = new Map();
  let current = null;
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match) {
      current = match[1];
      fields.set(current, match[2].trim());
    } else if (current && line.trim()) {
      fields.set(current, `${fields.get(current) || ""} ${line.trim()}`.trim());
    }
  }
  return {
    name: String(name),
    gid: Number(fields.get("PrimaryGroupID")),
    members: String(fields.get("GroupMembership") || "").split(/\s+/).filter(Boolean),
    nestedGroups: String(fields.get("NestedGroups") || "").split(/\s+/).filter(Boolean),
  };
}

export function validateHelperInstallIdentity({ uid, username, groupIds, signedGroup, inspectedGroup } = {}) {
  const numericUid = Number(uid);
  const name = typeof username === "string" ? username.trim() : "";
  const groups = normalizedGroupIds(groupIds);
  if (!Number.isSafeInteger(numericUid) || numericUid < 500 || name.startsWith("_")
    || ["root", "daemon", "nobody"].includes(name.toLowerCase())
    || groups.some((gid) => privilegedGroupIds.has(gid))) {
    throw codedError("HELPER_ACCOUNT_PRIVILEGED", "The Messages helper must run from a non-administrator GUI account.");
  }
  const expected = normalizedGroup(signedGroup);
  const actual = normalizedGroup(inspectedGroup);
  if (!groups.includes(expected.gid) || expected.gid !== actual.gid || expected.name !== actual.name
    || !expected.members.includes(name)
    || expected.members.some((member, index) => member !== actual.members[index])) {
    throw codedError("HELPER_SHARED_GROUP_MISMATCH", "The dedicated helper group membership changed after preparation.");
  }
  return { uid: numericUid, username: name, groupIds: groups, sharedGroup: expected };
}

function publicKeyFingerprint(key) {
  return ipcPublicKeyFingerprint(key?.type === "public"
    ? key.export({ type: "spki", format: "pem" })
    : key);
}

function parseJsonLines(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch {
      throw codedError("HELPER_IMSG_OUTPUT_INVALID", "imsg returned malformed metadata.");
    }
  }
  return parsed;
}

function normalizeAccounts(value) {
  return extractImsgAccountIdentities(value);
}

function accountResult(stdout) {
  const rows = parseJsonLines(stdout);
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw codedError("HELPER_ACCOUNT_UNAVAILABLE", "The active Messages account could not be inspected.");
  }
  return rows[0];
}

function imsgRun(binary, args, { run = execFileSync, timeout = 15_000 } = {}) {
  try {
    return run(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw codedError("HELPER_IMSG_UNAVAILABLE", "The private imsg runtime could not inspect Messages.", error);
  }
}

function bridgeStatus(binary, run) {
  const rows = parseJsonLines(imsgRun(binary, ["status", "--json"], { run, timeout: 8_000 }));
  return rows.length === 1 && rows[0] && typeof rows[0] === "object" ? rows[0] : {};
}

function bridgeReady(status) {
  return status.advanced_features === true
    && status.v2_ready === true
    && Array.isArray(status.rpc_methods)
    && status.rpc_methods.includes("watch.subscribe");
}

export function ensureImsgBridgeReady({
  binary,
  bridgeDylib,
  run = execFileSync,
  attempts = 80,
  forceRestart = false,
  wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  if (typeof binary !== "string" || !path.isAbsolute(binary)
    || typeof bridgeDylib !== "string" || !path.isAbsolute(bridgeDylib)) {
    throw codedError("HELPER_BRIDGE_PATH_INVALID", "The private imsg bridge runtime is invalid.");
  }
  let status = {};
  if (forceRestart === true) {
    imsgRun(binary, ["launch", "--kill-only", "--json"], { run, timeout: 30_000 });
    imsgRun(binary, ["launch", "--json", "--dylib", bridgeDylib], { run, timeout: 30_000 });
  } else {
    status = bridgeStatus(binary, run);
  }
  if (!bridgeReady(status) && forceRestart !== true) {
    imsgRun(binary, ["launch", "--json", "--dylib", bridgeDylib], { run, timeout: 30_000 });
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = bridgeStatus(binary, run);
    if (bridgeReady(status)) return status;
    if (attempt + 1 < attempts) wait(250);
  }
  throw codedError("HELPER_BRIDGE_NOT_READY", "The private imsg bridge did not become ready.");
}

export function inspectLiveImsgAccount(binary, options = {}) {
  return accountResult(imsgRun(binary, ["account", "--json"], options));
}

export function activeIdentityPins(account) {
  const raw = normalizeAccounts(account);
  const identityHashes = [...new Set(raw.map(imsgIdentityHash).filter(Boolean))].sort();
  const accountFingerprint = imsgAccountFingerprint(raw);
  if (!identityHashes.length || !accountFingerprint) {
    throw codedError("HELPER_ACCOUNT_UNAVAILABLE", "Messages did not report an active iMessage identity.");
  }
  return {
    hashes: identityHashes,
    accountFingerprint,
  };
}

function chatRows(binary, options = {}) {
  const stdout = imsgRun(binary, ["chats", "--limit", "50", "--json"], options);
  return parseJsonLines(stdout).filter((row) => row && typeof row === "object");
}

function candidateLocalIdentities(chat) {
  return [chat.account_login, chat.last_addressed_handle]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
}

function profileHash(profile) {
  return imsgProfileHash(profile);
}

export function discoverDedicatedImsgProfile({
  binary,
  expectedRecipientHash,
  account,
  chats,
  run = execFileSync,
} = {}) {
  if (typeof binary !== "string" || !path.isAbsolute(binary)) {
    throw codedError("HELPER_IMSG_PATH_INVALID", "The private imsg runtime path is invalid.");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(expectedRecipientHash || ""))) {
    throw codedError("HELPER_RECIPIENT_HASH_INVALID", "The expected recipient hash is invalid.");
  }
  const liveAccount = account || inspectLiveImsgAccount(binary, { run });
  const activePins = activeIdentityPins(liveAccount);
  const activeHashes = new Set(activePins.hashes);
  const rows = chats || chatRows(binary, { run });
  const matches = [];
  let unsafeMatch = null;
  for (const chat of rows) {
    if (chat.is_group === true || String(chat.service || "").toLowerCase() !== "imessage") continue;
    const participants = Array.isArray(chat.participants)
      ? chat.participants.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean)
      : [];
    if (participants.length !== 1) continue;
    const participant = participants[0];
    const participantHash = imsgIdentityHash(participant);
    if (participantHash !== String(expectedRecipientHash).toLowerCase()) continue;
    if (activeHashes.has(participantHash)) {
      unsafeMatch = codedError("HELPER_SELF_CHAT", "The matched Messages conversation is a self-chat.");
      continue;
    }
    const chatId = Number(chat.id);
    const chatGuid = typeof chat.guid === "string" ? chat.guid.trim() : "";
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !chatGuid) continue;
    const localCandidates = candidateLocalIdentities(chat);
    const localIdentity = localCandidates.find((value) => activeHashes.has(imsgIdentityHash(value))) || "";
    if (!localIdentity) continue;
    const lastMessageAt = Number.isFinite(Date.parse(String(chat.last_message_at || "")))
      ? Date.parse(chat.last_message_at)
      : 0;
    matches.push({ chat, chatId, chatGuid, participant, localIdentity, lastMessageAt });
  }
  if (!matches.length) {
    if (unsafeMatch) throw unsafeMatch;
    throw codedError("HELPER_CHAT_NOT_FOUND", "No recent direct iMessage chat matched the expected recipient.");
  }
  matches.sort((left, right) => right.lastMessageAt - left.lastMessageAt || right.chatId - left.chatId);
  const selected = matches[0];
  const profile = {
    binary,
    chatId: selected.chatId,
    chatGuid: selected.chatGuid,
    expectedSender: selected.participant,
    localIdentity: selected.localIdentity,
    localIdentityHashes: activePins.hashes,
    accountFingerprint: activePins.accountFingerprint,
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
  };
  return { profile, profileHash: profileHash(profile) };
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderHelperLaunchAgent({
  label = DEDICATED_HELPER_LABEL,
  nodePath,
  entrypoint,
  configPath,
  stdoutLog,
  stderrLog,
} = {}) {
  for (const [name, value] of Object.entries({ nodePath, entrypoint, configPath, stdoutLog, stderrLog })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw codedError("HELPER_PLIST_INVALID", "The helper LaunchAgent " + name + " path is invalid.");
    }
  }
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\"><dict>",
    "<key>Label</key><string>" + xml(label) + "</string>",
    "<key>ProgramArguments</key><array><string>" + xml(nodePath) + "</string><string>" + xml(entrypoint) + "</string></array>",
    "<key>EnvironmentVariables</key><dict><key>IMSG_HELPER_CONFIG</key><string>" + xml(configPath) + "</string></dict>",
    "<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ProcessType</key><string>Background</string>",
    "<key>ThrottleInterval</key><integer>10</integer>",
    "<key>LowPriorityIO</key><true/>",
    "<key>Umask</key><integer>63</integer>",
    "<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>128</integer></dict>",
    "<key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>256</integer></dict>",
    "<key>StandardOutPath</key><string>" + xml(stdoutLog) + "</string>",
    "<key>StandardErrorPath</key><string>" + xml(stderrLog) + "</string>",
    "</dict></plist>",
    "",
  ].join("\n");
}

function assertRegularFile(file, expectedHash, expectedBytes = null) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw codedError("HELPER_BUNDLE_UNSAFE", "The helper bundle contains a non-regular file.");
  }
  const data = readFileSync(file);
  if (helperSha256(data) !== expectedHash || (expectedBytes !== null && data.byteLength !== expectedBytes)) {
    throw codedError("HELPER_BUNDLE_TAMPERED", "The helper bundle failed its integrity check.");
  }
  return data;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveSignedBundleFile(root, relativePath, message) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw codedError("HELPER_BUNDLE_UNSAFE", message);
  }
  const candidate = path.resolve(root, relativePath);
  if (!inside(root, candidate) || !inside(root, realpathSync(candidate))) {
    throw codedError("HELPER_BUNDLE_UNSAFE", message);
  }
  return candidate;
}

export function verifyHelperBundle(bundleRoot) {
  const root = realpathSync(bundleRoot);
  const manifestFile = path.join(root, "bundle-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest?.version !== 2 || !Array.isArray(manifest.payload)
    || manifest.payload.length < 1 || manifest.payload.length > 512
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(manifest.bundleId || ""))) {
    throw codedError("HELPER_BUNDLE_INVALID", "The helper bundle manifest is invalid.");
  }
  const sharedGroup = normalizedGroup(manifest.sharedGroup);
  for (const [field, value] of Object.entries({
    dedicatedIdentityHash: manifest.dedicatedIdentityHash,
    controllerIdentityHash: manifest.controllerIdentityHash,
    expectedRecipientHash: manifest.expectedRecipientHash,
  })) {
    if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) {
      throw codedError("HELPER_BUNDLE_INVALID", `The helper bundle ${field} is invalid.`);
    }
  }
  const publicFile = resolveSignedBundleFile(root, manifest.controllerPublicKey?.path, "The controller public key escaped the helper bundle.");
  const publicPem = assertRegularFile(publicFile, manifest.controllerPublicKey.sha256);
  const controllerPublicKey = createPublicKey(publicPem);
  const fingerprint = publicKeyFingerprint(controllerPublicKey);
  if (fingerprint !== manifest.controllerPublicKey.fingerprint) {
    throw codedError("HELPER_BUNDLE_TAMPERED", "The controller public-key fingerprint changed.");
  }
  const signature = Buffer.from(readFileSync(path.join(root, "bundle-manifest.sig"), "utf8").trim(), "base64");
  const canonical = helperCanonicalJson(manifest);
  if (!verify(null, Buffer.from(canonical), controllerPublicKey, signature)) {
    throw codedError("HELPER_BUNDLE_SIGNATURE_INVALID", "The helper bundle signature is invalid.");
  }
  const payloadPaths = new Set();
  let payloadBytes = 0;
  for (const item of manifest.payload) {
    if (payloadPaths.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw codedError("HELPER_BUNDLE_INVALID", "The helper payload manifest is invalid.");
    }
    payloadPaths.add(item.path);
    payloadBytes += item.bytes;
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > 512 * 1024 * 1024) {
      throw codedError("HELPER_BUNDLE_INVALID", "The helper payload is too large.");
    }
    const file = resolveSignedBundleFile(root, item.path, "A helper payload path escaped the bundle.");
    assertRegularFile(file, item.sha256, item.bytes);
  }
  const installer = resolveSignedBundleFile(root, manifest.installer?.path, "The helper installer escaped its bundle.");
  assertRegularFile(installer, manifest.installer.sha256, manifest.installer.bytes);
  const installerProtocol = resolveSignedBundleFile(root, manifest.installerProtocol?.path, "The helper installer protocol escaped its bundle.");
  assertRegularFile(installerProtocol, manifest.installerProtocol.sha256, manifest.installerProtocol.bytes);
  const launcher = resolveSignedBundleFile(root, manifest.launcher?.path, "The helper launcher escaped its bundle.");
  assertRegularFile(launcher, manifest.launcher.sha256, manifest.launcher.bytes);
  const nodeItem = manifest.payload.find((item) => item.path === manifest.node?.path && item.kind === "node-runtime");
  if (!nodeItem || nodeItem.sha256 !== manifest.node.sha256 || nodeItem.bytes !== manifest.node.bytes
    || (nodeItem.mode & 0o111) === 0) {
    throw codedError("HELPER_NODE_CHANGED", "The staged helper-owned Node runtime is invalid.");
  }
  const exchange = path.join(root, "exchange");
  const exchangeMetadata = lstatSync(exchange);
  if (!exchangeMetadata.isDirectory() || exchangeMetadata.isSymbolicLink()
    || exchangeMetadata.gid !== sharedGroup.gid
    || (exchangeMetadata.mode & 0o070) !== 0o070 || (exchangeMetadata.mode & 0o007) !== 0
    || !(process.getgroups?.() || []).includes(sharedGroup.gid)) {
    throw codedError("HELPER_EXCHANGE_UNSAFE", "The signed helper exchange is not shared with this macOS account.");
  }
  return {
    root,
    manifest,
    controllerPublicKey,
    publicPem,
    manifestHash: helperSha256(canonical),
  };
}

function writeAtomic(file, data, mode) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".tmp-" + process.pid + "-" + Date.now();
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

function safeOwnedPath(file, uid, { directory = false } = {}) {
  const metadata = lstatSync(file);
  const expectedType = directory ? metadata.isDirectory() : metadata.isFile();
  if (!expectedType || metadata.isSymbolicLink() || metadata.uid !== uid) {
    throw codedError("HELPER_INSTALL_ROLLBACK_UNSAFE", "An existing helper install path is unsafe to replace.");
  }
  return metadata;
}

function existingBridgeRuntime(configPath, privateRoot, uid) {
  if (!existsSync(configPath)) return null;
  const metadata = safeOwnedPath(configPath, uid);
  if ((metadata.mode & 0o077) !== 0 || metadata.size < 2 || metadata.size > 64 * 1024) {
    throw codedError("HELPER_EXISTING_CONFIG_INVALID", "The existing helper configuration is unsafe.");
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw codedError("HELPER_EXISTING_CONFIG_INVALID", "The existing helper configuration is invalid.", error);
  }
  const binary = typeof config?.imsgBinary === "string" ? path.resolve(config.imsgBinary) : "";
  const bridgeDylib = typeof config?.bridgeDylib === "string" ? path.resolve(config.bridgeDylib) : "";
  for (const file of [binary, bridgeDylib]) {
    if (!file || !path.isAbsolute(file) || !inside(privateRoot, file)) {
      throw codedError("HELPER_EXISTING_CONFIG_INVALID", "The existing helper runtime escaped its private root.");
    }
    safeOwnedPath(file, uid);
  }
  return { binary, bridgeDylib };
}

function createFileRollback(uid) {
  const snapshots = [];
  return {
    preserve(file) {
      if (snapshots.some((snapshot) => snapshot.file === file)) return;
      if (!existsSync(file)) {
        snapshots.push({ file, existed: false, backup: null });
        return;
      }
      const metadata = safeOwnedPath(file, uid);
      const backup = `${file}.rollback-${process.pid}-${randomUUID()}`;
      copyFileSync(file, backup);
      chmodSync(backup, metadata.mode & 0o777);
      const descriptor = openSync(backup, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      snapshots.push({ file, existed: true, backup });
    },
    rollback() {
      for (const snapshot of [...snapshots].reverse()) {
        try {
          rmSync(snapshot.file, { force: true });
          if (snapshot.existed && snapshot.backup && existsSync(snapshot.backup)) renameSync(snapshot.backup, snapshot.file);
        } catch {}
      }
    },
    commit() {
      for (const snapshot of snapshots) {
        if (snapshot.backup) {
          try { rmSync(snapshot.backup, { force: true }); } catch {}
        }
      }
    },
    existed(file) {
      return snapshots.find((snapshot) => snapshot.file === file)?.existed === true;
    },
  };
}

function ensurePrivateDirectory(directory, uid) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid) {
    throw codedError("HELPER_PRIVATE_HOME_UNSAFE", "The helper private directory has an unsafe owner or type.");
  }
  chmodSync(directory, 0o700);
}

function ensureHelperIdentity(directory, uid) {
  const privatePath = path.join(directory, "helper-private.pem");
  const publicPath = path.join(directory, "helper-public.pem");
  let privateKey;
  if (existsSync(privatePath)) {
    const metadata = lstatSync(privatePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
      throw codedError("HELPER_PRIVATE_KEY_UNSAFE", "The helper private key has unsafe permissions.");
    }
    privateKey = createPrivateKey(readFileSync(privatePath));
    if (privateKey.asymmetricKeyType !== "ed25519") throw codedError("HELPER_KEY_INVALID", "The helper private key must use Ed25519.");
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    writeAtomic(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
  }
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  if (existsSync(publicPath) && publicKeyFingerprint(readFileSync(publicPath)) !== publicKeyFingerprint(publicKey)) {
    throw codedError("HELPER_KEY_MISMATCH", "The helper public and private keys do not match.");
  }
  writeAtomic(publicPath, publicPem, 0o600);
  return { privateKey, publicKey, privatePath, publicPath, publicPem, fingerprint: publicKeyFingerprint(publicKey) };
}

function copyInstalledPayload(bundle, installFilesRoot) {
  const installed = new Map();
  const temporary = installFilesRoot + ".tmp-" + process.pid + "-" + randomUUID();
  const previous = installFilesRoot + ".rollback-" + process.pid + "-" + randomUUID();
  const uid = process.getuid?.();
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  let movedPrevious = false;
  let activated = false;
  try {
    for (const item of bundle.manifest.payload) {
      const relative = item.path.slice("payload/".length);
      const destination = path.resolve(temporary, relative);
      if (!item.path.startsWith("payload/") || !relative || !inside(temporary, destination)) {
        throw codedError("HELPER_BUNDLE_INVALID", "A helper payload path is invalid.");
      }
      const source = path.join(bundle.root, item.path);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination);
      chmodSync(destination, item.kind === "module" ? 0o600 : ((item.mode & 0o111) ? 0o700 : 0o600));
      installed.set(item.path, path.join(installFilesRoot, relative));
    }
    if (existsSync(installFilesRoot)) {
      safeOwnedPath(installFilesRoot, uid, { directory: true });
      renameSync(installFilesRoot, previous);
      movedPrevious = true;
    }
    renameSync(temporary, installFilesRoot);
    activated = true;
    return {
      installed,
      rollback() {
        if (activated) rmSync(installFilesRoot, { recursive: true, force: true });
        if (movedPrevious && existsSync(previous)) renameSync(previous, installFilesRoot);
        activated = false;
      },
      commit() {
        if (movedPrevious) {
          try { rmSync(previous, { recursive: true, force: true }); } catch {}
        }
        movedPrevious = false;
        activated = false;
      },
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (activated) rmSync(installFilesRoot, { recursive: true, force: true });
    if (movedPrevious && existsSync(previous) && !existsSync(installFilesRoot)) renameSync(previous, installFilesRoot);
    throw error;
  }
}

function socketIdentity(socketPath) {
  try {
    const metadata = lstatSync(socketPath);
    return metadata.isSocket() ? { dev: metadata.dev, ino: metadata.ino } : null;
  } catch {
    return null;
  }
}

function waitForHealthyHelper({
  socketPath,
  previousSocket,
  domain,
  launchctl,
  healthCheck,
  attempts = 60,
  wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let serviceLoaded = false;
    try {
      launchctl("launchctl", ["print", `${domain}/${DEDICATED_HELPER_LABEL}`], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 10_000,
      });
      serviceLoaded = true;
    } catch {}
    const currentSocket = socketIdentity(socketPath);
    const freshSocket = Boolean(currentSocket
      && (!previousSocket || currentSocket.dev !== previousSocket.dev || currentSocket.ino !== previousSocket.ino));
    const externallyHealthy = typeof healthCheck === "function"
      ? healthCheck({ attempt, serviceLoaded, freshSocket, currentSocket }) === true
      : true;
    if (serviceLoaded && freshSocket && externallyHealthy) return currentSocket;
    wait(500);
  }
  throw codedError("HELPER_START_UNHEALTHY", "The replacement Messages helper did not create a healthy fresh socket.");
}

function cleanupRetiredPayloads(privateRoot, activeRoot, uid) {
  const candidates = [path.join(privateRoot, "files")];
  const releasesRoot = path.join(privateRoot, "releases");
  if (existsSync(releasesRoot)) {
    safeOwnedPath(releasesRoot, uid, { directory: true });
    for (const entry of readdirSync(releasesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(releasesRoot, entry.name));
    }
  }
  for (const candidate of candidates) {
    if (candidate === activeRoot || !existsSync(candidate)) continue;
    try {
      safeOwnedPath(candidate, uid, { directory: true });
      rmSync(candidate, { recursive: true, force: true });
    } catch {}
  }
}

function signedPublicAttestation({
  manifest,
  manifestHash,
  identity,
  processIdentity,
  profile,
  installedAt,
} = {}) {
  const runtime = createHelperAttestation(profile, processIdentity);
  const expectedHelperAttestation = {
    role: runtime.role,
    identityHash: runtime.identityHash,
    accountHash: runtime.accountHash,
    conversationHash: runtime.conversationHash,
    profileHash: runtime.profileHash,
  };
  const body = {
    version: 1,
    bundleId: manifest.bundleId,
    manifestHash,
    controllerPublicKeyFingerprint: manifest.controllerPublicKey.fingerprint,
    helperPublicKey: identity.publicPem.toString(),
    helperPublicKeyFingerprint: identity.fingerprint,
    helperIdentityHash: runtime.identityHash,
    expectedRecipientHash: manifest.expectedRecipientHash,
    accountFingerprint: runtime.accountHash,
    conversationHash: runtime.conversationHash,
    profileHash: runtime.profileHash,
    expectedHelperAttestation,
    helperAttestationHash: helperSha256(helperCanonicalJson(expectedHelperAttestation)),
    installedAt,
  };
  return {
    ...body,
    signature: sign(null, Buffer.from(helperCanonicalJson(body)), identity.privateKey).toString("base64"),
  };
}

export function installDedicatedImsgHelper(options = {}) {
  const bundle = verifyHelperBundle(options.bundleRoot || path.dirname(fileURLToPath(import.meta.url)));
  const user = options.user || os.userInfo();
  const uid = Number.isSafeInteger(options.uid) ? options.uid : process.getuid();
  const username = options.username || user.username;
  const home = path.resolve(options.home || user.homedir);
  const identityHash = helperUserIdentityHash({ uid, username, home });
  if (identityHash !== bundle.manifest.dedicatedIdentityHash) {
    throw codedError("HELPER_WRONG_USER", "Run this installer from the dedicated user's GUI session.");
  }
  if (process.platform !== "darwin" && options.allowNonDarwin !== true) {
    throw codedError("HELPER_PLATFORM_UNSUPPORTED", "The dedicated Messages helper requires macOS.");
  }
  const groupIds = normalizedGroupIds(options.groupIds || process.getgroups?.() || []);
  const inspectedGroup = options.inspectedGroup
    || (typeof options.groupInspector === "function"
      ? options.groupInspector(bundle.manifest.sharedGroup.name)
      : inspectMacGroup(bundle.manifest.sharedGroup.name));
  validateHelperInstallIdentity({
    uid,
    username,
    groupIds,
    signedGroup: bundle.manifest.sharedGroup,
    inspectedGroup,
  });

  const launchctl = options.launchctl || execFileSync;
  const domain = `gui/${uid}`;
  if (options.loadAgent !== false) {
    try {
      launchctl("launchctl", ["print", domain], { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
    } catch (error) {
      throw codedError(
        "HELPER_GUI_SESSION_REQUIRED",
        "Log in to the dedicated Messages account and leave that GUI session signed in before installing the helper.",
        error,
      );
    }
  }

  const privateRoot = path.resolve(options.privateRoot || path.join(home, "Library", "Application Support", "Codex iMessage Helper"));
  if (!inside(home, privateRoot)) throw codedError("HELPER_PRIVATE_HOME_UNSAFE", "The helper files must stay inside the dedicated user's home.");
  ensurePrivateDirectory(privateRoot, uid);
  const releasesRoot = path.join(privateRoot, "releases");
  ensurePrivateDirectory(releasesRoot, uid);
  const filesRoot = path.join(releasesRoot, bundle.manifest.bundleId);
  const payloadTransaction = copyInstalledPayload(bundle, filesRoot);
  const installed = payloadTransaction.installed;
  const fileTransaction = createFileRollback(uid);
  let agentMutationStarted = false;
  let plistPath = null;
  let configPath = null;
  let attestationPath = null;
  let previousBridgeRuntime = null;
  let bridgeRestarted = false;
  try {
    const imsgBinary = installed.get(bundle.manifest.imsg);
    const bridgeDylib = installed.get(bundle.manifest.bridgeDylib);
    const entrypoint = installed.get(bundle.manifest.entrypoint);
    const nodeRuntime = installed.get(bundle.manifest.node.path);
    if (!imsgBinary || !bridgeDylib || !entrypoint || !nodeRuntime) {
      throw codedError("HELPER_BUNDLE_INVALID", "The helper bundle is missing a required runtime file.");
    }
    try {
      (options.nodeCheck || execFileSync)(nodeRuntime, ["--check", entrypoint], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw codedError("HELPER_NODE_RUNTIME_INVALID", "The staged helper-owned Node runtime could not load the helper entrypoint.", error);
    }

    configPath = path.join(privateRoot, "helper-config.json");
    previousBridgeRuntime = existingBridgeRuntime(configPath, privateRoot, uid);
    if (options.bridgeReady !== true) {
      const forceRestart = options.forceBridgeRestart === true
        || (!previousBridgeRuntime
          || path.resolve(previousBridgeRuntime.bridgeDylib) !== path.resolve(bridgeDylib));
      ensureImsgBridgeReady({
        binary: imsgBinary,
        bridgeDylib,
        run: options.imsgRun || execFileSync,
        forceRestart,
        wait: options.wait,
      });
      bridgeRestarted = forceRestart;
    }
    const profileResult = discoverDedicatedImsgProfile({
      binary: imsgBinary,
      expectedRecipientHash: bundle.manifest.expectedRecipientHash,
      account: options.account,
      chats: options.chats,
      run: options.imsgRun || execFileSync,
    });
    const keyRoot = path.join(privateRoot, "keys");
    ensurePrivateDirectory(keyRoot, uid);
    const identity = ensureHelperIdentity(keyRoot, uid);
    const controllerPublicPath = path.join(keyRoot, `controller-${bundle.manifest.controllerPublicKey.fingerprint}.pem`);
    const socketPath = path.join(bundle.root, bundle.manifest.socket);
    const logs = path.join(privateRoot, "logs");
    ensurePrivateDirectory(logs, uid);
    plistPath = path.join(home, "Library", "LaunchAgents", DEDICATED_HELPER_LABEL + ".plist");
    attestationPath = path.join(bundle.root, bundle.manifest.helperAttestation);
    for (const file of [controllerPublicPath, configPath, plistPath, attestationPath]) fileTransaction.preserve(file);

    writeAtomic(controllerPublicPath, bundle.publicPem, 0o600);
    const config = {
      version: 1,
      socketPath,
      imsgBinary,
      bridgeDylib,
      helperPrivateKeyPath: identity.privatePath,
      controllerPublicKeyPath: controllerPublicPath,
      expectedControllerIdentityHash: bundle.manifest.controllerIdentityHash,
      expectedHelperIdentityHash: identityHash,
      profile: profileResult.profile,
    };
    writeAtomic(configPath, JSON.stringify(config, null, 2) + "\n", 0o600);
    const plist = renderHelperLaunchAgent({
      nodePath: nodeRuntime,
      entrypoint,
      configPath,
      stdoutLog: path.join(logs, "helper.log"),
      stderrLog: path.join(logs, "helper-error.log"),
    });
    writeAtomic(plistPath, plist, 0o644);

    if (options.loadAgent !== false) {
      const previousSocket = socketIdentity(socketPath);
      agentMutationStarted = true;
      try { launchctl("launchctl", ["bootout", domain, plistPath], { stdio: "ignore", timeout: 10_000 }); } catch {}
      launchctl("launchctl", ["bootstrap", domain, plistPath], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
      waitForHealthyHelper({
        socketPath,
        previousSocket,
        domain,
        launchctl,
        healthCheck: options.helperHealthCheck,
        attempts: options.helperHealthAttempts,
        wait: options.wait,
      });
    }

    // Test-only fault injection proves config/plist rollback after all runtime
    // validation without weakening the production transaction.
    options.beforeInstallCommit?.({ filesRoot, configPath, plistPath });
    const installedAt = (options.now || (() => new Date().toISOString()))();
    const attestation = signedPublicAttestation({
      manifest: bundle.manifest,
      manifestHash: bundle.manifestHash,
      identity,
      processIdentity: { uid, username, home },
      profile: profileResult.profile,
      installedAt,
    });
    writeAtomic(attestationPath, JSON.stringify(attestation, null, 2) + "\n", 0o644);

    payloadTransaction.commit();
    fileTransaction.commit();
    cleanupRetiredPayloads(privateRoot, filesRoot, uid);
    return {
      installed: true,
      label: DEDICATED_HELPER_LABEL,
      plistPath,
      configPath,
      attestationPath,
      helperPublicKeyFingerprint: identity.fingerprint,
      helperIdentityHash: identityHash,
      profileHash: profileResult.profileHash,
    };
  } catch (error) {
    if (agentMutationStarted && plistPath) {
      try { launchctl("launchctl", ["bootout", domain, plistPath], { stdio: "ignore", timeout: 10_000 }); } catch {}
    }
    fileTransaction.rollback();
    payloadTransaction.rollback();
    if (bridgeRestarted && previousBridgeRuntime) {
      try {
        ensureImsgBridgeReady({
          binary: previousBridgeRuntime.binary,
          bridgeDylib: previousBridgeRuntime.bridgeDylib,
          run: options.imsgRun || execFileSync,
          forceRestart: true,
          wait: options.wait,
        });
      } catch {}
    }
    if (agentMutationStarted && plistPath && fileTransaction.existed(plistPath)) {
      try { launchctl("launchctl", ["bootstrap", domain, plistPath], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }); } catch {}
    }
    throw error;
  }
}

function main() {
  const bundleArg = process.argv.find((value) => value.startsWith("--bundle="));
  const result = installDedicatedImsgHelper({
    bundleRoot: bundleArg ? bundleArg.slice("--bundle=".length) : path.dirname(fileURLToPath(import.meta.url)),
  });
  process.stdout.write(JSON.stringify({
    installed: result.installed,
    label: result.label,
    helperPublicKeyFingerprint: result.helperPublicKeyFingerprint,
    helperIdentityHash: result.helperIdentityHash,
    profileHash: result.profileHash,
  }, null, 2) + "\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write((error?.code || "HELPER_INSTALL_FAILED") + ": " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}

export const splitUserInstallerInternals = Object.freeze({
  normalizeAccounts,
  parseJsonLines,
  profileHash,
  bridgeReady,
  signedPublicAttestation,
});
