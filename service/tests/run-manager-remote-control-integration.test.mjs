import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RemoteControlCodexRuntime } from "../src/remote-control-runner.mjs";
import { RunManager } from "../src/run-manager.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testsDirectory, "../..");

async function eventually(assertion, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

test("three task runs use independent logical clients while the fourth waits for shared capacity", async () => {
  const calls = {
    physicalConnections: 0,
    physicalTerminations: 0,
    streams: [],
    streamCloses: [],
    clients: [],
    clientCloses: [],
    started: [],
    errors: [],
  };

  const runtime = new RemoteControlCodexRuntime({
    codexHome: "/Users/test/.codex",
    controllerFactory: () => ({
      websocketUrl: "wss://example.invalid/remote-control",
      refreshSession: async () => ({}),
      authorizeDeviceChallenge: async () => ({}),
    }),
    connectionFactory: () => {
      calls.physicalConnections += 1;
      return {
        createStream() {
          const stream = {
            id: calls.streams.length + 1,
            readyState: 1,
            close() {
              this.readyState = 3;
              calls.streamCloses.push(this.id);
            },
          };
          calls.streams.push(stream);
          return stream;
        },
        terminate() { calls.physicalTerminations += 1; },
      };
    },
    rpcClientFactory(options) {
      const client = {
        id: calls.clients.length + 1,
        running: false,
        closed: false,
        release: null,
        isRunning() { return this.running; },
        runTurn({ thread, clientUserMessageId }) {
          assert.equal(this.running, false, "a logical client must own only one active turn");
          this.running = true;
          this.stream = options.webSocketFactory();
          calls.started.push(clientUserMessageId);
          return new Promise((resolve) => {
            this.release = () => {
              this.running = false;
              resolve({ threadId: thread.id, turnId: `turn-${clientUserMessageId}` });
            };
          });
        },
        close() {
          assert.equal(this.running, false, "an active logical client must not be closed");
          if (this.closed) return;
          this.closed = true;
          this.stream?.close();
          calls.clientCloses.push(this.id);
        },
      };
      calls.clients.push(client);
      return client;
    },
  });

  const manager = new RunManager({
    maxConcurrent: 3,
    onError: (error) => calls.errors.push(error),
    run: async (event) => {
      const runner = runtime.createRunner();
      try {
        await runner.run({
          thread: { id: event.threadId, cwd: testsDirectory },
          prompt: event.claimed.reply.body,
          clientUserMessageId: event.replyId,
          reasoningEffort: "medium",
        });
      } finally {
        runner.close();
      }
    },
  });

  for (const [threadId, replyId] of [
    ["task-a", "a-1"],
    ["task-b", "b-1"],
    ["task-c", "c-1"],
    ["task-d", "d-1"],
    ["task-a", "a-2"],
  ]) {
    assert.equal(manager.enqueue({
      threadId,
      replyId,
      claimed: { reply: { body: `request-${replyId}` } },
    }), true);
  }

  await eventually(() => assert.deepEqual(calls.started, ["a-1", "b-1", "c-1"]));
  assert.equal(calls.physicalConnections, 1);
  assert.equal(calls.clients.length, 3);
  assert.equal(new Set(calls.clients).size, 3);
  assert.equal(calls.streams.length, 3);
  assert.equal(new Set(calls.streams).size, 3);
  assert.equal(manager.state("task-d").status, "pending");
  assert.equal(manager.state("task-a").status, "working");
  assert.equal(manager.state("task-a").pendingCount, 1, "same-task work remains FIFO");

  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /Queued behind earlier iMessage work\. Codex will start this message automatically\./);
  assert.doesNotMatch(daemon, /(?:no|free) (?:run )?slots?|run slot is free/i);

  calls.clients[1].release();
  await eventually(() => assert.deepEqual(calls.started, ["a-1", "b-1", "c-1", "d-1"]));
  assert.deepEqual(calls.clientCloses, [2]);
  assert.deepEqual(calls.streamCloses, [2]);
  assert.equal(calls.physicalConnections, 1, "later work reuses the physical relay");
  assert.equal(calls.physicalTerminations, 0, "one completed task cannot terminate the shared relay");
  assert.equal(manager.state("task-a").pendingCount, 1);

  calls.clients[0].release();
  await eventually(() => assert.deepEqual(calls.started, ["a-1", "b-1", "c-1", "d-1", "a-2"]));
  assert.deepEqual(calls.clientCloses, [2, 1]);
  assert.equal(calls.physicalConnections, 1);
  assert.equal(calls.physicalTerminations, 0);

  for (const client of calls.clients.filter((item) => item.running)) client.release();
  await eventually(() => {
    assert.equal(manager.states().size, 0);
    assert.equal(calls.clientCloses.length, 5);
  });
  assert.deepEqual([...calls.clientCloses].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual([...calls.streamCloses].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(calls.errors.length, 0, "independent clients must not report BUSY or capacity errors");
  assert.equal(calls.physicalTerminations, 0);

  runtime.close();
  assert.equal(calls.physicalTerminations, 1);
});
