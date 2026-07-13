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
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  IMSG_IPC_ATTACHMENT_CHUNK_BYTES,
  IMSG_IPC_MAX_FRAME_BYTES,
  IMSG_IPC_PROTOCOL_VERSION,
  IpcFrameDecoder,
  challengeTranscript,
  controllerIdentityHash,
  createControllerAttestation,
  encodeIpcFrame,
  errorFromIpc,
  ipcPublicKeyFingerprint,
  normalizeControllerAttestation,
  randomNonce,
  sessionTranscript,
  signIpcTranscript,
  verifyIpcTranscript,
} from "./imsg-ipc-protocol.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 32 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const ATTACHMENT_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const HASH_KEYS = ["identityHash", "accountHash", "conversationHash", "profileHash"];

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strictHash(value) {
  const text = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function validateExpectedHelperAttestation(value) {
  if (!isObject(value) || value.role !== "imsg-helper") {
    throw new TypeError("The imsg IPC client requires a pinned helper attestation.");
  }
  const output = { role: "imsg-helper" };
  for (const key of HASH_KEYS) {
    const hash = strictHash(value[key]);
    if (!hash) throw new TypeError(`The pinned helper ${key} is invalid.`);
    output[key] = hash;
  }
  if (value.instanceId !== undefined) {
    const instanceId = clean(value.instanceId);
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(instanceId)) throw new TypeError("The pinned helper instance id is invalid.");
    output.instanceId = instanceId;
  }
  return output;
}

function helperAttestationMatches(actual, expected) {
  if (!isObject(actual) || actual.role !== "imsg-helper") return false;
  if (!Number.isSafeInteger(Number(actual.uid)) || Number(actual.uid) < 0) return false;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clean(actual.username))) return false;
  if (!strictHash(actual.homeHash)) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function validResponseId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validOperationId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{16,160}$/.test(value);
}

function ambiguous(reason = "ipc-disconnected") {
  return {
    classification: "ambiguous",
    accepted: false,
    ambiguous: true,
    unsupported: false,
    retrySafe: false,
    reason,
  };
}

function safeExtension(value) {
  const extension = path.extname(clean(value)).toLowerCase();
  return ATTACHMENT_EXTENSIONS.has(extension) ? (extension === ".jpeg" ? ".jpg" : extension) : null;
}

function safeSegment(value) {
  const digest = createHash("sha256").update(String(value || "message")).digest("hex").slice(0, 24);
  return `message-${digest}`;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function readSecureFile(file, { maxBytes, privateFile }) {
  if (!path.isAbsolute(clean(file))) throw codedError("IMSG_IPC_CONFIG_INVALID", "A required IPC file path is not absolute.");
  const resolved = path.resolve(file);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let descriptor;
  try { descriptor = openSync(resolved, flags); } catch {
    throw codedError("IMSG_IPC_FILE_UNSAFE", "A required IPC file could not be opened safely.");
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) {
      throw codedError("IMSG_IPC_FILE_UNSAFE", "A required IPC file is invalid.");
    }
    if (privateFile) {
      if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
        throw codedError("IMSG_IPC_FILE_UNSAFE", "A private IPC file has unsafe ownership or permissions.");
      }
    } else if ((metadata.mode & 0o022) !== 0) {
      throw codedError("IMSG_IPC_FILE_UNSAFE", "A pinned IPC public key is writable by another account.");
    }
    if (lstatSync(resolved).isSymbolicLink()) {
      throw codedError("IMSG_IPC_FILE_UNSAFE", "A required IPC file is not canonical.");
    }
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (count <= 0) throw codedError("IMSG_IPC_FILE_UNSAFE", "A required IPC file changed while it was read.");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size) {
      throw codedError("IMSG_IPC_FILE_UNSAFE", "A required IPC file changed while it was read.");
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

export class ImsgIpcClient {
  constructor(options = {}) {
    if (!path.isAbsolute(clean(options.socketPath))) throw new TypeError("ImsgIpcClient requires an absolute Unix socket path.");
    if (!options.privateKey || !options.helperPublicKey) throw new TypeError("ImsgIpcClient requires pinned Ed25519 key material.");
    this.socketPath = path.resolve(options.socketPath);
    this.privateKey = options.privateKey;
    this.helperPublicKey = options.helperPublicKey;
    this.helperKeyFingerprint = ipcPublicKeyFingerprint(this.helperPublicKey);
    this.controllerAttestation = normalizeControllerAttestation(options.controllerAttestation);
    this.controllerIdentityHash = controllerIdentityHash(this.controllerAttestation);
    this.expectedHelperAttestation = validateExpectedHelperAttestation(options.expectedHelperAttestation);
    this.expectedHelperKeyFingerprint = strictHash(options.expectedHelperKeyFingerprint) || this.helperKeyFingerprint;
    if (this.expectedHelperKeyFingerprint !== this.helperKeyFingerprint) {
      throw new TypeError("The pinned helper public-key fingerprint does not match.");
    }
    this.maxFrameBytes = options.maxFrameBytes || IMSG_IPC_MAX_FRAME_BYTES;
    this.connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.socket = null;
    this.decoder = null;
    this.connectPromise = null;
    this.connectState = null;
    this.authenticated = false;
    this.intentionalClose = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.watches = new Map();
    this.earlyEvents = new Map();
    this.helperAttestation = null;
    this.profile = null;
  }

  async connect() {
    if (this.socket && this.authenticated && !this.socket.destroyed) return this;
    if (this.connectPromise) return this.connectPromise;
    this.intentionalClose = false;
    const attempt = this.#open();
    this.connectPromise = attempt;
    try {
      await attempt;
      return this;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = null;
    }
  }

  #open() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setNoDelay(true);
      this.socket = socket;
      this.decoder = new IpcFrameDecoder({ maxFrameBytes: this.maxFrameBytes });
      this.authenticated = false;
      this.connectState = { phase: "challenge", resolve, reject, serverNonce: null, clientNonce: null, transcript: null };
      const timer = setTimeout(() => {
        this.#destroy(codedError("IMSG_IPC_AUTH_TIMEOUT", "The local Messages helper authentication timed out."));
      }, this.connectTimeoutMs);
      timer.unref?.();
      this.connectState.timer = timer;
      socket.on("data", (chunk) => {
        if (this.socket !== socket) return;
        try {
          for (const frame of this.decoder.push(chunk)) this.#frame(frame);
        } catch (error) {
          this.#destroy(error, socket);
        }
      });
      socket.once("error", (error) => this.#destroy(codedError("IMSG_IPC_UNAVAILABLE", "The local Messages helper is unavailable.", { cause: error }), socket));
      socket.once("close", () => this.#closed(socket));
    });
  }

  #frame(frame) {
    if (!this.authenticated) return this.#handshake(frame);
    if (frame.type === "response") return this.#response(frame);
    if (frame.type === "event") return this.#event(frame);
    this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The local Messages helper sent an invalid frame."));
  }

  #handshake(frame) {
    const state = this.connectState;
    if (!state) return this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The local Messages helper authentication state was invalid."));
    if (state.phase === "challenge") {
      if (frame.type !== "challenge" || frame.protocol !== IMSG_IPC_PROTOCOL_VERSION
        || !helperAttestationMatches(frame.helperAttestation, this.expectedHelperAttestation)) {
        return this.#destroy(codedError("IMSG_IPC_AUTH_FAILED", "The local Messages helper identity did not match."));
      }
      let challenge;
      try { challenge = challengeTranscript({ serverNonce: frame.serverNonce, helperAttestation: frame.helperAttestation }); } catch {
        return this.#destroy(codedError("IMSG_IPC_AUTH_FAILED", "The local Messages helper challenge was invalid."));
      }
      if (!verifyIpcTranscript(this.helperPublicKey, challenge, frame.signature)) {
        return this.#destroy(codedError("IMSG_IPC_AUTH_FAILED", "The local Messages helper signature was invalid."));
      }
      state.serverNonce = frame.serverNonce;
      state.clientNonce = randomNonce();
      state.transcript = sessionTranscript({
        serverNonce: state.serverNonce,
        clientNonce: state.clientNonce,
        helperAttestation: frame.helperAttestation,
        controllerAttestation: this.controllerAttestation,
      });
      this.helperAttestation = structuredClone(frame.helperAttestation);
      state.phase = "ready";
      this.#write({
        type: "auth",
        protocol: IMSG_IPC_PROTOCOL_VERSION,
        clientNonce: state.clientNonce,
        controllerAttestation: this.controllerAttestation,
        signature: signIpcTranscript(this.privateKey, state.transcript),
      });
      return;
    }
    if (state.phase !== "ready" || frame.type !== "ready" || frame.protocol !== IMSG_IPC_PROTOCOL_VERSION
      || !verifyIpcTranscript(this.helperPublicKey, state.transcript, frame.signature)) {
      return this.#destroy(codedError("IMSG_IPC_AUTH_FAILED", "The local Messages helper session could not be authenticated."));
    }
    clearTimeout(state.timer);
    this.connectState = null;
    this.authenticated = true;
    state.resolve(this);
  }

  #write(frame) {
    if (!this.socket || this.socket.destroyed) throw codedError("IMSG_IPC_DISCONNECTED", "The local Messages helper disconnected.");
    try { this.socket.write(encodeIpcFrame(frame, this.maxFrameBytes)); } catch (error) {
      this.#destroy(error);
      throw codedError("IMSG_IPC_DISCONNECTED", "The local Messages helper disconnected.");
    }
  }

  #response(frame) {
    if (!validResponseId(frame.id)) return this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The local Messages helper returned an invalid response."));
    const pending = this.pending.get(frame.id);
    if (!pending || Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) {
      return this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The local Messages helper returned an unexpected response."));
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (Object.hasOwn(frame, "error")) pending.reject(errorFromIpc(frame.error));
    else pending.resolve(frame.result);
  }

  #event(frame) {
    const subscription = Number(frame.subscription);
    if (!Number.isSafeInteger(subscription) || subscription <= 0 || !["watch.message", "watch.error"].includes(frame.event)) {
      return this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The local Messages helper returned an invalid event."));
    }
    const watcher = this.watches.get(subscription);
    if (!watcher) {
      const pending = this.earlyEvents.get(subscription) || [];
      if (pending.length < 16) pending.push(frame);
      this.earlyEvents.set(subscription, pending);
      if (this.earlyEvents.size > 4) this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The helper sent events for unknown subscriptions."));
      return;
    }
    this.#deliverEvent(watcher, frame);
  }

  #deliverEvent(watcher, frame) {
    try {
      if (frame.event === "watch.message") watcher.onMessage(frame.message);
      else watcher.onError?.(frame.error ? errorFromIpc(frame.error, "IMSG_WATCH_FAILED") : null);
    } catch {
      // Consumer callbacks cannot destabilize the authenticated transport.
    }
  }

  #destroy(error, source = this.socket) {
    if (source && this.socket !== source) return;
    const state = this.connectState;
    if (state) {
      clearTimeout(state.timer);
      this.connectState = null;
      state.reject(error || codedError("IMSG_IPC_DISCONNECTED", "The local Messages helper disconnected."));
    }
    try { source?.destroy(); } catch {}
  }

  #closed(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.decoder = null;
    this.authenticated = false;
    const state = this.connectState;
    if (state) {
      clearTimeout(state.timer);
      this.connectState = null;
      state.reject(codedError("IMSG_IPC_DISCONNECTED", "The local Messages helper disconnected."));
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(codedError("IMSG_IPC_DISCONNECTED", "The local Messages helper disconnected.", { attempted: pending.attempted }));
    }
    this.pending.clear();
    if (!this.intentionalClose) {
      for (const watcher of this.watches.values()) {
        try { watcher.onError?.(codedError("IMSG_IPC_DISCONNECTED", "The local Messages helper disconnected.")); } catch {}
      }
    }
    this.watches.clear();
    this.earlyEvents.clear();
    socket.removeAllListeners();
  }

  async #request(method, params = {}, {
    mutation = false,
    timeoutMs = this.requestTimeoutMs,
    operationId = null,
  } = {}) {
    if (mutation && operationId !== null && !validOperationId(operationId)) {
      throw codedError("IMSG_IPC_OPERATION_INVALID", "The Messages operation id is invalid.");
    }
    await this.connect();
    const id = this.nextRequestId++;
    const frame = { type: "request", id, method, params: isObject(params) ? params : {} };
    if (mutation) frame.operationId = operationId || randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(codedError("IMSG_IPC_TIMEOUT", "The local Messages helper request timed out.", { attempted: true }));
        this.#destroy(codedError("IMSG_IPC_TIMEOUT", "The local Messages helper request timed out."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, attempted: true, mutation });
      try { this.#write(frame); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async helperStatus() {
    const status = await this.#request("helper.status");
    if (!isObject(status?.profile) || !Number.isSafeInteger(Number(status.profile.chatId))
      || Number(status.profile.chatId) <= 0 || !clean(status.profile.chatGuid) || !clean(status.profile.expectedSender)) {
      this.#destroy(codedError("IMSG_IPC_PROTOCOL", "The helper returned an invalid pinned profile."));
      throw codedError("IMSG_IPC_PROTOCOL", "The helper returned an invalid pinned profile.");
    }
    this.profile = {
      chatId: Number(status.profile.chatId),
      chatGuid: clean(status.profile.chatGuid),
      expectedSender: clean(status.profile.expectedSender),
    };
    return status;
  }

  status(params = {}) { return this.#request("status", params); }
  probeCapabilities(params = {}) { return this.status(params); }
  latestMessage(params) { return this.#request("latestMessage", params); }
  async start() { await this.#request("client.start"); return this; }

  async stop() {
    this.intentionalClose = true;
    if (this.socket && this.authenticated && !this.socket.destroyed) {
      try { await this.#request("client.stop", {}, { timeoutMs: Math.min(this.requestTimeoutMs, 2_000) }); } catch {}
    }
    await this.close();
  }

  async close() {
    this.intentionalClose = true;
    const socket = this.socket;
    if (!socket) return;
    await new Promise((resolve) => {
      if (this.socket !== socket || socket.destroyed) return resolve();
      const finish = () => resolve();
      socket.once("close", finish);
      try { socket.destroy(); } catch { finish(); }
    });
  }

  async restart() { await this.stop(); this.intentionalClose = false; return this.start(); }

  async resetConnection() {
    this.intentionalClose = true;
    const socket = this.socket;
    if (socket) {
      await new Promise((resolve) => {
        if (this.socket !== socket) return resolve();
        const finish = () => resolve();
        socket.once("close", finish);
        try { socket.destroy(); } catch { finish(); }
      });
    }
    this.profile = null;
    this.helperAttestation = null;
    this.intentionalClose = false;
  }

  async #mutation(method, params, options = {}) {
    try {
      return await this.#request(method, params, {
        mutation: true,
        operationId: clean(options.operationId) || null,
      });
    } catch (error) {
      return ambiguous(error?.code === "IMSG_IPC_TIMEOUT" ? "ipc-timeout" : "ipc-disconnected");
    }
  }

  async #uploadFile(fileValue) {
    if (!path.isAbsolute(clean(fileValue))) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment path is invalid.");
    let file;
    let metadata;
    try {
      file = realpathSync(fileValue);
      metadata = statSync(file);
    } catch {
      throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment path is unavailable.");
    }
    const extension = safeExtension(file);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ATTACHMENT_BYTES || !extension) {
      throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment is not an allowed image.");
    }
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    const begun = await this.#request("upload.begin", { name: `attachment${extension}`, size: metadata.size, sha256: digest });
    const handle = clean(begun?.handle);
    if (!handle) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper did not create an attachment upload.");
    let descriptor;
    try {
      descriptor = openSync(file, "r");
      let offset = 0;
      while (offset < metadata.size) {
        const buffer = Buffer.alloc(Math.min(IMSG_IPC_ATTACHMENT_CHUNK_BYTES, metadata.size - offset));
        const count = readSync(descriptor, buffer, 0, buffer.byteLength, offset);
        if (count <= 0) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment changed while it was read.");
        const response = await this.#request("upload.write", { handle, offset, data: buffer.subarray(0, count).toString("base64") });
        if (Number(response?.nextOffset) !== offset + count) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper rejected an attachment chunk.");
        offset += count;
      }
      const finished = await this.#request("upload.finish", { handle });
      if (clean(finished?.stagedAttachmentId) !== handle) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper did not finish the attachment upload.");
      return handle;
    } catch (error) {
      try { await this.#request("upload.release", { handle }); } catch {}
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  async #withUploadedAttachment(method, params, options = {}) {
    const source = isObject(params) ? { ...params } : {};
    const file = clean(source.file || source.path);
    if (!file) return this.#mutation(method, source, options);
    delete source.file;
    delete source.path;
    let handle;
    try {
      handle = await this.#uploadFile(file);
      return await this.#mutation(method, { ...source, stagedAttachmentId: handle }, options);
    } catch (error) {
      return ambiguous(error?.code === "IMSG_IPC_TIMEOUT" ? "ipc-timeout" : "attachment-transfer-failed");
    } finally {
      if (handle) {
        try { await this.#request("upload.release", { handle }); } catch {}
      }
    }
  }

  sendRich(params, options = {}) { return this.#withUploadedAttachment("sendRich", params, options); }
  sendAttachment(params, options = {}) { return this.#withUploadedAttachment("sendAttachment", params, options); }
  sendPoll(params, options = {}) { return this.#mutation("sendPoll", params, options); }
  sendPollVote(params, options = {}) {
    return this.#mutation("sendPollVote", { ...params, remove: options.remove === true }, options);
  }
  votePoll(params, options = {}) { return this.sendPollVote(params, options); }
  tapback(params, options = {}) { return this.#mutation("tapback", params, options); }
  setTyping(params, typing = true, options = {}) {
    return this.#mutation("setTyping", { ...params, typing: typing === true }, options);
  }
  typing(params, typing = true) { return this.setTyping(params, typing); }
  markRead(params, options = {}) { return this.#mutation("markRead", params, options); }
  read(params) { return this.markRead(params); }

  async sendStatus(guid, options = {}) {
    if (!this.profile) await this.helperStatus();
    return this.#mutation("sendStatus", { chat_id: this.profile.chatId, guid }, options);
  }

  getSendStatus(guid) { return this.sendStatus(guid); }
  editMessage(params, options = {}) { return this.#mutation("editMessage", params, options); }
  unsendMessage(params, options = {}) { return this.#mutation("unsendMessage", params, options); }

  async subscribeWatch(params = {}, handlers = {}) {
    const callbacks = {
      onMessage: typeof handlers === "function" ? handlers : handlers.onMessage || (() => {}),
      onError: typeof handlers === "function" ? null : handlers.onError,
    };
    const result = await this.#request("watch.subscribe", params);
    const subscription = Number(result?.subscription);
    if (!Number.isSafeInteger(subscription) || subscription <= 0) throw codedError("IMSG_IPC_PROTOCOL", "The helper returned an invalid watch subscription.");
    this.watches.set(subscription, callbacks);
    for (const frame of this.earlyEvents.get(subscription) || []) this.#deliverEvent(callbacks, frame);
    this.earlyEvents.delete(subscription);
    return { subscription, unsubscribe: () => this.unsubscribeWatch(subscription) };
  }

  watch(params, handlers) { return this.subscribeWatch(params, handlers); }

  async unsubscribeWatch(subscription) {
    const id = Number(subscription);
    const existed = this.watches.delete(id);
    this.earlyEvents.delete(id);
    if (!existed) return false;
    try {
      const result = await this.#request("watch.unsubscribe", { subscription: id });
      return result?.unsubscribed === true;
    } catch {
      return false;
    }
  }

  async importAttachments(attachments, options = {}) {
    const values = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
    if (!values.length) return [];
    if (!path.isAbsolute(clean(options.destinationRoot))) throw new TypeError("A private absolute destinationRoot is required.");
    const rootValue = path.resolve(options.destinationRoot);
    mkdirSync(rootValue, { recursive: true, mode: 0o700 });
    chmodSync(rootValue, 0o700);
    const root = realpathSync(rootValue);
    const destination = path.join(root, safeSegment(options.messageKey));
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    chmodSync(destination, 0o700);
    if (!inside(root, realpathSync(destination))) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment destination escaped its private root.");
    const opened = await this.#request("attachments.open", { attachments: values });
    const handle = clean(opened?.handle);
    const files = Array.isArray(opened?.files) ? opened.files.slice(0, MAX_ATTACHMENTS) : [];
    if (!handle) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper did not open the requested attachments.");
    const imported = [];
    try {
      for (const item of files) {
        const index = Number(item?.index);
        const size = Number(item?.size);
        const extension = safeExtension(`image${clean(item?.extension)}`);
        if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(size)
          || size <= 0 || size > MAX_ATTACHMENT_BYTES || !extension) continue;
        const temporary = path.join(destination, `.incoming-${randomUUID()}.tmp`);
        const target = path.join(destination, `image-${imported.length + 1}${extension}`);
        let descriptor;
        try {
          descriptor = openSync(temporary, "wx", 0o600);
          let offset = 0;
          while (offset < size) {
            const response = await this.#request("attachments.read", {
              handle,
              index,
              offset,
              length: Math.min(IMSG_IPC_ATTACHMENT_CHUNK_BYTES, size - offset),
            });
            const encoded = clean(response?.data);
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper returned malformed attachment data.");
            const data = Buffer.from(encoded, "base64");
            if (data.toString("base64") !== encoded || !data.byteLength || data.byteLength > IMSG_IPC_ATTACHMENT_CHUNK_BYTES
              || Number(response?.offset) !== offset || Number(response?.nextOffset) !== offset + data.byteLength
              || offset + data.byteLength > size) {
              throw codedError("IMSG_ATTACHMENT_INVALID", "The helper returned an invalid attachment chunk.");
            }
            const count = writeSync(descriptor, data, 0, data.byteLength, offset);
            if (count !== data.byteLength) throw codedError("IMSG_ATTACHMENT_INVALID", "The attachment import was incomplete.");
            offset += count;
            if (response?.eof === true && offset !== size) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper ended an attachment early.");
            if (offset === size && response?.eof !== true) throw codedError("IMSG_ATTACHMENT_INVALID", "The helper did not finish the attachment stream.");
          }
          fsyncSync(descriptor);
          closeSync(descriptor);
          descriptor = undefined;
          renameSync(temporary, target);
          chmodSync(target, 0o600);
          imported.push(target);
        } catch (error) {
          if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
          rmSync(temporary, { force: true });
          throw error;
        }
      }
      return imported;
    } finally {
      try { await this.#request("attachments.close", { handle }); } catch {}
    }
  }
}

export function createImsgIpcClientFromConfig(configPath, options = {}) {
  const configBytes = readSecureFile(configPath, { maxBytes: MAX_CONFIG_BYTES, privateFile: true });
  let config;
  try { config = JSON.parse(configBytes.toString("utf8")); } catch {
    throw codedError("IMSG_IPC_CONFIG_INVALID", "The private imsg IPC client configuration is invalid.");
  }
  if (!isObject(config) || config.version !== 1 || !path.isAbsolute(clean(config.socketPath))) {
    throw codedError("IMSG_IPC_CONFIG_INVALID", "The private imsg IPC client configuration is incomplete.");
  }
  const privateKeyPath = config.controllerPrivateKeyPath || config.privateKeyPath;
  const helperPublicKeyPath = config.helperPublicKeyPath;
  const privateKey = readSecureFile(privateKeyPath, { maxBytes: MAX_KEY_BYTES, privateFile: true });
  const helperPublicKey = readSecureFile(helperPublicKeyPath, { maxBytes: MAX_KEY_BYTES, privateFile: false });
  const user = os.userInfo();
  const codexHome = realpathSync(options.codexHome || config.codexHome || process.env.CODEX_HOME || path.join(user.homedir, ".codex"));
  const controllerAttestation = createControllerAttestation({
    uid: process.getuid?.(),
    username: user.username,
    codexHome,
  });
  if (strictHash(config.expectedControllerIdentityHash)
    && controllerIdentityHash(controllerAttestation) !== strictHash(config.expectedControllerIdentityHash)) {
    throw codedError("IMSG_IPC_CONTROLLER_MISMATCH", "The private imsg IPC client configuration belongs to another controller identity.");
  }
  return new ImsgIpcClient({
    ...options,
    socketPath: config.socketPath,
    privateKey,
    helperPublicKey,
    controllerAttestation,
    expectedHelperAttestation: config.expectedHelperAttestation,
    expectedHelperKeyFingerprint: config.expectedHelperKeyFingerprint,
  });
}

export const imsgIpcClientValues = Object.freeze({
  protocolVersion: IMSG_IPC_PROTOCOL_VERSION,
  maxFrameBytes: IMSG_IPC_MAX_FRAME_BYTES,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxAttachments: MAX_ATTACHMENTS,
});
