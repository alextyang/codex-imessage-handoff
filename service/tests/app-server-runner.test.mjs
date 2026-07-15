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
let acceptedClientUserMessageId = null;
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
  if (message.method === "thread/start") {
    if (mode === "invalid-thread-start") {
      send({ id: message.id, result: { thread: { id: "" }, cwd: message.params.cwd } });
      return;
    }
    send({ id: message.id, result: {
      thread: {
        id: "thread-created",
        cwd: message.params.cwd,
        createdAt: 1783987200,
        modelProvider: "openai"
      },
      cwd: message.params.cwd,
      model: "gpt-created",
      modelProvider: "openai",
      reasoningEffort: "high"
    } });
    return;
  }
  if (message.method === "thread/read") {
    const reconciledClientId = mode === "reconcile"
      ? "client-message-stable"
      : acceptedClientUserMessageId;
    send({ id: message.id, result: { thread: {
      id: message.params.threadId,
      turns: reconciledClientId ? [{
        id: "turn-recovered",
        status: "completed",
        items: [
          { type: "userMessage", id: "user-recovered", clientId: reconciledClientId, content: [] },
          { type: "agentMessage", id: "answer-recovered", text: "Recovered answer.", phase: "final_answer" },
        ],
      }] : [],
    } } });
    return;
  }
  if (message.method === "turn/start") {
    if (mode === "overloaded") {
      send({ id: message.id, error: { code: -32001, message: "Server overloaded; retry later" } });
      return;
    }
    if (mode === "lost-start-response") {
      acceptedClientUserMessageId = message.params.clientUserMessageId;
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

class ProcessRemoteStream extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.readyState = 0;
    this.buffer = "";
    child.stdout.on("data", (chunk) => {
      this.buffer += String(chunk);
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.emit("message", line);
      }
    });
    child.once("error", (error) => this.emit("error", error));
    child.once("close", () => {
      this.readyState = 3;
      this.emit("close");
    });
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(value) {
    if (this.readyState !== 1) throw new Error("Remote stream is closed.");
    this.child.stdin.write(`${value}\n`);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.child.stdin.end();
  }
}

function testRunner(directory, mode = "complete", options = {}) {
  const capture = path.join(directory, `${mode}.jsonl`);
  const image = path.join(directory, "generated.png");
  writeFileSync(capture, "");
  writeFileSync(image, "png");
  const executable = fakeProxy(directory, mode);
  const invocations = [];
  const webSocketFactory = () => {
    invocations.push({ command: executable, args: [], codexHome: path.join(directory, "codex-home") });
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: path.join(directory, "codex-home"),
        IMESSAGE_TEST_CAPTURE: capture,
        IMESSAGE_TEST_IMAGE: image,
      },
    });
    return new ProcessRemoteStream(child);
  };
  const client = new AppServerRpcClient({
    codexHome: path.join(directory, "codex-home"),
    webSocketFactory,
    requestTimeoutMs: options.requestTimeoutMs || 2_000,
    turnTimeoutMs: options.turnTimeoutMs || 2_000,
    interruptGraceMs: options.interruptGraceMs || 200,
  });
  const runner = new AppServerCodexRunner({ client });
  return { runner, client, capture, image, invocations, executable, webSocketFactory };
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

class InteractiveRemoteStream extends EventEmitter {
  constructor({ codexHome, serverRequest, completeOnResponse = true } = {}) {
    super();
    this.codexHome = codexHome;
    this.serverRequest = serverRequest;
    this.completeOnResponse = completeOnResponse;
    this.readyState = 0;
    this.sent = [];
    this.serverRequestResponse = null;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(value) {
    if (this.readyState !== 1) throw new Error("Remote stream is closed.");
    const message = JSON.parse(value);
    this.sent.push(message);
    if (message.method === "initialize") {
      this.#receive({ id: message.id, result: { codexHome: this.codexHome } });
      return;
    }
    if (message.method === "thread/resume") {
      this.#receive({ id: message.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (message.method === "turn/start") {
      this.#receive({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
      this.#receive({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
      if (this.serverRequest) this.#receive(this.serverRequest);
      return;
    }
    if (this.serverRequest && message.id === this.serverRequest.id && !message.method) {
      this.serverRequestResponse = message;
      if (this.completeOnResponse) this.complete("Interactive request completed.");
      return;
    }
  }

  complete(body = "Interactive request completed.") {
    this.#receive({ method: "item/completed", params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", text: body, phase: "final_answer" },
    } });
    this.#receive({ method: "turn/completed", params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    } });
  }

  notify(message) {
    this.#receive(message);
  }

  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }

  close() {
    if (this.readyState === 3) return;
    this.disconnect();
  }

  #receive(message) {
    queueMicrotask(() => {
      if (this.readyState === 1) this.emit("message", JSON.stringify(message));
    });
  }
}

function interactiveRunner(serverRequest, options = {}) {
  const codexHome = options.codexHome || "/tmp/interactive-remote-codex-home";
  let socket = null;
  const client = new AppServerRpcClient({
    codexHome,
    requestTimeoutMs: options.requestTimeoutMs || 1_000,
    turnTimeoutMs: options.turnTimeoutMs || 1_000,
    interruptGraceMs: options.interruptGraceMs || 50,
    serverRequestTimeoutMs: options.serverRequestTimeoutMs || 100,
    webSocketFactory: () => {
      socket = new InteractiveRemoteStream({
        codexHome,
        serverRequest,
        completeOnResponse: options.completeOnResponse !== false,
      });
      return socket;
    },
  });
  return {
    client,
    runner: new AppServerCodexRunner({ client }),
    socket: () => socket,
  };
}

function interactiveRequest(method, params = {}, id = "interactive-1") {
  return {
    id,
    method,
    params: { threadId: "thread-1", turnId: "turn-1", ...params },
  };
}

test("Remote Control creates a persistent thread with an idempotency source", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-create-"));
  const { runner, capture } = testRunner(directory);
  t.after(() => runner.client.close());

  const created = await runner.createThread({
    cwd: directory,
    threadSource: "imessage-handoff:new:flow-123",
  });

  assert.deepEqual(created, {
    id: "thread-created",
    cwd: directory,
    createdAt: 1783987200,
    modelProvider: "openai",
    model: "gpt-created",
    reasoningEffort: "high",
  });
  const start = messages(capture).find((message) => message.method === "thread/start");
  assert.deepEqual(start.params, {
    cwd: directory,
    ephemeral: false,
    threadSource: "imessage-handoff:new:flow-123",
  });
  assert.equal(messages(capture).some((message) => message.method === "turn/start"), false);
});

test("thread creation rejects an invalid app-server response and a missing cwd", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-create-invalid-"));
  const { runner, capture } = testRunner(directory, "invalid-thread-start");
  t.after(() => runner.client.close());

  await assert.rejects(
    runner.createThread({ cwd: directory, threadSource: "imessage-handoff:new:invalid" }),
    (error) => error?.code === "CODEX_PROTOCOL_ERROR",
  );
  await assert.rejects(
    runner.createThread({ cwd: path.join(directory, "missing"), threadSource: "imessage-handoff:new:missing" }),
    (error) => error?.code === "MISSING_CWD",
  );
  assert.equal(messages(capture).filter((message) => message.method === "thread/start").length, 1);
});

test("Remote Control runner preserves input and streams safe output", async (t) => {
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
    clientUserMessageId: "client-message-stable",
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
  assert.equal(start.params.clientUserMessageId, "client-message-stable");
  assert.equal(start.params.effort, "high");
  assert.deepEqual(invocations, [{ command: invocations[0].command, args: [], codexHome: path.join(directory, "codex-home") }]);
  assert.equal(sent.some((message) => message.method === "initialized"), true);
  assert.deepEqual(phases, ["Starting work.", "Creating an image.", "Finishing the response."]);
  assert.deepEqual(reasoning, ["Safe summary."]);
  assert.deepEqual(deltas, ["A clean answer.\n"]);
  assert.deepEqual(completed, ["A clean answer.\n"]);
  assert.deepEqual(images, [image]);
  assert.deepEqual(result, { status: "completed", body: "A clean answer.\n", generatedImages: [image] });
  assert.equal(runner.isRunning(), false);
});

test("canonical thread-name notifications are bounded and scoped to the active task", async (t) => {
  const fixture = interactiveRunner(null, { completeOnResponse: false });
  t.after(() => fixture.client.close());
  const updates = [];
  const run = fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Keep the canonical sidebar name synchronized.",
    onThreadNameUpdated: (threadName, context) => {
      updates.push({ threadName, context });
      throw new Error("presentation callback failures stay isolated");
    },
  });

  await waitFor(() => fixture.socket()?.sent.some((message) => message.method === "turn/start"));
  fixture.socket().notify({
    method: "thread/name/updated",
    params: { threadId: "foreign-thread", threadName: "Foreign task" },
  });
  fixture.socket().notify({
    method: "thread/name/updated",
    params: { threadId: "thread-1", threadName: null },
  });
  fixture.socket().notify({
    method: "thread/name/updated",
    params: { threadId: "thread-1", threadName: " \n\t\u0000 " },
  });
  fixture.socket().notify({
    method: "thread/name/updated",
    params: {
      threadId: "thread-1",
      threadName: `  Canonical\n sidebar\t title ${"🧭".repeat(200)}  `,
    },
  });

  await waitFor(() => updates.length === 1);
  assert.deepEqual(updates[0].context, { threadId: "thread-1" });
  assert.match(updates[0].threadName, /^Canonical sidebar title /u);
  assert.equal([...updates[0].threadName].length, 160);
  assert.equal(updates[0].threadName, updates[0].threadName.toWellFormed());
  assert.doesNotMatch(updates[0].threadName, /[\u0000-\u001f\u007f]/u);

  fixture.socket().complete("Named task completed.");
  assert.deepEqual(await run, {
    status: "completed",
    body: "Named task completed.",
    generatedImages: [],
  });
});

test("Remote Control reconciles a turn by the echoed client user-message id", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-reconcile-"));
  const { runner, capture } = testRunner(directory, "reconcile");
  t.after(() => runner.client.close());

  assert.deepEqual(
    await runner.findTurnByClientUserMessageId("thread-1", "client-message-stable"),
    {
      id: "turn-recovered",
      state: "completed",
      finalResponse: "Recovered answer.",
      status: "completed",
    },
  );
  const read = messages(capture).find((message) => message.method === "thread/read");
  assert.deepEqual(read.params, { threadId: "thread-1", includeTurns: true });
});

test("an ambiguous turn/start is reconciled by its stable id without a second start", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-ambiguous-start-"));
  const { runner, capture } = testRunner(directory, "lost-start-response", {
    // Child-process startup can be delayed substantially on a busy Desktop
    // Mac. Keep the ambiguity deterministic by allowing initialization to
    // finish before timing out the deliberately unanswered turn/start.
    requestTimeoutMs: 3_000,
    turnTimeoutMs: 5_000,
  });
  t.after(() => runner.client.close());
  const request = {
    thread: { id: "thread-1", cwd: directory },
    prompt: "Run this exactly once.",
    clientUserMessageId: "client-message-stable",
  };

  await assert.rejects(runner.run(request), (error) => {
    assert.equal(error.code, "CODEX_TIMEOUT");
    assert.equal(error.turnOutcomeUnknown, true);
    assert.equal(error.clientUserMessageId, "client-message-stable");
    return true;
  });
  const recovered = await runner.findTurnByClientUserMessageId("thread-1", "client-message-stable");
  assert.equal(recovered.id, "turn-recovered");
  assert.equal(recovered.finalResponse, "Recovered answer.");

  const starts = messages(capture).filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.clientUserMessageId, "client-message-stable");
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

test("a truncated command approval stays denied even when its handler accepts", async (t) => {
  const request = interactiveRequest("item/commandExecution/requestApproval", {
    itemId: "command-1",
    approvalId: "approval-callback-1",
    startedAtMs: 1783987200123,
    environmentId: "local",
    reason: "Network access is required.",
    command: `curl https://example.com/${"x".repeat(100_000)}`,
    cwd: "/tmp/project",
    commandActions: [{ type: "unknown", command: "curl" }],
    networkApprovalContext: { host: "example.com", protocol: "https" },
    proposedExecpolicyAmendment: ["curl", "https://example.com"],
    unexpectedSecret: "must not cross the protocol boundary",
  });
  const fixture = interactiveRunner(request);
  t.after(() => fixture.client.close());
  let received = null;
  let handlerContext = null;
  const result = await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Approve safely.",
    onServerRequest: async (descriptor, context) => {
      received = descriptor;
      handlerContext = context;
      return { decision: "accept" };
    },
  });

  assert.equal(result.body, "Interactive request completed.");
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "interactive-1",
    result: { decision: "decline" },
  });
  assert.equal(received.kind, "approval");
  assert.equal(received.approval, "command");
  assert.equal(received.protocol, "v2");
  assert.equal(received.threadId, "thread-1");
  assert.equal(received.turnId, "turn-1");
  assert.equal(received.itemId, "command-1");
  assert.equal(received.approvalId, "approval-callback-1");
  assert.equal(received.truncated, true);
  assert.ok(Buffer.byteLength(received.command, "utf8") <= 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(received), "utf8") <= 64 * 1024);
  assert.equal(Object.hasOwn(received, "unexpectedSecret"), false);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received.commandActions), true);
  assert.equal(handlerContext.signal.aborted, false);
  assert.equal(handlerContext.timeoutMs, 100);
});

test("undisclosed command approvals stay denied even when their handler accepts", async (t) => {
  const cases = [
    {
      name: "missing command",
      params: {
        itemId: "missing-command",
        reason: "Run an undisclosed action.",
        cwd: "/tmp/project",
      },
      decision: "accept",
    },
    {
      name: "unusable command actions",
      params: {
        itemId: "unusable-command-actions",
        reason: "Run an undisclosed action.",
        cwd: "/tmp/project",
        command: "   ",
        commandActions: [{ type: "unknown" }],
      },
      decision: "acceptForSession",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fixture = interactiveRunner(interactiveRequest(
        "item/commandExecution/requestApproval",
        entry.params,
      ));
      subtest.after(() => fixture.client.close());
      let received = null;
      await fixture.runner.run({
        thread: { id: "thread-1", cwd: "/tmp" },
        prompt: "Reject the undisclosed command.",
        onServerRequest: async (descriptor) => {
          received = descriptor;
          return { decision: entry.decision };
        },
      });

      assert.equal(received.approval, "command");
      assert.deepEqual(fixture.socket().serverRequestResponse, {
        id: "interactive-1",
        result: { decision: "decline" },
      });
    });
  }
});

test("usable commandActions can supply the command disclosure", async (t) => {
  const fixture = interactiveRunner(interactiveRequest(
    "item/commandExecution/requestApproval",
    {
      itemId: "command-actions-only",
      reason: "Inspect the working tree.",
      cwd: "/tmp/project",
      commandActions: [{ type: "unknown", command: "git status --short" }],
    },
  ));
  t.after(() => fixture.client.close());
  let received = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Review the command action.",
    onServerRequest: async (descriptor) => {
      received = descriptor;
      return { decision: "accept" };
    },
  });

  assert.equal(received.command, null);
  assert.equal(received.commandActions[0].command, "git status --short");
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "interactive-1",
    result: { decision: "accept" },
  });
});

test("a bounded long command and commandActions retain their suffixes and can be accepted", async (t) => {
  const marker = (fill, size, suffix) => `${fill.repeat(size - suffix.length)}${suffix}`;
  const request = interactiveRequest("item/commandExecution/requestApproval", {
    itemId: "bounded-long-command",
    reason: marker("r", 4 * 1024, "REASON-END"),
    cwd: marker("c", 4 * 1024, "CWD-END"),
    command: marker("x", 10 * 1024, "COMMAND-END"),
    commandActions: [{
      type: "unknown",
      command: marker("a", 10 * 1024, "ACTION-END"),
    }],
  });
  const fixture = interactiveRunner(request);
  t.after(() => fixture.client.close());
  let received = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Review the complete bounded command.",
    onServerRequest: async (descriptor) => {
      received = descriptor;
      return { decision: "accept" };
    },
  });

  assert.notEqual(received.truncated, true);
  assert.match(received.reason, /REASON-END$/);
  assert.match(received.cwd, /CWD-END$/);
  assert.match(received.command, /COMMAND-END$/);
  assert.match(received.commandActions[0].command, /ACTION-END$/);
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "interactive-1",
    result: { decision: "accept" },
  });
});

test("a v2 file approval without concrete changes cannot grant session authority", async (t) => {
  const request = interactiveRequest("item/fileChange/requestApproval", {
    itemId: "file-change-1",
    startedAtMs: 1783987200123,
    reason: "Write outside the current root.",
    grantRoot: "/outside/project",
  });
  const fixture = interactiveRunner(request);
  t.after(() => fixture.client.close());
  let received = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Review the incomplete file request.",
    onServerRequest: async (descriptor) => {
      received = descriptor;
      return { decision: "acceptForSession" };
    },
  });

  assert.equal(received.approval, "fileChange");
  assert.equal(received.protocol, "v2");
  assert.equal(received.grantRoot, "/outside/project");
  assert.equal(Object.hasOwn(received, "changes"), false);
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "interactive-1",
    result: { decision: "decline" },
  });
});

test("a truncated legacy file list stays denied even when its handler accepts", async (t) => {
  const fileChanges = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
    `/tmp/project/file-${index}.txt`,
    { type: "update", unified_diff: `@@ -1 +1 @@ file ${index}`, move_path: null },
  ]));
  const fixture = interactiveRunner({
    id: "legacy-files-truncated",
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-1",
      callId: "legacy-patch-truncated",
      fileChanges,
      reason: "Apply every requested file update.",
      grantRoot: "/tmp/project",
    },
  });
  t.after(() => fixture.client.close());
  let received = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Review the truncated file request.",
    onServerRequest: async (descriptor) => {
      received = descriptor;
      return { decision: "accept" };
    },
  });

  assert.equal(received.approval, "fileChange");
  assert.equal(received.protocol, "legacy");
  assert.equal(received.truncated, true);
  assert.equal(received.changes.length, 32);
  assert.equal(received.grantRoot, "/tmp/project");
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "legacy-files-truncated",
    result: { decision: "denied" },
  });
});

test("all 32 bounded legacy file changes retain their disclosure and can be accepted", async (t) => {
  const fileChanges = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
    `/tmp/project/file-${String(index + 1).padStart(2, "0")}.txt`,
    { type: "update", unified_diff: `change-${index + 1}`, move_path: null },
  ]));
  const fixture = interactiveRunner({
    id: "legacy-files-bounded",
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-1",
      callId: "legacy-patch-bounded",
      fileChanges,
      reason: "Apply all disclosed updates.",
      grantRoot: "/tmp/project",
    },
  });
  t.after(() => fixture.client.close());
  let received = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Review every disclosed file.",
    onServerRequest: async (descriptor) => {
      received = descriptor;
      return { decision: "accept" };
    },
  });

  assert.notEqual(received.truncated, true);
  assert.equal(received.changes.length, 32);
  assert.equal(received.changes[16].path, "/tmp/project/file-17.txt");
  assert.equal(received.changes[31].path, "/tmp/project/file-32.txt");
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "legacy-files-bounded",
    result: { decision: "approved" },
  });
});

test("bounded file metadata retains every field suffix and can be accepted", async (t) => {
  const marker = (fill, size, suffix) => `${fill.repeat(size - suffix.length)}${suffix}`;
  const pathName = marker("p", 4 * 1024, "PATH-END");
  const fixture = interactiveRunner({
    id: "legacy-file-boundaries",
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-1",
      callId: "legacy-patch-boundaries",
      fileChanges: {
        [pathName]: {
          type: marker("t", 64, "TYPE-END"),
          unified_diff: marker("v", 2 * 1024, "PREVIEW-END"),
          move_path: marker("m", 4 * 1024, "MOVE-END"),
        },
      },
      reason: marker("r", 4 * 1024, "REASON-END"),
      grantRoot: marker("g", 4 * 1024, "GRANT-END"),
    },
  });
  t.after(() => fixture.client.close());
  let received = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Review every bounded field.",
    onServerRequest: async (descriptor) => {
      received = descriptor;
      return { decision: "accept" };
    },
  });

  assert.notEqual(received.truncated, true);
  assert.match(received.reason, /REASON-END$/);
  assert.match(received.grantRoot, /GRANT-END$/);
  assert.match(received.changes[0].path, /PATH-END$/);
  assert.match(received.changes[0].type, /TYPE-END$/);
  assert.match(received.changes[0].preview, /PREVIEW-END$/);
  assert.match(received.changes[0].movePath, /MOVE-END$/);
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "legacy-file-boundaries",
    result: { decision: "approved" },
  });
});

test("legacy approval decisions map to exact legacy app-server responses", async (t) => {
  const cases = [
    {
      method: "execCommandApproval",
      params: {
        conversationId: "thread-1",
        callId: "legacy-command-1",
        approvalId: null,
        command: ["git", "status"],
        cwd: "/tmp",
        reason: null,
        parsedCmd: [{ type: "unknown", cmd: "git status" }],
      },
      decision: "acceptForSession",
      expected: "approved_for_session",
      approval: "command",
    },
    {
      method: "applyPatchApproval",
      params: {
        conversationId: "thread-1",
        callId: "legacy-patch-1",
        fileChanges: { "/tmp/file.txt": { type: "update", unified_diff: "@@ -1 +1 @@", move_path: null } },
        reason: "Write the requested change.",
        grantRoot: "/tmp",
      },
      decision: "cancel",
      expected: "abort",
      approval: "fileChange",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.method, async (subtest) => {
      const fixture = interactiveRunner({ id: "legacy-1", method: entry.method, params: entry.params });
      subtest.after(() => fixture.client.close());
      let descriptor = null;
      await fixture.runner.run({
        thread: { id: "thread-1", cwd: "/tmp" },
        prompt: "Handle legacy approval.",
        onServerRequest: async (value) => {
          descriptor = value;
          return { decision: entry.decision };
        },
      });
      assert.equal(descriptor.protocol, "legacy");
      assert.equal(descriptor.approval, entry.approval);
      assert.deepEqual(fixture.socket().serverRequestResponse, {
        id: "legacy-1",
        result: { decision: entry.expected },
      });
    });
  }
});

test("requestUserInput descriptor and answers use the exact app-server schema", async (t) => {
  const request = interactiveRequest("item/tool/requestUserInput", {
    itemId: "question-item-1",
    autoResolutionMs: 75,
    questions: [
      {
        id: "environment",
        header: "Target",
        question: "Where should this run?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Staging", description: "Use the staging environment." },
          { label: "Production", description: "Use the production environment." },
        ],
      },
      {
        id: "token",
        header: "Token",
        question: "Enter the one-time token.",
        isOther: false,
        isSecret: true,
        options: null,
      },
    ],
  });
  const fixture = interactiveRunner(request);
  t.after(() => fixture.client.close());
  let received = null;
  let timeoutMs = null;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Ask me.",
    onServerRequest: async (descriptor, context) => {
      received = descriptor;
      timeoutMs = context.timeoutMs;
      return { answers: { environment: ["Staging"], token: { answers: ["123456"] } } };
    },
  });
  assert.equal(received.kind, "userInput");
  assert.equal(received.itemId, "question-item-1");
  assert.equal(received.questions[1].isSecret, true);
  assert.equal(timeoutMs, 75);
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "interactive-1",
    result: {
      answers: {
        environment: { answers: ["Staging"] },
        token: { answers: ["123456"] },
      },
    },
  });
});

test("elicitation and dynamic-tool decisions map to exact app-server schemas", async (t) => {
  await t.test("elicitation", async (subtest) => {
    const request = interactiveRequest("mcpServer/elicitation/request", {
      mode: "form",
      serverName: "calendar",
      message: "Choose a date.",
      requestedSchema: { type: "object", properties: { date: { type: "string", format: "date" } } },
      _meta: { source: "test" },
    });
    const fixture = interactiveRunner(request);
    subtest.after(() => fixture.client.close());
    let descriptor = null;
    await fixture.runner.run({
      thread: { id: "thread-1", cwd: "/tmp" },
      prompt: "Collect form input.",
      onServerRequest: async (value) => {
        descriptor = value;
        return { action: "accept", content: { date: "2026-07-14" }, meta: { client: "imessage" } };
      },
    });
    assert.equal(descriptor.kind, "elicitation");
    assert.equal(descriptor.serverName, "calendar");
    assert.deepEqual(fixture.socket().serverRequestResponse, {
      id: "interactive-1",
      result: {
        action: "accept",
        content: { date: "2026-07-14" },
        _meta: { client: "imessage" },
      },
    });
  });

  await t.test("dynamic tool", async (subtest) => {
    const request = interactiveRequest("item/tool/call", {
      callId: "dynamic-call-1",
      namespace: "mobile",
      tool: "confirm",
      arguments: { action: "deploy", count: 2 },
    });
    const fixture = interactiveRunner(request);
    subtest.after(() => fixture.client.close());
    let descriptor = null;
    await fixture.runner.run({
      thread: { id: "thread-1", cwd: "/tmp" },
      prompt: "Use a dynamic tool.",
      onServerRequest: async (value) => {
        descriptor = value;
        return {
          success: true,
          contentItems: [
            { type: "text", text: "Confirmed." },
            { type: "image", imageUrl: "https://example.com/receipt.png" },
          ],
        };
      },
    });
    assert.equal(descriptor.kind, "dynamicTool");
    assert.deepEqual(descriptor.arguments, { action: "deploy", count: 2 });
    assert.deepEqual(fixture.socket().serverRequestResponse, {
      id: "interactive-1",
      result: {
        contentItems: [
          { type: "inputText", text: "Confirmed." },
          { type: "inputImage", imageUrl: "https://example.com/receipt.png" },
        ],
        success: true,
      },
    });
  });
});

test("interactive requests fail closed for missing, invalid, throwing, timed-out, or mismatched handlers", async (t) => {
  const baseRequest = () => interactiveRequest("item/commandExecution/requestApproval", {
    itemId: "command-1",
    startedAtMs: Date.now(),
    command: "touch /tmp/should-not-run",
    cwd: "/tmp",
  });
  const cases = [
    { name: "missing handler", handler: undefined },
    { name: "invalid decision", handler: async () => ({ decision: "approve-everything" }) },
    { name: "throwing handler", handler: async () => { throw new Error("broker unavailable"); } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fixture = interactiveRunner(baseRequest());
      subtest.after(() => fixture.client.close());
      await fixture.runner.run({
        thread: { id: "thread-1", cwd: "/tmp" },
        prompt: "Fail closed.",
        ...(entry.handler ? { onServerRequest: entry.handler } : {}),
      });
      assert.deepEqual(fixture.socket().serverRequestResponse, {
        id: "interactive-1",
        result: { decision: "decline" },
      });
    });
  }

  await t.test("timeout aborts the broker wait", async (subtest) => {
    const fixture = interactiveRunner(baseRequest(), { serverRequestTimeoutMs: 20 });
    subtest.after(() => fixture.client.close());
    let signal = null;
    const startedAt = Date.now();
    await fixture.runner.run({
      thread: { id: "thread-1", cwd: "/tmp" },
      prompt: "Bound the wait.",
      onServerRequest: async (_descriptor, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(signal.aborted, true);
    assert.deepEqual(fixture.socket().serverRequestResponse, {
      id: "interactive-1",
      result: { decision: "decline" },
    });
  });

  await t.test("foreign turn context never reaches the handler", async (subtest) => {
    const request = baseRequest();
    request.params.threadId = "foreign-thread";
    const fixture = interactiveRunner(request);
    subtest.after(() => fixture.client.close());
    let called = false;
    await fixture.runner.run({
      thread: { id: "thread-1", cwd: "/tmp" },
      prompt: "Reject foreign context.",
      onServerRequest: async () => {
        called = true;
        return { decision: "accept" };
      },
    });
    assert.equal(called, false);
    assert.deepEqual(fixture.socket().serverRequestResponse.result, { decision: "decline" });
  });
});

test("every supported interactive method has an exact fail-closed response without a handler", async (t) => {
  const cases = [
    {
      method: "item/fileChange/requestApproval",
      params: { itemId: "file-1", startedAtMs: Date.now(), reason: null, grantRoot: null },
      expected: { decision: "decline" },
    },
    {
      method: "execCommandApproval",
      params: {
        conversationId: "thread-1",
        callId: "legacy-command-1",
        approvalId: null,
        command: ["pwd"],
        cwd: "/tmp",
        reason: null,
        parsedCmd: [],
      },
      expected: { decision: "denied" },
    },
    {
      method: "applyPatchApproval",
      params: {
        conversationId: "thread-1",
        callId: "legacy-patch-1",
        fileChanges: {},
        reason: null,
        grantRoot: null,
      },
      expected: { decision: "denied" },
    },
    {
      method: "item/tool/requestUserInput",
      params: {
        itemId: "question-1",
        questions: [{
          id: "answer",
          header: "Answer",
          question: "Continue?",
          isOther: false,
          isSecret: false,
          options: null,
        }],
        autoResolutionMs: null,
      },
      expected: { answers: {} },
    },
    {
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        serverName: "test",
        message: "Enter a value.",
        requestedSchema: { type: "object", properties: {} },
        _meta: null,
      },
      expected: { action: "decline", content: null, _meta: null },
    },
    {
      method: "item/tool/call",
      params: { callId: "dynamic-1", namespace: null, tool: "confirm", arguments: {} },
      expected: { contentItems: [], success: false },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.method, async (subtest) => {
      const fixture = interactiveRunner(interactiveRequest(entry.method, entry.params));
      subtest.after(() => fixture.client.close());
      await fixture.runner.run({
        thread: { id: "thread-1", cwd: "/tmp" },
        prompt: "Default safely.",
      });
      assert.deepEqual(fixture.socket().serverRequestResponse, {
        id: "interactive-1",
        result: entry.expected,
      });
    });
  }
});

test("method-specific broker output validation declines malformed answers", async (t) => {
  const cases = [
    {
      method: "item/tool/requestUserInput",
      params: {
        itemId: "question-1",
        questions: [{
          id: "known",
          header: "Known",
          question: "Answer this.",
          isOther: false,
          isSecret: false,
          options: null,
        }],
        autoResolutionMs: null,
      },
      decision: { answers: { unknown: ["not allowed"] } },
      expected: { answers: {} },
    },
    {
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        serverName: "test",
        message: "Enter a value.",
        requestedSchema: { type: "object", properties: {} },
        _meta: null,
      },
      decision: (() => {
        const content = {};
        content.self = content;
        return { action: "accept", content };
      })(),
      expected: { action: "decline", content: null, _meta: null },
    },
    {
      method: "item/tool/call",
      params: { callId: "dynamic-1", namespace: null, tool: "confirm", arguments: {} },
      decision: { success: true, contentItems: [{ type: "executable", command: "rm -rf /" }] },
      expected: { contentItems: [], success: false },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.method, async (subtest) => {
      const fixture = interactiveRunner(interactiveRequest(entry.method, entry.params));
      subtest.after(() => fixture.client.close());
      await fixture.runner.run({
        thread: { id: "thread-1", cwd: "/tmp" },
        prompt: "Validate this result.",
        onServerRequest: async () => entry.decision,
      });
      assert.deepEqual(fixture.socket().serverRequestResponse.result, entry.expected);
    });
  }
});

test("unknown server requests fail closed and never invoke the turn handler", async (t) => {
  const fixture = interactiveRunner(interactiveRequest("device/adminAccess/grant", { scope: "all" }));
  t.after(() => fixture.client.close());
  let called = false;
  await fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Reject unknown methods.",
    onServerRequest: async () => {
      called = true;
      return { decision: "accept" };
    },
  });
  assert.equal(called, false);
  assert.deepEqual(fixture.socket().serverRequestResponse, {
    id: "interactive-1",
    error: { code: -32001, message: "This request requires interaction in the Codex app." },
  });
});

test("disconnect aborts an outstanding mobile decision and ignores a late approval", async (t) => {
  const request = interactiveRequest("item/fileChange/requestApproval", {
    itemId: "file-change-1",
    startedAtMs: Date.now(),
    reason: "Write outside the current root.",
    grantRoot: "/tmp/project",
  });
  const fixture = interactiveRunner(request, { completeOnResponse: false, serverRequestTimeoutMs: 500 });
  t.after(() => fixture.client.close());
  let resolveDecision;
  let signal = null;
  const run = fixture.runner.run({
    thread: { id: "thread-1", cwd: "/tmp" },
    prompt: "Wait for approval.",
    onServerRequest: async (_descriptor, context) => {
      signal = context.signal;
      return new Promise((resolve) => { resolveDecision = resolve; });
    },
  });
  await waitFor(() => typeof resolveDecision === "function");
  fixture.socket().disconnect();
  await assert.rejects(run, (error) => error?.code === "CODEX_DISCONNECTED");
  assert.equal(signal.aborted, true);
  resolveDecision({ decision: "accept" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.socket().sent.some((message) => (
    message.id === "interactive-1" && !message.method
  )), false);
});

test("runner interrupts a remote turn without closing its shared stream", async (t) => {
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
  assert.equal(runner.client.socket.readyState, 1);
});

test("runner interrupts a recovered turn by its persisted canonical turn id", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-recovered-cancel-"));
  const { runner, capture } = testRunner(directory, "cancel");
  t.after(() => runner.client.close());

  assert.equal(await runner.cancelRecoveredTurn("thread-1", "turn-recovered-42"), true);
  const interrupt = messages(capture).find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-recovered-42" });
});

test("runner-owned remote streams close after a completed turn", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-owned-"));
  const fixture = testRunner(directory);
  const owned = new AppServerCodexRunner({
    codexHome: path.join(directory, "codex-home"),
    webSocketFactory: fixture.webSocketFactory,
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
  });
  const result = await owned.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Hello" });
  assert.equal(result.status, "completed");
  assert.equal(owned.client.socket, null);
  fixture.client.close();
});

test("a runtime-owned injected client closes and releases tracking after each runner operation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-injected-owned-"));
  let closeCount = 0;
  let released = 0;
  const client = {
    async startThread({ cwd, threadSource }) {
      return {
        thread: { id: "thread-injected", cwd },
        cwd,
        threadSource,
      };
    },
    close() { closeCount += 1; },
  };
  const runner = new AppServerCodexRunner({
    client,
    ownsClient: true,
    onClientClose(closedClient) {
      assert.equal(closedClient, client);
      released += 1;
    },
  });

  const created = await runner.createThread({ cwd: directory, threadSource: "imessage-handoff:test" });
  assert.equal(created.id, "thread-injected");
  assert.equal(closeCount, 1);
  assert.equal(released, 1);

  await assert.rejects(
    runner.createThread({ cwd: path.join(directory, "missing"), threadSource: "imessage-handoff:test" }),
    (error) => error.code === "MISSING_CWD",
  );
  assert.equal(closeCount, 1, "an owned client is released only once");
  assert.equal(released, 1);
});

test("runner bounds Remote Control initialization waits", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-app-server-timeout-"));
  const { runner } = testRunner(directory, "timeout", { requestTimeoutMs: 40 });
  t.after(() => runner.client.close());
  await assert.rejects(
    runner.run({ thread: { id: "thread-1", cwd: directory }, prompt: "Hello" }),
    (error) => error.code === "CODEX_TIMEOUT",
  );
  assert.equal(runner.isRunning(), false);
});

test("terminal initialization notifications reject promptly and classify missing pairing", async (t) => {
  const cases = [
    {
      name: "generic terminal error",
      error: { code: -32000, message: "Remote app-server initialization failed." },
      expectedCode: "CODEX_FAILED",
    },
    {
      name: "client is not paired",
      error: "not paired for this client",
      expectedCode: "CODEX_REMOTE_PAIRING_REQUIRED",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let closed = false;
      class TerminalErrorSocket extends EventEmitter {
        readyState = 0;
        send(value) {
          const message = JSON.parse(value);
          if (message.method !== "initialize") return;
          queueMicrotask(() => this.emit("message", JSON.stringify({
            method: "error",
            params: { error: entry.error, willRetry: false },
          })));
        }
        close() {
          closed = true;
          this.readyState = 3;
        }
      }
      const client = new AppServerRpcClient({
        codexHome: "/tmp/terminal-error-codex-home",
        requestTimeoutMs: 10_000,
        webSocketFactory: () => {
          const socket = new TerminalErrorSocket();
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.emit("open");
          });
          return socket;
        },
      });
      let deadline;
      try {
        const outcome = await Promise.race([
          client.connect().then(
            () => ({ resolved: true }),
            (error) => ({ error }),
          ),
          new Promise((resolve) => {
            deadline = setTimeout(() => resolve({ timedOut: true }), 250);
          }),
        ]);
        assert.equal(outcome.timedOut, undefined, "initialize waited for its request timeout");
        assert.equal(outcome.resolved, undefined);
        assert.equal(outcome.error?.code, entry.expectedCode);
        assert.equal(client.ready, false);
        assert.equal(closed, true);
      } finally {
        clearTimeout(deadline);
        client.close();
      }
    });
  }
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
  // This verifies that the explicit timeout and interrupt grace bound the
  // operation without assuming the host scheduler will wake the test within
  // a sub-second wall-clock window.
  assert.ok(Date.now() - startedAt < 2_000);
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
    requestTimeoutMs: 2_000,
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

test("protocol client requires an injected Remote Control stream and receives no local endpoint", async () => {
  const sent = [];
  let factoryArguments = null;
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
    webSocketFactory: (...args) => {
      factoryArguments = args;
      const socket = new FakeSocket();
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
  });
  await client.connect();
  assert.deepEqual(factoryArguments, []);
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[1].method, "initialized");
  client.close();
});

test("protocol client cannot construct a local Codex transport", () => {
  assert.throws(
    () => new AppServerRpcClient({ codexHome: "/tmp/.codex" }),
    (error) => error?.code === "CODEX_REMOTE_TRANSPORT_REQUIRED",
  );
});
