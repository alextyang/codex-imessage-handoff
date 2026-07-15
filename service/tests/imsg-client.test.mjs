import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { ImsgClient } from "../src/imsg-client.mjs";
import {
  IMSG_RPC_SEND_TIMEOUT_MS,
  IMSG_UPSTREAM_BRIDGE_SEND_TIMEOUT_MS,
} from "../src/imsg-timeouts.mjs";

const fullStatus = {
  version: "0.13.0",
  basic_features: true,
  advanced_features: true,
  poll_caption_control: true,
  custom_emoji_tapbacks: true,
  typing_indicators: true,
  read_receipts: true,
  sip: "disabled",
  bridge_version: 2,
  v2_ready: true,
  selectors: {
    clientMessageGuid: true,
    urlPreviewMessage: true,
    sendRichLinkAction: true,
    pollPayloadMessage: true,
    pollVoteMessage: true,
    editMessage: true,
    retractMessagePart: true,
  },
  rpc_methods: [
    "chats.list",
    "watch.subscribe",
    "watch.unsubscribe",
    "send.rich",
    "send.rich.client-guid",
    "send.attachment",
    "poll.send",
    "poll.vote",
    "poll.unvote",
    "tapback",
    "typing",
    "read",
    "message.send_status",
    "message.edit",
    "message.unsend",
  ],
};

function execFixture(status = fullStatus, options = {}) {
  const calls = [];
  const implementation = (file, args, _execOptions, callback) => {
    calls.push({ file, args });
    queueMicrotask(() => {
      if (args[0] === "--version") callback(null, "imsg 0.13.0\n", "");
      else if (args[0] === "status") callback(null, `${JSON.stringify(status)}\n`, "");
      else if (args[0] === "history" && options.history !== undefined) {
        const rows = Array.isArray(options.history) ? options.history : options.history ? [options.history] : [];
        callback(null, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "");
      }
      else if (args[0] === "send" && options.cliSend !== false) callback(null, `${JSON.stringify({ status: "sent", guid: "CLI-GUID" })}\n`, "");
      else callback(Object.assign(new Error("failed"), { code: options.errorCode || 1 }), "", "sensitive diagnostic");
    });
  };
  return { calls, implementation };
}

class FakeChild extends EventEmitter {
  constructor(onRequest = () => {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 123;
    this.exitCode = null;
    this.killed = false;
    this.requests = [];
    this.closed = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const lines = String(chunk).split("\n").filter(Boolean);
        for (const line of lines) {
          const request = JSON.parse(line);
          this.requests.push(request);
          onRequest(request, this);
        }
        callback();
      },
    });
    this.stdin.on("finish", () => this.close(0));
  }

  json(value, chunks = null) {
    const line = `${JSON.stringify(value)}\n`;
    if (!chunks) {
      this.stdout.write(line);
      return;
    }
    let offset = 0;
    for (const length of chunks) {
      this.stdout.write(line.slice(offset, offset + length));
      offset += length;
    }
    if (offset < line.length) this.stdout.write(line.slice(offset));
  }

  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    queueMicrotask(() => this.emit("close", code, null));
  }

  kill() {
    this.killed = true;
    this.close(0);
    return true;
  }
}

function respondingChild(overrides = {}) {
  return new FakeChild((request, child) => {
    if (overrides[request.method]) return overrides[request.method](request, child);
    queueMicrotask(() => child.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
  });
}

function createClient({ status = fullStatus, child, spawnImpl, execOptions, ...options } = {}) {
  const exec = execFixture(status, execOptions);
  const spawned = child || respondingChild();
  const client = new ImsgClient({
    binary: "/fake/imsg",
    execFileImpl: exec.implementation,
    spawnImpl: spawnImpl || (() => spawned),
    rpcTimeoutMs: 40,
    sendTimeoutMs: 40,
    stopTimeoutMs: 10,
    ...options,
  });
  return { client, child: spawned, execCalls: exec.calls };
}

test("default RPC send timeout exceeds imsg's full private-bridge window", () => {
  const { client } = createClient({ sendTimeoutMs: undefined });

  assert.equal(client.sendTimeoutMs, IMSG_RPC_SEND_TIMEOUT_MS);
  assert.ok(client.sendTimeoutMs > IMSG_UPSTREAM_BRIDGE_SEND_TIMEOUT_MS);
});

test("locates imsg and reports normalized basic and bridge capabilities", async () => {
  const { client, execCalls } = createClient();
  const status = await client.probeCapabilities();

  assert.equal(status.available, true);
  assert.equal(status.version, "0.13.0");
  assert.equal(status.capabilities.richText, true);
  assert.equal(status.capabilities.clientMessageGuid, true);
  assert.equal(status.capabilities.urlPreviews, true);
  assert.equal(status.capabilities.polls, true);
  assert.equal(status.capabilities.pollCaptionControl, true);
  assert.equal(status.capabilities.pollVoting, true);
  assert.equal(status.capabilities.customEmojiTapbacks, true);
  assert.equal(status.capabilities.typing, true);
  assert.equal(status.capabilities.readReceipts, true);
  assert.equal(status.capabilities.edits, true);
  assert.equal(status.capabilities.unsend, true);
  assert.deepEqual(execCalls.map((call) => call.args), [["--version"], ["status", "--json"]]);
});

test("recognizes the macOS 27 translation-aware edit selector", async () => {
  const statusFixture = {
    ...fullStatus,
    selectors: {
      ...fullStatus.selectors,
      editMessage: false,
      editMessageItem: false,
      editMessageItemTranslation: true,
    },
  };
  const { client } = createClient({ status: statusFixture });

  const status = await client.probeCapabilities();

  assert.equal(status.capabilities.edits, true);
});

test("reads one latest local message to baseline a new conversation without RPC", async () => {
  const latest = { id: 902, guid: "LATEST", text: "private existing history" };
  const { client, execCalls } = createClient({ execOptions: { history: [
    { id: 901, guid: "CHRONOLOGICALLY-LATER", text: "outbound copy" },
    latest,
    { id: 900, guid: "OLDER", text: "older copy" },
  ] } });
  assert.deepEqual(await client.latestMessage({ chat_id: 42 }), latest);
  const historyCall = execCalls.find((call) => call.args[0] === "history");
  assert.deepEqual(historyCall.args, ["history", "--chat-id", "42", "--limit", "50", "--json"]);
  assert.equal((await client.latestMessage({ chat_id: 42 })).text, "private existing history");
});

test("frames fragmented JSON-RPC lines and correlates concurrent request IDs", async () => {
  const delayed = new Map();
  const child = respondingChild({
    "chats.list": (request, process) => queueMicrotask(() => process.json({ jsonrpc: "2.0", id: request.id, result: { chats: [] } }, [1, 2, 4])),
    alpha: (request) => delayed.set("alpha", request),
    beta: (request, process) => {
      delayed.set("beta", request);
      queueMicrotask(() => {
        const first = delayed.get("alpha");
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { value: "b" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { value: "a" } })}\n`,
        );
      });
    },
  });
  const { client } = createClient({ child });
  await client.start();

  const [alpha, beta] = await Promise.all([client.request("alpha"), client.request("beta")]);
  assert.deepEqual(alpha, { value: "a" });
  assert.deepEqual(beta, { value: "b" });
  await client.stop();
});

test("routes watch notifications and unsubscribes without leaking handlers", async () => {
  let subscriptionRequest;
  const child = respondingChild({
    "watch.subscribe": (request, process) => {
      subscriptionRequest = request;
      queueMicrotask(() => process.json({ jsonrpc: "2.0", id: request.id, result: { subscription: 9 } }));
    },
  });
  const { client } = createClient({ child });
  const messages = [];
  const watch = await client.subscribeWatch({ chat_id: 42, include_reactions: true }, (message) => messages.push(message));
  child.json({ jsonrpc: "2.0", method: "message", params: { subscription: 9, message: { guid: "INBOUND", text: "hello" } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscriptionRequest.params.chat_id, 42);
  assert.deepEqual(messages, [{ guid: "INBOUND", text: "hello" }]);
  assert.equal(await watch.unsubscribe(), true);
  child.json({ jsonrpc: "2.0", method: "message", params: { subscription: 9, message: { guid: "LATE" } } });
  assert.equal(messages.length, 1);
  await client.stop();
});

test("rejects oversized RPC lines and bounds outbound requests", async () => {
  const child = respondingChild({ query: (_request, process) => queueMicrotask(() => process.stdout.write("x".repeat(65))) });
  const { client } = createClient({ child, maxLineBytes: 64, maxMessageBytes: 1024 });
  await client.start();
  await assert.rejects(client.request("query", { value: "hello" }), { code: "IMSG_RPC_LINE_TOO_LARGE" });
  assert.equal(child.killed, true);

  const second = createClient({ maxMessageBytes: 80 });
  await second.client.start();
  await assert.rejects(second.client.request("query", { value: "x".repeat(100) }), { code: "IMSG_MESSAGE_TOO_LARGE", attempted: false });
  await second.client.stop();
});

test("advanced send capability failures fail closed before delivery", async () => {
  const noBridge = { ...fullStatus, advanced_features: false, v2_ready: false };
  const { client, child } = createClient({ status: noBridge });

  const formatted = await client.sendRich({ chat_id: 42, text: "hello", formatting: [{ start: 0, length: 5, styles: ["bold"] }] });
  const reply = await client.sendRich({ chat_id: 42, text: "hello", reply_to: "PARENT" });
  const link = await client.sendRich({ chat_id: 42, url: "https://example.com" });
  const file = await client.sendRich({ chat_id: 42, file: "/tmp/image.png" });

  assert.deepEqual([formatted, reply, link, file].map((result) => result.classification),
    ["unsupported", "unsupported", "unsupported", "unsupported"]);
  assert.equal(child.requests.length, 0, "capability rejection must happen before spawning RPC");
});

test("caller-owned message GUIDs are canonical, capability-gated, and forwarded unchanged", async () => {
  const guid = "12345678-1234-4ABC-8DEF-1234567890AB";
  const { client, child } = createClient();
  const sent = await client.sendRich({
    chat_id: 42,
    text: "clean mirror",
    reply_to: "PARENT",
    dd_scan: false,
    client_guid: guid,
  });
  assert.equal(sent.classification, "accepted");
  const request = child.requests.find((item) => item.method === "send.rich.client-guid");
  assert.equal(request.params.client_guid, guid);
  assert.equal(request.params.text, "clean mirror");

  const count = child.requests.length;
  assert.equal((await client.sendRich({ chat_id: 42, text: "bad", client_guid: guid.toLowerCase() })).classification, "unsupported");
  assert.equal(child.requests.length, count, "an invalid GUID must fail before an RPC write");
  await client.stop();

  const unsupportedStatus = structuredClone(fullStatus);
  delete unsupportedStatus.selectors.clientMessageGuid;
  const missing = createClient({ status: unsupportedStatus });
  assert.equal((await missing.client.sendRich({ chat_id: 42, text: "blocked", client_guid: guid })).classification, "unsupported");
  assert.equal(missing.child.requests.length, 0);

  const mixedVersionStatus = structuredClone(fullStatus);
  mixedVersionStatus.rpc_methods = mixedVersionStatus.rpc_methods.filter((method) => method !== "send.rich.client-guid");
  const mixedVersion = createClient({ status: mixedVersionStatus });
  assert.equal(mixedVersionStatus.selectors.clientMessageGuid, true,
    "the newer injected helper advertises GUID construction");
  assert.equal((await mixedVersion.client.sendRich({
    chat_id: 42,
    text: "must not use the legacy RPC method",
    client_guid: guid,
  })).classification, "unsupported");
  assert.equal(mixedVersion.child.requests.length, 0,
    "a newer helper cannot make an older RPC binary safe to send through");
});

test("an RPC binary swapped after capability probing rejects the distinct GUID method without legacy fallback", async () => {
  const guid = "12345678-1234-4ABC-8DEF-1234567890AB";
  const child = respondingChild({
    "send.rich.client-guid": (request, process) => queueMicrotask(() => process.json({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" },
    })),
  });
  const { client } = createClient({ child });
  const probed = await client.probeCapabilities();
  assert.equal(probed.capabilities.clientMessageGuid, true);

  const result = await client.sendRich({
    chat_id: 42,
    text: "must remain unsent",
    reply_to: "PARENT",
    client_guid: guid,
  });
  assert.equal(result.classification, "unsupported");
  assert.equal(result.retrySafe, true);
  assert.deepEqual(child.requests.map((request) => request.method), [
    "chats.list",
    "send.rich.client-guid",
  ]);
  assert.equal(child.requests.some((request) => request.method === "send.rich"), false,
    "method-not-found must never downgrade to an uncorrelatable legacy send");
  await client.stop();
});

test("sends rich text, native polls, votes, tapbacks, typing, read receipts, and status through documented RPC methods", async () => {
  const { client, child } = createClient();
  const rich = await client.sendRich({ chat_id: 42, text: "hello", effect: "confetti", formatting: [{ start: 0, length: 5, styles: ["bold"] }] });
  const reply = await client.sendRich({ chat_id: 42, text: "threaded", reply_to: "PARENT", dd_scan: false });
  const attachment = await client.sendRich({ chat_id: 42, file: "/tmp/image.png", reply_to: "PARENT" });
  const link = await client.sendRich({ chat_id: 42, url: "https://example.com/card" });
  const poll = await client.sendPoll({ chat_id: 42, question: "Dinner?", options: ["Pizza", "Sushi"], sendCaption: false });
  const vote = await client.votePoll({ chat_id: 42, poll_guid: "POLL", option_id: "PIZZA" });
  const reaction = await client.tapback({ chat_id: 42, message_guid: "MESSAGE", reaction: "love" });
  const customReaction = await client.tapback({ chat_id: 42, message_guid: "MESSAGE", reaction: "🔕", remove: true });
  const typing = await client.setTyping({ chat_id: 42 }, true);
  const read = await client.markRead({ chat_id: 42 });
  const status = await client.sendStatus("MESSAGE");
  const edit = await client.editMessage({ chat_id: 42, message_guid: "MESSAGE", text: "Revised", part_index: 0 });
  const unsend = await client.unsendMessage({ chat_id: 42, message_guid: "MESSAGE", part_index: 0 });

  assert.ok([rich, reply, attachment, link, poll, vote, reaction, customReaction, typing, read, status, edit, unsend].every((result) => result.classification === "accepted"));
  assert.deepEqual(
    child.requests.map((request) => request.method),
    ["chats.list", "send.rich", "send.rich", "send.attachment", "send.rich", "poll.send", "poll.vote", "tapback", "tapback", "typing", "read", "message.send_status", "message.edit", "message.unsend"],
  );
  assert.deepEqual(child.requests[1].params.text_formatting, [{ start: 0, length: 5, styles: ["bold"] }]);
  assert.equal(child.requests[2].params.reply_to, "PARENT");
  assert.equal(child.requests[2].params.dd_scan, false);
  assert.equal(child.requests[3].params.file, "/tmp/image.png");
  assert.equal(child.requests[4].params.url, "https://example.com/card");
  assert.deepEqual(child.requests[5].params, {
    chat_id: 42,
    question: "Dinner?",
    options: ["Pizza", "Sushi"],
    send_caption: false,
  });
  assert.deepEqual(child.requests[8].params, { chat_id: 42, message_guid: "MESSAGE", reaction: "🔕", remove: true });
  assert.deepEqual(child.requests[12].params, { chat_id: 42, message_guid: "MESSAGE", text: "Revised", part_index: 0 });
  assert.deepEqual(child.requests[13].params, { chat_id: 42, message_guid: "MESSAGE", part_index: 0 });
  await client.stop();
});

test("preserves only bounded content-free diagnostics for explicit RPC send errors", async () => {
  const sensitiveGuid = "p:0/01234567-89AB-CDEF-0123-456789ABCDEF";
  const sensitiveIdentity = "private-person@example.com";
  const child = respondingChild({
    "poll.send": (request, process) => queueMicrotask(() => process.json({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: `Could not resolve reply target for poll: ${sensitiveGuid} ${sensitiveIdentity}`,
      },
    })),
  });
  const { client } = createClient({ child });
  const result = await client.sendPoll({
    chat_id: 42,
    question: "Choose",
    options: ["One", "Two"],
    reply_to: sensitiveGuid,
  });

  assert.deepEqual(result, {
    classification: "ambiguous",
    accepted: false,
    ambiguous: true,
    unsupported: false,
    retrySafe: false,
    reason: "transport-or-send-failure",
    failureSource: "remote-error",
    remoteCode: -32603,
    remoteCategory: "poll-reply-target-unresolved",
    remoteMessage: "The poll reply target could not be resolved.",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(sensitiveGuid), false);
  assert.equal(serialized.includes(sensitiveIdentity), false);
  await client.stop();
});

test("classifies an oversized native poll payload without retaining its labels", async () => {
  const privateLabel = "private menu label";
  const child = respondingChild({
    "poll.send": (request, process) => queueMicrotask(() => process.json({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: `Poll definition payload exceeds 4096 bytes: ${privateLabel}`,
      },
    })),
  });
  const { client } = createClient({ child });
  const result = await client.sendPoll({ chat_id: 42, question: "Choose", options: ["One", "Two"] });

  assert.equal(result.remoteCategory, "poll-payload-too-large");
  assert.equal(result.remoteMessage, "The native poll payload exceeded the Messages size limit.");
  assert.equal(JSON.stringify(result).includes(privateLabel), false);
  await client.stop();
});

test("classifies only the helper's fixed poll-construction stage codes", async () => {
  const stages = new Map([
    ["missing-class", "poll-construction-missing-class"],
    ["empty-balloon", "poll-construction-empty-balloon"],
    ["legacy-item-alloc", "poll-construction-legacy-item-allocation"],
    ["legacy-item-init", "poll-construction-legacy-item-initialization"],
    ["legacy-wrap", "poll-construction-legacy-wrapper"],
    ["atomic-selector", "poll-construction-atomic-selector"],
    ["atomic-init-nil", "poll-construction-atomic-initialization"],
  ]);
  for (const [code, category] of stages) {
    const child = respondingChild({
      "poll.send": (request, process) => queueMicrotask(() => process.json({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: `Could not construct poll IMMessage [${code}] private-person@example.com`,
        },
      })),
    });
    const { client } = createClient({ child });
    const result = await client.sendPoll({ chat_id: 42, question: "Choose", options: ["One", "Two"] });
    assert.equal(result.remoteCategory, category);
    assert.equal(JSON.stringify(result).includes("private-person"), false);
    await client.stop();
  }

  const unknownChild = respondingChild({
    "poll.send": (request, process) => queueMicrotask(() => process.json({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: "Could not construct poll IMMessage [private-user-supplied-code]",
      },
    })),
  });
  const unknown = createClient({ child: unknownChild });
  const unknownResult = await unknown.client.sendPoll({ chat_id: 42, question: "Choose", options: ["One", "Two"] });
  assert.equal(unknownResult.remoteCategory, "poll-message-construction-failed");
  assert.equal(JSON.stringify(unknownResult).includes("private-user-supplied-code"), false);
  await unknown.client.stop();
});

test("drops unsafe or unbounded remote diagnostics and distinguishes timeout from EOF", async () => {
  const unsafeChild = respondingChild({
    "poll.send": (request, process) => queueMicrotask(() => process.json({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: Number.MAX_SAFE_INTEGER,
        message: "private-person@example.com said a private message",
        data: "x".repeat(3_000),
      },
    })),
  });
  const unsafe = createClient({ child: unsafeChild });
  const unsafeResult = await unsafe.client.sendPoll({ chat_id: 42, question: "Choose", options: ["One", "Two"] });
  assert.deepEqual(unsafeResult, {
    classification: "ambiguous",
    accepted: false,
    ambiguous: true,
    unsupported: false,
    retrySafe: false,
    reason: "transport-or-send-failure",
    failureSource: "remote-error",
  });
  await unsafe.client.stop();

  const timedOut = createClient({ child: respondingChild({ "poll.send": () => {} }) });
  const timeoutResult = await timedOut.client.sendPoll({ chat_id: 42, question: "Choose", options: ["One", "Two"] });
  assert.equal(timeoutResult.reason, "timeout");
  assert.equal(timeoutResult.failureSource, "timeout");
  await timedOut.client.stop();

  const closedChild = respondingChild({
    "poll.send": (_request, process) => queueMicrotask(() => process.close(1)),
  });
  const closed = createClient({ child: closedChild });
  const closedResult = await closed.client.sendPoll({ chat_id: 42, question: "Choose", options: ["One", "Two"] });
  assert.equal(closedResult.reason, "transport-or-send-failure");
  assert.equal(closedResult.failureSource, "eof");
  await closed.client.stop();
});

test("caps native Apple polls at twelve options before any send attempt", async () => {
  const { client, child } = createClient();
  const valid = await client.sendPoll({
    chat_id: 42,
    question: "Choose",
    options: Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`),
  });
  const invalid = await client.sendPoll({
    chat_id: 42,
    question: "Choose",
    options: Array.from({ length: 13 }, (_, index) => `Option ${index + 1}`),
  });

  assert.equal(valid.classification, "accepted");
  assert.equal(invalid.classification, "unsupported");
  assert.equal(invalid.retrySafe, true);
  assert.equal(child.requests.filter((request) => request.method === "poll.send").length, 1);
  await client.stop();
});

test("caption-free polls fail closed when the patched imsg capability is absent", async () => {
  const status = { ...fullStatus, poll_caption_control: false };
  const { client, child } = createClient({ status });

  const result = await client.sendPoll({
    chat_id: 42,
    question: "Choose",
    options: ["One", "Two"],
    send_caption: false,
  });

  assert.equal((await client.status()).capabilities.pollCaptionControl, false);
  assert.equal(result.classification, "unsupported");
  assert.equal(result.reason, "pollCaptionControl-unavailable");
  assert.equal(child.requests.length, 0, "caption suppression must not be attempted on an unpatched imsg");
});

test("poll caption control rejects non-boolean values before any send attempt", async () => {
  const { client, child } = createClient();
  const result = await client.sendPoll({
    chat_id: 42,
    question: "Choose",
    options: ["One", "Two"],
    send_caption: "false",
  });

  assert.equal(result.classification, "unsupported");
  assert.equal(result.reason, "IMSG_INVALID_INPUT");
  assert.equal(child.requests.length, 0);
});

test("rejects malformed edit and unsend mutations before writing RPC", async () => {
  const { client, child } = createClient();
  const edit = await client.editMessage({ chat_id: 42, message_guid: "MESSAGE", text: "", part_index: -1 });
  const unsend = await client.unsendMessage({ chat_id: 42, message_guid: "MESSAGE", part_index: -1 });
  assert.equal(edit.classification, "unsupported");
  assert.equal(unsend.classification, "unsupported");
  assert.equal(child.requests.length, 0);
});

test("stop removes watch subscriptions, closes stdin, and leaves no pending RPC work", async () => {
  const child = respondingChild({
    "watch.subscribe": (request, process) => queueMicrotask(() => process.json({ jsonrpc: "2.0", id: request.id, result: { subscription: 7 } })),
  });
  const { client } = createClient({ child });
  await client.subscribeWatch({}, () => {});
  await client.stop();

  assert.equal(child.requests.some((request) => request.method === "watch.unsubscribe"), true);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(client.child, null);
  assert.equal(client.pending.size, 0);
  assert.equal(client.watchers.size, 0);
});
