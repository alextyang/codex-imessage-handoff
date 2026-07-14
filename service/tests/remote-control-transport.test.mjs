import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import {
  RemoteControlConnection,
  RemoteControlStream,
  remoteControlTransportInternals,
} from "../src/remote-control-transport.mjs";

const TOKEN = "controller-session-token";
const CLIENT_ID = "controller-client";
const ENV_ID = "env-desktop";
const WS_URL = "wss://chatgpt.com/backend-api/codex/remote/control/client";
const SCOPES = ["remote_control_controller_websocket"];

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.pingCount = 0;
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  receive(value) {
    this.emit("message", typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value));
  }

  send(value, callback) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(String(value));
    queueMicrotask(() => callback?.());
  }

  ping() {
    this.pingCount += 1;
  }

  close(code = 1_000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close(1_006, "terminated");
  }
}

function eventually(predicate, message = "condition was not met") {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(check, 2);
    };
    check();
  });
}

async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function fixture(options = {}) {
  const sockets = [];
  const factoryCalls = [];
  const proofs = [];
  const tokenExpiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  const connection = new RemoteControlConnection({
    websocketUrl: WS_URL,
    reconnectDelayMs: options.reconnectDelayMs ?? 1,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    timing: options.timing,
    getSession: async () => ({
      clientId: CLIENT_ID,
      envId: ENV_ID,
      tokenExpiresAt,
      scopes: SCOPES,
      headers: {
        Authorization: "Bearer chatgpt-token",
        "x-codex-client-session-token": `Bearer ${TOKEN}`,
        "X-Codex-Protocol-Version": "wrong",
      },
    }),
    authorizeDeviceChallenge: async (challenge) => {
      proofs.push(challenge);
      return {
        type: "device_key_proof",
        keyId: "device-key",
        signatureDerBase64: "signature",
        signedPayloadBase64: "payload",
        algorithm: "ecdsa_p256_sha256",
      };
    },
    webSocketFactory: (url, webSocketOptions) => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      factoryCalls.push({ url, options: webSocketOptions });
      return socket;
    },
  });
  return { connection, sockets, factoryCalls, proofs, tokenExpiresAt };
}

function challenge(tokenExpiresAt, overrides = {}) {
  return {
    type: "device_key_challenge",
    nonce: "nonce",
    purpose: "remote_control_client_websocket",
    audience: "remote_control_client_websocket",
    sessionId: "session",
    targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/client",
    accountUserId: "account-user",
    clientId: CLIENT_ID,
    tokenSha256Base64url: createHash("sha256").update(TOKEN).digest("base64url"),
    tokenExpiresAt,
    scopes: SCOPES,
    ...overrides,
  };
}

async function openStream(fx, stream, socket = null) {
  await eventually(() => fx.sockets.length > 0, "websocket was not constructed");
  const current = socket || fx.sockets.at(-1);
  const opened = stream.readyState === 1 ? Promise.resolve() : once(stream, "open");
  current.open();
  current.receive(challenge(fx.tokenExpiresAt));
  await opened;
  return current;
}

function sentJson(socket) {
  return socket.sent.map((value) => JSON.parse(value));
}

function initialize(stream, id = "initialize") {
  stream.send(JSON.stringify({ id, method: "initialize", params: {} }));
}

function serverEnvelope(stream, seqId, message, cursor = null) {
  return {
    type: "server_message",
    client_id: CLIENT_ID,
    env_id: ENV_ID,
    stream_id: stream.streamId,
    seq_id: seqId,
    cursor,
    message,
  };
}

test("v3 headers and device proof precede the logical open event", async (t) => {
  const fx = fixture();
  t.after(() => fx.connection.terminate());
  const stream = fx.connection.createStream();
  let opened = false;
  stream.on("open", () => { opened = true; });
  await eventually(() => fx.sockets.length === 1);
  const socket = fx.sockets[0];
  assert.equal(fx.factoryCalls[0].url, WS_URL);
  assert.equal(fx.factoryCalls[0].options.perMessageDeflate, false);
  assert.equal(fx.factoryCalls[0].options.maxPayload, remoteControlTransportInternals.maxWireEnvelopeBytes);
  assert.equal(fx.factoryCalls[0].options.headers["x-codex-client-id"], CLIENT_ID);
  assert.equal(fx.factoryCalls[0].options.headers["x-codex-protocol-version"], "3");
  assert.equal("X-Codex-Protocol-Version" in fx.factoryCalls[0].options.headers, false);

  socket.open();
  await Promise.resolve();
  assert.equal(opened, false);
  socket.receive(challenge(fx.tokenExpiresAt));
  await eventually(() => opened);
  assert.equal(fx.proofs.length, 1);
  assert.equal(sentJson(socket)[0].type, "device_key_proof");

  initialize(stream);
  const envelope = sentJson(socket)[1];
  assert.equal(envelope.type, "client_message");
  assert.equal(envelope.seq_id, 1);
  assert.equal(envelope.skip_history, false);
  assert.equal(envelope.env_id, ENV_ID);
  assert.equal(envelope.client_id, CLIENT_ID);
  assert.equal(envelope.stream_id, stream.streamId);
});

test("oversized websocket payloads fail terminally before and after device authorization", async (t) => {
  for (const authorized of [false, true]) {
    await t.test(authorized ? "authorized" : "pre-authorization", async () => {
      const fx = fixture({ reconnectDelayMs: 1 });
      const stream = fx.connection.createStream();
      const errors = [];
      stream.on("error", (error) => errors.push(error));
      const closed = new Promise((resolve) => stream.once("close", resolve));
      await eventually(() => fx.sockets.length === 1);
      const socket = fx.sockets[0];
      if (authorized) await openStream(fx, stream, socket);
      else socket.open();
      socket.receive(Buffer.alloc(remoteControlTransportInternals.maxWireEnvelopeBytes + 1, 0x78));
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, "REMOTE_CONTROL_FATAL");
      assert.equal(fx.sockets.length, 1, "a protocol-size failure must not reconnect");
      assert.equal(fx.proofs.length, authorized ? 1 : 0);
      assert.throws(() => fx.connection.createStream(), /terminated/i);
    });
  }
});

test("ws maxPayload errors are terminal instead of entering a reconnect loop", async () => {
  const fx = fixture({ reconnectDelayMs: 1 });
  const stream = fx.connection.createStream();
  const errors = [];
  stream.on("error", (error) => errors.push(error));
  const closed = new Promise((resolve) => stream.once("close", resolve));
  await eventually(() => fx.sockets.length === 1);
  const socket = fx.sockets[0];
  socket.open();
  socket.emit("error", Object.assign(new Error("payload too large"), {
    code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
  }));
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "REMOTE_CONTROL_FATAL");
  assert.equal(fx.sockets.length, 1);
});

test("one connection multiplexes streams and correlates raw server errors", async (t) => {
  const fx = fixture();
  t.after(() => fx.connection.terminate());
  const first = fx.connection.createStream();
  const second = fx.connection.createStream();
  await openStream(fx, first);
  await eventually(() => second.readyState === 1);
  assert.equal(fx.sockets.length, 1);
  initialize(first, "init-a");
  initialize(second, "init-b");
  first.send(JSON.stringify({ id: 7, method: "thread/read", params: {} }));
  const received = once(first, "message");
  fx.sockets[0].receive(serverEnvelope(first, 1, { type: "error", code: "failed" }, "cursor-1"));
  const [raw] = await received;
  assert.deepEqual(JSON.parse(raw), { id: "init-a", error: { code: "failed" } });
  assert.notEqual(first.streamId, second.streamId);
});

test("acks bound replay and reconnect carries the last delivered cursor", async (t) => {
  const fx = fixture();
  t.after(() => fx.connection.terminate());
  const stream = fx.connection.createStream();
  const firstSocket = await openStream(fx, stream);
  initialize(stream, "init");
  stream.send(JSON.stringify({ id: "read", method: "thread/read", params: {} }));
  firstSocket.receive({
    type: "ack",
    client_id: CLIENT_ID,
    env_id: ENV_ID,
    stream_id: stream.streamId,
    seq_id: 1,
  });
  firstSocket.receive(serverEnvelope(stream, 1, { id: "init", result: {} }, "cursor-a"));
  firstSocket.close(1_006, "network loss");
  await eventually(() => fx.sockets.length === 2, "transport did not reconnect");
  const secondSocket = fx.sockets[1];
  assert.equal(fx.factoryCalls[1].options.headers["x-codex-subscribe-cursor"], "cursor-a");
  secondSocket.open();
  secondSocket.receive(challenge(fx.tokenExpiresAt));
  await eventually(() => sentJson(secondSocket).length >= 2);
  const replay = sentJson(secondSocket).filter((entry) => entry.type === "client_message");
  assert.equal(replay.length, 1);
  assert.equal(replay[0].seq_id, 2);
  assert.equal(replay[0].message.id, "read");
  assert.ok(sentJson(secondSocket).some((entry) => entry.type === "ping"
    && entry.stream_id === stream.streamId));
  assert.equal(stream.readyState, 1);
});

test("relay failures back off exponentially, cap, and cannot be bypassed by active sends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fx = fixture({ reconnectDelayMs: 1_000, reconnectMaxDelayMs: 4_000 });
  try {
    const stream = fx.connection.createStream();
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 1);
    const initialSocket = fx.sockets[0];
    const opened = once(stream, "open");
    initialSocket.open();
    initialSocket.receive(challenge(fx.tokenExpiresAt));
    await opened;
    initialize(stream);

    initialSocket.close(1_006, "relay unavailable");
    stream.send(JSON.stringify({ id: "queued-1", method: "thread/read", params: {} }));
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 1, "active sends must not bypass reconnect backoff");

    t.mock.timers.tick(999);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 1);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 2);

    // A TCP/WebSocket open without successful device proof is not enough to
    // reset the backoff.
    fx.sockets[1].open();
    fx.sockets[1].close(1_006, "relay unavailable before challenge");
    stream.send(JSON.stringify({ id: "queued-2", method: "thread/read", params: {} }));
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 2);
    t.mock.timers.tick(1_999);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 2);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 3);

    fx.sockets[2].emit("error", new Error("relay unavailable"));
    t.mock.timers.tick(3_999);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 3);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 4);

    fx.sockets[3].emit("error", new Error("relay still unavailable"));
    t.mock.timers.tick(4_000);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 5, "reconnect delay should remain capped");
  } finally {
    fx.connection.terminate();
    t.mock.timers.reset();
  }
});

test("successful device proof resets reconnect backoff to the quick first retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fx = fixture({ reconnectDelayMs: 1_000, reconnectMaxDelayMs: 30_000 });
  try {
    const stream = fx.connection.createStream();
    await flushMicrotasks();
    fx.sockets[0].emit("error", new Error("first outage"));

    t.mock.timers.tick(1_000);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 2);
    fx.sockets[1].emit("error", new Error("second outage"));

    t.mock.timers.tick(2_000);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 3);
    const authorizedSocket = fx.sockets[2];
    const opened = once(stream, "open");
    authorizedSocket.open();
    authorizedSocket.receive(challenge(fx.tokenExpiresAt));
    await opened;

    authorizedSocket.close(1_006, "new outage after authorization");
    t.mock.timers.tick(999);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 3);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 4, "authorization should restore the first retry delay");
  } finally {
    fx.connection.terminate();
    t.mock.timers.reset();
  }
});

test("becoming idle cancels and resets a pending reconnect backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fx = fixture({ reconnectDelayMs: 1_000, reconnectMaxDelayMs: 30_000 });
  try {
    const firstStream = fx.connection.createStream();
    await flushMicrotasks();
    fx.sockets[0].emit("error", new Error("first outage"));
    t.mock.timers.tick(1_000);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 2);
    fx.sockets[1].emit("error", new Error("second outage"));

    firstStream.terminate();
    await flushMicrotasks();
    t.mock.timers.tick(2_000);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 2, "idle should cancel the pending retry");

    const secondStream = fx.connection.createStream();
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 3, "new demand should connect immediately after idle");
    fx.sockets[2].emit("error", new Error("outage after idle"));
    t.mock.timers.tick(999);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 3);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(fx.sockets.length, 4, "idle should restore the first retry delay");
    secondStream.terminate();
  } finally {
    fx.connection.terminate();
    t.mock.timers.reset();
  }
});

test("large client messages segment below the v3 cap and require every segment ack", async (t) => {
  const fx = fixture();
  t.after(() => fx.connection.terminate());
  const stream = fx.connection.createStream();
  const firstSocket = await openStream(fx, stream);
  initialize(stream);
  firstSocket.receive({
    type: "ack", client_id: CLIENT_ID, env_id: ENV_ID, stream_id: stream.streamId, seq_id: 1,
  });
  const large = { id: "large", method: "thread/read", params: { value: "x".repeat(240 * 1024) } };
  stream.send(JSON.stringify(large));
  const chunks = sentJson(firstSocket).filter((entry) => entry.type === "client_message_chunk");
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.map((entry) => entry.segment_id), chunks.map((_entry, index) => index));
  assert.ok(chunks.every((entry) => Buffer.byteLength(JSON.stringify(entry))
    <= remoteControlTransportInternals.maxWireEnvelopeBytes));
  const restored = Buffer.concat(chunks.map((entry) => Buffer.from(entry.message_chunk_base64, "base64")));
  assert.deepEqual(JSON.parse(restored), large);
  for (const chunk of chunks.slice(0, -1)) {
    firstSocket.receive({
      type: "ack",
      client_id: CLIENT_ID,
      env_id: ENV_ID,
      stream_id: stream.streamId,
      seq_id: 2,
      segment_id: chunk.segment_id,
      segment_count: chunks.length,
    });
  }
  firstSocket.close(1_006, "network loss");
  await eventually(() => fx.sockets.length === 2);
  const secondSocket = fx.sockets[1];
  secondSocket.open();
  secondSocket.receive(challenge(fx.tokenExpiresAt));
  await eventually(() => sentJson(secondSocket).some((entry) => entry.type === "client_message_chunk"));
  assert.equal(
    sentJson(secondSocket).filter((entry) => entry.type === "client_message_chunk").length,
    chunks.length,
  );
});

test("server segments reassemble once and sequence gaps fail the logical stream closed", async (t) => {
  const fx = fixture();
  t.after(() => fx.connection.terminate());
  const stream = fx.connection.createStream();
  const socket = await openStream(fx, stream);
  initialize(stream, "init");
  const payload = Buffer.from(JSON.stringify({ id: "init", result: { text: "done" } }));
  const midpoint = Math.ceil(payload.length / 2);
  const chunks = [payload.subarray(0, midpoint), payload.subarray(midpoint)];
  let messageCount = 0;
  stream.on("message", () => { messageCount += 1; });
  for (let index = 0; index < chunks.length; index += 1) {
    socket.receive({
      type: "server_message_chunk",
      client_id: CLIENT_ID,
      env_id: ENV_ID,
      stream_id: stream.streamId,
      seq_id: 1,
      cursor: "cursor-segmented",
      segment_id: index,
      segment_count: chunks.length,
      message_size_bytes: payload.length,
      message_chunk_base64: chunks[index].toString("base64"),
    });
    if (index === 0) assert.equal(messageCount, 0);
  }
  assert.equal(messageCount, 1);

  const errors = [];
  stream.on("error", (error) => errors.push(error));
  const closed = new Promise((resolve) => stream.once("close", (...args) => resolve(args)));
  socket.receive(serverEnvelope(stream, 3, { method: "turn/started", params: {} }));
  const [code] = await closed;
  assert.equal(code, remoteControlTransportInternals.streamProtocolErrorCode);
  assert.equal(stream.readyState, RemoteControlStream.CLOSED);
  assert.equal(errors[0].code, "REMOTE_CONTROL_PROTOCOL_GAP");
});

test("native and logical pings keep one multiplexed connection alive", async (t) => {
  const fx = fixture({
    timing: {
      websocketPingIntervalMs: 4,
      websocketPongTimeoutMs: 100,
      streamPingIntervalMs: 4,
      streamPongTimeoutMs: 100,
    },
  });
  t.after(() => fx.connection.terminate());
  const stream = fx.connection.createStream();
  const socket = await openStream(fx, stream);
  initialize(stream);
  await eventually(() => socket.pingCount > 0, "native websocket ping was not sent");
  await eventually(
    () => sentJson(socket).some((entry) => entry.type === "ping"),
    "logical stream ping was not sent",
  );
  const ping = sentJson(socket).find((entry) => entry.type === "ping");
  assert.equal(ping.state, "foreground");
  assert.equal(ping.skip_history, true);
  assert.equal(ping.stream_id, stream.streamId);

  socket.emit("pong");
  socket.receive({
    type: "pong",
    client_id: CLIENT_ID,
    env_id: ENV_ID,
    stream_id: stream.streamId,
    seq_id: 1,
    cursor: "cursor-pong",
    status: "active",
    skip_history: true,
  });
  assert.equal(stream.readyState, RemoteControlStream.OPEN);
});

test("a segment gap closes only the affected logical stream", async (t) => {
  const fx = fixture();
  t.after(() => fx.connection.terminate());
  const broken = fx.connection.createStream();
  const healthy = fx.connection.createStream();
  const socket = await openStream(fx, broken);
  await eventually(() => healthy.readyState === RemoteControlStream.OPEN);
  initialize(broken, "broken-init");
  initialize(healthy, "healthy-init");
  broken.on("error", () => {});
  const closed = new Promise((resolve) => broken.once("close", (...args) => resolve(args)));
  socket.receive({
    type: "server_message_chunk",
    client_id: CLIENT_ID,
    env_id: ENV_ID,
    stream_id: broken.streamId,
    seq_id: 1,
    segment_id: 1,
    segment_count: 2,
    message_size_bytes: 2,
    message_chunk_base64: "e30=",
  });
  const [code] = await closed;
  assert.equal(code, remoteControlTransportInternals.streamProtocolErrorCode);
  assert.equal(broken.readyState, RemoteControlStream.CLOSED);
  assert.equal(healthy.readyState, RemoteControlStream.OPEN);
  assert.equal(fx.sockets.length, 1);
  healthy.send(JSON.stringify({ id: "read", method: "thread/read", params: {} }));
  assert.ok(sentJson(socket).some((entry) => entry.message?.id === "read"));
});

test("invalid challenge metadata fails closed before open", async () => {
  const fx = fixture();
  const stream = fx.connection.createStream();
  const errors = [];
  stream.on("error", (error) => errors.push(error));
  const closed = new Promise((resolve) => stream.once("close", (...args) => resolve(args)));
  await eventually(() => fx.sockets.length === 1);
  fx.sockets[0].open();
  fx.sockets[0].receive(challenge(fx.tokenExpiresAt, { targetPath: "/wrong" }));
  const [code] = await closed;
  assert.equal(code, remoteControlTransportInternals.streamProtocolErrorCode);
  assert.equal(stream.readyState, RemoteControlStream.CLOSED);
  assert.match(errors[0].message, /target/i);
  assert.equal(fx.proofs.length, 0);
});
