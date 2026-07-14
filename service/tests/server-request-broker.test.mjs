import assert from "node:assert/strict";
import test from "node:test";
import { ServerRequestBroker } from "../src/server-request-broker.mjs";

function approval(threadId = "thread-a", requestId = "approval-1", overrides = {}) {
  return {
    kind: "approval",
    method: "item/commandExecution/requestApproval",
    requestId,
    threadId,
    turnId: `turn-${threadId}`,
    approval: "command",
    command: "git status",
    cwd: "/tmp/project",
    reason: "The task needs permission.",
    ...overrides,
  };
}

function fileApproval(threadId = "thread-a", requestId = "file-approval-1", overrides = {}) {
  return approval(threadId, requestId, {
    method: "item/fileChange/requestApproval",
    approval: "fileChange",
    protocol: "v2",
    command: undefined,
    cwd: undefined,
    grantRoot: "/tmp/project",
    ...overrides,
  });
}

function userInput(threadId = "thread-a", questions = []) {
  return {
    kind: "userInput",
    method: "item/tool/requestUserInput",
    requestId: `input-${threadId}`,
    threadId,
    turnId: `turn-${threadId}`,
    questions,
  };
}

function elicitation(threadId = "thread-a", overrides = {}) {
  return {
    kind: "elicitation",
    method: "mcpServer/elicitation/request",
    requestId: `elicitation-${threadId}`,
    threadId,
    turnId: `turn-${threadId}`,
    mode: "form",
    serverName: "calendar",
    message: "Enter the requested details.",
    ...overrides,
  };
}

function dynamicTool(threadId = "thread-a") {
  return {
    kind: "dynamicTool",
    method: "item/tool/call",
    requestId: `tool-${threadId}`,
    threadId,
    turnId: `turn-${threadId}`,
    namespace: "mobile",
    tool: "confirm",
    arguments: { operation: "deploy" },
  };
}

function harness(overrides = {}) {
  const texts = [];
  const choiceMessages = [];
  const broker = new ServerRequestBroker({
    sendText: overrides.sendText || (async (message) => { texts.push(message); }),
    sendChoices: overrides.sendChoices || (async (message) => { choiceMessages.push(message); }),
  });
  return { broker, texts, choiceMessages };
}

function tokenFor(message, label) {
  const choice = message?.choices?.find((entry) => entry.label === label);
  assert.ok(choice, `missing choice ${label}`);
  assert.match(choice.token, /^request:/);
  return choice.token;
}

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("approval choices and text replies map to bounded app-server decisions", async (t) => {
  const cases = [
    { reply: { type: "choice", label: "Allow once" }, expected: "accept" },
    { reply: { type: "choice", label: "Allow for session" }, expected: "acceptForSession" },
    { reply: { type: "choice", label: "Deny" }, expected: "decline" },
    { reply: { type: "text", body: "always" }, expected: "acceptForSession" },
    { reply: { type: "text", body: "cancel" }, expected: "cancel" },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.expected, async () => {
      const { broker, texts, choiceMessages } = harness();
      const result = broker.request(approval("thread-a", `approval-${index}`));
      await waitFor(() => choiceMessages.length === 1);
      assert.match(texts[0].body, /Codex wants to run an action/);
      assert.match(texts[0].body, /git status/);
      assert.equal(broker.pending("thread-a"), true);

      if (entry.reply.type === "choice") {
        const response = await broker.handleAction({
          kind: "control",
          command: "respond",
          argument: tokenFor(choiceMessages[0], entry.reply.label),
          threadId: "thread-a",
        });
        assert.deepEqual(response, { handled: true, accepted: true, stale: false });
      } else {
        const response = await broker.handleAction({ kind: "prompt", body: entry.reply.body, threadId: "thread-a" });
        assert.deepEqual(response, { handled: true, accepted: true, stale: false });
      }
      assert.deepEqual(await result, { decision: entry.expected });
      assert.equal(broker.pending("thread-a"), false);
      broker.stop();
    });
  }
});

test("truncated command and file approvals are denied without actionable choices", async (t) => {
  const cases = [
    {
      name: "command",
      descriptor: approval("thread-command", "truncated-command", {
        command: "curl https://example.com/partial",
        truncated: true,
      }),
    },
    {
      name: "file changes",
      descriptor: fileApproval("thread-files", "truncated-files", {
        protocol: "legacy",
        truncated: true,
        changes: [{ path: "/tmp/project/file.txt", type: "update", preview: "partial diff" }],
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { broker, texts, choiceMessages } = harness();
      assert.deepEqual(await broker.request(entry.descriptor), { decision: "decline" });
      assert.equal(broker.pending(entry.descriptor.threadId), false);
      await flush();
      assert.equal(texts.length, 1);
      assert.match(texts[0].body, /exceeded the safe display limit.*denied/i);
      assert.doesNotMatch(texts[0].body, /Choose below|reply.*allow/i);
      assert.deepEqual(choiceMessages, []);
    });
  }
});

test("command approvals without a reviewable command fail closed without choices", async (t) => {
  const cases = [
    {
      name: "missing command",
      descriptor: approval("thread-missing-command", "missing-command", {
        command: undefined,
        commandActions: undefined,
      }),
    },
    {
      name: "unusable command actions",
      descriptor: approval("thread-unusable-actions", "unusable-actions", {
        command: "   ",
        commandActions: [{ type: "unknown" }],
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { broker, texts, choiceMessages } = harness();
      assert.deepEqual(await broker.request(entry.descriptor), { decision: "decline" });
      assert.equal(broker.pending(entry.descriptor.threadId), false);
      await flush();
      assert.equal(texts.length, 1);
      assert.match(texts[0].body, /complete, reviewable command.*denied/i);
      assert.doesNotMatch(texts[0].body, /Choose below|reply.*allow/i);
      assert.deepEqual(choiceMessages, []);
    });
  }
});

test("usable legacy commandActions provide the complete reviewable command disclosure", async () => {
  const { broker, texts, choiceMessages } = harness();
  const result = broker.request(approval("thread-actions", "usable-actions", {
    command: undefined,
    commandActions: [{ type: "unknown", cmd: "git status --short" }],
  }));

  await waitFor(() => choiceMessages.length === 1);
  assert.match(texts[0].body, /Command actions\n[\s\S]*"cmd": "git status --short"/);
  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-actions" });
  assert.deepEqual(await result, { decision: "decline" });
});

test("a descriptor-sized command is shown through its suffix before Allow is available", async () => {
  const { broker, texts, choiceMessages } = harness();
  const suffix = "COMMAND-SUFFIX-MUST-BE-VISIBLE";
  const command = `printf '%s' ${"x".repeat(10_000)} ${suffix}`;
  const result = broker.request(approval("thread-long-command", "long-command", { command }));

  await waitFor(() => choiceMessages.length === 1);
  assert.ok(texts[0].body.length > 10_000);
  assert.ok(texts[0].body.indexOf(suffix) > 8_000);
  assert.ok(texts[0].body.indexOf(suffix) < texts[0].body.indexOf("Choose below"));
  await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: tokenFor(choiceMessages[0], "Allow once"),
    threadId: "thread-long-command",
  });
  assert.deepEqual(await result, { decision: "accept" });
});

test("all 32 bounded file changes are shown before Allow is available", async () => {
  const { broker, texts, choiceMessages } = harness();
  const changes = Array.from({ length: 32 }, (_, index) => ({
    path: `/tmp/project/file-${String(index + 1).padStart(2, "0")}.txt`,
    type: "update",
    preview: `change-${index + 1}`,
  }));
  const result = broker.request(fileApproval("thread-32-files", "all-files", {
    protocol: "legacy",
    changes,
  }));

  await waitFor(() => choiceMessages.length === 1);
  const body = texts[0].body;
  for (let index = 17; index <= 32; index += 1) {
    assert.match(body, new RegExp(`${index}\\. /tmp/project/file-${String(index).padStart(2, "0")}\\.txt`));
  }
  assert.ok(body.indexOf("32. /tmp/project/file-32.txt") < body.indexOf("Choose below"));
  await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: tokenFor(choiceMessages[0], "Allow once"),
    threadId: "thread-32-files",
  });
  assert.deepEqual(await result, { decision: "accept" });
});

test("bounded approval metadata, paths, move targets, and previews render through their suffixes", async () => {
  const { broker, texts, choiceMessages } = harness();
  const marker = (fill, size, suffix) => `${fill.repeat(size - suffix.length)}${suffix}`;
  const descriptor = fileApproval("thread-boundaries", "boundary-fields", {
    protocol: "legacy",
    reason: marker("r", 4_096, "REASON-END"),
    cwd: marker("c", 4_096, "CWD-END"),
    grantRoot: marker("g", 4_096, "GRANT-END"),
    changes: [{
      path: marker("p", 4_096, "PATH-END"),
      type: marker("t", 64, "TYPE-END"),
      movePath: marker("m", 4_096, "MOVE-END"),
      preview: marker("v", 2_048, "PREVIEW-END"),
    }],
  });
  const result = broker.request(descriptor);

  await waitFor(() => choiceMessages.length === 1);
  for (const suffix of ["REASON-END", "CWD-END", "GRANT-END", "PATH-END", "TYPE-END", "MOVE-END", "PREVIEW-END"]) {
    assert.match(texts[0].body, new RegExp(suffix));
  }
  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-boundaries" });
  assert.deepEqual(await result, { decision: "decline" });
});

test("an approval that cannot be rendered losslessly is denied without choices", async () => {
  const { broker, texts, choiceMessages } = harness();
  const commandActions = [{ type: "unknown", command: "git status" }];
  commandActions[0].metadata = commandActions;
  const descriptor = approval("thread-unrenderable", "unrenderable", {
    command: undefined,
    commandActions,
  });

  assert.deepEqual(await broker.request(descriptor), { decision: "decline" });
  await flush();
  assert.match(texts[0].body, /could not be presented completely.*denied/i);
  assert.deepEqual(choiceMessages, []);
});

test("undisclosed v2 file changes fail closed while showing their grant root", async () => {
  const { broker, texts, choiceMessages } = harness();
  const descriptor = fileApproval("thread-files", "undisclosed-files", {
    grantRoot: "/outside/project",
  });

  assert.deepEqual(await broker.request(descriptor), { decision: "decline" });
  assert.equal(broker.pending("thread-files"), false);
  await flush();
  assert.equal(texts.length, 1);
  assert.match(texts[0].body, /complete, reviewable file list.*denied/i);
  assert.match(texts[0].body, /Grant root\n\/outside\/project/);
  assert.doesNotMatch(texts[0].body, /Allow for session|Choose below|reply.*always/i);
  assert.deepEqual(choiceMessages, []);
});

test("a concrete file approval renders its grant root and reviewable changes", async () => {
  const { broker, texts, choiceMessages } = harness();
  const result = broker.request(fileApproval("thread-files", "concrete-files", {
    protocol: "legacy",
    grantRoot: "/tmp/project",
    changes: [{
      path: "/tmp/project/file.txt",
      type: "update",
      preview: "@@ -1 +1 @@",
    }],
  }));

  await waitFor(() => choiceMessages.length === 1);
  assert.match(texts[0].body, /Grant root\n\/tmp\/project/);
  assert.match(texts[0].body, /Changes\n1\. \/tmp\/project\/file\.txt\nType\nupdate/);
  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-files" });
  assert.deepEqual(await result, { decision: "decline" });
});

test("invalid approval replies give guidance without granting authority", async () => {
  const { broker, texts } = harness();
  const result = broker.request(approval());
  await waitFor(() => texts.length === 1);
  const response = await broker.handleAction({ kind: "prompt", body: "do whatever you want", threadId: "thread-a" });
  assert.deepEqual(response, { handled: true, accepted: false, stale: false });
  assert.equal(broker.pending("thread-a"), true);
  assert.match(texts[1].body, /allow.*always.*deny/i);
  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-a" });
  assert.deepEqual(await result, { decision: "decline" });
});

test("requests are FIFO per task while different tasks remain independent", async () => {
  const { broker, texts, choiceMessages } = harness();
  const first = broker.request(approval("thread-a", "first", { command: "first command" }));
  const second = broker.request(approval("thread-a", "second", { command: "second command" }));
  const independent = broker.request(approval("thread-b", "independent", { command: "other task command" }));
  await waitFor(() => choiceMessages.length === 2);

  assert.deepEqual(new Set(texts.map((entry) => entry.threadId)), new Set(["thread-a", "thread-b"]));
  assert.equal(texts.some((entry) => entry.body.includes("second command")), false);
  const oldToken = tokenFor(choiceMessages.find((entry) => entry.threadId === "thread-a"), "Allow once");

  await broker.handleAction({ kind: "prompt", body: "allow", threadId: "thread-a" });
  assert.deepEqual(await first, { decision: "accept" });
  await waitFor(() => texts.some((entry) => entry.body.includes("second command")));

  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: oldToken,
    threadId: "thread-a",
  }), { handled: true, stale: true });
  assert.equal(broker.pending("thread-a"), true);

  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-a" });
  await broker.handleAction({ kind: "prompt", body: "allow", threadId: "thread-b" });
  assert.deepEqual(await second, { decision: "decline" });
  assert.deepEqual(await independent, { decision: "accept" });
});

test("multi-question user input supports options, added choices, and step-scoped tokens", async () => {
  const { broker, texts, choiceMessages } = harness();
  const result = broker.request(userInput("thread-a", [
    {
      id: "environment",
      header: "Environment",
      question: "Where should this run?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Staging", description: "Use the test deployment." },
        { label: "Production", description: "Use the live deployment." },
      ],
    },
    {
      id: "region",
      header: "Region",
      question: "Choose a region.",
      isOther: false,
      isSecret: false,
      options: [{ label: "West" }, { label: "East" }],
    },
  ]));
  await waitFor(() => choiceMessages.length === 1);
  const firstPoll = choiceMessages[0];
  assert.equal(firstPoll.allowOther, true);
  assert.match(firstPoll.choices[0].label, /Staging · Use the test deployment/);
  assert.match(firstPoll.otherToken, /^request:/);
  const staleOptionToken = tokenFor(firstPoll, "Production · Use the live deployment.");

  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    commandArgument: firstPoll.otherToken,
    argument: "Canary",
    threadId: "thread-a",
  }), { handled: true, accepted: true, stale: false });
  await waitFor(() => choiceMessages.length === 2);
  assert.match(texts.at(-1).body, /Question 2 of 2/);

  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: staleOptionToken,
    threadId: "thread-a",
  }), { handled: true, stale: true });

  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: tokenFor(choiceMessages[1], "West"),
    threadId: "thread-a",
  }), { handled: true, accepted: true, stale: false });
  assert.deepEqual(await result, {
    answers: {
      environment: ["Canary"],
      region: ["West"],
    },
  });
});

test("secret questions fail closed without entering the task queue or leaking the prompt", async () => {
  const texts = [];
  const broker = new ServerRequestBroker({
    sendText: async (message) => {
      texts.push(message);
      throw new Error("notification unavailable");
    },
    sendChoices: async () => assert.fail("secret requests must not create choices"),
  });
  const result = await broker.request(userInput("secret-thread", [
    {
      id: "password",
      header: "Password",
      question: "Send the launch password SUPER-SECRET-VALUE.",
      isSecret: true,
      isOther: false,
      options: null,
    },
  ]));
  assert.deepEqual(result, { answers: {} });
  assert.equal(broker.pending("secret-thread"), false);
  await flush();
  assert.equal(texts.length, 1);
  assert.match(texts[0].body, /never accepted through Messages/);
  assert.doesNotMatch(texts[0].body, /SUPER-SECRET-VALUE/);
});

test("secret fail-closed behavior survives synchronous presentation failures", async () => {
  const broker = new ServerRequestBroker({
    sendText: () => { throw new Error("synchronous transport failure"); },
    sendChoices: async () => {},
  });
  const result = await broker.request(userInput("secret-thread", [{
    id: "secret",
    question: "Secret?",
    isSecret: true,
    options: null,
  }]));
  assert.deepEqual(result, { answers: {} });
  assert.equal(broker.pending("secret-thread"), false);
});

test("form elicitation accepts bounded JSON and supports deny or cancel", async (t) => {
  await t.test("accept form content", async () => {
    const { broker, texts } = harness();
    const result = broker.request(elicitation());
    await waitFor(() => texts.length === 1);
    assert.match(texts[0].body, /calendar/);
    assert.deepEqual(await broker.handleAction({
      kind: "prompt",
      body: "not-json",
      threadId: "thread-a",
    }), { handled: true, accepted: false, stale: false });
    assert.equal(broker.pending("thread-a"), true);
    await broker.handleAction({
      kind: "prompt",
      body: '{"date":"2026-07-14"}',
      threadId: "thread-a",
    });
    assert.deepEqual(await result, { action: "accept", content: { date: "2026-07-14" } });
  });

  for (const terminal of ["deny", "cancel"]) {
    await t.test(terminal, async () => {
      const { broker, texts } = harness();
      const result = broker.request(elicitation());
      await waitFor(() => texts.length === 1);
      await broker.handleAction({ kind: "prompt", body: terminal, threadId: "thread-a" });
      assert.deepEqual(await result, { action: terminal === "deny" ? "decline" : "cancel" });
    });
  }
});

test("URL elicitation only accepts its explicit Continue, Deny, or Cancel choices", async () => {
  const { broker, texts, choiceMessages } = harness();
  const result = broker.request(elicitation("thread-url", {
    mode: "url",
    url: "https://example.com/authorize",
    elicitationId: "url-1",
  }));
  await waitFor(() => choiceMessages.length === 1);
  assert.match(texts[0].body, /https:\/\/example\.com\/authorize/);

  assert.deepEqual(await broker.handleAction({
    kind: "prompt",
    body: '{"unexpected":"content"}',
    threadId: "thread-url",
  }), { handled: true, accepted: false, stale: false });
  assert.equal(broker.pending("thread-url"), true);

  await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: tokenFor(choiceMessages[0], "Continue"),
    threadId: "thread-url",
  });
  assert.deepEqual(await result, { action: "accept", content: null });
});

test("dynamic tool results return text only and terminal replies fail closed", async (t) => {
  await t.test("text result", async () => {
    const { broker, texts } = harness();
    const result = broker.request(dynamicTool());
    await waitFor(() => texts.length === 1);
    assert.match(texts[0].body, /mobile · confirm/);
    assert.match(texts[0].body, /deploy/);
    await broker.handleAction({ kind: "prompt", body: "Deployment confirmed.", threadId: "thread-a" });
    assert.deepEqual(await result, {
      success: true,
      contentItems: [{ type: "text", text: "Deployment confirmed." }],
    });
  });

  for (const terminal of ["fail", "cancel"]) {
    await t.test(terminal, async () => {
      const { broker, texts } = harness();
      const result = broker.request(dynamicTool());
      await waitFor(() => texts.length === 1);
      await broker.handleAction({ kind: "prompt", body: terminal, threadId: "thread-a" });
      assert.deepEqual(await result, { success: false, contentItems: [] });
    });
  }
});

test("settled and foreign response tokens are stale and cannot affect another task", async () => {
  const { broker, choiceMessages } = harness();
  const result = broker.request(approval());
  await waitFor(() => choiceMessages.length === 1);
  const token = tokenFor(choiceMessages[0], "Allow once");

  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: token,
    threadId: "foreign-thread",
  }), { handled: true, stale: true });
  assert.equal(broker.pending("thread-a"), true);

  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-a" });
  assert.deepEqual(await result, { decision: "decline" });
  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: token,
    threadId: "thread-a",
  }), { handled: true, stale: true });
});

test("abort rejects active and queued requests and never presents the aborted queue entry", async () => {
  const { broker, texts } = harness();
  const active = broker.request(approval("thread-a", "active"));
  const controller = new AbortController();
  const queued = broker.request(approval("thread-a", "queued", { command: "must never appear" }), {
    signal: controller.signal,
  });
  await waitFor(() => texts.length === 1);
  controller.abort();
  await assert.rejects(queued, (error) => error?.code === "CODEX_INTERACTION_ABORTED");
  assert.equal(texts.some((entry) => entry.body.includes("must never appear")), false);
  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-a" });
  assert.deepEqual(await active, { decision: "decline" });
});

test("abort during presentation cannot emit a ghost choices poll", async () => {
  let releaseText;
  const textStarted = new Promise((resolve) => { releaseText = resolve; });
  let allowTextToFinish;
  const textGate = new Promise((resolve) => { allowTextToFinish = resolve; });
  const choiceMessages = [];
  const broker = new ServerRequestBroker({
    sendText: async () => {
      releaseText();
      await textGate;
    },
    sendChoices: async (message) => { choiceMessages.push(message); },
  });
  const controller = new AbortController();
  const result = broker.request(approval(), { signal: controller.signal });
  await textStarted;
  controller.abort();
  await assert.rejects(result, (error) => error?.code === "CODEX_INTERACTION_ABORTED");
  allowTextToFinish();
  await flush();
  assert.deepEqual(choiceMessages, []);
});

test("stop rejects all work, invalidates tokens, and rejects future requests", async () => {
  const { broker, choiceMessages } = harness();
  const active = broker.request(approval("thread-a", "active"));
  const queued = broker.request(approval("thread-a", "queued"));
  await waitFor(() => choiceMessages.length === 1);
  const token = tokenFor(choiceMessages[0], "Allow once");
  broker.stop();
  await assert.rejects(active, (error) => error?.code === "CODEX_INTERACTION_STOPPED");
  await assert.rejects(queued, (error) => error?.code === "CODEX_INTERACTION_STOPPED");
  assert.equal(broker.pending("thread-a"), false);
  assert.deepEqual(await broker.handleAction({
    kind: "control",
    command: "respond",
    argument: token,
    threadId: "thread-a",
  }), { handled: true, stale: true });
  await assert.rejects(broker.request(approval()), (error) => error?.code === "CODEX_INTERACTION_STOPPED");
});

test("initial text and choices presentation failures reject safely and release the task", async (t) => {
  for (const stage of ["text", "choices"]) {
    await t.test(stage, async () => {
      const broker = new ServerRequestBroker({
        sendText: async () => {
          if (stage === "text") throw new Error("text transport failed");
        },
        sendChoices: async () => {
          if (stage === "choices") throw new Error("poll transport failed");
        },
      });
      const result = broker.request(approval());
      await assert.rejects(result, (error) => (
        error?.code === "CODEX_INTERACTION_DELIVERY_FAILED" && /transport failed/.test(error.message)
      ));
      assert.equal(broker.pending("thread-a"), false);
    });
  }
});

test("a failed presentation releases the FIFO queue so the next request can proceed", async () => {
  const texts = [];
  const choices = [];
  const broker = new ServerRequestBroker({
    sendText: async (message) => {
      if (message.descriptor.requestId === "broken") throw new Error("first delivery failed");
      texts.push(message);
    },
    sendChoices: async (message) => { choices.push(message); },
  });
  const broken = broker.request(approval("thread-a", "broken"));
  const next = broker.request(approval("thread-a", "next", { command: "safe next request" }));
  await assert.rejects(broken, (error) => error?.code === "CODEX_INTERACTION_DELIVERY_FAILED");
  await waitFor(() => choices.length === 1);
  assert.match(texts[0].body, /safe next request/);
  await broker.handleAction({ kind: "prompt", body: "deny", threadId: "thread-a" });
  assert.deepEqual(await next, { decision: "decline" });
});

test("guidance delivery failure rejects the request instead of leaving it pending", async () => {
  const broker = new ServerRequestBroker({
    sendText: async (message) => {
      if (message.deliveryId.includes(":guidance:")) throw new Error("guidance delivery failed");
    },
    sendChoices: async () => {},
  });
  const result = broker.request(approval());
  await waitFor(() => broker.pending("thread-a"));
  assert.deepEqual(
    await broker.handleAction({ kind: "prompt", body: "ambiguous", threadId: "thread-a" }),
    { handled: true, accepted: false, stale: false, deliveryFailed: true },
  );
  await assert.rejects(result, (error) => error?.code === "CODEX_INTERACTION_DELIVERY_FAILED");
  assert.equal(broker.pending("thread-a"), false);
});

test("failure while presenting a later question rejects the whole request", async () => {
  const broker = new ServerRequestBroker({
    sendText: async (message) => {
      if (message.deliveryId.includes(":step:1:text")) throw new Error("second question failed");
    },
    sendChoices: async () => {},
  });
  const result = broker.request(userInput("thread-a", [
    { id: "first", question: "First?", isOther: false, isSecret: false, options: null },
    { id: "second", question: "Second?", isOther: false, isSecret: false, options: null },
  ]));
  await waitFor(() => broker.pending("thread-a"));
  assert.deepEqual(
    await broker.handleAction({ kind: "prompt", body: "one", threadId: "thread-a" }),
    { handled: true, accepted: false, stale: false, deliveryFailed: true },
  );
  await assert.rejects(result, (error) => error?.code === "CODEX_INTERACTION_DELIVERY_FAILED");
  assert.equal(broker.pending("thread-a"), false);
});

test("unsupported requests and per-task overflow fail closed", async () => {
  const { broker } = harness();
  await assert.rejects(
    broker.request({ kind: "unknown", method: "unknown/request", requestId: "1", threadId: "unknown-thread" }),
    (error) => error?.code === "CODEX_INTERACTION_DELIVERY_FAILED",
  );

  const requests = Array.from({ length: 8 }, (_, index) => (
    broker.request(approval("busy-thread", `approval-${index}`))
  ));
  await assert.rejects(
    broker.request(approval("busy-thread", "overflow")),
    (error) => error?.code === "CODEX_INTERACTION_OVERFLOW",
  );
  broker.stop();
  await Promise.all(requests.map((request) => assert.rejects(
    request,
    (error) => error?.code === "CODEX_INTERACTION_STOPPED",
  )));
});
