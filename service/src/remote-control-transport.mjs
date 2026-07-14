import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const PROTOCOL_VERSION = 3;
const CLIENT_SEGMENT_THRESHOLD_BYTES = 100 * 1024;
const MAX_WIRE_ENVELOPE_BYTES = 150 * 1024;
const MAX_LOGICAL_MESSAGE_BYTES = 1024 * 1024 * 1024;
const MAX_SEGMENT_COUNT = Math.ceil(
  MAX_LOGICAL_MESSAGE_BYTES / CLIENT_SEGMENT_THRESHOLD_BYTES,
);

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_PING_INTERVAL_MS = 10_000;
const DEFAULT_WEBSOCKET_PONG_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_PING_INTERVAL_MS = 30_000;
const DEFAULT_STREAM_PONG_TIMEOUT_MS = 10 * 60_000;
const STREAM_PROTOCOL_ERROR_CODE = 4_000;

const INTERNAL_STREAM = Symbol("remote-control-stream");

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function rawText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return String(value);
}

function rawByteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Buffer.byteLength(String(value), "utf8");
}

function requestId(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function envelopeKey(envelope) {
  return `${envelope.env_id}:${envelope.stream_id}:${envelope.seq_id}`;
}

function segmentId(envelope) {
  return envelope.segment_id ?? 0;
}

function setHeader(headers, name, value) {
  const existing = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  headers[name] = value;
}

function getHeader(headers, name) {
  const entry = Object.entries(headers || {}).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function timer(callback, delay) {
  const handle = setTimeout(callback, delay);
  handle.unref?.();
  return handle;
}

function interval(callback, delay) {
  const handle = setInterval(callback, delay);
  handle.unref?.();
  return handle;
}

function log(logger, level, message, details) {
  try {
    logger?.[level]?.(message, details);
  } catch {
    // Diagnostics must never break protocol handling.
  }
}

function normalizeTiming(timing = {}) {
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? Number(value) : fallback;
  return {
    challengeTimeoutMs: positive(timing.challengeTimeoutMs, DEFAULT_CHALLENGE_TIMEOUT_MS),
    websocketPingIntervalMs: positive(
      timing.websocketPingIntervalMs,
      DEFAULT_WEBSOCKET_PING_INTERVAL_MS,
    ),
    websocketPongTimeoutMs: positive(
      timing.websocketPongTimeoutMs,
      DEFAULT_WEBSOCKET_PONG_TIMEOUT_MS,
    ),
    streamPingIntervalMs: positive(timing.streamPingIntervalMs, DEFAULT_STREAM_PING_INTERVAL_MS),
    streamPongTimeoutMs: positive(timing.streamPongTimeoutMs, DEFAULT_STREAM_PONG_TIMEOUT_MS),
  };
}

function normalizeSession(value) {
  if (!isObject(value)) throw new TypeError("Remote Control session metadata is missing.");
  const clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
  const envId = typeof value.envId === "string" ? value.envId.trim() : "";
  if (!clientId || !envId) throw new TypeError("Remote Control clientId and envId are required.");
  if (!isObject(value.headers)) throw new TypeError("Remote Control session headers are required.");
  if (!isPositiveInteger(value.tokenExpiresAt)) {
    throw new TypeError("Remote Control tokenExpiresAt must be a positive Unix timestamp.");
  }
  if (!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")) {
    throw new TypeError("Remote Control session scopes are invalid.");
  }
  const headers = Object.fromEntries(Object.entries(value.headers).map(([key, headerValue]) => (
    [String(key), String(headerValue)]
  )));
  return {
    clientId,
    envId,
    headers,
    tokenExpiresAt: value.tokenExpiresAt,
    scopes: [...value.scopes],
  };
}

function websocketTarget(websocketUrl) {
  const target = new URL(websocketUrl);
  const protocol = target.protocol === "wss:" ? "https:" : target.protocol === "ws:" ? "http:" : null;
  if (!protocol) throw new TypeError("Remote Control websocketUrl must use ws: or wss:.");
  return { origin: `${protocol}//${target.host}`, path: target.pathname };
}

function sessionToken(headers) {
  const match = /^Bearer\s+(.+)$/i.exec(String(getHeader(headers, "x-codex-client-session-token") || ""));
  return match?.[1] || null;
}

function validateDeviceChallenge(challenge, session, websocketUrl, now = Date.now()) {
  if (!isObject(challenge) || challenge.type !== "device_key_challenge") {
    throw new TypeError("Remote Control device-key challenge is invalid.");
  }
  const requiredStrings = [
    "nonce",
    "sessionId",
    "targetOrigin",
    "targetPath",
    "accountUserId",
    "clientId",
    "tokenSha256Base64url",
  ];
  if (!requiredStrings.every((key) => typeof challenge[key] === "string" && challenge[key])) {
    throw new TypeError("Remote Control device-key challenge fields are invalid.");
  }
  if (challenge.purpose !== "remote_control_client_websocket"
    || challenge.audience !== "remote_control_client_websocket") {
    throw new Error("Remote Control device-key challenge purpose is invalid.");
  }
  const expectedTarget = websocketTarget(websocketUrl);
  if (challenge.targetOrigin !== expectedTarget.origin || challenge.targetPath !== expectedTarget.path) {
    throw new Error("Remote Control device-key challenge target does not match the websocket URL.");
  }
  if (challenge.clientId !== session.clientId) {
    throw new Error("Remote Control device-key challenge client does not match the session.");
  }
  const token = sessionToken(session.headers);
  if (!token) throw new Error("Remote Control session token header is missing.");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("base64url");
  if (challenge.tokenSha256Base64url !== tokenHash) {
    throw new Error("Remote Control device-key challenge token hash does not match the session.");
  }
  if (!isPositiveInteger(challenge.tokenExpiresAt)
    || challenge.tokenExpiresAt <= Math.floor(now / 1_000)
    || challenge.tokenExpiresAt !== session.tokenExpiresAt) {
    throw new Error("Remote Control device-key challenge expiry does not match the session.");
  }
  if (!Array.isArray(challenge.scopes)
    || challenge.scopes.length !== session.scopes.length
    || !challenge.scopes.every((scope, index) => scope === session.scopes[index])) {
    throw new Error("Remote Control device-key challenge scopes do not match the session.");
  }
  return challenge;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  if (value.length % 4 === 1) return null;
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  return canonical === value.replace(/=+$/, "") ? decoded : null;
}

function chunkType(type) {
  return type === "client_message" ? "client_message_chunk" : "server_message_chunk";
}

/**
 * Split one logical client/server message using Codex Remote Control protocol
 * v3. The 100 KiB threshold applies to the unsegmented envelope; the 150 KiB
 * limit applies to every encoded transport envelope.
 */
function segmentEnvelope(envelope) {
  if (envelope.type === "client_message_chunk" || envelope.type === "server_message_chunk") {
    if (jsonBytes(envelope) > MAX_WIRE_ENVELOPE_BYTES) {
      throw new RangeError("Remote Control segment exceeds the 150 KiB wire limit.");
    }
    return [envelope];
  }
  if (jsonBytes(envelope) <= CLIENT_SEGMENT_THRESHOLD_BYTES) return [envelope];
  if (envelope.type !== "client_message" && envelope.type !== "server_message") {
    throw new RangeError("Remote Control envelope exceeds the unsegmented wire limit.");
  }

  const message = Buffer.from(JSON.stringify(envelope.message), "utf8");
  const messageSize = message.length;
  if (messageSize <= 0 || messageSize > MAX_LOGICAL_MESSAGE_BYTES) {
    throw new RangeError("Remote Control logical message exceeds the 1 GiB limit.");
  }

  let requestedCount = Math.max(1, Math.ceil(messageSize / CLIENT_SEGMENT_THRESHOLD_BYTES));
  for (;;) {
    const chunkSize = Math.max(1, Math.ceil(messageSize / requestedCount));
    const chunks = [];
    for (let offset = 0; offset < messageSize; offset += chunkSize) {
      chunks.push(message.subarray(offset, offset + chunkSize));
    }
    if (chunks.length > MAX_SEGMENT_COUNT) {
      throw new RangeError("Remote Control message requires too many segments.");
    }
    const segments = chunks.map((chunk, index) => {
      const segmented = {
        ...envelope,
        type: chunkType(envelope.type),
        segment_id: index,
        segment_count: chunks.length,
        message_size_bytes: messageSize,
        message_chunk_base64: chunk.toString("base64"),
      };
      delete segmented.message;
      return segmented;
    });
    if (segments.every((segment) => jsonBytes(segment) <= MAX_WIRE_ENVELOPE_BYTES)) return segments;
    if (chunkSize === 1) {
      throw new RangeError("Remote Control segment metadata exceeds the 150 KiB wire limit.");
    }
    requestedCount += 1;
  }
}

class EnvelopeQueue {
  constructor() {
    this.byStream = new Map();
    this.nextSeqByStream = new Map();
    this.highestAckByStream = new Map();
    this.segmentCountByEnvelope = new Map();
    this.ackedSegmentsByEnvelope = new Map();
  }

  add(envelope, { retain = true } = {}) {
    const seqId = this.nextSeqByStream.get(envelope.stream_id) ?? 1;
    this.nextSeqByStream.set(envelope.stream_id, seqId + 1);
    const result = { ...envelope, seq_id: seqId };
    if (retain) {
      const queue = this.byStream.get(result.stream_id) || [];
      queue.push(result);
      this.byStream.set(result.stream_id, queue);
    }
    return result;
  }

  recordSegmentCount(envelope, count) {
    if (envelope.type === "client_message") {
      this.segmentCountByEnvelope.set(envelopeKey(envelope), count);
    }
  }

  getSegmentCount(envelope) {
    const key = envelopeKey(envelope);
    let count = this.segmentCountByEnvelope.get(key);
    if (count == null) {
      count = envelope.type === "client_message" ? segmentEnvelope(envelope).length : 1;
      this.segmentCountByEnvelope.set(key, count);
    }
    return count;
  }

  handleAck(ack) {
    const queue = this.byStream.get(ack.stream_id);
    if (!queue) return;
    const highest = Math.max(this.highestAckByStream.get(ack.stream_id) ?? 0, ack.seq_id);
    this.highestAckByStream.set(ack.stream_id, highest);
    const acknowledged = queue.find((envelope) => envelope.seq_id === ack.seq_id);
    if (acknowledged?.type === "client_message" && this.getSegmentCount(acknowledged) > 1) {
      const id = segmentId(ack);
      const count = this.getSegmentCount(acknowledged);
      if (id >= 0 && id < count) {
        const key = envelopeKey(acknowledged);
        const ids = this.ackedSegmentsByEnvelope.get(key) || new Set();
        ids.add(id);
        this.ackedSegmentsByEnvelope.set(key, ids);
      }
    }
    while (queue.length && queue[0].seq_id <= highest) {
      const front = queue[0];
      const count = front.type === "client_message" ? this.getSegmentCount(front) : 1;
      const ackedCount = this.ackedSegmentsByEnvelope.get(envelopeKey(front))?.size ?? 0;
      if (count > 1 && ackedCount < count) break;
      queue.shift();
      this.#forgetEnvelope(front);
    }
    if (!queue.length) {
      this.byStream.delete(ack.stream_id);
      this.highestAckByStream.delete(ack.stream_id);
    }
  }

  *values() {
    for (const queue of this.byStream.values()) {
      for (const envelope of queue) yield envelope;
    }
  }

  forgetStream(streamId) {
    const queue = this.byStream.get(streamId) || [];
    for (const envelope of queue) this.#forgetEnvelope(envelope);
    this.byStream.delete(streamId);
    this.nextSeqByStream.delete(streamId);
    this.highestAckByStream.delete(streamId);
  }

  clear() {
    this.byStream.clear();
    this.nextSeqByStream.clear();
    this.highestAckByStream.clear();
    this.segmentCountByEnvelope.clear();
    this.ackedSegmentsByEnvelope.clear();
  }

  #forgetEnvelope(envelope) {
    const key = envelopeKey(envelope);
    this.segmentCountByEnvelope.delete(key);
    this.ackedSegmentsByEnvelope.delete(key);
  }
}

function isEnvelopeBase(value) {
  return isObject(value)
    && typeof value.client_id === "string"
    && isNonNegativeInteger(value.seq_id)
    && typeof value.env_id === "string"
    && typeof value.stream_id === "string";
}

function parseServerEnvelope(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isEnvelopeBase(value)) return null;
  if (value.type === "ack") {
    if (value.segment_id != null && !isNonNegativeInteger(value.segment_id)) return null;
    if (value.segment_count != null && !isPositiveInteger(value.segment_count)) return null;
    return value;
  }
  if (value.type === "server_message") {
    return isObject(value.message) ? value : null;
  }
  if (value.type === "server_message_chunk") {
    return isNonNegativeInteger(value.segment_id)
      && isPositiveInteger(value.segment_count)
      && isPositiveInteger(value.message_size_bytes)
      && typeof value.message_chunk_base64 === "string"
      ? value
      : null;
  }
  if (value.type === "pong") {
    return value.status === "active" || value.status === "unknown" ? value : null;
  }
  return null;
}

function convertServerPayload(payload, pendingRequestIds, logger) {
  if ("method" in payload || "result" in payload || "error" in payload) {
    const id = requestId(payload.id);
    if (id != null) {
      const index = pendingRequestIds.indexOf(id);
      if (index >= 0) pendingRequestIds.splice(index, 1);
    }
    return payload;
  }
  if (payload.type === "error") {
    const id = pendingRequestIds.shift() ?? null;
    if (id == null) {
      log(logger, "warn", "Received a Remote Control error with no pending request.", { payload });
      return null;
    }
    const error = { ...payload };
    delete error.type;
    return { id, error };
  }
  log(logger, "warn", "Ignoring an unsupported Remote Control server payload.", { payload });
  return null;
}

/**
 * One enrolled-controller connection. A process should construct one instance
 * and obtain all logical app-server transports through createStream().
 */
export class RemoteControlConnection {
  constructor({
    webSocketFactory,
    websocketUrl,
    getSession,
    authorizeDeviceChallenge,
    logger = null,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
    timing,
  } = {}) {
    if (typeof webSocketFactory !== "function") throw new TypeError("webSocketFactory is required.");
    if (typeof getSession !== "function") throw new TypeError("getSession is required.");
    if (typeof authorizeDeviceChallenge !== "function") {
      throw new TypeError("authorizeDeviceChallenge is required.");
    }
    websocketTarget(websocketUrl);
    this.webSocketFactory = webSocketFactory;
    this.websocketUrl = websocketUrl;
    this.getSession = getSession;
    this.authorizeDeviceChallenge = authorizeDeviceChallenge;
    this.logger = logger;
    this.reconnectDelayMs = Number.isFinite(reconnectDelayMs) && reconnectDelayMs >= 0
      ? Number(reconnectDelayMs)
      : DEFAULT_RECONNECT_DELAY_MS;
    const normalizedReconnectMaxDelayMs = Number.isFinite(reconnectMaxDelayMs)
      && reconnectMaxDelayMs >= 0
      ? Number(reconnectMaxDelayMs)
      : DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.reconnectMaxDelayMs = Math.max(this.reconnectDelayMs, normalizedReconnectMaxDelayMs);
    this.nextReconnectDelayMs = this.reconnectDelayMs;
    this.reconnectAttempt = 0;
    this.timing = normalizeTiming(timing);

    this.streams = new Set();
    this.socket = null;
    this.session = null;
    this.clientId = null;
    this.envId = null;
    this.cursor = null;
    this.authorized = false;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.challengeTimer = null;
    this.challengeInFlight = false;
    this.websocketPingTimer = null;
    this.streamPingTimer = null;
    this.lastWebsocketPongAt = null;
    this.unacked = new EnvelopeQueue();
    this.pendingClientClosed = new Map();
    this.pendingClientClosedInFlight = new Set();
    this.terminal = false;
  }

  createStream() {
    if (this.terminal) throw new Error("Remote Control connection has been terminated.");
    return new RemoteControlStream(INTERNAL_STREAM, this);
  }

  terminate() {
    if (this.terminal) return;
    this.terminal = true;
    this.#stopReconnect();
    this.#resetReconnectBackoff();
    this.#stopChallengeTimer();
    this.#stopWebsocketPing();
    this.#stopStreamPing();
    this.#terminatePhysicalSocket();
    for (const stream of [...this.streams]) {
      this.#removeStream(stream, 1_006, "Remote Control connection terminated.", false, false);
    }
    this.pendingClientClosed.clear();
    this.pendingClientClosedInFlight.clear();
    this.unacked.clear();
  }

  _registerStream(stream) {
    if (this.terminal) throw new Error("Remote Control connection has been terminated.");
    this.streams.add(stream);
    this.#startStreamPing();
    if (this.authorized) queueMicrotask(() => stream._markOpen());
    else queueMicrotask(() => this.#ensureConnection());
  }

  _sendJsonRpc(stream, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      throw new TypeError("Remote Control transport expected JSON text.", { cause: error });
    }
    if (!isObject(message)) throw new TypeError("Remote Control transport expected JSON-RPC objects.");
    const streamId = stream._ensureStreamId(message);
    const id = requestId(message.id);
    if (id != null) stream.pendingRequestIds.push(id);
    const envelope = this.unacked.add({
      type: "client_message",
      client_id: this.#requireClientId(),
      stream_id: streamId,
      env_id: this.#requireEnvId(),
      skip_history: false,
      message,
    });
    try {
      this.#sendEnvelopeNow(envelope);
    } catch (error) {
      stream._failProtocol(error.message);
      throw error;
    }
  }

  _forgetStreamEnvelopes(streamId) {
    if (streamId) this.unacked.forgetStream(streamId);
  }

  _closeStream(stream, code = 1_000, reason = "", sendClientClosed = true) {
    this.#removeStream(stream, code, reason, code === 1_000, sendClientClosed);
  }

  _sendStreamProtocolError(stream, reason) {
    const error = Object.assign(new Error(reason), { code: "REMOTE_CONTROL_PROTOCOL_GAP" });
    stream._emitError(error);
    this.#removeStream(stream, STREAM_PROTOCOL_ERROR_CODE, reason, false, true);
  }

  _acceptCursor(cursor) {
    if (typeof cursor === "string" && cursor) this.cursor = cursor;
  }

  #requireClientId() {
    if (!this.clientId) throw new Error("Remote Control client is not enrolled.");
    return this.clientId;
  }

  #requireEnvId() {
    if (!this.envId) throw new Error("Remote Control environment is not selected.");
    return this.envId;
  }

  #hasDemand() {
    return this.streams.size > 0 || this.pendingClientClosed.size > 0;
  }

  #ensureConnection() {
    if (this.terminal
      || !this.#hasDemand()
      || this.authorized
      || this.socket
      || this.connectPromise
      || this.reconnectTimer) return;
    const connecting = this.#openPhysicalSocket();
    this.connectPromise = connecting;
    connecting.catch((error) => {
      log(this.logger, "warn", "Remote Control websocket connection failed.", { error });
      if (error?.remoteControlSessionProvider === true) this.#rejectCurrentStreams(error);
      else if (error?.code === "REMOTE_CONTROL_FATAL") this.#failConnection(error);
      else this.#scheduleReconnect();
    }).finally(() => {
      if (this.connectPromise === connecting) this.connectPromise = null;
    });
  }

  async #openPhysicalSocket() {
    let nextSession;
    try {
      nextSession = normalizeSession(await this.getSession());
    } catch (cause) {
      const error = cause instanceof Error
        ? cause
        : new Error("Remote Control session provider failed.", { cause });
      error.remoteControlSessionProvider = true;
      throw error;
    }
    if (this.terminal || !this.#hasDemand()) return;
    if ((this.clientId && this.clientId !== nextSession.clientId)
      || (this.envId && this.envId !== nextSession.envId)) {
      const error = Object.assign(
        new Error("Remote Control session identity changed while logical streams were active."),
        { code: "REMOTE_CONTROL_FATAL" },
      );
      throw error;
    }
    this.clientId = nextSession.clientId;
    this.envId = nextSession.envId;
    this.session = nextSession;
    const headers = { ...nextSession.headers };
    setHeader(headers, "x-codex-client-id", nextSession.clientId);
    setHeader(headers, "x-codex-protocol-version", String(PROTOCOL_VERSION));
    if (this.cursor != null) setHeader(headers, "x-codex-subscribe-cursor", this.cursor);
    const socket = this.webSocketFactory(this.websocketUrl, {
      headers,
      perMessageDeflate: false,
      maxPayload: MAX_WIRE_ENVELOPE_BYTES,
    });
    if (!socket || typeof socket.on !== "function" || typeof socket.send !== "function") {
      throw new TypeError("webSocketFactory did not return a WebSocket-compatible object.");
    }
    if (this.terminal || !this.#hasDemand()) {
      socket.terminate?.();
      return;
    }
    this.socket = socket;
    this.authorized = false;
    socket.once("open", () => {
      if (this.socket === socket) this.#handlePhysicalOpen(socket);
    });
    socket.on("message", (data) => {
      if (this.socket !== socket) return;
      if (rawByteLength(data) > MAX_WIRE_ENVELOPE_BYTES) {
        this.#failConnection(Object.assign(
          new Error("Remote Control wire envelope exceeds the 150 KiB limit."),
          { code: "REMOTE_CONTROL_FATAL" },
        ));
        return;
      }
      this.#handleSocketMessage(socket, rawText(data));
    });
    socket.on("pong", () => {
      if (this.socket === socket) this.lastWebsocketPongAt = Date.now();
    });
    socket.on("error", (error) => {
      if (this.socket === socket) {
        log(this.logger, "warn", "Remote Control websocket reported an error.", { error });
        if (error?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
          this.#failConnection(Object.assign(
            new Error("Remote Control websocket payload exceeded the protocol limit."),
            { code: "REMOTE_CONTROL_FATAL" },
          ));
        } else {
          this.#forceReconnect();
        }
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.authorized = false;
        this.session = null;
        this.#stopChallengeTimer();
        this.#stopWebsocketPing();
        this.#scheduleReconnect();
      }
    });
  }

  #handlePhysicalOpen(socket) {
    this.#stopChallengeTimer();
    this.challengeInFlight = false;
    this.challengeTimer = timer(() => {
      if (this.socket === socket && !this.authorized) {
        log(this.logger, "warn", "Remote Control device-key challenge timed out.");
        this.#forceReconnect();
      }
    }, this.timing.challengeTimeoutMs);
  }

  #handleSocketMessage(socket, text) {
    if (!this.authorized) {
      this.#handleDeviceChallenge(socket, text);
      return;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_WIRE_ENVELOPE_BYTES) {
      this.#failConnection(new Error("Remote Control wire envelope exceeds the 150 KiB limit."));
      return;
    }
    const envelope = parseServerEnvelope(text);
    if (!envelope) {
      log(this.logger, "warn", "Ignoring a malformed Remote Control websocket payload.");
      return;
    }
    if (envelope.client_id !== this.clientId) {
      log(this.logger, "warn", "Remote Control websocket client id changed unexpectedly.");
      this.#forceReconnect();
      return;
    }
    if (envelope.env_id !== this.envId) return;
    if (envelope.type === "ack") {
      this.unacked.handleAck(envelope);
      return;
    }
    const stream = [...this.streams].find((candidate) => candidate.streamId === envelope.stream_id);
    if (!stream) return;
    stream._handleServerEnvelope(envelope, text);
  }

  #handleDeviceChallenge(socket, text) {
    if (this.challengeInFlight) return;
    let candidate;
    try {
      candidate = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(candidate) || candidate.type !== "device_key_challenge") return;
    let challenge;
    try {
      challenge = validateDeviceChallenge(candidate, this.session, this.websocketUrl);
    } catch (error) {
      this.#failConnection(error);
      return;
    }
    this.challengeInFlight = true;
    this.#stopChallengeTimer();
    Promise.resolve(this.authorizeDeviceChallenge(challenge, { ...this.session, headers: { ...this.session.headers } }))
      .then(async (proof) => {
        if (!isObject(proof) || proof.type !== "device_key_proof") {
          throw new TypeError("authorizeDeviceChallenge did not return a device_key_proof object.");
        }
        if (this.socket !== socket || this.terminal) return;
        await this.#sendProof(socket, JSON.stringify(proof));
        if (this.socket !== socket || this.terminal) return;
        this.authorized = true;
        this.#resetReconnectBackoff();
        this.challengeInFlight = false;
        this.lastWebsocketPongAt = Date.now();
        this.#startWebsocketPing();
        this.#replayUnacked();
        this.#flushPendingClientClosed();
        this.#restoreStreamSubscriptions();
        for (const stream of this.streams) stream._markOpen();
        if (!this.streams.size && !this.pendingClientClosed.size) this.#disposeIdle();
      })
      .catch((error) => {
        if (this.socket !== socket || this.terminal) return;
        this.challengeInFlight = false;
        log(this.logger, "warn", "Remote Control device-key proof failed.", { error });
        this.#forceReconnect();
      });
  }

  #sendProof(socket, text) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const complete = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      try {
        socket.send(text, complete);
        // Browser-compatible fakes may expose only send(data); production uses
        // ws, whose callback confirms that the proof was queued successfully.
        if (socket.send.length < 2) queueMicrotask(() => complete());
      } catch (error) {
        complete(error);
      }
    });
  }

  #sendEnvelopeNow(envelope) {
    if (!this.authorized || !this.socket || this.socket.readyState !== OPEN) {
      this.#ensureConnection();
      return;
    }
    const segments = segmentEnvelope(envelope);
    this.unacked.recordSegmentCount(envelope, segments.length);
    for (const segment of segments) {
      if (!this.authorized || !this.socket || this.socket.readyState !== OPEN) break;
      const socket = this.socket;
      try {
        socket.send(JSON.stringify(segment), (error) => {
          if (error && this.socket === socket) {
            log(this.logger, "warn", "Remote Control websocket send failed.", { error });
            this.#forceReconnect();
          }
        });
      } catch (error) {
        if (this.socket === socket) this.#forceReconnect();
        throw error;
      }
    }
  }

  #replayUnacked() {
    for (const envelope of this.unacked.values()) this.#sendEnvelopeNow(envelope);
  }

  #restoreStreamSubscriptions() {
    for (const stream of this.streams) {
      if (stream.readyState !== OPEN || !stream.streamId) continue;
      const envelope = this.unacked.add({
        type: "ping",
        client_id: this.#requireClientId(),
        stream_id: stream.streamId,
        env_id: this.#requireEnvId(),
        state: "foreground",
        skip_history: true,
      });
      this.#sendEnvelopeNow(envelope);
    }
  }

  #startWebsocketPing() {
    this.#stopWebsocketPing();
    this.lastWebsocketPongAt = Date.now();
    this.websocketPingTimer = interval(() => {
      const socket = this.socket;
      if (!this.authorized || !socket || socket.readyState !== OPEN) return;
      if (Date.now() - this.lastWebsocketPongAt > this.timing.websocketPongTimeoutMs) {
        log(this.logger, "warn", "Remote Control websocket pong timed out.");
        this.#forceReconnect();
        return;
      }
      if (typeof socket.ping === "function") {
        try {
          socket.ping();
        } catch {
          this.#forceReconnect();
        }
      }
    }, this.timing.websocketPingIntervalMs);
  }

  #stopWebsocketPing() {
    if (this.websocketPingTimer) clearInterval(this.websocketPingTimer);
    this.websocketPingTimer = null;
    this.lastWebsocketPongAt = null;
  }

  #startStreamPing() {
    if (this.streamPingTimer) return;
    this.streamPingTimer = interval(() => {
      const now = Date.now();
      for (const stream of [...this.streams]) {
        if (stream.readyState !== OPEN || !stream.streamId) continue;
        if (stream.lastPongAt != null && now - stream.lastPongAt >= this.timing.streamPongTimeoutMs) {
          stream._failProtocol("Remote Control app-server stream pong timed out.");
          continue;
        }
        if (!this.authorized || this.socket?.readyState !== OPEN) continue;
        const envelope = this.unacked.add({
          type: "ping",
          client_id: this.#requireClientId(),
          stream_id: stream.streamId,
          env_id: this.#requireEnvId(),
          state: "foreground",
          skip_history: true,
        });
        this.#sendEnvelopeNow(envelope);
      }
    }, this.timing.streamPingIntervalMs);
  }

  #stopStreamPing() {
    if (this.streamPingTimer) clearInterval(this.streamPingTimer);
    this.streamPingTimer = null;
  }

  #sendClientClosed(stream) {
    if (!stream.streamId || !this.clientId || !this.envId) return;
    const envelope = this.unacked.add({
      type: "client_closed",
      client_id: this.clientId,
      stream_id: stream.streamId,
      env_id: this.envId,
    }, { retain: false });
    this.pendingClientClosed.set(envelopeKey(envelope), envelope);
    this.#flushPendingClientClosed();
  }

  #flushPendingClientClosed() {
    if (!this.pendingClientClosed.size) return;
    if (!this.authorized || !this.socket || this.socket.readyState !== OPEN) {
      this.#ensureConnection();
      return;
    }
    const socket = this.socket;
    for (const [key, envelope] of [...this.pendingClientClosed]) {
      if (this.pendingClientClosedInFlight.has(key)) continue;
      this.pendingClientClosedInFlight.add(key);
      try {
        socket.send(JSON.stringify(envelope), (error) => {
          this.pendingClientClosedInFlight.delete(key);
          if (!error) {
            this.pendingClientClosed.delete(key);
            if (!this.streams.size && !this.pendingClientClosed.size) this.#disposeIdle();
          } else if (this.socket === socket) {
            this.#forceReconnect();
          }
        });
      } catch {
        this.pendingClientClosedInFlight.delete(key);
        if (this.socket === socket) this.#forceReconnect();
        return;
      }
    }
  }

  #removeStream(stream, code, reason, wasClean, sendClientClosed) {
    if (!this.streams.has(stream)) return;
    stream.readyState = CLOSING;
    if (sendClientClosed) this.#sendClientClosed(stream);
    this._forgetStreamEnvelopes(stream.streamId);
    this.streams.delete(stream);
    stream._finishClose(code, reason, wasClean);
    if (!this.streams.size) {
      this.#stopStreamPing();
      if (this.pendingClientClosed.size) this.#flushPendingClientClosed();
      else this.#disposeIdle();
    }
  }

  #scheduleReconnect() {
    if (this.terminal || !this.#hasDemand() || this.reconnectTimer) return;
    const delay = this.nextReconnectDelayMs;
    this.reconnectAttempt += 1;
    this.nextReconnectDelayMs = Math.min(
      this.reconnectMaxDelayMs,
      this.nextReconnectDelayMs * 2,
    );
    log(this.logger, "debug", "Remote Control websocket reconnect scheduled.", {
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });
    this.reconnectTimer = timer(() => {
      this.reconnectTimer = null;
      this.#ensureConnection();
    }, delay);
  }

  #stopReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  #resetReconnectBackoff() {
    this.reconnectAttempt = 0;
    this.nextReconnectDelayMs = this.reconnectDelayMs;
  }

  #stopChallengeTimer() {
    if (this.challengeTimer) clearTimeout(this.challengeTimer);
    this.challengeTimer = null;
  }

  #forceReconnect() {
    this.#stopChallengeTimer();
    this.#stopWebsocketPing();
    this.challengeInFlight = false;
    this.authorized = false;
    this.session = null;
    this.pendingClientClosedInFlight.clear();
    this.#terminatePhysicalSocket();
    this.#scheduleReconnect();
  }

  #terminatePhysicalSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else socket.close?.();
    } catch {
      // The logical stream owns reconnect/close behavior.
    }
  }

  #disposeIdle() {
    if (this.streams.size || this.pendingClientClosed.size) return;
    this.#stopReconnect();
    this.#resetReconnectBackoff();
    this.#stopChallengeTimer();
    this.#stopWebsocketPing();
    this.#stopStreamPing();
    const socket = this.socket;
    this.socket = null;
    this.authorized = false;
    this.session = null;
    this.clientId = null;
    this.envId = null;
    this.cursor = null;
    this.unacked.clear();
    if (socket) {
      try {
        socket.close?.(1_000, "Idle");
      } catch {
        socket.terminate?.();
      }
    }
  }

  #failConnection(error) {
    if (this.terminal) return;
    this.terminal = true;
    this.#stopReconnect();
    this.#stopChallengeTimer();
    this.#stopWebsocketPing();
    this.#terminatePhysicalSocket();
    for (const stream of [...this.streams]) {
      stream._emitError(error instanceof Error ? error : new Error(String(error)));
      this.#removeStream(stream, STREAM_PROTOCOL_ERROR_CODE, error?.message || "Protocol error", false, false);
    }
    this.pendingClientClosed.clear();
    this.pendingClientClosedInFlight.clear();
    this.unacked.clear();
  }

  #rejectCurrentStreams(error) {
    this.#stopReconnect();
    this.#stopChallengeTimer();
    this.#stopWebsocketPing();
    this.#terminatePhysicalSocket();
    for (const stream of [...this.streams]) {
      stream._emitError(error instanceof Error ? error : new Error(String(error)));
      this.#removeStream(stream, STREAM_PROTOCOL_ERROR_CODE, error?.message || "Remote Control unavailable", false, false);
    }
    this.pendingClientClosed.clear();
    this.pendingClientClosedInFlight.clear();
    this.unacked.clear();
    this.authorized = false;
    this.session = null;
    this.clientId = null;
    this.envId = null;
    this.cursor = null;
  }
}

/**
 * A WebSocket-like logical app-server stream. Prefer obtaining instances from
 * one process-wide RemoteControlConnection. Constructing this class directly
 * is retained as a convenience and creates a privately owned connection.
 */
export class RemoteControlStream extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(options, connection) {
    super();
    if (options === INTERNAL_STREAM) {
      this.connection = connection;
      this.ownedConnection = null;
    } else {
      this.ownedConnection = new RemoteControlConnection(options);
      this.connection = this.ownedConnection;
    }
    this.readyState = CONNECTING;
    this.streamId = null;
    this.pendingRequestIds = [];
    this.lastPongAt = null;
    this.seenServerSeqId = null;
    this.pendingSegmentedSeqId = null;
    this.nextSegmentId = 0;
    this.assembly = null;
    this.connection._registerStream(this);
  }

  send(value) {
    if (this.readyState !== OPEN) throw new Error("Remote Control stream is not open.");
    if (typeof value !== "string") throw new TypeError("Remote Control stream send() requires a string.");
    this.connection._sendJsonRpc(this, value);
  }

  close(code = 1_000, reason = "") {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.connection._closeStream(this, code, String(reason), true);
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.connection._closeStream(this, 1_006, "Remote Control stream terminated.", false);
  }

  _markOpen() {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.emit("open");
  }

  _ensureStreamId(message) {
    if (message.method === "initialize") {
      this.connection._forgetStreamEnvelopes(this.streamId);
      this.streamId = randomUUID();
      this.pendingRequestIds.length = 0;
      this.lastPongAt = Date.now();
      this.seenServerSeqId = null;
      this.pendingSegmentedSeqId = null;
      this.nextSegmentId = 0;
      this.assembly = null;
      return this.streamId;
    }
    if (!this.streamId) {
      throw new Error("The first Remote Control JSON-RPC request must be initialize.");
    }
    return this.streamId;
  }

  _handleServerEnvelope(envelope, wireText) {
    if (envelope.type === "pong") {
      this.lastPongAt = Date.now();
      if (envelope.status === "unknown") {
        this._failProtocol("Remote Control app-server stream became unknown.");
        return;
      }
      if (this._hasServerSeqGap(envelope.seq_id)) {
        this._failProtocol("Remote Control app-server stream sequence gap detected.");
        return;
      }
      if (this._acceptServerSeq(envelope.seq_id)) this.connection._acceptCursor(envelope.cursor);
      return;
    }

    if (envelope.type === "server_message_chunk") {
      if (Buffer.byteLength(wireText, "utf8") > MAX_WIRE_ENVELOPE_BYTES) {
        this._failProtocol("Remote Control server segment exceeds the 150 KiB wire limit.");
        return;
      }
      if (this._hasServerSeqGap(envelope.seq_id)) {
        this._failProtocol("Remote Control app-server stream sequence gap detected.");
        return;
      }
      const observation = this._observeSegmentOrder(envelope.seq_id, envelope.segment_id);
      if (observation === "stale") return;
      if (observation === "gap") {
        this._failProtocol("Remote Control app-server stream segment gap detected.");
        return;
      }
      let completed;
      try {
        completed = this._observeSegment(envelope);
      } catch (error) {
        this._failProtocol(error.message);
        return;
      }
      if (!completed) return;
      this.pendingSegmentedSeqId = null;
      this.nextSegmentId = 0;
      this.assembly = null;
      this._deliverServerMessage(completed);
      return;
    }

    if (this.pendingSegmentedSeqId === envelope.seq_id) {
      this._failProtocol("Remote Control app-server changed framing within a segmented message.");
      return;
    }
    if (this._hasServerSeqGap(envelope.seq_id)) {
      this._failProtocol("Remote Control app-server stream sequence gap detected.");
      return;
    }
    this._deliverServerMessage(envelope);
  }

  _deliverServerMessage(envelope) {
    if (!this._acceptServerSeq(envelope.seq_id)) return;
    const message = convertServerPayload(envelope.message, this.pendingRequestIds, this.connection.logger);
    if (message != null) this.emit("message", JSON.stringify(message));
    this.connection._acceptCursor(envelope.cursor);
  }

  _hasServerSeqGap(seqId) {
    if (this.pendingSegmentedSeqId != null && seqId > this.pendingSegmentedSeqId) return true;
    return this.seenServerSeqId != null && seqId > this.seenServerSeqId + 1;
  }

  _acceptServerSeq(seqId) {
    if (this.seenServerSeqId != null && seqId <= this.seenServerSeqId) return false;
    this.seenServerSeqId = seqId;
    return true;
  }

  _observeSegmentOrder(seqId, id) {
    if (this.seenServerSeqId != null && seqId <= this.seenServerSeqId) return "stale";
    if (this.pendingSegmentedSeqId == null) {
      if (id !== 0) return "gap";
      this.pendingSegmentedSeqId = seqId;
      this.nextSegmentId = 1;
      return "accept";
    }
    if (seqId < this.pendingSegmentedSeqId) return "stale";
    if (seqId > this.pendingSegmentedSeqId) return "gap";
    if (id < this.nextSegmentId) return "stale";
    if (id > this.nextSegmentId) return "gap";
    this.nextSegmentId += 1;
    return "accept";
  }

  _observeSegment(envelope) {
    const count = envelope.segment_count;
    if (count <= 1 || count > MAX_SEGMENT_COUNT
      || envelope.segment_id >= count
      || envelope.message_size_bytes > MAX_LOGICAL_MESSAGE_BYTES) {
      throw new Error("Remote Control server segment metadata is invalid.");
    }
    const chunk = decodeBase64(envelope.message_chunk_base64);
    if (!chunk) throw new Error("Remote Control server segment payload is invalid.");
    if (!this.assembly) {
      this.assembly = {
        segmentCount: count,
        messageSizeBytes: envelope.message_size_bytes,
        chunks: [],
        firstEnvelope: envelope,
      };
    } else if (this.assembly.segmentCount !== count
      || this.assembly.messageSizeBytes !== envelope.message_size_bytes) {
      throw new Error("Remote Control server segment metadata changed during reassembly.");
    }
    this.assembly.chunks.push(chunk);
    if (this.assembly.chunks.length < count) return null;
    const contents = Buffer.concat(this.assembly.chunks);
    if (contents.length !== this.assembly.messageSizeBytes) {
      throw new Error("Remote Control reassembled message size does not match its metadata.");
    }
    let message;
    try {
      message = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new Error("Remote Control reassembled message is not valid JSON.");
    }
    if (!isObject(message)) throw new Error("Remote Control reassembled message is not a JSON-RPC object.");
    return {
      type: "server_message",
      client_id: envelope.client_id,
      seq_id: envelope.seq_id,
      stream_id: envelope.stream_id,
      env_id: envelope.env_id,
      cursor: envelope.cursor,
      message,
    };
  }

  _failProtocol(reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.connection._sendStreamProtocolError(this, reason);
  }

  _emitError(error) {
    if (this.listenerCount("error") > 0) this.emit("error", error);
    else log(this.connection.logger, "error", error.message, { error });
  }

  _finishClose(code, reason, wasClean) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", code, Buffer.from(String(reason)), wasClean);
  }
}

export const remoteControlTransportInternals = Object.freeze({
  states: Object.freeze({ CONNECTING, OPEN, CLOSING, CLOSED }),
  protocolVersion: PROTOCOL_VERSION,
  clientSegmentThresholdBytes: CLIENT_SEGMENT_THRESHOLD_BYTES,
  maxWireEnvelopeBytes: MAX_WIRE_ENVELOPE_BYTES,
  maxLogicalMessageBytes: MAX_LOGICAL_MESSAGE_BYTES,
  maxSegmentCount: MAX_SEGMENT_COUNT,
  streamProtocolErrorCode: STREAM_PROTOCOL_ERROR_CODE,
  segmentEnvelope,
  validateDeviceChallenge,
});
