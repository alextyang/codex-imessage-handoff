import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  verify,
} from "node:crypto";
import os from "node:os";
import path from "node:path";
import { servicePaths } from "./paths.mjs";
import {
  assertDedicatedHelperAccount,
  canonicalJson,
  expectedControllerIdentityHash,
  publicKeyFingerprint,
  userIdentityHash,
  validateDedicatedSharedGroup,
} from "./split-user-staging.mjs";
import { inspectMacGroup, verifyHelperBundle } from "./split-user-helper-installer.mjs";
import { execFileSync } from "node:child_process";
import { createImsgIpcClientFromConfig } from "./imsg-ipc-client.mjs";
import { REQUIRED_PINNED_IMSG_CAPABILITIES } from "./imsg-client.mjs";
import {
  imsgConversationHash,
  imsgIdentityHashes,
  imsgProfileHash,
  ipcIdentityHash,
} from "./imsg-ipc-protocol.mjs";

const MAX_STATE_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function strictHash(value, code = "SPLIT_USER_ATTESTATION_INVALID") {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!HASH_PATTERN.test(normalized)) throw codedError(code, "The split-user identity contains an invalid hash.");
  return normalized;
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readBoundedRegularFile(file, { privateFile = false, expectedUid = null } = {}) {
  const input = String(file || "");
  if (!path.isAbsolute(input)) throw codedError("SPLIT_USER_FILE_UNSAFE", "A split-user file path is invalid.");
  const resolved = path.resolve(input);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let descriptor;
  try { descriptor = openSync(resolved, flags); } catch (error) {
    throw codedError("SPLIT_USER_FILE_UNSAFE", "A split-user file could not be opened safely.", error);
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_STATE_BYTES) {
      throw codedError("SPLIT_USER_FILE_UNSAFE", "A split-user file is invalid.");
    }
    if (lstatSync(resolved).isSymbolicLink() || realpathSync(resolved) !== resolved) {
      throw codedError("SPLIT_USER_FILE_UNSAFE", "A split-user file is not canonical.");
    }
    if (privateFile && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)) {
      throw codedError("SPLIT_USER_FILE_UNSAFE", "A private split-user file has unsafe ownership or permissions.");
    }
    if (Number.isSafeInteger(expectedUid) && metadata.uid !== expectedUid) {
      throw codedError("SPLIT_USER_FILE_UNSAFE", "The helper attestation was not written by the dedicated account.");
    }
    if (!privateFile && (metadata.mode & 0o022) !== 0) {
      throw codedError("SPLIT_USER_FILE_UNSAFE", "A public split-user file is writable by another account.");
    }
    const output = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < output.byteLength) {
      const count = readSync(descriptor, output, offset, output.byteLength - offset, offset);
      if (count <= 0) throw codedError("SPLIT_USER_FILE_UNSAFE", "A split-user file changed while it was read.");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size) {
      throw codedError("SPLIT_USER_FILE_UNSAFE", "A split-user file changed while it was read.");
    }
    return output;
  } finally {
    closeSync(descriptor);
  }
}

function parseJson(buffer, code) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw codedError(code, "A split-user metadata file is invalid.", error);
  }
}

function writeAtomic(file, data, mode = 0o600) {
  const destination = path.resolve(file);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(destination), 0o700);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw codedError("SPLIT_USER_WRITE_FAILED", "A private split-user file could not be written.");
      offset += count;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    rmSync(temporary, { force: true });
  }
}

export function defaultSplitUserControllerPaths() {
  const root = path.join(servicePaths().home, "split-user-controller");
  return {
    root,
    activeState: path.join(root, "active-bundle.json"),
    helperPublicKey: path.join(root, "helper-public.pem"),
    clientConfig: path.join(root, "helper-client.json"),
    verifiedState: path.join(root, "verified-helper.json"),
  };
}

export function readSplitUserControllerState(file = defaultSplitUserControllerPaths().activeState) {
  const state = parseJson(readBoundedRegularFile(file, { privateFile: true }), "SPLIT_USER_STATE_INVALID");
  if (state.version !== 1 || typeof state.bundleId !== "string" || !state.bundleId
    || !path.isAbsolute(state.socketPath) || !path.isAbsolute(state.helperAttestationPath)
    || !path.isAbsolute(state.privateKeyPath) || !path.isAbsolute(state.publicKeyPath)) {
    throw codedError("SPLIT_USER_STATE_INVALID", "The active split-user bundle state is incomplete.");
  }
  for (const key of ["bundleManifestHash", "controllerIdentityHash", "controllerPublicKeyFingerprint", "expectedRecipientHash"]) {
    strictHash(state[key], "SPLIT_USER_STATE_INVALID");
  }
  if (!state.sharedGroup || typeof state.sharedGroup !== "object") {
    throw codedError("SPLIT_USER_STATE_INVALID", "The dedicated helper group is missing from the active state.");
  }
  return state;
}

export function verifyHelperPublicAttestation({
  attestation,
  activeState,
  manifest,
  dedicatedUser,
} = {}) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)
    || !activeState || !manifest) {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper attestation is incomplete.");
  }
  const { signature, ...body } = attestation;
  if (body.version !== 1 || typeof signature !== "string" || !signature) {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper attestation is incomplete.");
  }
  let helperPublicKey;
  try { helperPublicKey = createPublicKey(body.helperPublicKey || ""); } catch (error) {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper attestation key is invalid.", error);
  }
  if (helperPublicKey.asymmetricKeyType !== "ed25519") {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper attestation key is invalid.");
  }
  const fingerprint = publicKeyFingerprint(helperPublicKey);
  if (fingerprint !== strictHash(body.helperPublicKeyFingerprint)) {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper public-key fingerprint does not match.");
  }
  let signatureBytes;
  try { signatureBytes = Buffer.from(signature, "base64"); } catch {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper attestation signature is invalid.");
  }
  if (signatureBytes.byteLength !== 64
    || !verify(null, Buffer.from(canonicalJson(body)), helperPublicKey, signatureBytes)) {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper attestation signature is invalid.");
  }
  const dedicatedIdentity = userIdentityHash(dedicatedUser);
  const expected = body.expectedHelperAttestation;
  if (!expected || expected.role !== "imsg-helper") {
    throw codedError("SPLIT_USER_ATTESTATION_INVALID", "The helper runtime identity is incomplete.");
  }
  const expectedHashes = {
    identityHash: strictHash(expected.identityHash),
    accountHash: strictHash(expected.accountHash),
    conversationHash: strictHash(expected.conversationHash),
    profileHash: strictHash(expected.profileHash),
  };
  const expectedBodyHash = hash(canonicalJson({ role: "imsg-helper", ...expectedHashes }));
  const matches = body.bundleId === activeState.bundleId
    && body.bundleId === manifest.bundleId
    && strictHash(body.manifestHash) === strictHash(activeState.bundleManifestHash)
    && strictHash(body.controllerPublicKeyFingerprint) === strictHash(activeState.controllerPublicKeyFingerprint)
    && strictHash(body.controllerPublicKeyFingerprint) === strictHash(manifest.controllerPublicKey?.fingerprint)
    && strictHash(body.expectedRecipientHash) === strictHash(activeState.expectedRecipientHash)
    && strictHash(body.expectedRecipientHash) === strictHash(manifest.expectedRecipientHash)
    && strictHash(body.helperIdentityHash) === dedicatedIdentity
    && strictHash(body.helperIdentityHash) === strictHash(manifest.dedicatedIdentityHash)
    && strictHash(body.accountFingerprint) === expectedHashes.accountHash
    && strictHash(body.conversationHash) === expectedHashes.conversationHash
    && strictHash(body.profileHash) === expectedHashes.profileHash
    && expectedHashes.identityHash === dedicatedIdentity
    && strictHash(body.helperAttestationHash) === expectedBodyHash;
  if (!matches) throw codedError("SPLIT_USER_ATTESTATION_MISMATCH", "The helper attestation does not match the prepared bundle.");
  return {
    body,
    helperPublicKey: body.helperPublicKey,
    helperPublicKeyFingerprint: fingerprint,
    expectedHelperAttestation: { role: "imsg-helper", ...expectedHashes },
  };
}

function verifyRuntimeProfile(status, verified, activeState, dedicatedUser) {
  const profile = status?.profile;
  const settings = status?.settings;
  const attestation = status?.helperAttestation;
  if (!profile || !settings || !attestation || status.helperKeyFingerprint !== verified.helperPublicKeyFingerprint) {
    throw codedError("SPLIT_USER_RUNTIME_MISMATCH", "The authenticated helper returned incomplete identity metadata.");
  }
  if (attestation.uid !== Number(dedicatedUser.uid)
    || attestation.username !== dedicatedUser.username
    || attestation.homeHash !== ipcIdentityHash("helper-home", path.resolve(dedicatedUser.home))) {
    throw codedError("SPLIT_USER_RUNTIME_MISMATCH", "The helper is running under the wrong macOS account.");
  }
  for (const [key, value] of Object.entries(verified.expectedHelperAttestation)) {
    if (attestation[key] !== value) throw codedError("SPLIT_USER_RUNTIME_MISMATCH", "The live helper identity changed.");
  }
  const profileWithSettings = { ...profile, featureMode: settings.featureMode };
  if (imsgProfileHash(profileWithSettings) !== verified.expectedHelperAttestation.profileHash
    || imsgConversationHash(profile) !== verified.expectedHelperAttestation.conversationHash
    || imsgIdentityHashes(profile.expectedSender)[0] !== strictHash(activeState.expectedRecipientHash)) {
    throw codedError("SPLIT_USER_RUNTIME_MISMATCH", "The live helper conversation changed.");
  }
  if (settings.featureMode !== "bridge" || settings.presentation !== "rich"
    || settings.polls !== true || settings.reactions !== true) {
    throw codedError("SPLIT_USER_RUNTIME_MISMATCH", "The helper is not configured for the full-feature Messages mode.");
  }
  return {
    chatId: Number(profile.chatId),
    chatGuid: profile.chatGuid,
    expectedSender: profile.expectedSender,
    featureMode: settings.featureMode,
    presentation: settings.presentation,
    polls: settings.polls,
    reactions: settings.reactions,
  };
}

export async function finishSplitUserHelper(options = {}) {
  const dedicatedHome = String(options.dedicatedUser?.home || "");
  if (!path.isAbsolute(dedicatedHome)) {
    throw codedError("SPLIT_USER_IDENTITY_INVALID", "The dedicated Messages account needs an absolute home directory.");
  }
  const dedicatedUser = {
    uid: Number(options.dedicatedUser?.uid),
    username: String(options.dedicatedUser?.username || "").trim(),
    home: path.resolve(dedicatedHome),
    groupIds: Array.isArray(options.dedicatedUser?.groupIds)
      ? options.dedicatedUser.groupIds
      : String(execFileSync("/usr/bin/id", ["-G", String(options.dedicatedUser?.username || "")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      })).trim().split(/\s+/).map(Number),
  };
  userIdentityHash(dedicatedUser);
  const paths = { ...defaultSplitUserControllerPaths(), ...(options.paths || {}) };
  const activeState = readSplitUserControllerState(paths.activeState);
  const user = os.userInfo();
  assertDedicatedHelperAccount(dedicatedUser, { controllerUsername: user.username });
  const codexHome = realpathSync(options.codexHome || process.env.CODEX_HOME || path.join(user.homedir, ".codex"));
  const controllerHash = expectedControllerIdentityHash({
    uid: process.getuid?.(),
    username: user.username,
    codexHome,
  });
  if (controllerHash !== activeState.controllerIdentityHash) {
    throw codedError("SPLIT_USER_CONTROLLER_MISMATCH", "The prepared bundle belongs to another Codex controller account.");
  }

  const sharedRoot = path.dirname(path.dirname(path.resolve(activeState.socketPath)));
  if (!samePath(activeState.helperAttestationPath, path.join(sharedRoot, "exchange", "helper-identity.json"))) {
    throw codedError("SPLIT_USER_STATE_INVALID", "The helper attestation path escaped its prepared bundle.");
  }
  const bundle = verifyHelperBundle(sharedRoot);
  if (bundle.manifestHash !== activeState.bundleManifestHash || bundle.manifest.bundleId !== activeState.bundleId
    || !samePath(activeState.socketPath, path.join(sharedRoot, bundle.manifest.socket))
    || !samePath(activeState.helperAttestationPath, path.join(sharedRoot, bundle.manifest.helperAttestation))) {
    throw codedError("SPLIT_USER_BUNDLE_MISMATCH", "The prepared helper bundle changed.");
  }
  const signedGroup = validateDedicatedSharedGroup(bundle.manifest.sharedGroup, {
    controllerUsername: user.username,
    helperUsername: dedicatedUser.username,
  });
  const activeGroup = validateDedicatedSharedGroup(inspectMacGroup(signedGroup.name), {
    controllerUsername: user.username,
    helperUsername: dedicatedUser.username,
  });
  if (activeGroup.gid !== signedGroup.gid || !dedicatedUser.groupIds.includes(signedGroup.gid)
    || canonicalJson(activeState.sharedGroup) !== canonicalJson(signedGroup)) {
    throw codedError("SPLIT_USER_SHARED_GROUP_MISMATCH", "The dedicated helper group changed after preparation.");
  }
  if (!inside(sharedRoot, activeState.socketPath) || !inside(sharedRoot, activeState.helperAttestationPath)) {
    throw codedError("SPLIT_USER_STATE_INVALID", "A helper exchange path escaped its prepared bundle.");
  }

  const controllerPrivate = createPrivateKey(readBoundedRegularFile(activeState.privateKeyPath, { privateFile: true }));
  const controllerPublic = createPublicKey(controllerPrivate);
  if (publicKeyFingerprint(controllerPublic) !== activeState.controllerPublicKeyFingerprint
    || publicKeyFingerprint(readBoundedRegularFile(activeState.publicKeyPath, { privateFile: true })) !== activeState.controllerPublicKeyFingerprint) {
    throw codedError("SPLIT_USER_CONTROLLER_MISMATCH", "The controller signing identity changed.");
  }

  const attestationBytes = readBoundedRegularFile(activeState.helperAttestationPath, {
    expectedUid: dedicatedUser.uid,
  });
  const attestation = parseJson(attestationBytes, "SPLIT_USER_ATTESTATION_INVALID");
  const verified = verifyHelperPublicAttestation({
    attestation,
    activeState,
    manifest: bundle.manifest,
    dedicatedUser,
  });

  writeAtomic(paths.helperPublicKey, verified.helperPublicKey, 0o600);
  const clientConfig = {
    version: 1,
    socketPath: activeState.socketPath,
    controllerPrivateKeyPath: activeState.privateKeyPath,
    helperPublicKeyPath: paths.helperPublicKey,
    codexHome,
    expectedControllerIdentityHash: activeState.controllerIdentityHash,
    expectedHelperAttestation: verified.expectedHelperAttestation,
    expectedHelperKeyFingerprint: verified.helperPublicKeyFingerprint,
  };
  writeAtomic(paths.clientConfig, `${JSON.stringify(clientConfig, null, 2)}\n`, 0o600);

  const client = createImsgIpcClientFromConfig(paths.clientConfig, {
    codexHome,
    connectTimeoutMs: options.connectTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  let runtimeProfile;
  let capabilities;
  let watchVerified = false;
  try {
    await client.connect();
    const helperStatus = await client.helperStatus();
    runtimeProfile = verifyRuntimeProfile(helperStatus, verified, activeState, dedicatedUser);
    capabilities = await client.status({ refresh: true });
    if (!capabilities?.available || !capabilities?.basic || !capabilities?.advanced
      || capabilities?.v2Ready !== true
      || REQUIRED_PINNED_IMSG_CAPABILITIES.some(
        (name) => capabilities?.capabilities?.[name] !== true,
      )) {
      throw codedError("SPLIT_USER_CAPABILITIES_MISSING", "The dedicated helper did not expose the required advanced Messages capabilities.");
    }
    const latest = await client.latestMessage({ chat_id: runtimeProfile.chatId });
    await client.start();
    const watch = await client.subscribeWatch({
      chat_id: runtimeProfile.chatId,
      ...(Number.isSafeInteger(Number(latest?.rowid)) ? { since_rowid: Number(latest.rowid) } : {}),
      attachments: true,
      include_reactions: true,
      debounce_ms: 500,
    }, { onMessage: () => {}, onError: () => {} });
    await watch.unsubscribe();
    watchVerified = true;
  } finally {
    // This is a diagnostics connection to a helper-owned, pinned RPC process.
    // Closing the authenticated socket must not stop that shared bridge before
    // the persistent service takes over its own connection.
    await client.close().catch(() => {});
  }

  writeAtomic(paths.verifiedState, `${JSON.stringify({
    version: 1,
    bundleId: activeState.bundleId,
    bundleManifestHash: activeState.bundleManifestHash,
    helperPublicKeyFingerprint: verified.helperPublicKeyFingerprint,
    helperIdentityHash: verified.expectedHelperAttestation.identityHash,
    accountFingerprint: verified.expectedHelperAttestation.accountHash,
    conversationHash: verified.expectedHelperAttestation.conversationHash,
    profileHash: verified.expectedHelperAttestation.profileHash,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, 0o600);

  return {
    clientConfigPath: paths.clientConfig,
    profile: runtimeProfile,
    capabilities,
    watchVerified,
    helperPublicKeyFingerprint: verified.helperPublicKeyFingerprint,
  };
}

export const splitUserControllerInternals = Object.freeze({
  readBoundedRegularFile,
  verifyRuntimeProfile,
});
