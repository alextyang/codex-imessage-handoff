import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export const IMSG_IPC_PROTOCOL_VERSION = 1;
export const IMSG_IPC_MAX_FRAME_BYTES = 1024 * 1024;
export const IMSG_IPC_ATTACHMENT_CHUNK_BYTES = 192 * 1024;
export const IMSG_IPC_MAX_FRAMES_PER_PUSH = 32;
const IMSG_IPC_MAX_CANONICAL_DEPTH = 16;

export function randomNonce() {
  return randomBytes(32).toString("base64url");
}

function canonical(value, depth = 0) {
  if (depth > IMSG_IPC_MAX_CANONICAL_DEPTH) {
    throw Object.assign(new Error("The IPC transcript is nested too deeply."), { code: "IMSG_IPC_VALUE_TOO_DEEP" });
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("The IPC transcript contains an unsupported value.");
  }
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`);
  return `{${entries.join(",")}}`;
}

function boundedAttestation(value, role) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`The ${role} IPC attestation is invalid.`), { code: "IMSG_IPC_ATTESTATION_INVALID" });
  }
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized, "utf8") > 8192) {
    throw Object.assign(new Error(`The ${role} IPC attestation is too large.`), { code: "IMSG_IPC_ATTESTATION_INVALID" });
  }
  return JSON.parse(serialized);
}

function nonce(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(text)) {
    throw Object.assign(new Error("The imsg IPC authentication challenge is invalid."), { code: "IMSG_IPC_AUTH_INVALID" });
  }
  return text;
}

export function ipcIdentityHash(label, value) {
  const text = typeof value === "string" ? value : canonical(value);
  return createHash("sha256").update(`imsg-ipc:${label}\0${text}`).digest("hex");
}

export function canonicalImsgIdentity(value) {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  for (let count = 0; count < 4; count += 1) {
    const stripped = text.replace(/^(?:tel:|mailto:|[PE]:)\s*/i, "").trim();
    if (stripped === text) break;
    text = stripped;
  }
  if (/^[^\s@]+@[^\s@]+$/.test(text)) return `email:${text.toLocaleLowerCase("en-US")}`;
  if (!/^\+?[\d\s().-]+$/.test(text)) return `handle:${text.toLocaleLowerCase("en-US")}`;
  let digits = text.replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return digits.length >= 7 && digits.length <= 15 ? `phone:${digits}` : null;
}

export function extractImsgAccountIdentities(value) {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const objects = [root];
  if (root.account && typeof root.account === "object" && !Array.isArray(root.account)) objects.push(root.account);
  if (Array.isArray(root.accounts)) {
    for (const account of root.accounts) {
      if (account && typeof account === "object" && !Array.isArray(account)) objects.push(account);
    }
  }
  const identities = [];
  const scalarKeys = ["account_login", "accountLogin", "last_addressed_handle", "lastAddressedHandle", "login"];
  const arrayKeys = ["account_logins", "accountLogins", "aliases", "handles"];
  const identityValue = (item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    for (const key of ["handle", "identifier", "address", "value", "id"]) {
      if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
    }
    return "";
  };
  for (const object of objects) {
    for (const key of scalarKeys) {
      if (typeof object[key] === "string" && object[key].trim()) identities.push(object[key].trim());
    }
    for (const key of arrayKeys) {
      if (Array.isArray(object[key])) {
        identities.push(...object[key].map(identityValue).filter(Boolean));
      }
    }
  }
  return [...new Set(identities)];
}

export function imsgIdentityHashes(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(canonicalImsgIdentity)
    .filter(Boolean)
    .map((identity) => ipcIdentityHash("messages-identity", identity)))].sort();
}

export function imsgAccountFingerprint(values) {
  const identities = imsgIdentityHashes(values);
  return identities.length ? ipcIdentityHash("messages-account", identities) : null;
}

export function imsgConversationHash({ chatId, chatGuid } = {}) {
  const id = Number(chatId);
  const guid = typeof chatGuid === "string" ? chatGuid.trim() : "";
  if (!Number.isSafeInteger(id) || id <= 0 || !guid) throw new TypeError("The Messages conversation identity is invalid.");
  return ipcIdentityHash("conversation", `${id}\0${guid}`);
}

export function imsgProfileHash(profile = {}) {
  const id = Number(profile.chatId);
  const guid = typeof profile.chatGuid === "string" ? profile.chatGuid.trim() : "";
  const sender = canonicalImsgIdentity(profile.expectedSender);
  if (!Number.isSafeInteger(id) || id <= 0 || !guid || !sender || profile.featureMode !== "bridge") {
    throw new TypeError("The Messages helper profile is invalid.");
  }
  return ipcIdentityHash("profile", {
    chatId: id,
    chatGuid: guid,
    expectedSender: sender,
    featureMode: "bridge",
  });
}

export function helperIdentityHash({ uid, username, home } = {}) {
  const numericUid = Number(uid);
  const name = typeof username === "string" ? username.trim() : "";
  const homeValue = typeof home === "string" ? home : "";
  if (!Number.isSafeInteger(numericUid) || numericUid < 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(name) || !homeValue.startsWith("/")) {
    throw new TypeError("The Messages helper process identity is invalid.");
  }
  return ipcIdentityHash("helper-identity", {
    uid: numericUid,
    username: name,
    homeHash: ipcIdentityHash("helper-home", homeValue),
  });
}

export function createHelperAttestation(profile = {}, processIdentity = {}) {
  const uid = Number(processIdentity.uid);
  const username = typeof processIdentity.username === "string" ? processIdentity.username.trim() : "";
  const home = typeof processIdentity.home === "string" ? processIdentity.home : "";
  const accountHash = typeof profile.accountFingerprint === "string" ? profile.accountFingerprint.toLowerCase() : "";
  if (!Number.isSafeInteger(uid) || uid < 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(username)
    || !home || !/^[a-f0-9]{64}$/.test(accountHash)) {
    throw new TypeError("The Messages helper attestation identity is invalid.");
  }
  const conversationHash = imsgConversationHash(profile);
  return {
    role: "imsg-helper",
    uid,
    username,
    homeHash: ipcIdentityHash("helper-home", home),
    identityHash: helperIdentityHash({ uid, username, home }),
    accountHash,
    conversationHash,
    profileHash: imsgProfileHash(profile),
    instanceId: typeof profile.instanceId === "string" && profile.instanceId.trim()
      ? profile.instanceId.trim()
      : ipcIdentityHash("helper-instance", `${uid}\0${String(profile.chatGuid).trim()}`).slice(0, 32),
  };
}

export function createControllerAttestation({ uid, username, codexHome } = {}) {
  const home = typeof codexHome === "string" ? codexHome : "";
  if (!home.startsWith("/")) throw new TypeError("The Codex controller home is invalid.");
  return normalizeControllerAttestation({
    role: "codex-controller",
    uid,
    username,
    codexHomeHash: ipcIdentityHash("codex-home", home),
  });
}

export function normalizeControllerAttestation(value) {
  const attestation = boundedAttestation(value, "controller");
  const uid = Number(attestation.uid);
  const username = typeof attestation.username === "string" ? attestation.username.trim() : "";
  const codexHomeHash = typeof attestation.codexHomeHash === "string" ? attestation.codexHomeHash.toLowerCase() : "";
  if (attestation.role !== "codex-controller"
    || !Number.isSafeInteger(uid) || uid < 0
    || !/^[A-Za-z0-9._-]{1,128}$/.test(username)
    || !/^[a-f0-9]{64}$/.test(codexHomeHash)) {
    throw Object.assign(new Error("The controller IPC attestation is invalid."), { code: "IMSG_IPC_ATTESTATION_INVALID" });
  }
  return { role: "codex-controller", uid, username, codexHomeHash };
}

export function controllerIdentityHash(value) {
  return ipcIdentityHash("controller-identity", normalizeControllerAttestation(value));
}

export function generateIpcKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
}

export function ipcPublicKeyFingerprint(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw Object.assign(new Error("The imsg IPC public key is not Ed25519."), { code: "IMSG_IPC_KEY_INVALID" });
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function challengeTranscript({ serverNonce, helperAttestation }) {
  return Buffer.from(canonical({
    protocol: IMSG_IPC_PROTOCOL_VERSION,
    phase: "challenge",
    serverNonce: nonce(serverNonce),
    helperAttestation: boundedAttestation(helperAttestation, "helper"),
  }), "utf8");
}

export function sessionTranscript({ serverNonce, clientNonce, helperAttestation, controllerAttestation }) {
  return Buffer.from(canonical({
    protocol: IMSG_IPC_PROTOCOL_VERSION,
    phase: "session",
    serverNonce: nonce(serverNonce),
    clientNonce: nonce(clientNonce),
    helperAttestation: boundedAttestation(helperAttestation, "helper"),
    controllerAttestation: boundedAttestation(controllerAttestation, "controller"),
  }), "utf8");
}

export function signIpcTranscript(privateKey, transcript) {
  const key = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw Object.assign(new Error("The imsg IPC private key is not Ed25519."), { code: "IMSG_IPC_KEY_INVALID" });
  return sign(null, Buffer.from(transcript), key).toString("base64url");
}

export function verifyIpcTranscript(publicKey, transcript, signature) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(signature)) return false;
  try {
    const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(transcript), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function encodeIpcFrame(value, maxFrameBytes = IMSG_IPC_MAX_FRAME_BYTES) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("The imsg IPC frame must be an object."), { code: "IMSG_IPC_FRAME_INVALID" });
  }
  const output = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (output.byteLength > maxFrameBytes) {
    throw Object.assign(new Error("The imsg IPC frame is too large."), { code: "IMSG_IPC_FRAME_TOO_LARGE" });
  }
  return output;
}

export class IpcFrameDecoder {
  constructor({
    maxFrameBytes = IMSG_IPC_MAX_FRAME_BYTES,
    maxFramesPerPush = IMSG_IPC_MAX_FRAMES_PER_PUSH,
  } = {}) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 16 || maxFrameBytes > IMSG_IPC_MAX_FRAME_BYTES
      || !Number.isSafeInteger(maxFramesPerPush) || maxFramesPerPush < 1 || maxFramesPerPush > 256) {
      throw Object.assign(new Error("The imsg IPC decoder limits are invalid."), { code: "IMSG_IPC_LIMIT_INVALID" });
    }
    this.maxFrameBytes = maxFrameBytes;
    this.maxFramesPerPush = maxFramesPerPush;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk))) {
      throw Object.assign(new Error("The imsg IPC input chunk is invalid."), { code: "IMSG_IPC_FRAME_INVALID" });
    }
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
    if (this.buffer.byteLength + incoming.byteLength > this.maxFrameBytes * 2) {
      throw Object.assign(new Error("The imsg IPC input buffer is too large."), { code: "IMSG_IPC_FRAME_TOO_LARGE" });
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    const frames = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.byteLength > this.maxFrameBytes) {
          throw Object.assign(new Error("The imsg IPC frame is too large."), { code: "IMSG_IPC_FRAME_TOO_LARGE" });
        }
        return frames;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.byteLength) continue;
      if (line.byteLength + 1 > this.maxFrameBytes) {
        throw Object.assign(new Error("The imsg IPC frame is too large."), { code: "IMSG_IPC_FRAME_TOO_LARGE" });
      }
      let parsed;
      try { parsed = JSON.parse(line.toString("utf8")); } catch {
        throw Object.assign(new Error("The imsg IPC frame is malformed."), { code: "IMSG_IPC_FRAME_INVALID" });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw Object.assign(new Error("The imsg IPC frame must be an object."), { code: "IMSG_IPC_FRAME_INVALID" });
      }
      frames.push(parsed);
      if (frames.length > this.maxFramesPerPush) {
        throw Object.assign(new Error("The imsg IPC frame burst is too large."), { code: "IMSG_IPC_FRAME_BURST" });
      }
    }
  }
}

export function publicIpcError(error, fallbackCode = "IMSG_IPC_FAILED") {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const safeMessages = {
    IMSG_INVALID_INPUT: "The Messages operation was invalid.",
    IMSG_MESSAGE_TOO_LARGE: "The Messages operation was too large.",
    IMSG_UNSUPPORTED: "The Messages operation is unavailable.",
    IMSG_PROVIDER_CHAT: "The configured Messages chat is not allowed.",
    IMSG_SELF_CHAT: "The configured Messages chat uses the transport identity as its recipient.",
    IMSG_CHAT_MISMATCH: "The configured Messages chat changed.",
    IMSG_ATTACHMENT_INVALID: "The Messages attachment was invalid.",
    IMSG_ATTACHMENT_TOO_LARGE: "The Messages attachment was too large.",
  };
  return { code, message: safeMessages[code] || "The local Messages helper could not complete the operation." };
}

export function errorFromIpc(value, fallbackCode = "IMSG_IPC_FAILED") {
  const code = typeof value?.code === "string" ? value.code : fallbackCode;
  const message = typeof value?.message === "string" ? value.message : "The local Messages helper could not complete the operation.";
  return Object.assign(new Error(message), { code });
}
