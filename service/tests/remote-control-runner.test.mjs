import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AppServerCodexRunner, AppServerRpcClient } from "../src/app-server-runner.mjs";
import { RemoteControlCodexRuntime } from "../src/remote-control-runner.mjs";

function fixture() {
  const calls = {
    controller: [],
    connection: [],
    client: [],
    runner: [],
    refresh: [],
    authorize: [],
    logicalStreams: 0,
    clients: [],
    close: [],
    terminate: 0,
  };
  const logicalStream = { kind: "logical-remote-control-stream" };
  const controller = {
    websocketUrl: "wss://chatgpt.com/backend-api/codex/remote/control/client",
    async refreshSession(options) {
      calls.refresh.push(options);
      return { clientId: "client", envId: "env" };
    },
    async authorizeDeviceChallenge(challenge, session) {
      calls.authorize.push({ challenge, session });
      return { type: "device_key_proof" };
    },
  };
  const connection = {
    createStream() {
      calls.logicalStreams += 1;
      return logicalStream;
    },
    terminate() {
      calls.terminate += 1;
    },
  };
  const runtime = new RemoteControlCodexRuntime({
    codexHome: "/Users/test/.codex",
    controllerOptions: { appVersion: "test" },
    rpcClientOptions: { requestTimeoutMs: 123 },
    webSocketFactory: () => ({ physical: true }),
    controllerFactory(options) {
      calls.controller.push(options);
      return controller;
    },
    connectionFactory(options) {
      calls.connection.push(options);
      return connection;
    },
    rpcClientFactory(options) {
      calls.client.push(options);
      const ordinal = calls.clients.length + 1;
      const client = {
        ordinal,
        close() { calls.close.push(ordinal); },
        isRunning() { return false; },
      };
      calls.clients.push(client);
      return client;
    },
    runnerFactory(options) {
      const runner = { ...options, ordinal: calls.runner.length + 1 };
      calls.runner.push(options);
      return runner;
    },
  });
  return { runtime, calls, controller, connection, logicalStream };
}

test("runtime shares one controller and connection but owns one RPC client per runner", async () => {
  const fx = fixture();
  assert.equal(fx.calls.controller.length, 0);
  assert.equal(fx.calls.connection.length, 0);
  assert.equal(fx.calls.client.length, 0);

  const first = fx.runtime.createRunner();
  const second = fx.runtime.createRunner();
  assert.notEqual(first, second);
  assert.notEqual(first.client, second.client);
  assert.equal(first.client, fx.calls.clients[0]);
  assert.equal(second.client, fx.calls.clients[1]);
  assert.equal(fx.calls.controller.length, 1);
  assert.equal(fx.calls.connection.length, 1);
  assert.equal(fx.calls.client.length, 2);
  assert.equal(fx.calls.runner.length, 2);
  assert.equal(fx.calls.runner[0].ownsClient, true);
  assert.equal(fx.calls.runner[1].ownsClient, true);
  assert.equal(typeof fx.calls.runner[0].onClientClose, "function");
  assert.deepEqual(fx.calls.controller[0], {
    appVersion: "test",
    codexHome: "/Users/test/.codex",
  });

  const connectionOptions = fx.calls.connection[0];
  assert.equal(connectionOptions.websocketUrl, fx.controller.websocketUrl);
  const session = await connectionOptions.getSession();
  assert.deepEqual(session, { clientId: "client", envId: "env" });
  assert.deepEqual(fx.calls.refresh, [{ force: true }]);
  const challenge = { nonce: "nonce" };
  const sessionMetadata = { tokenExpiresAt: 123 };
  assert.deepEqual(
    await connectionOptions.authorizeDeviceChallenge(challenge, sessionMetadata),
    { type: "device_key_proof" },
  );
  assert.deepEqual(fx.calls.authorize, [{ challenge, session: sessionMetadata }]);

  for (const clientOptions of fx.calls.client) {
    assert.equal(clientOptions.codexHome, "/Users/test/.codex");
    assert.equal(clientOptions.requestTimeoutMs, 123);
    assert.equal("spawnImpl" in clientOptions, false);
    assert.equal("socketPath" in clientOptions, false);
    assert.equal("codexPath" in clientOptions, false);
    assert.equal(clientOptions.webSocketFactory("ws://localhost/rpc", {
      createConnection() { throw new Error("must not attach locally"); },
    }), fx.logicalStream);
  }
  assert.equal(fx.calls.logicalStreams, 2);
});

test("default RPC composition can only obtain a logical Remote Control stream", () => {
  let connectionOptions = null;
  let terminated = 0;
  const logical = { readyState: 3 };
  const runtime = new RemoteControlCodexRuntime({
    codexHome: "/Users/test/.codex",
    controllerFactory: () => ({
      websocketUrl: "wss://chatgpt.com/backend-api/codex/remote/control/client",
      refreshSession: async () => ({}),
      authorizeDeviceChallenge: async () => ({}),
    }),
    connectionFactory: (options) => {
      connectionOptions = options;
      return {
        createStream: () => logical,
        terminate: () => { terminated += 1; },
      };
    },
  });
  const first = runtime.createRunner();
  const second = runtime.createRunner();
  assert.ok(first instanceof AppServerCodexRunner);
  assert.ok(first.client instanceof AppServerRpcClient);
  assert.ok(second.client instanceof AppServerRpcClient);
  assert.notEqual(first.client, second.client);
  assert.equal(first.ownsClient, true);
  assert.equal(second.ownsClient, true);
  assert.equal("spawnImpl" in first.client, false);
  assert.equal("child" in first.client, false);
  assert.equal(first.client.webSocketFactory("ws://localhost/rpc", {
    createConnection() { throw new Error("local socket path executed"); },
  }), logical);
  assert.equal(typeof connectionOptions.webSocketFactory, "function");
  runtime.close();
  assert.equal(terminated, 1);
});

test("close detaches every active client, terminates the relay, and is idempotent", () => {
  const fx = fixture();
  fx.runtime.createRunner();
  fx.runtime.createRunner();
  fx.runtime.close();
  fx.runtime.close();
  assert.deepEqual(fx.calls.close, [1, 2]);
  assert.equal(fx.calls.terminate, 1);
  assert.throws(() => fx.runtime.createRunner(), /closed/i);
});

test("a runner-owned client is removed from runtime shutdown tracking after it closes", () => {
  const fx = fixture();
  fx.runtime.createRunner();
  fx.runtime.createRunner();
  fx.calls.clients[0].close();
  fx.calls.runner[0].onClientClose(fx.calls.clients[0]);
  fx.runtime.close();
  assert.deepEqual(fx.calls.close, [1, 2]);
  assert.equal(fx.calls.terminate, 1);
});

test("runtime source has no local process or socket attachment implementation", () => {
  const source = readFileSync(new URL("../src/remote-control-runner.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\s*\(|execFile|\.kill\s*\(/);
  assert.doesNotMatch(source, /node:net|spawnImpl|socketPath|codexPath|createConnection\s*:/);
  assert.match(source, /connection\.createStream\(\)/);
});
