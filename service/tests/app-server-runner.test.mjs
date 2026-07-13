import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerCodexRunner, AppServerRpcClient } from "../src/app-server-runner.mjs";

function fakeProxy(directory, mode = "complete") {
  const executable = path.join(directory, `fake-proxy-${mode}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const capture = process.env.IMESSAGE_TEST_CAPTURE;
let buffer = "";
let turnId = "turn-1";
function record(value) { appendFileSync(capture, JSON.stringify(value) + "\\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function finish(status = "completed") {
  send({ method: "turn/completed", params: { threadId: "thread-1", turn: {
    id: turnId, status, items: [], error: null
  } } });
}
function handle(message) {
  record(message);
  if (message.method === "initialize") {
    if (mode !== "timeout") send({ id: message.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/resume") {
    const resume = () => send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    if (mode === "slow-resume") setTimeout(resume, 80);
    else resume();
    return;
  }
  if (message.method === "turn/start") {
    if (mode === "overloaded") {
      send({ id: message.id, error: { code: -32001, message: "Server overloaded; retry later" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } } });
    if (mode === "cancel" || mode === "ignore-interrupt") return;
    if (mode === "approval") {
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId, itemId: "command-1" } });
      return;
    }
    send({ method: "item/completed", params: { threadId: "another-thread", turnId: "another-turn", item: { id: "foreign", type: "agentMessage", text: "Do not collect this.", phase: "final_answer" } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId, itemId: "reasoning-1", delta: "Safe summary." } });
    send({ method: "item/started", params: { threadId: "thread-1", turnId, item: { id: "answer-1", type: "agentMessage", text: "", phase: "final_answer" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "answer-1", delta: "A clean answer.\\n" } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { id: "answer-1", type: "agentMessage", text: "A clean answer.\\n", phase: "final_answer" } } });
    send({ method: "item/started", params: { threadId: "thread-1", turnId, item: { id: "image-1", type: "imageGeneration" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { id: "image-1", type: "imageGeneration", savedPath: process.env.IMESSAGE_TEST_IMAGE, result: "" } } });
    finish();
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (mode !== "ignore-interrupt") finish("interrupted");
    return;
  }
  if (message.id === "approval-1") {
    send({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { id: "answer-1", type: "agentMessage", text: "Approval safely declined.", phase: "final_answer" } } });
    finish();
  }
}
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
`, "utf8");
  chmodSync(executable, 0o700);
  return executable;
}

function testRunner(directory, mode = "complete", options = {}) {
  const capture = path.join(directory, `${mode}.jsonl`);
  const image = path.join(directory, "generated.png");
  writeFileSync(capture, "");
  writeFileSync(image, "png");
  const executable = fakeProxy(directory, mode);
  const invocations = [];
  const spawnImpl = (command, args, spawnOptions) => {
    invocations.push({ command, args, codexHome: spawnOptions.env.CODEX_HOME });
    return spawn(command, args, {
      ...spawnOptions,
      env: {
        ...spawnOptions.env,
        IMESSAGE_TEST_CAPTURE: capture,
        IMESSAGE_TEST_IMAGE: image,
      },
    });
  };
  const client = new AppServerRpcClient({
    codexPath: executable,
    codexHome: path.join(directory, "codex-home"),
    spawnImpl,
    requestTimeoutMs: options.requestTimeoutMs || 2_000,
    turnTimeoutMs: options.turnTimeoutMs || 2_000,
    interruptGraceMs: options.interruptGraceMs || 200,
  });
  const runner = new AppServerCodexRunner({ client });
  return { runner, client, capture, image, invocations, executable, spawnImpl };
}

function messages(capture) {
  return readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the fake proxy.");
}

test("shared app-server runner preserves input and streams safe output", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-runner-"));
  const { runner, capture, image, invocations } = testRunner(directory);
  t.after(() => runner.client.close());
  const phases = [];
  const reasoning = [];
  const deltas = [];
  const completed = [];
  const images = [];
  const prompt = "First line\n\nDo not wrap or trim this message.\n";
  const localInput = path.join(directory, "input photo.png");
  writeFileSync(localInput, "png");
  const result = await runner.run({
    thread: { id: "thread-1", cwd: directory },
    prompt,
    images: [localInput],
    reasoningEffort: "high",
    onPhase: (phase) => phases.push(phase),
    onReasoningDelta: (delta) => reasoning.push(delta),
    onAssistantDelta: (delta) => deltas.push(delta),
    onAssistantMessage: (body) => completed.push(body),
    onGeneratedImage: (file) => images.push(file),
  });

  const sent = messages(capture);
  const start = sent.find((message) => message.method === "turn/start");
  assert.equal(start.params.input[0].text, prompt);
  assert.deepEqual(start.params.input[1], { type: "localImage", path: localInput });
  assert.equal(start.params.effort, "high");
  assert.deepEqual(invocations, [{
    command: invocations[0].command,
    args: ["app-server", "proxy", "--sock", path.join(directory, "codex-home", "app-server-control", "app-server-control.sock")],
    codexHome: path.join(directory, "codex-home"),
  }]);
  assert.equal(sent.some((message) => message.method === "initialized"), true);
  assert.deepEqual(phases, ["Starting work.", "Creating an image.", "Finishing the response."]);
  assert.deepEqual(reasoning, ["Safe summary."]);
  assert.deepEqual(deltas, ["A clean answer.\n"]);
  assert.deepEqual(completed, ["A clean answer.\n"]);
  assert.deepEqual(images, [image]);
  assert.deepEqual(result, { status: "completed", body: "A clean answer.\n", generatedImages: [image] });
  assert.equal(runner.isRunning(), false);
});

test("server overload is deferred as busy instead of failing the message", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-overloaded-"));
  const { runner } = testRunner(directory, "overloaded");
  t.after(() => runner.client.close());
  await assert.rejects(runner.run({
    thread: { id: "thread-1", cwd: directory },
    prompt: "Wait for capacity.",
  }), (error) => error?.code === "BUSY");
});

test("runner safely declines app-server approval requests", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-approval-"));
  const { runner, capture } = testRunner(directory, "approval");
  t.after(() => runner.client.close());
  const result = await runner.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Proceed." });
  const approval = messages(capture).find((message) => message.id === "approval-1" && !message.method);
  assert.deepEqual(approval, { id: "approval-1", result: { decision: "decline" } });
  assert.equal(result.body, "Approval safely declined.");
});

test("runner interrupts the shared turn without terminating the proxy", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-cancel-"));
  const { runner, capture } = testRunner(directory, "cancel");
  t.after(() => runner.client.close());
  const run = runner.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Keep working." });
  await waitFor(() => messages(capture).some((message) => message.method === "turn/start"));
  assert.equal(runner.cancel("different-thread"), false);
  assert.equal(runner.cancel("thread-1"), true);
  assert.deepEqual(await run, { status: "cancelled", body: "" });
  const interrupt = messages(capture).find((message) => message.method === "turn/interrupt");
  assert.equal(interrupt.params.threadId, "thread-1");
  assert.equal(interrupt.params.turnId, "turn-1");
  assert.equal(runner.client.child.exitCode, null);
});

test("runner interrupts a recovered turn by its persisted canonical turn id", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-recovered-cancel-"));
  const { runner, capture } = testRunner(directory, "cancel");
  t.after(() => runner.client.close());

  assert.equal(await runner.cancelRecoveredTurn("thread-1", "turn-recovered-42"), true);
  const interrupt = messages(capture).find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-recovered-42" });
});

test("runner-owned proxy connections close after a completed turn", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-owned-"));
  const fixture = testRunner(directory);
  const owned = new AppServerCodexRunner({
    codexPath: fixture.executable,
    codexHome: path.join(directory, "codex-home"),
    spawnImpl: fixture.spawnImpl,
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
  });
  const result = await owned.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Hello" });
  assert.equal(result.status, "completed");
  assert.equal(owned.client.child, null);
  fixture.client.close();
});

test("runner bounds initialization waits and reports managed daemon unavailability", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-timeout-"));
  const { runner } = testRunner(directory, "timeout", { requestTimeoutMs: 40 });
  t.after(() => runner.client.close());
  await assert.rejects(
    runner.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Hello" }),
    (error) => error.code === "CODEX_UNAVAILABLE",
  );
  assert.equal(runner.isRunning(), false);
});

test("turn timeout interrupts backend work and rejects after bounded grace", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-turn-timeout-"));
  const { runner, capture } = testRunner(directory, "ignore-interrupt", {
    turnTimeoutMs: 120,
    interruptGraceMs: 40,
  });
  t.after(() => runner.client.close());
  const startedAt = Date.now();
  await assert.rejects(
    runner.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Do not run forever." }),
    (error) => error.code === "CODEX_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 500);
  // The interrupt is already bounded by the runner's 40 ms grace; allow the
  // parallel full suite extra time to flush the child-process capture file.
  await waitFor(() => messages(capture).some((message) => message.method === "turn/interrupt"), 5_000);
  const interrupt = messages(capture).find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
  assert.equal(runner.isRunning(), false);
});

test("a timeout during resume never starts a ghost turn", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-ghost-turn-"));
  const { runner, capture } = testRunner(directory, "slow-resume", {
    requestTimeoutMs: 500,
    turnTimeoutMs: 20,
    interruptGraceMs: 200,
  });
  t.after(() => runner.client.close());
  await assert.rejects(
    runner.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Never start late." }),
    (error) => error.code === "CODEX_TIMEOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(messages(capture).some((message) => message.method === "turn/start"), false);
});

test("initialize rejects an app-server using a different Codex home", async () => {
  class WrongHomeSocket extends EventEmitter {
    readyState = 0;
    send(value) {
      const message = JSON.parse(value);
      if (message.method === "initialize") queueMicrotask(() => this.emit("message", JSON.stringify({
        id: message.id,
        result: { codexHome: "/tmp/not-the-expected-home" },
      })));
    }
    terminate() { this.readyState = 3; }
  }
  const client = new AppServerRpcClient({
    codexHome: "/tmp/expected-codex-home",
    webSocketFactory: () => {
      const socket = new WrongHomeSocket();
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
  });
  await assert.rejects(client.connect(), (error) => error.code === "CODEX_WRONG_HOME");
  assert.equal(client.ready, false);
});

test("late events from an old socket cannot disconnect its replacement", async () => {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    readyState = 0;
    send(value) {
      const message = JSON.parse(value);
      if (message.method === "initialize") queueMicrotask(() => this.emit("message", JSON.stringify({
        id: message.id,
        result: { codexHome: "/tmp/stable-codex-home" },
      })));
      else if (Object.hasOwn(message, "id")) queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result: {} })));
    }
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
  }
  const client = new AppServerRpcClient({
    codexHome: "/tmp/stable-codex-home",
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
  });
  await client.connect();
  sockets[0].readyState = 3;
  sockets[0].emit("close");
  await client.connect();
  sockets[0].emit("error", new Error("late old-socket error"));
  sockets[0].emit("close");
  assert.equal(client.ready, true);
  await client.request("thread/resume", { threadId: "thread-1" });
  assert.equal(sockets.length, 2);
  client.close();
});

test("production transport uses websocket-over-Unix instead of raw proxy stdio", async () => {
  const sent = [];
  let connectionFactory = null;
  class FakeSocket extends EventEmitter {
    readyState = 0;
    send(value) {
      const message = JSON.parse(value);
      sent.push(message);
      if (message.method === "initialize") queueMicrotask(() => this.emit("message", JSON.stringify({
        id: message.id,
        result: { userAgent: "fake", codexHome: "/tmp/.codex", platformFamily: "unix", platformOs: "macos" },
      })));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close"));
    }
  }
  const client = new AppServerRpcClient({
    codexHome: "/tmp/.codex",
    socketPath: "/tmp/.codex/app-server-control/app-server-control.sock",
    webSocketFactory: (url, options) => {
      assert.equal(url, "ws://localhost/rpc");
      assert.equal(options.perMessageDeflate, false);
      connectionFactory = options.createConnection;
      const socket = new FakeSocket();
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
  });
  await client.connect();
  assert.equal(typeof connectionFactory, "function");
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[1].method, "initialized");
  client.close();
});
