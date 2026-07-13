import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ImsgClient } from "./imsg-client.mjs";
import { inspectLocalImsgChat } from "./imsg-chat.mjs";
import {
  IMSG_IPC_ATTACHMENT_CHUNK_BYTES,
  IMSG_IPC_MAX_FRAME_BYTES,
  IMSG_IPC_PROTOCOL_VERSION,
  IpcFrameDecoder,
  canonicalImsgIdentity,
  challengeTranscript,
  controllerIdentityHash,
  createHelperAttestation,
  encodeIpcFrame,
  extractImsgAccountIdentities,
  ipcPublicKeyFingerprint,
  imsgAccountFingerprint,
  publicIpcError,
  randomNonce,
  sessionTranscript,
  signIpcTranscript,
  verifyIpcTranscript,
} from "./imsg-ipc-protocol.mjs";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const MAX_OPERATION_RESULTS = 256;
const MAX_OPERATION_RESULT_BYTES = 64 * 1024;
const MAX_IN_FLIGHT_REQUESTS = 64;
const MAX_OPEN_ATTACHMENT_HANDLES = 8;
const AUTH_TIMEOUT_MS = 5_000;

class SupervisedImsgClient extends ImsgClient {
  constructor(options) {
    super(options);
    this.pinnedSessionStarted = false;
  }

  async start() {
    if (this.pinnedSessionStarted) {
      if (this.child && this.rpcReady) return this;
      throw codedError("IMSG_RPC_CLOSED", "The supervised imsg RPC session exited.");
    }
    await super.start();
    this.pinnedSessionStarted = true;
    return this;
  }

  async stop() {
    this.pinnedSessionStarted = false;
    return super.stop();
  }
}

const TARGET_METHODS = new Set([
  "latestMessage",
  "sendRich",
  "sendPoll",
  "sendPollVote",
  "tapback",
  "setTyping",
  "markRead",
  "sendAttachment",
  "editMessage",
  "unsendMessage",
  "sendStatus",
  "watch.subscribe",
]);

const MUTATION_METHODS = new Set([
  "sendRich",
  "sendPoll",
  "sendPollVote",
  "tapback",
  "setTyping",
  "markRead",
  "sendAttachment",
  "editMessage",
  "unsendMessage",
  "sendStatus",
]);

const OBSERVED_GUID_METHODS = new Set(["sendStatus", "tapback", "editMessage", "unsendMessage"]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalIdentity(value) {
  return canonicalImsgIdentity(value);
}

function sameIdentity(left, right) {
  const a = canonicalIdentity(left);
  const b = canonicalIdentity(right);
  return Boolean(a && b && a === b);
}

export function messagesAccountFingerprint(values) {
  return imsgAccountFingerprint(values);
}

export function inspectLocalImsgIdentity({ binary, run = execFileSync } = {}) {
  if (!path.isAbsolute(clean(binary))) throw codedError("IMSG_ACCOUNT_UNAVAILABLE", "The pinned imsg binary is invalid.");
  let output;
  try {
    output = run(binary, ["account", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
  } catch {
    throw codedError("IMSG_ACCOUNT_UNAVAILABLE", "The live Messages account could not be inspected.");
  }
  if (Buffer.byteLength(String(output || ""), "utf8") > 512 * 1024) {
    throw codedError("IMSG_ACCOUNT_UNAVAILABLE", "The live Messages account inspection was too large.");
  }
  let status;
  try {
    const lines = String(output || "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length !== 1) throw new Error("invalid status");
    status = JSON.parse(lines[0]);
  } catch {
    throw codedError("IMSG_ACCOUNT_UNAVAILABLE", "The live Messages account inspection was invalid.");
  }
  const identities = extractImsgAccountIdentities(status);
  const accountFingerprint = messagesAccountFingerprint(identities);
  if (!accountFingerprint) throw codedError("IMSG_ACCOUNT_UNAVAILABLE", "The live Messages account identity was unavailable.");
  return { accountFingerprint, identities };
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function attachmentPath(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return clean(value.path || value.filename);
}

function safeAttachmentExtension(value) {
  const extension = path.extname(clean(value)).toLowerCase();
  return ATTACHMENT_EXTENSIONS.has(extension) ? (extension === ".jpeg" ? ".jpg" : extension) : null;
}

function validRequestId(value) {
  return (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    || (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value));
}

function validOperationId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{16,160}$/.test(value);
}

function messageGuid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const guid = clean(value.guid || value.message_guid || value.messageGuid);
  return guid && Buffer.byteLength(guid, "utf8") <= 4096 ? guid : "";
}

function referencedGuid(method, params) {
  if (method === "sendStatus") return clean(params?.guid);
  return clean(params?.message_guid || params?.messageGuid || params?.message_id);
}

function validateTarget(params, profile) {
  const source = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const candidates = [
    ["to", source.to],
    ["chat_id", source.chat_id ?? source.chatId],
    ["chat_identifier", source.chat_identifier ?? source.chatIdentifier],
    ["chat_guid", source.chat_guid ?? source.chatGuid],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (candidates.length !== 1) throw codedError("IMSG_INVALID_INPUT", "Exactly one configured chat target is required.");
  const [kind, value] = candidates[0];
  const allowed = (kind === "chat_id" && Number(value) === profile.chatId)
    || (kind === "chat_guid" && clean(value) === profile.chatGuid);
  if (!allowed) throw codedError("IMSG_CHAT_NOT_ALLOWED", "The Messages operation targeted a chat outside the configured allow-list.");
}

function validateWatchMessage(message, profile) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const hasId = message.chat_id !== undefined && message.chat_id !== null;
  const hasGuid = Boolean(clean(message.chat_guid));
  if (!hasId && !hasGuid) return false;
  if (hasId && Number(message.chat_id) !== profile.chatId) return false;
  if (hasGuid && clean(message.chat_guid) !== profile.chatGuid) return false;
  if (message.is_from_me === true) return true;
  return sameIdentity(message.sender, profile.expectedSender);
}

function validateProfile(profile) {
  const chatId = Number(profile?.chatId);
  const chatGuid = clean(profile?.chatGuid);
  const expectedSender = clean(profile?.expectedSender);
  const localIdentity = clean(profile?.localIdentity);
  const accountFingerprint = clean(profile?.accountFingerprint).toLowerCase();
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || !chatGuid || !expectedSender || !localIdentity
    || !/^[a-f0-9]{64}$/.test(accountFingerprint)) {
    throw codedError("IMSG_PROFILE_INVALID", "The dedicated Messages profile is incomplete.");
  }
  if (sameIdentity(expectedSender, localIdentity)) {
    throw codedError("IMSG_SELF_CHAT", "The dedicated Messages identity cannot be the configured recipient.");
  }
  if (profile?.featureMode !== "bridge"
    || profile?.presentation !== "rich"
    || profile?.polls !== true
    || profile?.reactions !== true) {
    throw codedError("IMSG_PROFILE_INVALID", "The dedicated Messages profile must use the full advanced bridge.");
  }
  return {
    ...profile,
    chatId,
    chatGuid,
    expectedSender,
    localIdentity,
    accountFingerprint,
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
  };
}

function processIdentity(options) {
  const user = os.userInfo();
  const actual = {
    uid: process.getuid?.(),
    username: user.username,
    home: realpathSync(os.homedir()),
  };
  if (Number.isSafeInteger(options.expectedUid) && actual.uid !== Number(options.expectedUid)) {
    throw codedError("IMSG_HELPER_IDENTITY_MISMATCH", "The Messages helper is running under the wrong macOS user.");
  }
  if (clean(options.expectedUsername) && actual.username !== clean(options.expectedUsername)) {
    throw codedError("IMSG_HELPER_IDENTITY_MISMATCH", "The Messages helper is running under the wrong macOS account.");
  }
  if (clean(options.expectedHome) && actual.home !== realpathSync(clean(options.expectedHome))) {
    throw codedError("IMSG_HELPER_IDENTITY_MISMATCH", "The Messages helper is using the wrong home directory.");
  }
  return actual;
}

function strictBase64(value) {
  const text = clean(value);
  if (!text || text.length > Math.ceil(IMSG_IPC_ATTACHMENT_CHUNK_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment chunk is invalid.");
  }
  const decoded = Buffer.from(text, "base64");
  if (!decoded.byteLength || decoded.byteLength > IMSG_IPC_ATTACHMENT_CHUNK_BYTES) {
    throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment chunk is invalid.");
  }
  return decoded;
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export class ImsgHelperServer {
  constructor(options = {}) {
    if (!path.isAbsolute(clean(options.socketPath))) throw new TypeError("ImsgHelperServer requires an absolute Unix socket path.");
    if (!options.privateKey || !options.controllerPublicKey) throw new TypeError("ImsgHelperServer requires pinned Ed25519 key material.");
    if (!/^[a-f0-9]{64}$/i.test(clean(options.expectedControllerIdentityHash))) {
      throw new TypeError("ImsgHelperServer requires a pinned controller identity hash.");
    }
    this.options = options;
    this.socketPath = path.resolve(options.socketPath);
    this.privateKey = options.privateKey;
    this.controllerPublicKey = options.controllerPublicKey;
    this.helperKeyFingerprint = ipcPublicKeyFingerprint(options.privateKey);
    this.controllerKeyFingerprint = ipcPublicKeyFingerprint(options.controllerPublicKey);
    this.profile = validateProfile(options.profile);
    if (!options.client && !path.isAbsolute(clean(this.profile.binary))) {
      throw new TypeError("ImsgHelperServer requires an absolute pinned imsg binary path.");
    }
    this.client = options.client || new SupervisedImsgClient({ binary: this.profile.binary, logger: options.logger });
    this.inspectChat = options.inspectChat || ((profile) => inspectLocalImsgChat({ binary: profile.binary, chatId: profile.chatId }));
    this.inspectIdentity = options.inspectIdentity || ((profile) => inspectLocalImsgIdentity({ binary: profile.binary }));
    this.expectedControllerIdentityHash = clean(options.expectedControllerIdentityHash).toLowerCase();
    this.maxFrameBytes = options.maxFrameBytes || IMSG_IPC_MAX_FRAME_BYTES;
    this.socketMode = options.socketMode ?? 0o660;
    this.authTimeoutMs = options.authTimeoutMs || AUTH_TIMEOUT_MS;
    this.messagesAttachmentRoot = options.messagesAttachmentRoot || path.join(os.homedir(), "Library", "Messages", "Attachments");
    this.stagingRoot = options.stagingRoot || path.join(os.homedir(), "Library", "Application Support", "Codex iMessage Transport", "staging");
    this.server = null;
    this.connections = new Set();
    this.activeConnection = null;
    this.operationResults = new Map();
    this.mutationChain = Promise.resolve();
    this.identity = null;
    this.attestation = null;
    this.liveAccount = null;
    this.clientStarted = false;
    this.rpcChild = null;
    this.rpcFailureHandler = null;
    this.stopping = false;
    this.fatalError = null;
    this.fatalPromise = new Promise((resolve) => { this.resolveFatal = resolve; });
  }

  helperStatus() {
    if (!this.attestation) throw codedError("IMSG_HELPER_NOT_READY", "The Messages helper has not started.");
    return {
      authenticated: true,
      health: { healthy: !this.fatalError, rpcStarted: this.clientStarted },
      helperAttestation: structuredClone(this.attestation),
      helperKeyFingerprint: this.helperKeyFingerprint,
      controllerKeyFingerprint: this.controllerKeyFingerprint,
      profile: {
        chatId: this.profile.chatId,
        chatGuid: this.profile.chatGuid,
        expectedSender: this.profile.expectedSender,
      },
      settings: {
        featureMode: "bridge",
        presentation: "rich",
        polls: true,
        reactions: true,
      },
    };
  }

  waitForFatal() {
    return this.fatalPromise;
  }

  async start() {
    if (this.server) return this;
    if (this.fatalError) throw this.fatalError;
    this.stopping = false;
    this.identity = processIdentity(this.options);
    const startupStatus = await this.client.status({ refresh: true });
    this.#assertPinnedCapabilities(startupStatus);
    const liveAccount = await this.inspectIdentity(this.profile);
    const liveIdentities = Array.isArray(liveAccount?.identities) ? liveAccount.identities : [];
    const liveFingerprint = messagesAccountFingerprint(liveIdentities);
    const reportedFingerprint = clean(liveAccount?.accountFingerprint).toLowerCase();
    if (reportedFingerprint && reportedFingerprint !== liveFingerprint) {
      throw codedError("IMSG_ACCOUNT_MISMATCH", "The live Messages account report was inconsistent.");
    }
    if (!/^[a-f0-9]{64}$/.test(liveFingerprint) || liveFingerprint !== this.profile.accountFingerprint) {
      throw codedError("IMSG_ACCOUNT_MISMATCH", "The live Messages account changed.");
    }
    if (liveIdentities.some((identity) => sameIdentity(identity, this.profile.expectedSender))) {
      throw codedError("IMSG_SELF_CHAT", "The live Messages account is the configured recipient.");
    }
    this.liveAccount = { accountFingerprint: liveFingerprint };
    const inspected = this.inspectChat(this.profile);
    if (!inspected || Number(inspected.chatId) !== this.profile.chatId || clean(inspected.chatGuid) !== this.profile.chatGuid) {
      throw codedError("IMSG_CHAT_MISMATCH", "The configured Messages conversation changed.");
    }
    if (clean(inspected.service).toLocaleLowerCase("en-US") !== "imessage" || inspected.isGroup === true) {
      throw codedError("IMSG_CHAT_NOT_ALLOWED", "The helper requires one direct iMessage conversation.");
    }
    if (!Array.isArray(inspected.participants) || inspected.participants.length !== 1 || !sameIdentity(inspected.participants[0], this.profile.expectedSender)) {
      throw codedError("IMSG_CHAT_MISMATCH", "The configured Messages participant changed.");
    }
    this.attestation = createHelperAttestation(this.profile, this.identity);
    this.#prepareSocketDirectory();
    this.#prepareOperationStore();
    await this.#removeStaleSocket();
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    chmodSync(this.socketPath, this.socketMode);
    return this;
  }

  async stop() {
    this.stopping = true;
    const server = this.server;
    this.server = null;
    for (const state of [...this.connections]) this.#closeConnection(state);
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    try { await this.client.stop(); } catch {}
    this.clientStarted = false;
    this.#unmonitorRpcChild();
    this.#removeOwnedSocket();
  }

  #prepareSocketDirectory() {
    const directory = path.dirname(this.socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o770 });
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o002) !== 0) {
      throw codedError("IMSG_IPC_PATH_INVALID", "The helper socket directory is unsafe.");
    }
    this.socketPath = path.join(realpathSync(directory), path.basename(this.socketPath));
    mkdirSync(this.stagingRoot, { recursive: true, mode: 0o700 });
    const stagingMetadata = lstatSync(this.stagingRoot);
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink() || stagingMetadata.uid !== process.getuid()) {
      throw codedError("IMSG_IPC_PATH_INVALID", "The helper attachment staging directory is unsafe.");
    }
    chmodSync(this.stagingRoot, 0o700);
  }

  #operationDirectory() {
    const profileHash = clean(this.attestation?.profileHash).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(profileHash)) {
      throw codedError("IMSG_HELPER_NOT_READY", "The Messages operation store is not pinned to a profile.");
    }
    return path.join(this.stagingRoot, "operations", profileHash);
  }

  #prepareOperationStore() {
    const directory = this.#operationDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()) {
      throw codedError("IMSG_IPC_PATH_INVALID", "The helper operation store is unsafe.");
    }
    chmodSync(directory, 0o700);
    this.#pruneOperationStore();
  }

  #operationFile(operationId) {
    const digest = createHash("sha256").update(operationId).digest("hex");
    return path.join(this.#operationDirectory(), `${digest}.json`);
  }

  #readOperationResult(operationId) {
    const file = this.#operationFile(operationId);
    let descriptor;
    try {
      descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0
        || metadata.size <= 0 || metadata.size > MAX_OPERATION_RESULT_BYTES) return null;
      const buffer = Buffer.alloc(metadata.size);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
        if (count <= 0) return null;
        offset += count;
      }
      const value = JSON.parse(buffer.toString("utf8"));
      if (value?.version !== 1 || value?.operationId !== operationId
        || value?.profileHash !== this.attestation.profileHash
        || !value?.result || typeof value.result !== "object"
        || value.result.classification !== "accepted") return null;
      return value.result;
    } catch {
      return null;
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
    }
  }

  #persistOperationResult(operationId, result) {
    if (result?.classification !== "accepted") return false;
    const file = this.#operationFile(operationId);
    if (existsSync(file)) {
      const existing = this.#readOperationResult(operationId);
      return Boolean(existing && JSON.stringify(existing) === JSON.stringify(result));
    }
    const payload = Buffer.from(`${JSON.stringify({
      version: 1,
      operationId,
      profileHash: this.attestation.profileHash,
      createdAt: new Date().toISOString(),
      result,
    })}\n`, "utf8");
    if (payload.byteLength > MAX_OPERATION_RESULT_BYTES) return false;
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    let descriptor;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      let offset = 0;
      while (offset < payload.byteLength) {
        const count = writeSync(descriptor, payload, offset, payload.byteLength - offset, offset);
        if (count <= 0) throw codedError("IMSG_OPERATION_STORE_FAILED", "The Messages operation result was not durable.");
        offset += count;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, file);
      const directoryDescriptor = openSync(path.dirname(file), fsConstants.O_RDONLY);
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      this.#pruneOperationStore();
      return true;
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      rmSync(temporary, { force: true });
    }
  }

  #pruneOperationStore() {
    const directory = this.#operationDirectory();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const results = entries
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
      .flatMap((entry) => {
        const file = path.join(directory, entry.name);
        try { return [{ file, mtimeMs: statSync(file).mtimeMs }]; } catch { return []; }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const entry of results.slice(MAX_OPERATION_RESULTS)) rmSync(entry.file, { force: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.includes(".tmp-")) rmSync(path.join(directory, entry.name), { force: true });
    }
  }

  async #removeStaleSocket() {
    if (!existsSync(this.socketPath)) return;
    const stat = lstatSync(this.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid()) throw codedError("IMSG_IPC_PATH_CONFLICT", "The helper socket path is occupied.");
    const alive = await new Promise((resolve) => {
      const probe = net.createConnection(this.socketPath);
      const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 250);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
      probe.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (alive) throw codedError("IMSG_IPC_ALREADY_RUNNING", "Another Messages helper is already listening.");
    rmSync(this.socketPath, { force: true });
  }

  #removeOwnedSocket() {
    try {
      const stat = lstatSync(this.socketPath);
      if (stat.isSocket() && stat.uid === process.getuid()) rmSync(this.socketPath, { force: true });
    } catch {}
  }

  #accept(socket) {
    socket.setNoDelay(true);
    const state = {
      socket,
      decoder: new IpcFrameDecoder({ maxFrameBytes: this.maxFrameBytes }),
      authenticated: false,
      closing: false,
      serverNonce: randomNonce(),
      clientNonce: null,
      watches: new Map(),
      nextWatchId: 1,
      readHandles: new Map(),
      uploads: new Map(),
      allowedAttachmentPaths: new Map(),
      allowedMessageGuids: new Set(),
      inFlight: 0,
      authTimer: null,
    };
    this.connections.add(state);
    const transcript = challengeTranscript({ serverNonce: state.serverNonce, helperAttestation: this.attestation });
    this.#write(state, {
      type: "challenge",
      protocol: IMSG_IPC_PROTOCOL_VERSION,
      serverNonce: state.serverNonce,
      helperAttestation: this.attestation,
      signature: signIpcTranscript(this.privateKey, transcript),
    });
    state.authTimer = setTimeout(() => this.#closeConnection(state), this.authTimeoutMs);
    state.authTimer.unref?.();
    socket.on("data", (chunk) => {
      try {
        for (const frame of state.decoder.push(chunk)) this.#frame(state, frame);
      } catch {
        this.#closeConnection(state);
      }
    });
    socket.once("error", () => this.#closeConnection(state));
    socket.once("close", () => this.#closeConnection(state));
  }

  #write(state, frame) {
    if (state.closing || state.socket.destroyed) return false;
    try { return state.socket.write(encodeIpcFrame(frame, this.maxFrameBytes)); } catch { this.#closeConnection(state); return false; }
  }

  #frame(state, frame) {
    if (!state.authenticated) return this.#authenticate(state, frame);
    if (frame.type !== "request" || !validRequestId(frame.id) || typeof frame.method !== "string") {
      this.#closeConnection(state);
      return;
    }
    this.#request(state, frame);
  }

  #authenticate(state, frame) {
    if (frame.type !== "auth" || frame.protocol !== IMSG_IPC_PROTOCOL_VERSION || this.activeConnection) {
      this.#closeConnection(state);
      return;
    }
    const controllerAttestation = frame.controllerAttestation;
    let identityHash;
    try { identityHash = controllerIdentityHash(controllerAttestation); } catch {
      this.#closeConnection(state);
      return;
    }
    if (identityHash !== this.expectedControllerIdentityHash) {
      this.#closeConnection(state);
      return;
    }
    let transcript;
    try {
      transcript = sessionTranscript({
        serverNonce: state.serverNonce,
        clientNonce: frame.clientNonce,
        helperAttestation: this.attestation,
        controllerAttestation,
      });
    } catch {
      this.#closeConnection(state);
      return;
    }
    if (!verifyIpcTranscript(this.controllerPublicKey, transcript, frame.signature)) {
      this.#closeConnection(state);
      return;
    }
    clearTimeout(state.authTimer);
    state.authTimer = null;
    state.authenticated = true;
    state.clientNonce = frame.clientNonce;
    state.controllerAttestation = controllerAttestation;
    this.activeConnection = state;
    this.#write(state, {
      type: "ready",
      protocol: IMSG_IPC_PROTOCOL_VERSION,
      signature: signIpcTranscript(this.privateKey, transcript),
    });
  }

  async #request(state, frame) {
    if (state.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      this.#write(state, { type: "response", id: frame.id, error: publicIpcError(codedError("IMSG_IPC_BUSY", "The helper has too many active requests.")) });
      return;
    }
    state.inFlight += 1;
    try {
      const result = MUTATION_METHODS.has(frame.method)
        ? await this.#mutation(state, frame)
        : await this.#dispatch(state, frame.method, frame.params || {});
      this.#write(state, { type: "response", id: frame.id, result: result ?? null });
    } catch (error) {
      this.#write(state, { type: "response", id: frame.id, error: publicIpcError(error) });
    } finally {
      state.inFlight -= 1;
    }
  }

  async #mutation(state, frame) {
    if (!validOperationId(frame.operationId)) throw codedError("IMSG_IPC_OPERATION_INVALID", "A mutation operation id is required.");
    const prior = this.operationResults.get(frame.operationId);
    if (prior) {
      const result = await prior.promise;
      this.#registerMessageGuid(state, result);
      return result;
    }
    const durable = this.#readOperationResult(frame.operationId);
    if (durable) {
      const promise = Promise.resolve(durable);
      this.operationResults.set(frame.operationId, { promise, createdAt: Date.now() });
      this.#registerMessageGuid(state, durable);
      return durable;
    }
    const operation = this.mutationChain.then(async () => {
      const result = await this.#dispatch(state, frame.method, frame.params || {});
      // Persist accepted results before acknowledging the controller. A retry
      // with the same operation id can recover the exact GUID after a restart
      // without creating a second Messages item.
      if (result?.classification === "accepted") {
        let persisted = false;
        try { persisted = this.#persistOperationResult(frame.operationId, result); } catch {}
        if (!persisted) {
          const error = codedError(
            "IMSG_OPERATION_STORE_FAILED",
            "The accepted Messages operation could not be recorded durably.",
          );
          // The Messages side effect may already exist. Never acknowledge it
          // without an exact durable result: retire this helper so the
          // supervisor exposes an unhealthy transport instead of risking a
          // second send from the same process.
          this.#scheduleFatal(error);
          throw error;
        }
      }
      return result;
    });
    this.mutationChain = operation.catch(() => {});
    const stored = { promise: operation, createdAt: Date.now() };
    this.operationResults.set(frame.operationId, stored);
    if (this.operationResults.size > MAX_OPERATION_RESULTS) {
      const oldest = this.operationResults.keys().next().value;
      if (oldest !== frame.operationId) this.operationResults.delete(oldest);
    }
    return operation;
  }

  #assertPinnedCapabilities(status) {
    const capabilities = status?.capabilities || {};
    const required = ["watch", "richText", "replies", "polls", "pollVoting", "typing", "attachments"];
    if (!status?.available || status?.advanced !== true || required.some((name) => capabilities[name] !== true)) {
      throw codedError("IMSG_PINNED_MODE_UNAVAILABLE", "The full pinned advanced imsg bridge is unavailable.");
    }
    return status;
  }

  #assertClientAlive() {
    if (!this.clientStarted) throw codedError("IMSG_RPC_NOT_STARTED", "The pinned imsg RPC session has not started.");
    if (this.rpcChild && (this.client.child !== this.rpcChild || this.client.rpcReady === false)) {
      const error = codedError("IMSG_RPC_CLOSED", "The pinned imsg RPC session exited.");
      this.#scheduleFatal(error);
      throw error;
    }
  }

  async #clientStatus(params = {}) {
    const status = await this.client.status(params);
    return this.#assertPinnedCapabilities(status);
  }

  async #startClient() {
    if (this.clientStarted) {
      this.#assertClientAlive();
      return { started: true };
    }
    await this.#clientStatus({ refresh: true });
    try {
      await this.client.start();
    } catch (error) {
      this.#scheduleFatal(codedError("IMSG_RPC_UNAVAILABLE", "The pinned imsg RPC session could not start."));
      throw error;
    }
    this.clientStarted = true;
    this.#monitorRpcChild();
    return { started: true };
  }

  async #stopClient(state) {
    await this.#unsubscribeAll(state);
    this.clientStarted = false;
    this.#unmonitorRpcChild();
    await this.client.stop();
    return { stopped: true };
  }

  async #invokeClient(method, ...args) {
    this.#assertClientAlive();
    let result;
    try {
      result = await this.client[method](...args);
    } catch (error) {
      if (/^IMSG_(?:RPC|MALFORMED|OUTPUT)/.test(clean(error?.code))) this.#scheduleFatal(error);
      throw error;
    }
    if ((result?.classification === "ambiguous"
        && new Set(["timeout", "transport-or-send-failure", "status-query-failure"]).has(result.reason))
      || (result?.classification === "unsupported"
        && new Set(["rpc-unavailable", "rpc-method-unavailable"]).has(result.reason))) {
      this.#scheduleFatal(codedError("IMSG_RPC_UNHEALTHY", "The pinned imsg RPC session became unhealthy."));
    }
    return result;
  }

  #monitorRpcChild() {
    this.#unmonitorRpcChild();
    const child = this.client?.child;
    if (!child?.once) return;
    const failed = () => {
      if (!this.stopping && this.clientStarted && this.rpcChild === child) {
        this.#scheduleFatal(codedError("IMSG_RPC_CLOSED", "The pinned imsg RPC session exited."));
      }
    };
    this.rpcChild = child;
    this.rpcFailureHandler = failed;
    child.once("error", failed);
    child.once("close", failed);
  }

  #unmonitorRpcChild() {
    if (this.rpcChild && this.rpcFailureHandler) {
      this.rpcChild.off?.("error", this.rpcFailureHandler);
      this.rpcChild.off?.("close", this.rpcFailureHandler);
    }
    this.rpcChild = null;
    this.rpcFailureHandler = null;
  }

  #scheduleFatal(error) {
    if (this.stopping || this.fatalError) return;
    const timer = setImmediate(() => this.#fatal(error));
    timer.unref?.();
  }

  #fatal(error) {
    if (this.stopping || this.fatalError) return;
    this.fatalError = codedError(clean(error?.code) || "IMSG_HELPER_UNHEALTHY", "The pinned Messages helper became unhealthy.");
    this.resolveFatal?.(this.fatalError);
    const server = this.server;
    this.server = null;
    for (const state of [...this.connections]) this.#closeConnection(state);
    try { server?.close?.(() => this.#removeOwnedSocket()); } catch {}
    this.clientStarted = false;
    this.#unmonitorRpcChild();
    let stopping;
    try { stopping = this.client.stop(); } catch { stopping = null; }
    Promise.resolve(stopping).catch(() => {}).finally(() => {
      this.#removeOwnedSocket();
      try { this.options.onFatal?.(this.fatalError); } catch {}
    });
  }

  async #dispatch(state, method, params) {
    if (TARGET_METHODS.has(method)) validateTarget(params, this.profile);
    if (OBSERVED_GUID_METHODS.has(method)) {
      const guid = referencedGuid(method, params);
      if (!guid || !state.allowedMessageGuids.has(guid)) {
        throw codedError("IMSG_MESSAGE_NOT_ALLOWED", "The message is not known to belong to the configured chat.");
      }
    }
    switch (method) {
      case "helper.status": return this.helperStatus();
      case "status": return this.#clientStatus(params);
      case "latestMessage": {
        const message = await this.client.latestMessage(params);
        this.#registerMessageGuid(state, message);
        this.#registerAllowedAttachments(state, message);
        return message;
      }
      case "client.start": return this.#startClient();
      case "client.stop": return this.#stopClient(state);
      case "watch.subscribe": return this.#subscribeWatch(state, params);
      case "watch.unsubscribe": return { unsubscribed: await this.#unsubscribeWatch(state, params.subscription) };
      case "sendRich": return this.#recordSentGuid(state, await this.#invokeClient("sendRich", this.#withStagedFile(state, params)));
      case "sendAttachment": return this.#recordSentGuid(state, await this.#invokeClient("sendAttachment", this.#withStagedFile(state, params)));
      case "sendPoll": return this.#recordSentGuid(state, await this.#invokeClient("sendPoll", params));
      case "sendPollVote": return this.#invokeClient("sendPollVote", params, { remove: params.remove === true });
      case "tapback": return this.#invokeClient("tapback", params);
      case "setTyping": return this.#invokeClient("setTyping", params, params.typing !== false);
      case "markRead": return this.#invokeClient("markRead", params);
      case "sendStatus": return this.#invokeClient("sendStatus", clean(params.guid));
      case "editMessage": return this.#invokeClient("editMessage", params);
      case "unsendMessage": return this.#invokeClient("unsendMessage", params);
      case "attachments.open": return this.#openAttachments(state, params.attachments);
      case "attachments.read": return this.#readAttachment(state, params);
      case "attachments.close": return { closed: this.#closeAttachmentHandle(state, clean(params.handle)) };
      case "upload.begin": return this.#beginUpload(state, params);
      case "upload.write": return this.#writeUpload(state, params);
      case "upload.finish": return this.#finishUpload(state, params);
      case "upload.release": return { released: this.#releaseUpload(state, clean(params.handle)) };
      default: throw codedError("IMSG_IPC_METHOD_NOT_ALLOWED", "The requested Messages helper method is not allowed.");
    }
  }

  async #subscribeWatch(state, params) {
    this.#assertClientAlive();
    if (state.watches.size >= 1) throw codedError("IMSG_IPC_WATCH_EXISTS", "A Messages watch is already active.");
    const id = state.nextWatchId++;
    const watch = await this.client.subscribeWatch(params, {
      onMessage: (message) => {
        if (validateWatchMessage(message, this.profile)) {
          this.#registerMessageGuid(state, message);
          this.#registerAllowedAttachments(state, message);
          this.#write(state, { type: "event", event: "watch.message", subscription: id, message });
        }
      },
      onError: (error) => {
        this.#write(state, { type: "event", event: "watch.error", subscription: id, error: error ? publicIpcError(error, "IMSG_WATCH_FAILED") : null });
        if (error && !this.stopping) this.#scheduleFatal(codedError("IMSG_RPC_CLOSED", "The pinned imsg watch exited."));
      },
    });
    state.watches.set(id, watch);
    return { subscription: id };
  }

  async #unsubscribeWatch(state, idValue) {
    const id = Number(idValue);
    const watch = state.watches.get(id);
    if (!watch) return false;
    state.watches.delete(id);
    try { return await watch.unsubscribe(); } catch { return false; }
  }

  async #unsubscribeAll(state) {
    await Promise.allSettled([...state.watches.keys()].map((id) => this.#unsubscribeWatch(state, id)));
  }

  #registerMessageGuid(state, value) {
    const guid = messageGuid(value);
    if (guid) state.allowedMessageGuids.add(guid);
    const pollGuid = clean(value?.poll_guid || value?.pollGuid || value?.poll?.guid);
    if (pollGuid && Buffer.byteLength(pollGuid, "utf8") <= 4096) state.allowedMessageGuids.add(pollGuid);
    while (state.allowedMessageGuids.size > 4096) {
      state.allowedMessageGuids.delete(state.allowedMessageGuids.values().next().value);
    }
  }

  #recordSentGuid(state, result) {
    if (result?.classification === "accepted") this.#registerMessageGuid(state, result);
    return result;
  }

  #registerAllowedAttachments(state, message) {
    const values = Array.isArray(message?.attachments) ? message.attachments.slice(0, MAX_ATTACHMENTS) : [];
    let root;
    try { root = realpathSync(this.messagesAttachmentRoot); } catch { return; }
    for (const value of values) {
      const raw = attachmentPath(value);
      if (!path.isAbsolute(raw)) continue;
      try {
        const file = realpathSync(raw);
        const stat = statSync(file);
        if (inside(root, file) && stat.isFile() && stat.size > 0 && stat.size <= MAX_ATTACHMENT_BYTES && safeAttachmentExtension(file)) {
          state.allowedAttachmentPaths.set(file, { dev: stat.dev, ino: stat.ino, size: stat.size });
        }
      } catch {}
    }
    while (state.allowedAttachmentPaths.size > 64) {
      state.allowedAttachmentPaths.delete(state.allowedAttachmentPaths.keys().next().value);
    }
  }

  #openAttachments(state, attachments) {
    if (state.readHandles.size >= MAX_OPEN_ATTACHMENT_HANDLES) {
      throw codedError("IMSG_IPC_BUSY", "Too many attachment reads are active.");
    }
    const root = realpathSync(this.messagesAttachmentRoot);
    const values = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
    const files = [];
    for (const value of values) {
      const raw = attachmentPath(value);
      if (!path.isAbsolute(raw)) continue;
      try {
        const file = realpathSync(raw);
        const extension = safeAttachmentExtension(file);
        const pinned = state.allowedAttachmentPaths.get(file);
        if (!inside(root, file) || !pinned || !extension) continue;
        const descriptor = openSync(file, "r");
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.dev !== pinned.dev || stat.ino !== pinned.ino || stat.size !== pinned.size
          || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) {
          closeSync(descriptor);
          continue;
        }
        files.push({ file, descriptor, size: stat.size, extension });
      } catch {}
    }
    const handle = randomUUID();
    state.readHandles.set(handle, files);
    return { handle, files: files.map((file, index) => ({ index, size: file.size, extension: file.extension })) };
  }

  #readAttachment(state, params) {
    const files = state.readHandles.get(clean(params.handle));
    const index = Number(params.index);
    const offset = Number(params.offset);
    const length = Math.min(IMSG_IPC_ATTACHMENT_CHUNK_BYTES, Number(params.length) || IMSG_IPC_ATTACHMENT_CHUNK_BYTES);
    if (!files || !Number.isSafeInteger(index) || !files[index] || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
      throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment read request is invalid.");
    }
    const file = files[index];
    if (offset > file.size) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment read offset is invalid.");
    const buffer = Buffer.alloc(Math.min(length, file.size - offset));
    const count = readSync(file.descriptor, buffer, 0, buffer.length, offset);
    return { data: buffer.subarray(0, count).toString("base64"), offset, nextOffset: offset + count, eof: offset + count >= file.size };
  }

  #closeAttachmentHandle(state, handle) {
    const files = state.readHandles.get(handle);
    if (!files) return false;
    state.readHandles.delete(handle);
    for (const file of files) {
      try { closeSync(file.descriptor); } catch {}
    }
    return true;
  }

  #beginUpload(state, params) {
    if (state.uploads.size >= MAX_ATTACHMENTS) throw codedError("IMSG_IPC_BUSY", "Too many attachment uploads are active.");
    const size = Number(params.size);
    const extension = safeAttachmentExtension(params.name);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) throw codedError("IMSG_ATTACHMENT_TOO_LARGE", "The attachment size is invalid.");
    if (!extension) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment type is not allowed.");
    const expectedHash = clean(params.sha256).toLowerCase();
    if (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash)) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment digest is invalid.");
    const handle = randomUUID();
    const file = path.join(this.stagingRoot, `${handle}${extension}`);
    const descriptor = openSync(file, "wx", 0o600);
    state.uploads.set(handle, { file, descriptor, size, expectedHash: expectedHash || null, offset: 0, finished: false });
    return { handle };
  }

  #writeUpload(state, params) {
    const upload = state.uploads.get(clean(params.handle));
    const offset = Number(params.offset);
    if (!upload || upload.finished || !Number.isSafeInteger(offset) || offset !== upload.offset) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment upload is out of sequence.");
    const data = strictBase64(params.data);
    if (upload.offset + data.byteLength > upload.size) throw codedError("IMSG_ATTACHMENT_TOO_LARGE", "The attachment upload exceeded its declared size.");
    const count = writeSync(upload.descriptor, data, 0, data.byteLength, upload.offset);
    if (count !== data.byteLength) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment upload was incomplete.");
    upload.offset += count;
    return { nextOffset: upload.offset };
  }

  #finishUpload(state, params) {
    const upload = state.uploads.get(clean(params.handle));
    if (!upload || upload.finished || upload.offset !== upload.size || fstatSync(upload.descriptor).size !== upload.size) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment upload is incomplete.");
    closeSync(upload.descriptor);
    upload.descriptor = null;
    if (upload.expectedHash && hashFile(upload.file) !== upload.expectedHash) {
      this.#releaseUpload(state, clean(params.handle));
      throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment digest did not match.");
    }
    upload.finished = true;
    return { stagedAttachmentId: clean(params.handle) };
  }

  #withStagedFile(state, params) {
    const source = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
    const stagedId = clean(source.stagedAttachmentId);
    const rawFile = clean(source.file || source.path);
    delete source.stagedAttachmentId;
    delete source.path;
    if (!stagedId) {
      if (rawFile) throw codedError("IMSG_ATTACHMENT_INVALID", "Raw cross-user attachment paths are not allowed.");
      return source;
    }
    const upload = state.uploads.get(stagedId);
    if (!upload?.finished) throw codedError("IMSG_ATTACHMENT_INVALID", "The staged attachment is unavailable.");
    source.file = upload.file;
    return source;
  }

  #releaseUpload(state, handle) {
    const upload = state.uploads.get(handle);
    if (!upload) return false;
    state.uploads.delete(handle);
    try { if (upload.descriptor !== null) closeSync(upload.descriptor); } catch {}
    try { rmSync(upload.file, { force: true }); } catch {}
    return true;
  }

  #closeConnection(state) {
    if (!state || state.closing) return;
    state.closing = true;
    clearTimeout(state.authTimer);
    this.connections.delete(state);
    for (const handle of [...state.uploads.keys()]) this.#releaseUpload(state, handle);
    for (const handle of [...state.readHandles.keys()]) this.#closeAttachmentHandle(state, handle);
    state.allowedAttachmentPaths.clear();
    state.allowedMessageGuids.clear();
    try { state.socket.destroy(); } catch {}
    if (!state.authenticated) return;
    if (this.activeConnection === state) this.activeConnection = null;
    // The advanced bridge is process-pinned, not controller-connection-pinned.
    // A diagnostics probe or controller restart must release only its watches;
    // stopping the RPC child here creates needless gaps in the live service.
    Promise.resolve()
      .then(() => this.#unsubscribeAll(state))
      .catch(() => {});
  }
}

export const imsgHelperServerValues = Object.freeze({
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  allowedAttachmentExtensions: [...ATTACHMENT_EXTENSIONS],
});
