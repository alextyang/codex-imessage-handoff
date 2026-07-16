import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTROLLER_DYNAMIC_TOOLS,
  CONTROLLER_MODEL,
  CONTROLLER_NAMESPACE,
  CONTROLLER_REASONING,
  CONTROLLER_RUN_THREAD_ID,
  HiddenControllerConversation,
} from "../src/hidden-controller-conversation.mjs";

const IDENTITY_KEY = "a".repeat(64);
const OTHER_IDENTITY_KEY = "b".repeat(64);

function validState(identityKey = IDENTITY_KEY, overrides = {}) {
  return {
    version: 1,
    identityKey,
    session: null,
    retiredSessions: [],
    jobs: [],
    completed: [],
    recent: [],
    topLevel: [],
    toolJournal: {},
    ...overrides,
  };
}

function fixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hidden-controller-"));
  const stateFile = path.join(root, "state.json");
  const controllerRoot = path.join(root, "controller-workspace");
  const starts = [];
  const runs = [];
  const requests = [];
  const deliveries = [];
  const imageDeliveries = [];
  const typing = [];
  const toolInvocations = [];
  const serverResults = [];
  const cancellations = [];
  let toolCalls = 0;
  let sendAttempts = 0;
  let imageSendAttempts = 0;
  const runner = {
    client: {
      request: async (method, params) => {
        requests.push({ method, params });
        if (typeof options.requestHandler === "function") return options.requestHandler(method, params);
        if (options.requestErrors?.[method]) throw options.requestErrors[method];
        return {};
      },
    },
    createThread: async (params) => {
      starts.push(params);
      const createError = Array.isArray(options.createErrors)
        ? options.createErrors[starts.length - 1]
        : options.createError;
      if (createError) throw createError;
      return options.threadResult || {
        id: `ephemeral-${starts.length}`,
        cwd: params.cwd,
        ephemeral: true,
        model: CONTROLLER_MODEL,
      };
    },
    cancel: (threadId) => {
      cancellations.push(threadId);
      return true;
    },
    run: async (params) => {
      runs.push(params);
      if (options.dynamicTool) {
        const first = await params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "list_tasks",
          callId: "call-1",
          arguments: { limit: 3 },
        }, {});
        serverResults.push(first);
        const duplicate = await params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "list_tasks",
          callId: "call-1",
          arguments: { limit: 3 },
        }, {});
        assert.deepEqual(duplicate, first);
      }
      if (options.dynamicMutation) {
        const descriptor = {
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "send_task_message",
          arguments: { id: "task-a", text: "Run tests" },
        };
        const first = await params.onServerRequest({ ...descriptor, callId: "mutation-1" }, {});
        const regenerated = await params.onServerRequest({ ...descriptor, callId: "mutation-2" }, {});
        assert.deepEqual(regenerated, first);
      }
      if (options.parallelMutation) {
        const [first, duplicate] = await Promise.all([
          params.onServerRequest({
            kind: "dynamicTool",
            namespace: CONTROLLER_NAMESPACE,
            tool: "send_task_message",
            callId: "parallel-1",
            arguments: { id: "task-a", text: "Run tests" },
          }, {}),
          params.onServerRequest({
            kind: "dynamicTool",
            namespace: CONTROLLER_NAMESPACE,
            tool: "send_task_message",
            callId: "parallel-2",
            arguments: { text: "  Run tests  ", id: "task-a" },
          }, {}),
        ]);
        assert.deepEqual(duplicate, first);
      }
      if (options.truncatedMutation) {
        const truncated = await params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "send_task_message",
          callId: "truncated-1",
          truncated: true,
          arguments: { id: "task-a", text: "Run tests" },
        }, {});
        const oversized = await params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "send_task_message",
          callId: "oversized-1",
          arguments: { id: "task-a", text: "x".repeat(12_001) },
        }, {});
        serverResults.push(truncated, oversized);
      }
      if (options.dynamicToolBurst) {
        for (let index = 0; index < 17; index += 1) {
          serverResults.push(await params.onServerRequest({
            kind: "dynamicTool",
            namespace: CONTROLLER_NAMESPACE,
            tool: "list_tasks",
            callId: `burst-${index}`,
            arguments: { limit: 1 },
          }, {}));
        }
      }
      if (options.budgetDuringMutation) {
        let releaseMutation;
        let markMutationStarted;
        const mutationStarted = new Promise((resolve) => { markMutationStarted = resolve; });
        options.mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
        options.markMutationStarted = markMutationStarted;
        const mutation = params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "send_task_message",
          callId: "budget-mutation",
          arguments: { id: "task-a", text: "Run the committed action" },
        }, {});
        await mutationStarted;
        for (let index = 0; index < 15; index += 1) {
          await params.onServerRequest({
            kind: "dynamicTool",
            namespace: CONTROLLER_NAMESPACE,
            tool: "list_tasks",
            callId: `budget-read-${index}`,
            arguments: { limit: 1 },
          }, {});
        }
        serverResults.push(await params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "list_tasks",
          callId: "budget-overflow",
          arguments: { limit: 1 },
        }, {}));
        await Promise.resolve();
        options.observeBeforeMutationRelease?.(cancellations);
        releaseMutation();
        await mutation;
        await Promise.resolve();
      }
      if (options.abortBeforeLateMutation) {
        options.abortBeforeLateMutation();
        serverResults.push(await params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "send_task_message",
          callId: "late-cancelled-mutation",
          arguments: { id: "task-a", text: "This must not be admitted" },
        }, {}));
      }
      if (options.detachedMutation) {
        let release;
        let started;
        const startedPromise = new Promise((resolve) => { started = resolve; });
        options.detachedGate = new Promise((resolve) => { release = resolve; });
        options.markDetachedStarted = started;
        options.releaseDetachedMutation = release;
        void params.onServerRequest({
          kind: "dynamicTool",
          namespace: CONTROLLER_NAMESPACE,
          tool: "send_task_message",
          callId: "detached-mutation",
          arguments: { id: "task-a", text: "Finish before delivery" },
        }, {});
        await startedPromise;
      }
      if (options.deferResult) {
        await new Promise((resolve) => { options.releaseResult = resolve; });
      }
      const runError = Array.isArray(options.runErrors) ? options.runErrors[runs.length - 1] : options.runError;
      if (runError) throw runError;
      return {
        status: options.runStatus || "completed",
        body: options.body || "Controller result",
        generatedImages: options.generatedImages || [],
      };
    },
  };
  const conversation = new HiddenControllerConversation({
    stateFile,
    identityKey: options.identityKey || IDENTITY_KEY,
    runner,
    cwd: controllerRoot,
    send: async (event, sendOptions) => {
      sendAttempts += 1;
      if (options.sendError && sendAttempts <= (options.sendFailures || 1)) throw options.sendError;
      deliveries.push({ event, sendOptions });
      return { sent: true };
    },
    sendImages: async (files, sendOptions) => {
      imageSendAttempts += 1;
      const configuredFailure = Array.isArray(options.imageSendFailureAttempts)
        ? options.imageSendFailureAttempts.includes(imageSendAttempts)
        : imageSendAttempts <= (options.imageSendFailures || 1);
      if (options.imageSendError && configuredFailure) {
        throw options.imageSendError;
      }
      imageDeliveries.push({ files, sendOptions });
      return { sent: true };
    },
    snapshot: async () => ({ pending: 2, tasks: [{ id: "task-a", title: "A" }] }),
    executeTool: async (invocation) => {
      toolCalls += 1;
      toolInvocations.push(invocation);
      if (options.budgetDuringMutation && invocation.tool === "send_task_message") {
        options.markMutationStarted();
        await options.mutationGate;
      }
      if (options.detachedMutation && invocation.tool === "send_task_message") {
        options.markDetachedStarted();
        await options.detachedGate;
      }
      return options.toolResult ?? { result: { tasks: ["task-a"] } };
    },
    setTyping: async (value) => { typing.push(value); },
  });
  return {
    conversation,
    stateFile,
    root,
    controllerRoot,
    starts,
    runs,
    requests,
    deliveries,
    imageDeliveries,
    typing,
    sendAttempts: () => sendAttempts,
    imageSendAttempts: () => imageSendAttempts,
    toolCalls: () => toolCalls,
    toolInvocations,
    serverResults,
    cancellations,
  };
}

test("creates a hidden Terra Medium controller and keeps its output top-level", async () => {
  const item = fixture();
  const event = item.conversation.enqueue({ messageKey: "guid-1", body: "What is running?", createdAt: "2026-07-15T12:00:00.000Z" });
  assert.equal(event.threadId, CONTROLLER_RUN_THREAD_ID);
  await item.conversation.execute(event.controllerJobId);

  assert.equal(item.starts.length, 1);
  assert.equal(CONTROLLER_MODEL, "gpt-5.6-terra");
  assert.equal(CONTROLLER_REASONING, "medium");
  assert.equal(item.starts[0].model, CONTROLLER_MODEL);
  assert.equal(item.starts[0].ephemeral, true);
  assert.equal(item.starts[0].approvalPolicy, "on-request");
  assert.equal(item.starts[0].sandbox, "read-only");
  assert.equal(path.dirname(item.starts[0].cwd), path.resolve(item.controllerRoot));
  assert.match(path.basename(item.starts[0].cwd), /^session-/u);
  assert.equal(statSync(item.controllerRoot).mode & 0o777, 0o700);
  assert.equal(statSync(item.starts[0].cwd).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(item.starts[0].cwd), []);
  assert.deepEqual(item.starts[0].dynamicTools, CONTROLLER_DYNAMIC_TOOLS);
  assert.match(item.starts[0].developerInstructions, /top-level iMessage controller/);
  assert.equal(item.runs[0].model, CONTROLLER_MODEL);
  assert.equal(item.runs[0].reasoningEffort, CONTROLLER_REASONING);
  assert.equal(item.runs[0].turnTimeoutMs, 10 * 60 * 1000);
  assert.deepEqual(item.runs[0].thread, { id: "ephemeral-1", cwd: item.starts[0].cwd });
  assert.equal(item.runs[0].prompt, "What is running?");
  assert.equal(item.runs[0].additionalContext.service_state.kind, "application");
  assert.deepEqual(item.typing, [true, false]);
  assert.equal(item.deliveries.length, 1);
  assert.equal(item.deliveries[0].event.thread, undefined);
  assert.equal(item.deliveries[0].event.body, "Controller result");
  assert.equal(item.deliveries[0].sendOptions.controllerRoute, true);
  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.equal(statSync(item.stateFile).mode & 0o777, 0o600);
  assert.equal(persisted.identityKey, IDENTITY_KEY);
  assert.equal(persisted.session.cwd, item.starts[0].cwd);
  assert.equal(persisted.jobs.length, 0);
  assert.equal(item.conversation.enqueue({ messageKey: "guid-1", body: "What is running?" }).completed, true);
  assert.equal(item.runs.length, 1, "an accepted response cannot replay before inbound acknowledgement");
});

test("reuses its ephemeral session and journals duplicate dynamic tool calls", async () => {
  const item = fixture({ dynamicTool: true });
  const first = item.conversation.enqueue({ messageKey: "guid-1", body: "List tasks." });
  await item.conversation.execute(first.controllerJobId);
  const second = item.conversation.enqueue({ messageKey: "guid-2", body: "Again." });
  await item.conversation.execute(second.controllerJobId);
  assert.equal(item.starts.length, 1);
  assert.equal(item.runs.length, 2);
  assert.equal(item.toolCalls(), 2, "the call id is scoped to each durable root job");
  assert.equal(item.requests.filter((entry) => entry.method === "thread/settings/update").length, 1);
  assert.equal(item.requests.filter((entry) => entry.method === "thread/memoryMode/set").length, 1);
});

test("deduplicates regenerated mutating calls by durable job and exact arguments", async () => {
  const item = fixture({ dynamicMutation: true });
  const event = item.conversation.enqueue({ messageKey: "guid-mutation", body: "Send it." });
  await item.conversation.execute(event.controllerJobId);
  assert.equal(item.toolCalls(), 1);
  assert.match(item.toolInvocations[0].operationId, /^[a-f0-9]{40}$/u);
});

test("serializes parallel regenerated mutations and canonicalizes reordered arguments", async () => {
  const item = fixture({ parallelMutation: true });
  const event = item.conversation.enqueue({ messageKey: "guid-parallel", body: "Send it once." });
  await item.conversation.execute(event.controllerJobId);
  assert.equal(item.toolCalls(), 1);
});

test("fails closed when mutating dynamic-tool arguments are truncated or exceed the schema", async () => {
  const item = fixture({ truncatedMutation: true });
  const event = item.conversation.enqueue({ messageKey: "guid-truncated", body: "Send the long update." });
  await item.conversation.execute(event.controllerJobId);

  assert.equal(item.toolCalls(), 0, "neither rejected mutation may reach the local executor");
  assert.equal(item.serverResults.length, 2);
  assert.equal(item.serverResults[0].success, false);
  assert.equal(item.serverResults[1].success, false);
  assert.equal(JSON.parse(item.serverResults[0].contentItems[0].text).error, "CONTROL_ARGUMENTS_TRUNCATED");
  assert.equal(JSON.parse(item.serverResults[1].contentItems[0].text).error, "CONTROL_ARGUMENTS_INVALID");
});

test("bounds oversized tool output as valid JSON before returning it to the model", async () => {
  const item = fixture({
    dynamicTool: true,
    toolResult: { result: { tasks: ["x".repeat(64 * 1024)] } },
  });
  const event = item.conversation.enqueue({ messageKey: "guid-large-tool-result", body: "List tasks." });
  await item.conversation.execute(event.controllerJobId);

  const text = item.serverResults[0].contentItems[0].text;
  assert.ok(Buffer.byteLength(text, "utf8") <= 24 * 1024);
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/u);
});

test("rejects and deletes a thread when Codex does not honor the hidden Terra contract", async () => {
  for (const threadResult of [
    { id: "not-ephemeral", ephemeral: false, model: CONTROLLER_MODEL },
    { id: "wrong-model", ephemeral: true, model: "gpt-5.6" },
  ]) {
    const item = fixture({ threadResult });
    const event = item.conversation.enqueue({ messageKey: `guid-${threadResult.id}`, body: "Inspect the Mac." });
    await assert.rejects(
      item.conversation.execute(event.controllerJobId),
      (error) => error?.code === "CONTROLLER_SESSION_CONTRACT_MISMATCH",
    );
    assert.equal(item.runs.length, 0);
    assert.equal(item.requests.some((entry) => entry.method === "thread/delete" && entry.params.threadId === threadResult.id), true);
    assert.equal(readdirSync(item.controllerRoot).length, 0);
    const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
    assert.equal(persisted.session, null);
    assert.equal(persisted.jobs[0].status, "queued");
  }
});

test("durably reconciles an ambiguous thread start before creating a replacement", async () => {
  const ambiguous = Object.assign(new Error("lost thread/start response"), {
    code: "CODEX_DISCONNECTED",
    threadStartOutcomeUnknown: true,
  });
  const first = fixture({ createError: ambiguous });
  const event = first.conversation.enqueue({ messageKey: "guid-ambiguous-start", body: "Inspect the Mac." });
  await assert.rejects(
    first.conversation.execute(event.controllerJobId),
    (error) => error?.code === "CONTROLLER_SESSION_START_UNCERTAIN",
  );
  const pending = JSON.parse(readFileSync(first.stateFile, "utf8")).startingSession;
  assert.ok(pending);
  assert.equal(existsSync(pending.cwd), true);

  const recoveryRequests = [];
  let createCount = 0;
  const resumed = new HiddenControllerConversation({
    stateFile: first.stateFile,
    identityKey: IDENTITY_KEY,
    cwd: first.controllerRoot,
    runner: {
      client: {
        request: async (method, params) => {
          recoveryRequests.push({ method, params });
          if (method === "thread/list") {
            return {
              data: [{
                id: "ambiguous-ephemeral",
                cwd: pending.cwd,
                ephemeral: true,
                threadSource: pending.threadSource,
              }],
              nextCursor: null,
            };
          }
          return {};
        },
      },
      createThread: async (params) => {
        createCount += 1;
        return { id: "replacement-ephemeral", cwd: params.cwd, ephemeral: true, model: CONTROLLER_MODEL };
      },
      run: async () => ({ status: "completed", body: "Recovered safely.", generatedImages: [] }),
      cancel: () => true,
    },
    send: async () => ({ sent: true }),
    executeTool: async () => ({ result: {} }),
  });
  await resumed.execute(event.controllerJobId);

  assert.equal(recoveryRequests.some((entry) => entry.method === "thread/list"
    && entry.params.cwd === pending.cwd && Array.isArray(entry.params.sourceKinds)), true);
  assert.equal(recoveryRequests.some((entry) => entry.method === "thread/delete"
    && entry.params.threadId === "ambiguous-ephemeral"), true);
  assert.equal(createCount, 1);
  assert.equal(existsSync(pending.cwd), false);
  const persisted = JSON.parse(readFileSync(first.stateFile, "utf8"));
  assert.equal(persisted.startingSession, null);
  assert.equal(persisted.session.threadId, "replacement-ephemeral");
});

test("retains a failed session deletion as a durable cleanup obligation", async () => {
  const item = fixture({
    threadResult: { id: "contract-failure", ephemeral: false, model: CONTROLLER_MODEL },
    requestErrors: { "thread/delete": Object.assign(new Error("offline"), { code: "CODEX_TIMEOUT" }) },
  });
  const event = item.conversation.enqueue({ messageKey: "guid-delete-pending", body: "Inspect the Mac." });
  await assert.rejects(
    item.conversation.execute(event.controllerJobId),
    (error) => error?.code === "CONTROLLER_SESSION_CONTRACT_MISMATCH",
  );

  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.equal(persisted.startingSession, null);
  assert.equal(persisted.retiredSessions.length, 1);
  assert.equal(persisted.retiredSessions[0].threadId, "contract-failure");
  assert.equal(existsSync(persisted.retiredSessions[0].cwd), true);
});

test("caps tool calls per turn and retires an interrupted over-budget session", async () => {
  const item = fixture({ dynamicToolBurst: true, runStatus: "cancelled" });
  const event = item.conversation.enqueue({ messageKey: "guid-tool-budget", body: "Keep listing forever." });
  await item.conversation.execute(event.controllerJobId);

  assert.equal(item.toolCalls(), 16);
  assert.equal(item.serverResults.length, 17);
  assert.equal(JSON.parse(item.serverResults.at(-1).contentItems[0].text).error, "CONTROL_TOOL_BUDGET_EXHAUSTED");
  assert.deepEqual(item.cancellations, ["ephemeral-1"]);
  assert.match(item.deliveries[0].event.body, /safe tool and context limit/i);
  assert.equal(JSON.parse(readFileSync(item.stateFile, "utf8")).session, null);
});

test("tool-budget cancellation waits for an in-flight mutation commit boundary", async () => {
  let cancellationCountBeforeRelease = null;
  let conversation = null;
  let cancellationSafeDuringMutation = null;
  const item = fixture({
    budgetDuringMutation: true,
    runStatus: "cancelled",
    observeBeforeMutationRelease: (cancellations) => {
      cancellationCountBeforeRelease = cancellations.length;
      cancellationSafeDuringMutation = conversation.cancellationSafe;
    },
  });
  conversation = item.conversation;
  const event = item.conversation.enqueue({ messageKey: "guid-budget-mutation", body: "Act, then keep listing." });
  await item.conversation.execute(event.controllerJobId);

  assert.equal(cancellationCountBeforeRelease, 0);
  assert.equal(cancellationSafeDuringMutation, false);
  assert.equal(item.conversation.cancellationSafe, true);
  assert.deepEqual(item.cancellations, ["ephemeral-1"]);
  assert.equal(item.toolInvocations.filter((invocation) => invocation.tool === "send_task_message").length, 1);
});

test("enforces the cumulative 48 KiB tool-response budget", async () => {
  const item = fixture({
    dynamicToolBurst: true,
    toolResult: { result: { tasks: ["x".repeat(12 * 1024)] } },
    runStatus: "cancelled",
  });
  const event = item.conversation.enqueue({ messageKey: "guid-response-budget", body: "Return every task repeatedly." });
  await item.conversation.execute(event.controllerJobId);

  const responseBytes = item.serverResults.reduce((sum, result) => (
    sum + (result.contentItems || []).reduce((inner, content) => inner + Buffer.byteLength(content.text || "", "utf8"), 0)
  ), 0);
  assert.ok(responseBytes <= 48 * 1024, `tool responses used ${responseBytes} bytes`);
  assert.ok(item.toolCalls() < 17, "execution must stop once the response budget is exhausted");
  assert.deepEqual(item.cancellations, ["ephemeral-1"]);
});

test("an outer controller cancellation denies a late dynamic mutation", async () => {
  const controller = new AbortController();
  const item = fixture({
    abortBeforeLateMutation: () => controller.abort(),
    runStatus: "cancelled",
  });
  const event = item.conversation.enqueue({ messageKey: "guid-late-cancel", body: "Start, then stop." });
  await assert.rejects(
    item.conversation.execute(event.controllerJobId, { signal: controller.signal }),
    (error) => error?.code === "CONTROL_ABORTED",
  );

  assert.equal(item.toolCalls(), 0);
  assert.equal(item.serverResults[0].success, false);
  assert.equal(JSON.parse(item.serverResults[0].contentItems[0].text).error, "CONTROL_ABORTED");
});

test("a completed runner cannot deliver after its controller job is cancelled", async () => {
  const controller = new AbortController();
  const options = { deferResult: true };
  const item = fixture(options);
  const event = item.conversation.enqueue({ messageKey: "guid-result-race", body: "Stop before this result arrives." });
  const execution = item.conversation.execute(event.controllerJobId, { signal: controller.signal });
  while (!options.releaseResult) await new Promise((resolve) => setImmediate(resolve));

  item.conversation.recordControlReceipt("cancel-result-race", {
    outcome: "authorized",
    replyIds: [event.replyId],
  });
  controller.abort();
  item.conversation.applyControlCancellation("cancel-result-race", {
    replyIds: [event.replyId],
    active: true,
  });
  options.releaseResult();

  await assert.rejects(execution, (error) => error?.code === "CONTROL_ABORTED");
  assert.equal(item.deliveries.length, 0);
  assert.deepEqual(item.conversation.pendingEvents(), []);
  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.equal(persisted.session, null);
  assert.equal(persisted.recent.length, 0);
  assert.equal(persisted.controlReceipts["cancel-result-race"].outcome, "applied");
});

test("does not deliver or advance the FIFO while a detached mutation is still settling", async () => {
  const options = { detachedMutation: true };
  const item = fixture(options);
  const event = item.conversation.enqueue({ messageKey: "guid-detached-mutation", body: "Run one action." });
  let settled = false;
  const execution = item.conversation.execute(event.controllerJobId).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(item.deliveries.length, 0);
  assert.equal(item.conversation.cancellationSafe, false);
  options.releaseDetachedMutation();
  await execution;
  assert.equal(item.deliveries.length, 1);
  assert.equal(item.conversation.cancellationSafe, true);
});

test("refuses corrupt state without silently overwriting or replaying it", () => {
  const cases = [
    "{not-json",
    JSON.stringify({ ...validState(), jobs: {} }),
  ];
  for (const [index, contents] of cases.entries()) {
    const root = mkdtempSync(path.join(os.tmpdir(), `hidden-controller-corrupt-${index}-`));
    const stateFile = path.join(root, "state.json");
    writeFileSync(stateFile, contents);
    assert.throws(
      () => new HiddenControllerConversation({
        stateFile,
        identityKey: IDENTITY_KEY,
        cwd: path.join(root, "workspace"),
        runner: {
          client: { request: async () => ({}) },
          createThread: async () => ({ id: "must-not-start" }),
          run: async () => ({ status: "completed", body: "must not run" }),
        },
        send: async () => ({ sent: true }),
        executeTool: async () => ({}),
      }),
      (error) => error?.code === "CONTROLLER_STATE_INVALID",
    );
    assert.equal(readFileSync(stateFile, "utf8"), contents);
  }
});

test("refuses state with more session cleanup obligations than can be retained", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hidden-controller-obligations-"));
  const stateFile = path.join(root, "state.json");
  const session = (index) => ({
    threadId: `ephemeral-${index}`,
    cwd: path.join(root, `session-${index}`),
    createdAt: "2026-07-15T12:00:00.000Z",
    lastUsedAt: "2026-07-15T12:00:00.000Z",
    turnCount: 0,
    contextBytes: 0,
  });
  writeFileSync(stateFile, JSON.stringify(validState(IDENTITY_KEY, {
    session: session("live"),
    retiredSessions: Array.from({ length: 65 }, (_, index) => session(index)),
  })));
  assert.throws(() => new HiddenControllerConversation({
    stateFile,
    identityKey: IDENTITY_KEY,
    cwd: root,
    runner: { client: { request: async () => ({}) } },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  }), (error) => error?.code === "CONTROLLER_STATE_INVALID");
});

test("persists controller action receipts across retries", () => {
  const item = fixture();
  item.conversation.recordControlReceipt("cancel-guid", {
    outcome: "authorized",
    replyIds: ["controller:job-a"],
  });
  item.conversation.recordControlReceipt("cancel-guid", {
    outcome: "applied",
    replyIds: ["controller:job-a"],
    active: true,
    pending: 2,
  });
  const resumed = new HiddenControllerConversation({
    stateFile: item.stateFile,
    identityKey: IDENTITY_KEY,
    cwd: item.controllerRoot,
    runner: { client: { request: async () => ({}) } },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  });
  assert.deepEqual(resumed.controlReceipt("cancel-guid"), {
    outcome: "applied",
    at: item.conversation.controlReceipt("cancel-guid").at,
    replyIds: ["controller:job-a"],
    active: true,
    pending: 2,
  });
});

test("commits cancellation tombstones atomically with the applied receipt", () => {
  const item = fixture();
  const first = item.conversation.enqueue({ messageKey: "cancelled-a", body: "First queued request" });
  const second = item.conversation.enqueue({ messageKey: "cancelled-b", body: "Second queued request" });
  const replyIds = [first.replyId, second.replyId];
  item.conversation.recordControlReceipt("cancel-action", { outcome: "authorized", replyIds });
  const receipt = item.conversation.applyControlCancellation("cancel-action", {
    replyIds,
    active: true,
    pending: 1,
  });

  assert.equal(receipt.outcome, "applied");
  assert.deepEqual(item.conversation.pendingEvents(), []);
  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.deepEqual(persisted.jobs, []);
  assert.deepEqual(persisted.controlReceipts["cancel-action"], receipt);
  assert.ok(persisted.completed.includes("cancelled-a"));
  assert.ok(persisted.completed.includes("cancelled-b"));

  const resumed = new HiddenControllerConversation({
    stateFile: item.stateFile,
    identityKey: IDENTITY_KEY,
    cwd: item.controllerRoot,
    runner: { client: { request: async () => ({}) } },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  });
  assert.deepEqual(resumed.pendingEvents(), []);
  assert.deepEqual(resumed.controlReceipt("cancel-action"), receipt);
});

test("applied receipts from older builds tombstone matching jobs during startup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hidden-controller-applied-recovery-"));
  const stateFile = path.join(root, "state.json");
  const session = {
    threadId: "ephemeral-cancelled",
    cwd: path.join(root, "session-cancelled"),
    createdAt: "2026-07-15T11:59:00.000Z",
    lastUsedAt: "2026-07-15T12:00:00.000Z",
    turnCount: 1,
    contextBytes: 100,
  };
  writeFileSync(stateFile, JSON.stringify(validState(IDENTITY_KEY, {
    session,
    jobs: [{
      id: "cancelled-job",
      messageKey: "cancelled-guid",
      body: "This must not be replayed.",
      attachments: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      status: "queued",
      clientUserMessageId: "controller-cancelled-job",
      delivery: null,
    }],
    controlReceipts: {
      "old-cancel": {
        outcome: "applied",
        at: "2026-07-15T12:00:01.000Z",
        replyIds: ["controller:cancelled-job"],
        active: true,
        pending: 0,
      },
    },
  })));
  const conversation = new HiddenControllerConversation({
    stateFile,
    identityKey: IDENTITY_KEY,
    cwd: root,
    runner: { client: { request: async () => ({}) } },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  });

  assert.deepEqual(conversation.pendingEvents(), []);
  assert.equal(conversation.controlReceipt("old-cancel").outcome, "applied");
  assert.equal(conversation.threadId, null, "a possibly active cancelled session must not be reused");
});

test("quarantines state bound to another iMessage identity and starts empty", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hidden-controller-identity-"));
  const stateFile = path.join(root, "state.json");
  const oldState = JSON.stringify(validState(OTHER_IDENTITY_KEY, {
    jobs: [{
      id: "old-job",
      messageKey: "old-guid",
      body: "Do not execute this old identity's request.",
      attachments: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      status: "queued",
      clientUserMessageId: "old-message",
      delivery: null,
    }],
  }));
  writeFileSync(stateFile, oldState);
  const conversation = new HiddenControllerConversation({
    stateFile,
    identityKey: IDENTITY_KEY,
    cwd: path.join(root, "workspace"),
    runner: {
      client: { request: async () => ({}) },
      createThread: async () => ({ id: "unused" }),
      run: async () => ({ status: "completed", body: "unused" }),
    },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  });

  assert.deepEqual(conversation.pendingEvents(), []);
  assert.equal(existsSync(stateFile), false);
  const quarantines = readdirSync(root).filter((name) => name.startsWith("state.json.identity-mismatch-"));
  assert.equal(quarantines.length, 1);
  assert.equal(readFileSync(path.join(root, quarantines[0]), "utf8"), oldState);

  conversation.enqueue({ messageKey: "new-guid", body: "This belongs to the current identity." });
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).identityKey, IDENTITY_KEY);
  assert.equal(conversation.pendingEvents().length, 1);
});

test("never replays a running ephemeral turn after restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hidden-controller-recovery-"));
  const stateFile = path.join(root, "state.json");
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    identityKey: IDENTITY_KEY,
    session: { threadId: "ephemeral-old", createdAt: "2026-07-15T12:00:00.000Z", lastUsedAt: "2026-07-15T12:00:00.000Z", turnCount: 1, contextBytes: 100 },
    retiredSessions: [],
    jobs: [{ id: "job-a", messageKey: "guid-a", body: "Click it", attachments: [], createdAt: "2026-07-15T12:00:00.000Z", status: "running", clientUserMessageId: "controller-a", delivery: null }],
    completed: [],
    recent: [],
    topLevel: [],
    toolJournal: {},
  }));
  let runCount = 0;
  const deliveries = [];
  const conversation = new HiddenControllerConversation({
    stateFile,
    identityKey: IDENTITY_KEY,
    cwd: root,
    runner: { client: { request: async () => ({}) }, createThread: async () => ({ id: "nope" }), run: async () => { runCount += 1; } },
    send: async (event) => { deliveries.push(event); },
    executeTool: async () => ({}),
  });
  const [event] = conversation.pendingEvents();
  await conversation.execute(event.controllerJobId);
  assert.equal(runCount, 0);
  assert.match(deliveries[0].body, /may have acted/i);
});

test("a submitted ambiguous turn becomes an uncertainty notice rather than a retry", async () => {
  const error = Object.assign(new Error("lost"), { code: "CODEX_DISCONNECTED", turnOutcomeUnknown: true });
  const item = fixture({ runError: error });
  const event = item.conversation.enqueue({ messageKey: "guid-uncertain", body: "Open Settings." });
  const result = await item.conversation.execute(event.controllerJobId);
  assert.equal(result.status, "uncertain");
  assert.equal(item.runs.length, 1);
  assert.match(item.deliveries[0].event.body, /not submitted again/i);
});

test("an externally interrupted turn is delivered once as uncertain and is never resumed", async () => {
  const item = fixture({ runStatus: "interrupted" });
  const event = item.conversation.enqueue({ messageKey: "guid-interrupted", body: "Inspect and act." });
  await item.conversation.execute(event.controllerJobId);

  assert.equal(item.runs.length, 1);
  assert.match(item.deliveries[0].event.body, /not submitted again/i);
  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.deepEqual(persisted.jobs, []);
  assert.equal(persisted.session, null);
  assert.equal(item.conversation.enqueue({ messageKey: "guid-interrupted", body: "Inspect and act." }).completed, true);
});

test("a transient Messages failure retries only delivery and never repeats the controller turn", async () => {
  const item = fixture({ sendError: Object.assign(new Error("offline"), { code: "IMSG_OFFLINE" }) });
  const event = item.conversation.enqueue({ messageKey: "guid-delivery", body: "List active tasks." });
  await assert.rejects(
    item.conversation.execute(event.controllerJobId),
    (error) => error?.code === "CONTROLLER_DELIVERY_PENDING" && error?.controllerDeliveryPending === true,
  );
  assert.equal(item.runs.length, 1);
  assert.equal(JSON.parse(readFileSync(item.stateFile, "utf8")).jobs[0].status, "delivering");

  await item.conversation.execute(event.controllerJobId);
  assert.equal(item.runs.length, 1, "the completed Codex turn must not be submitted again");
  assert.equal(item.sendAttempts(), 2);
  assert.equal(item.deliveries.length, 1);
  assert.equal(JSON.parse(readFileSync(item.stateFile, "utf8")).jobs.length, 0);
});

test("generated-image retry resumes after the last accepted item without duplicating text or images", async () => {
  const item = fixture({
    generatedImages: ["/tmp/controller-one.png", "/tmp/controller-two.png"],
    imageSendError: Object.assign(new Error("offline"), { code: "IMSG_OFFLINE" }),
    imageSendFailureAttempts: [2],
  });
  const event = item.conversation.enqueue({ messageKey: "guid-images", body: "Show me the chart." });

  await assert.rejects(
    item.conversation.execute(event.controllerJobId),
    (error) => error?.code === "CONTROLLER_DELIVERY_PENDING" && error?.controllerDeliveryPending === true,
  );
  let persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.equal(item.runs.length, 1);
  assert.equal(item.deliveries.length, 1);
  assert.deepEqual(item.imageDeliveries.map((entry) => entry.files), [["/tmp/controller-one.png"]]);
  assert.equal(persisted.jobs[0].delivery.imagesDelivered, 1);

  await item.conversation.execute(event.controllerJobId);
  persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.equal(item.runs.length, 1, "a delivery retry must not rerun Codex");
  assert.equal(item.deliveries.length, 1, "the accepted response text must not be duplicated");
  assert.deepEqual(item.imageDeliveries.map((entry) => entry.files), [
    ["/tmp/controller-one.png"],
    ["/tmp/controller-two.png"],
  ]);
  assert.deepEqual(persisted.jobs, []);
});

test("a missing ephemeral thread is discarded and safely recreated before resubmission", async () => {
  const item = fixture({ runErrors: [Object.assign(new Error("missing"), { code: "THREAD_NOT_FOUND" }), null] });
  const event = item.conversation.enqueue({ messageKey: "guid-stale-session", body: "What is running?" });
  await assert.rejects(item.conversation.execute(event.controllerJobId), (error) => error?.code === "THREAD_NOT_FOUND");
  assert.equal(JSON.parse(readFileSync(item.stateFile, "utf8")).session, null);

  await item.conversation.execute(event.controllerJobId);
  assert.equal(item.starts.length, 2);
  assert.equal(item.runs.length, 2);
  assert.equal(item.deliveries.length, 1);
});

test("a full durable inbox rejects new work without evicting an older message", () => {
  const item = fixture();
  const state = validState();
  state.jobs = Array.from({ length: 128 }, (_, index) => ({
    id: `job-${index}`,
    messageKey: `guid-${index}`,
    body: `message ${index}`,
    attachments: [],
    createdAt: "2026-07-15T12:00:00.000Z",
    status: "queued",
    clientUserMessageId: `controller-${index}`,
    delivery: null,
  }));
  writeFileSync(item.stateFile, JSON.stringify(state));
  const reloaded = new HiddenControllerConversation({
    stateFile: item.stateFile,
    identityKey: IDENTITY_KEY,
    cwd: item.root,
    runner: { client: { request: async () => ({}) }, createThread: async () => ({ id: "unused" }), run: async () => ({ status: "completed", body: "unused" }) },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  });
  assert.throws(
    () => reloaded.enqueue({ messageKey: "guid-new", body: "Do not drop the oldest message." }),
    (error) => error?.code === "CONTROLLER_QUEUE_FULL",
  );
  const persisted = JSON.parse(readFileSync(item.stateFile, "utf8"));
  assert.equal(persisted.jobs.length, 128);
  assert.equal(persisted.jobs[0].messageKey, "guid-0");
});

test("capacity waiters wake only after durable room is released", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hidden-controller-capacity-"));
  const stateFile = path.join(root, "state.json");
  const jobs = Array.from({ length: 128 }, (_, index) => ({
    id: `job-${index}`,
    messageKey: `guid-${index}`,
    body: `message ${index}`,
    attachments: [],
    createdAt: "2026-07-15T12:00:00.000Z",
    status: "queued",
    clientUserMessageId: `controller-${index}`,
    delivery: null,
  }));
  writeFileSync(stateFile, JSON.stringify(validState(IDENTITY_KEY, { jobs })));
  const conversation = new HiddenControllerConversation({
    stateFile,
    identityKey: IDENTITY_KEY,
    cwd: path.join(root, "workspace"),
    runner: {
      client: { request: async () => ({}) },
      createThread: async () => ({ id: "unused" }),
      run: async () => ({ status: "completed", body: "unused" }),
    },
    send: async () => ({ sent: true }),
    executeTool: async () => ({}),
  });

  let awakened = false;
  const capacity = conversation.waitForCapacity(30_000).then(() => { awakened = true; });
  await Promise.resolve();
  assert.equal(awakened, false);
  assert.equal(conversation.discard("job-0"), true);
  await capacity;
  assert.equal(awakened, true);

  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.jobs.length, 127);
  assert.equal(persisted.completed.includes("guid-0"), true);
  assert.doesNotThrow(() => conversation.enqueue({ messageKey: "guid-new", body: "Now there is room." }));
});
