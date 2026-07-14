import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  readdirSync,
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalImsgIdentity,
  controllerIdentityHash,
  createControllerAttestation,
  helperIdentityHash,
  imsgIdentityHashes,
} from "./imsg-ipc-protocol.mjs";

export const SPLIT_USER_BUNDLE_VERSION = 2;
export const SPLIT_USER_HELPER_LABEL = "com.codex.imessage-handoff.imsg-helper";
export const DEFAULT_SPLIT_USER_SHARED_BASE = "/Users/Shared";
export const DEFAULT_SPLIT_USER_BUNDLE_NAME = "codex-imessage-helper";
export const DEFAULT_SPLIT_USER_GROUP_NAME = "codex-imessage-handoff";

export const HELPER_FORBIDDEN_GROUP_IDS = Object.freeze([0, 79, 80, 81, 98, 204, 250, 395, 398, 399, 400]);
const privilegedGroupIds = new Set(HELPER_FORBIDDEN_GROUP_IDS);
const broadGroupIds = new Set([0, 12, 20, 61, 79, 80, 81]);
const broadGroupNames = new Set([
  "wheel",
  "everyone",
  "staff",
  "admin",
  "localaccounts",
  "_appserverusr",
  "_appserveradm",
]);

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(sourceDirectory, "..", "..");
const privateKeyName = "controller-private.pem";
const publicKeyName = "controller-public.pem";
const controllerStateName = "controller-identity.json";
const markerName = ".codex-imessage-helper-bundle";
const installerName = "install-helper.mjs";
const launcherName = "Install Codex Messages.command";
const manifestName = "bundle-manifest.json";
const signatureName = "bundle-manifest.sig";

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalRecipient(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const canonical = text.length <= 512 && !/[\u0000-\u001f]/.test(text)
    ? canonicalImsgIdentity(text)
    : null;
  if (!canonical) {
    throw codedError("SPLIT_USER_RECIPIENT_INVALID", "A valid expected recipient is required.");
  }
  return canonical;
}

export function recipientIdentityHash(value) {
  canonicalRecipient(value);
  const [hash] = imsgIdentityHashes(value);
  if (!hash) throw codedError("SPLIT_USER_RECIPIENT_INVALID", "A valid expected recipient is required.");
  return hash;
}

export function userIdentityHash({ uid, username, home } = {}) {
  const numericUid = Number(uid);
  const name = typeof username === "string" ? username.trim() : "";
  const resolvedHome = typeof home === "string" && path.isAbsolute(home) ? path.resolve(home) : "";
  if (!Number.isSafeInteger(numericUid) || numericUid < 0 || !/^[A-Za-z0-9._-]{1,80}$/.test(name) || !resolvedHome) {
    throw codedError("SPLIT_USER_IDENTITY_INVALID", "The split-user identity is invalid.");
  }
  return helperIdentityHash({ uid: numericUid, username: name, home: resolvedHome });
}

function normalizedGroupIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((item) => Number.isSafeInteger(item) && item >= 0))].sort((a, b) => a - b);
}

export function assertDedicatedHelperAccount(user = {}, { controllerUsername = "" } = {}) {
  const uid = Number(user.uid);
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const groupIds = normalizedGroupIds(user.groupIds);
  if (!Number.isSafeInteger(uid) || uid < 500 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(username)
    || username.startsWith("_") || ["root", "daemon", "nobody"].includes(username.toLowerCase())) {
    throw codedError("SPLIT_USER_HELPER_PRIVILEGED", "The Messages helper must use a non-privileged macOS GUI account.");
  }
  if (username === String(controllerUsername || "").trim() || user.isAdmin === true
    || groupIds.some((gid) => privilegedGroupIds.has(gid))) {
    throw codedError("SPLIT_USER_HELPER_PRIVILEGED", "The Messages helper account must not be the controller or an administrator.");
  }
  if (!groupIds.length) {
    throw codedError("SPLIT_USER_HELPER_GROUPS_UNKNOWN", "The Messages helper group memberships must be verified before staging.");
  }
  return { uid, username, home: path.resolve(String(user.home || "")), groupIds };
}

export function validateDedicatedSharedGroup(group = {}, { controllerUsername = "", helperUsername = "" } = {}) {
  const name = typeof group.name === "string" ? group.name.trim() : "";
  const gid = Number(group.gid);
  const members = [...new Set(Array.isArray(group.members)
    ? group.members.map((value) => String(value || "").trim()).filter(Boolean)
    : [])].sort();
  const nestedGroups = Array.isArray(group.nestedGroups) ? group.nestedGroups.filter(Boolean) : [];
  const expected = [...new Set([controllerUsername, helperUsername].map((value) => String(value || "").trim()).filter(Boolean))].sort();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)
    || name.startsWith("_") || name.toLowerCase().startsWith("com.apple.")
    || broadGroupNames.has(name.toLowerCase()) || !Number.isSafeInteger(gid) || gid < 500
    || broadGroupIds.has(gid) || expected.length !== 2
    || nestedGroups.length !== 0 || members.length !== 2 || members.some((value, index) => value !== expected[index])) {
    throw codedError(
      "SPLIT_USER_SHARED_GROUP_UNSAFE",
      "The helper exchange requires a dedicated non-system group containing exactly the controller and helper accounts.",
    );
  }
  return { name, gid, members, nestedGroups: [] };
}

export function resolveHelperNodeRuntime(value = "", { controllerHome = "" } = {}) {
  const configured = typeof value === "string" ? value.trim() : "";
  const candidates = configured
    ? [configured]
    : ["/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"];
  const selected = candidates.find((candidate) => {
    if (!path.isAbsolute(candidate) || !existsSync(candidate)) return false;
    const metadata = lstatSync(candidate);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o111) !== 0;
  });
  if (!selected) {
    throw codedError("SPLIT_USER_NODE_RUNTIME_UNAVAILABLE", "A standalone app-owned Node runtime is required for the Messages helper.");
  }
  const resolved = realpathSync(selected);
  const unsafeRoots = ["/opt/homebrew", "/usr/local/Cellar", "/usr/local/Homebrew", "/usr/local/opt"];
  if (unsafeRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
    || (controllerHome && (resolved === path.resolve(controllerHome) || within(path.resolve(controllerHome), resolved)))) {
    throw codedError(
      "SPLIT_USER_NODE_RUNTIME_UNSAFE",
      "The persistent helper cannot depend on a controller-owned or Homebrew-managed Node runtime.",
    );
  }
  return resolved;
}

export function expectedControllerIdentityHash({ uid, username, codexHome } = {}) {
  const numericUid = Number(uid);
  const name = typeof username === "string" ? username.trim() : "";
  const home = typeof codexHome === "string" && path.isAbsolute(codexHome) ? realpathSync(codexHome) : "";
  if (!Number.isSafeInteger(numericUid) || numericUid < 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(name) || !home) {
    throw codedError("SPLIT_USER_IDENTITY_INVALID", "The controller identity is invalid.");
  }
  return controllerIdentityHash(createControllerAttestation({ uid: numericUid, username: name, codexHome: home }));
}

export function publicKeyFingerprint(key) {
  const publicKey = key?.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw codedError("SPLIT_USER_KEY_INVALID", "The split-user identity must use Ed25519.");
  }
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

function privateFileMode(file) {
  return lstatSync(file).mode & 0o777;
}

function assertPrivateFile(file, uid = process.getuid?.()) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw codedError("SPLIT_USER_PRIVATE_FILE_UNSAFE", "A split-user private file has unsafe permissions.");
  }
  if (Number.isSafeInteger(uid) && metadata.uid !== uid) {
    throw codedError("SPLIT_USER_PRIVATE_FILE_UNSAFE", "A split-user private file has the wrong owner.");
  }
  return metadata;
}

function writeAtomic(file, data, mode) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", mode);
  try {
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

function readEd25519PrivateKey(file) {
  assertPrivateFile(file);
  let key;
  try { key = createPrivateKey(readFileSync(file)); } catch (error) {
    throw codedError("SPLIT_USER_KEY_INVALID", "The controller private key could not be read.", error);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw codedError("SPLIT_USER_KEY_INVALID", "The controller private key must use Ed25519.");
  }
  return key;
}

export function ensureControllerIdentity({ keyDirectory, controllerIdentityHash, now = () => new Date().toISOString() } = {}) {
  const directory = path.resolve(String(keyDirectory || ""));
  if (!path.isAbsolute(directory)) throw codedError("SPLIT_USER_KEY_PATH_INVALID", "A private controller key directory is required.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const privateKeyPath = path.join(directory, privateKeyName);
  const publicKeyPath = path.join(directory, publicKeyName);
  let privateKey;
  if (existsSync(privateKeyPath)) {
    privateKey = readEd25519PrivateKey(privateKeyPath);
  } else {
    const generated = generateKeyPairSync("ed25519");
    privateKey = generated.privateKey;
    writeAtomic(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
  }
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  if (existsSync(publicKeyPath)) {
    const existing = createPublicKey(readFileSync(publicKeyPath));
    if (publicKeyFingerprint(existing) !== publicKeyFingerprint(publicKey)) {
      throw codedError("SPLIT_USER_KEY_MISMATCH", "The controller public and private keys do not match.");
    }
  } else {
    writeAtomic(publicKeyPath, publicPem, 0o600);
  }
  chmodSync(publicKeyPath, 0o600);
  const fingerprint = publicKeyFingerprint(publicKey);
  const state = {
    version: 1,
    controllerIdentityHash,
    publicKeyFingerprint: fingerprint,
    privateKeyPath,
    publicKeyPath,
    updatedAt: now(),
  };
  writeAtomic(path.join(directory, controllerStateName), `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return { privateKey, publicKey, privateKeyPath, publicKeyPath, publicPem, fingerprint };
}

function relativeImports(source) {
  const specifiers = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith(".")) specifiers.add(match[1]);
      else if (!match[1].startsWith("node:")) {
        throw codedError("SPLIT_USER_EXTERNAL_DEPENDENCY", "The helper runtime cannot include external package imports.");
      }
    }
  }
  return [...specifiers];
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function collectHelperModuleGraph(entrypoint, { projectRoot = defaultProjectRoot } = {}) {
  const root = realpathSync(projectRoot);
  const pending = [realpathSync(entrypoint)];
  const files = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    if (!within(root, file)) throw codedError("SPLIT_USER_RUNTIME_SCOPE", "The helper runtime escaped the project root.");
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw codedError("SPLIT_USER_RUNTIME_INVALID", "The helper runtime contains an unsafe module.");
    }
    const source = readFileSync(file, "utf8");
    if (/\b(?:codex\s+exec|app-server\s+proxy)\b/i.test(source)) {
      throw codedError("SPLIT_USER_CODEX_FORBIDDEN", "The Messages helper runtime must not start Codex.");
    }
    files.add(file);
    for (const specifier of relativeImports(source)) {
      const resolved = realpathSync(path.resolve(path.dirname(file), specifier));
      pending.push(resolved);
    }
  }
  return [...files].sort();
}

function copyPayloadFile(source, destination, mode) {
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw codedError("SPLIT_USER_PAYLOAD_INVALID", "The split-user payload contains an unsafe file.");
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination);
  chmodSync(destination, mode);
  const copied = readFileSync(destination);
  return { sha256: sha256(copied), bytes: copied.byteLength, mode };
}

function runtimeTreeFiles(root) {
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, item.name);
      const relative = path.join(relativeDirectory, item.name);
      if (item.isSymbolicLink()) {
        throw codedError("SPLIT_USER_RUNTIME_SYMLINK", "The staged imsg runtime must not contain symlinks.");
      }
      if (item.isDirectory()) visit(source, relative);
      else if (item.isFile()) files.push({ source, relative });
      else throw codedError("SPLIT_USER_RUNTIME_INVALID", "The staged imsg runtime contains an unsupported file.");
    }
  };
  visit(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function safeBundleDestination(sharedBase, sharedRoot) {
  const base = path.resolve(sharedBase);
  const destination = path.resolve(sharedRoot);
  if (!within(base, destination)) {
    throw codedError("SPLIT_USER_SHARED_PATH_INVALID", "The split-user bundle must be inside its Shared base directory.");
  }
  return { base, destination };
}

function assertOwnedBundleFile(file, uid) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
    throw codedError("SPLIT_USER_BUNDLE_UNSAFE", "The existing split-user bundle is not an owned, immutable staged bundle.");
  }
  return readFileSync(file);
}

function verifyExistingStagedBundle(destination, { uid, publicKey, fingerprint } = {}) {
  const metadata = lstatSync(destination);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
    throw codedError("SPLIT_USER_BUNDLE_UNSAFE", "The existing split-user bundle is not an owned, immutable staged bundle.");
  }
  let marker;
  let manifest;
  try {
    marker = JSON.parse(assertOwnedBundleFile(path.join(destination, markerName), uid));
    manifest = JSON.parse(assertOwnedBundleFile(path.join(destination, manifestName), uid));
  } catch (error) {
    if (error?.code === "SPLIT_USER_BUNDLE_UNSAFE") throw error;
    throw codedError("SPLIT_USER_BUNDLE_UNSAFE", "The existing split-user bundle metadata is invalid.", error);
  }
  if (marker?.version !== 1 || typeof marker.bundleId !== "string" || marker.bundleId !== manifest?.bundleId
    || manifest?.version !== SPLIT_USER_BUNDLE_VERSION || manifest.controllerPublicKey?.path !== publicKeyName) {
    throw codedError("SPLIT_USER_BUNDLE_UNSAFE", "The existing split-user bundle marker does not match its manifest.");
  }
  const embeddedPublic = assertOwnedBundleFile(path.join(destination, String(manifest.controllerPublicKey?.path || "")), uid);
  if (publicKeyFingerprint(embeddedPublic) !== fingerprint) {
    throw codedError("SPLIT_USER_BUNDLE_UNSAFE", "The existing split-user bundle belongs to a different controller identity.");
  }
  const signatureText = assertOwnedBundleFile(path.join(destination, signatureName), uid).toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)
    || !verify(null, Buffer.from(canonicalJson(manifest)), publicKey, Buffer.from(signatureText, "base64"))) {
    throw codedError("SPLIT_USER_BUNDLE_UNSAFE", "The existing split-user bundle signature is invalid.");
  }
  return { bundleId: marker.bundleId, manifest };
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function safeExistingExchange(directory, { uid, gid } = {}) {
  if (!existsSync(directory)) return false;
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== uid || metadata.gid !== gid || (metadata.mode & 0o007) !== 0) {
    throw codedError(
      "SPLIT_USER_EXCHANGE_UNSAFE",
      "The existing helper exchange directory is unsafe.",
    );
  }
  return true;
}

function parkExistingExchange(destination, parkedExchange, identity) {
  const exchange = path.join(destination, "exchange");
  if (!safeExistingExchange(exchange, identity)) return false;
  renameSync(exchange, parkedExchange);
  syncDirectory(destination);
  syncDirectory(path.dirname(destination));
  return true;
}

function restoreParkedExchange(destination, parkedExchange) {
  if (!existsSync(parkedExchange)) return false;
  const exchange = path.join(destination, "exchange");
  if (existsSync(exchange)) rmSync(exchange, { recursive: true, force: true });
  renameSync(parkedExchange, exchange);
  syncDirectory(destination);
  syncDirectory(path.dirname(destination));
  return true;
}

function recoverQuarantinedBundle(destination, validation) {
  if (existsSync(destination)) return null;
  const parent = path.dirname(destination);
  const prefix = `${path.basename(destination)}.quarantine-`;
  const candidates = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .flatMap((entry) => {
      const candidate = path.join(parent, entry.name);
      try {
        const verified = verifyExistingStagedBundle(candidate, validation);
        return [{ candidate, verified, mtimeMs: lstatSync(candidate).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) return null;
  renameSync(candidates[0].candidate, destination);
  syncDirectory(parent);
  return candidates[0].verified;
}

function controllerDefaults(options = {}) {
  const user = os.userInfo();
  return {
    uid: Number.isSafeInteger(options.uid) ? options.uid : process.getuid(),
    username: options.username || user.username,
    home: options.home || user.homedir,
    codexHome: path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(user.homedir, ".codex")),
  };
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function stageSplitUserHelperBundle(options = {}) {
  const sharedBase = options.sharedBase || DEFAULT_SPLIT_USER_SHARED_BASE;
  const sharedRoot = options.sharedRoot || path.join(sharedBase, DEFAULT_SPLIT_USER_BUNDLE_NAME);
  const { destination } = safeBundleDestination(sharedBase, sharedRoot);

  const projectRoot = realpathSync(options.projectRoot || defaultProjectRoot);
  const entrypoint = realpathSync(options.entrypoint || path.join(projectRoot, "service", "src", "imsg-helper-entry.mjs"));
  const installerSource = realpathSync(options.installerSource || path.join(projectRoot, "service", "src", "split-user-helper-installer.mjs"));
  const installerProtocolSource = realpathSync(options.installerProtocolSource || path.join(projectRoot, "service", "src", "imsg-ipc-protocol.mjs"));
  const daemonSafeImsgBinary = realpathSync(String(options.daemonSafeImsgBinary || options.imsgBinary || ""));
  const imsgRuntimeRoot = realpathSync(String(options.imsgRuntimeRoot || "/opt/homebrew/libexec/imsg"));
  const recipientHash = recipientIdentityHash(options.expectedRecipient);
  const dedicated = options.dedicatedUser || {};
  const dedicatedHash = userIdentityHash(dedicated);
  const controller = controllerDefaults(options.controller);
  const helperAccount = assertDedicatedHelperAccount(dedicated, { controllerUsername: controller.username });
  const sharedGroup = validateDedicatedSharedGroup(options.sharedGroup, {
    controllerUsername: controller.username,
    helperUsername: helperAccount.username,
  });
  const controllerGroupIds = normalizedGroupIds(options.controller?.groupIds);
  if (!controllerGroupIds.includes(sharedGroup.gid) || !helperAccount.groupIds.includes(sharedGroup.gid)) {
    throw codedError("SPLIT_USER_SHARED_GROUP_MEMBERSHIP", "Both macOS accounts must be direct members of the dedicated helper group.");
  }
  const nodeSource = resolveHelperNodeRuntime(options.nodePath, { controllerHome: controller.home });
  const controllerHash = expectedControllerIdentityHash(controller);
  const keyDirectory = path.resolve(options.controllerKeyDirectory
    || path.join(controller.home, ".codex", "imessage-handoff", "split-user-controller"));
  if (!within(path.resolve(controller.home), keyDirectory)) {
    throw codedError("SPLIT_USER_KEY_PATH_INVALID", "Controller keys must remain inside the controller home.");
  }
  const identity = ensureControllerIdentity({
    keyDirectory,
    controllerIdentityHash: controllerHash,
    now: options.now,
  });
  const existingValidation = { uid: controller.uid, publicKey: identity.publicKey, fingerprint: identity.fingerprint };
  recoverQuarantinedBundle(destination, existingValidation);
  if (existsSync(destination)) verifyExistingStagedBundle(destination, existingValidation);

  const moduleGraph = collectHelperModuleGraph(entrypoint, { projectRoot });
  const bundleId = options.bundleId || randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(bundleId))) {
    throw codedError("SPLIT_USER_BUNDLE_ID_INVALID", "The split-user bundle id is invalid.");
  }
  const temporary = `${destination}.tmp-${process.pid}-${bundleId}`;
  mkdirSync(temporary, { recursive: false, mode: 0o755 });
  try {
    mkdirSync(path.join(temporary, "payload"), { mode: 0o755 });
    const exchangeDirectory = path.join(temporary, "exchange");
    mkdirSync(exchangeDirectory, { mode: 0o770 });
    chownSync(exchangeDirectory, controller.uid, sharedGroup.gid);
    chmodSync(exchangeDirectory, 0o770);

    const payload = [];
    for (const source of moduleGraph) {
      const relativeSource = path.relative(projectRoot, source);
      const relative = path.posix.join("payload", ...relativeSource.split(path.sep));
      const details = copyPayloadFile(source, path.join(temporary, relative), 0o644);
      payload.push({ path: relative, kind: "module", ...details });
    }
    const nodeRelative = "payload/runtime/node/node";
    const nodeDetails = copyPayloadFile(nodeSource, path.join(temporary, nodeRelative), 0o555);
    payload.push({ path: nodeRelative, kind: "node-runtime", ...nodeDetails });
    const stagedRuntimeRoot = "payload/runtime/imsg";
    const runtimeFiles = runtimeTreeFiles(imsgRuntimeRoot);
    if (!runtimeFiles.some((item) => item.relative === "imsg")
      || !runtimeFiles.some((item) => item.relative === "imsg-bridge-helper.dylib")) {
      throw codedError("SPLIT_USER_RUNTIME_INCOMPLETE", "The imsg runtime must include its binary and bridge helper.");
    }
    for (const item of runtimeFiles) {
      const source = item.relative === "imsg" ? daemonSafeImsgBinary : item.source;
      const originalMode = lstatSync(source).mode & 0o777;
      const mode = (originalMode & 0o111) !== 0 ? 0o555 : 0o444;
      const relative = path.posix.join(stagedRuntimeRoot, ...item.relative.split(path.sep));
      payload.push({ path: relative, kind: item.relative === "imsg" ? "imsg" : "imsg-runtime", ...copyPayloadFile(source, path.join(temporary, relative), mode) });
    }
    const imsgRelative = `${stagedRuntimeRoot}/imsg`;
    const bridgeDylibRelative = `${stagedRuntimeRoot}/imsg-bridge-helper.dylib`;
    payload.sort((left, right) => left.path.localeCompare(right.path));

    const publicRelative = publicKeyName;
    writeFileSync(path.join(temporary, publicRelative), identity.publicPem, { mode: 0o644 });
    chmodSync(path.join(temporary, publicRelative), 0o644);
    const publicBytes = readFileSync(path.join(temporary, publicRelative));

    const installerDetails = copyPayloadFile(installerSource, path.join(temporary, installerName), 0o555);
    const installerProtocolName = "imsg-ipc-protocol.mjs";
    const installerProtocolDetails = copyPayloadFile(installerProtocolSource, path.join(temporary, installerProtocolName), 0o444);
    const entrypointRelative = path.posix.join("payload", ...path.relative(projectRoot, entrypoint).split(path.sep));
    const launcher = [
      "#!/bin/sh",
      "set -u",
      "printf '\\nInstalling the Codex Messages helper…\\n\\n'",
      shellQuote(path.join(destination, nodeRelative)) + " "
        + shellQuote(path.join(destination, installerName)) + " "
        + shellQuote("--bundle=" + destination),
      "status=$?",
      "if [ \"$status\" -eq 0 ]; then",
      "  printf '\\nThe Codex Messages helper is ready. Return to your main macOS account.\\n'",
      "else",
      "  printf '\\nSetup could not finish. Leave this window open and return to Codex.\\n'",
      "fi",
      "printf '\\nPress Return to close this window.\\n'",
      "IFS= read -r _answer || true",
      "exit \"$status\"",
      "",
    ].join("\n");
    writeFileSync(path.join(temporary, launcherName), launcher, { mode: 0o555 });
    chmodSync(path.join(temporary, launcherName), 0o555);
    const launcherBytes = readFileSync(path.join(temporary, launcherName));
    const createdAt = (options.now || (() => new Date().toISOString()))();
    const manifest = {
      version: SPLIT_USER_BUNDLE_VERSION,
      bundleId,
      createdAt,
      helperLabel: SPLIT_USER_HELPER_LABEL,
      sharedGroup,
      dedicatedIdentityHash: dedicatedHash,
      controllerIdentityHash: controllerHash,
      controllerPublicKey: {
        path: publicRelative,
        sha256: sha256(publicBytes),
        fingerprint: identity.fingerprint,
      },
      expectedRecipientHash: recipientHash,
      node: { path: nodeRelative, ...nodeDetails },
      installer: { path: installerName, ...installerDetails },
      installerProtocol: { path: installerProtocolName, ...installerProtocolDetails },
      launcher: { path: launcherName, sha256: sha256(launcherBytes), bytes: launcherBytes.byteLength, mode: 0o555 },
      entrypoint: entrypointRelative,
      imsg: imsgRelative,
      bridgeDylib: bridgeDylibRelative,
      socket: "exchange/imsg-helper.sock",
      helperAttestation: "exchange/helper-identity.json",
      payload,
    };
    const canonical = canonicalJson(manifest);
    const signature = sign(null, Buffer.from(canonical), identity.privateKey).toString("base64");
    writeFileSync(path.join(temporary, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    writeFileSync(path.join(temporary, signatureName), `${signature}\n`, { mode: 0o644 });
    writeFileSync(path.join(temporary, markerName), `${JSON.stringify({ version: 1, bundleId })}\n`, { mode: 0o644 });
    chmodSync(temporary, 0o755);

    const controllerState = {
      version: 1,
      bundleId,
      bundleManifestHash: sha256(canonical),
      controllerIdentityHash: controllerHash,
      controllerPublicKeyFingerprint: identity.fingerprint,
      expectedRecipientHash: recipientHash,
      sharedGroup,
      socketPath: path.join(destination, manifest.socket),
      helperAttestationPath: path.join(destination, manifest.helperAttestation),
      privateKeyPath: identity.privateKeyPath,
      publicKeyPath: identity.publicKeyPath,
      preparedAt: createdAt,
    };
    let quarantine = null;
    let parkedExchange = null;
    let activated = false;
    try {
      if (existsSync(destination)) {
        verifyExistingStagedBundle(destination, existingValidation);
        parkedExchange = `${destination}.exchange-${randomUUID()}`;
        if (!parkExistingExchange(destination, parkedExchange, {
          uid: controller.uid,
          gid: sharedGroup.gid,
        })) parkedExchange = null;
        quarantine = `${destination}.quarantine-${randomUUID()}`;
        renameSync(destination, quarantine);
        syncDirectory(path.dirname(destination));
      }
      renameSync(temporary, destination);
      activated = true;
      syncDirectory(path.dirname(destination));
      if (parkedExchange) restoreParkedExchange(destination, parkedExchange);
      // Test-only fault injection exercises the rollback boundary without
      // requiring unsafe permission changes to the controller's real home.
      options.beforeControllerStateCommit?.({ destination, quarantine });
      writeAtomic(path.join(keyDirectory, "active-bundle.json"), `${JSON.stringify(controllerState, null, 2)}\n`, 0o600);
    } catch (error) {
      if (activated) {
        if (parkedExchange && !existsSync(parkedExchange)) {
          const activeExchange = path.join(destination, "exchange");
          if (existsSync(activeExchange)) renameSync(activeExchange, parkedExchange);
        }
        rmSync(destination, { recursive: true, force: true });
      }
      if (quarantine && existsSync(quarantine) && !existsSync(destination)) renameSync(quarantine, destination);
      if (parkedExchange && existsSync(parkedExchange) && existsSync(destination)) {
        restoreParkedExchange(destination, parkedExchange);
      }
      try { syncDirectory(path.dirname(destination)); } catch {}
      throw error;
    }
    if (quarantine) {
      try { rmSync(quarantine, { recursive: true, force: true }); } catch {}
    }
    return {
      sharedRoot: destination,
      installerPath: path.join(destination, installerName),
      launcherPath: path.join(destination, launcherName),
      manifestPath: path.join(destination, manifestName),
      controllerKeyDirectory: keyDirectory,
      controllerPublicKeyFingerprint: identity.fingerprint,
      controllerIdentityHash: controllerHash,
      dedicatedIdentityHash: dedicatedHash,
      expectedRecipientHash: recipientHash,
      bundleManifestHash: controllerState.bundleManifestHash,
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export const splitUserStagingInternals = Object.freeze({
  assertPrivateFile,
  privateFileMode,
  writeAtomic,
  markerName,
  manifestName,
  signatureName,
  installerName,
  launcherName,
});
