import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ImsgTransport, imsgTransportInternals } from "../src/imsg-transport.mjs";
import { ImsgIpcClient } from "../src/imsg-ipc-client.mjs";

const THREAD = {
  id: "thread-a",
  title: "Rich formatting",
  createdAt: "2026-07-12T12:00:00.000Z",
  projectLabel: "iMessage handoff",
};

class FakeClient {
  constructor({ advanced = true, richUnsupported = false, sideEffectsFail = false, latestMessage = null } = {}) {
    this.advanced = advanced;
    this.richUnsupported = richUnsupported;
    this.sideEffectsFail = sideEffectsFail;
    this.calls = [];
    this.next = 1;
    this.watchHandlers = null;
    this.latestMessageValue = latestMessage;
    this.helperStatusCount = 0;
    this.statusCount = 0;
  }

  async status() {
    this.statusCount += 1;
    return {
      available: true,
      basic: true,
      advanced: this.advanced,
      capabilities: {
        watch: this.advanced,
        richText: this.advanced,
        effects: this.advanced,
        urlPreviews: this.advanced,
        replies: this.advanced,
        polls: this.advanced,
        pollVoting: this.advanced,
        typing: this.advanced,
        readReceipts: this.advanced,
        tapbacks: this.advanced,
        attachments: this.advanced,
        sendStatus: true,
        edits: this.advanced,
        unsend: this.advanced,
      },
    };
  }

  async start() { this.calls.push(["start"]); }
  async helperStatus() { this.helperStatusCount += 1; return helperReport(); }
  async resetConnection() { this.calls.push(["reset-connection"]); }
  async latestMessage() { return this.latestMessageValue; }
  async stop() { this.calls.push(["stop"]); }
  async subscribeWatch(params, handlers) {
    this.calls.push(["watch", params]);
    this.watchHandlers = handlers;
    return { subscription: 1, unsubscribe: async () => { this.calls.push(["unsubscribe"]); } };
  }
  accepted(kind, extras = {}) {
    return { classification: "accepted", accepted: true, ok: true, guid: `${kind}-${this.next++}`, ...extras };
  }
  async sendRich(params, options) {
    this.calls.push(["rich", params, options]);
    await this.onSendRich?.(params);
    return this.richUnsupported
      ? { classification: "unsupported" }
      : this.accepted("rich");
  }
  async sendPoll(params, options) {
    this.calls.push(["poll", params, options]);
    return this.accepted("poll", {
      poll: { options: params.options.map((label, index) => ({ id: `option-${index}`, text: label })) },
    });
  }
  async setTyping(params, value) { this.calls.push(["typing", params, value]); return this.accepted("typing"); }
  async markRead(params) {
    this.calls.push(["read", params]);
    if (this.sideEffectsFail) throw new Error("read failed");
    return this.accepted("read");
  }
  async tapback(params) {
    this.calls.push(["tapback", params]);
    if (this.sideEffectsFail) throw new Error("tapback failed");
    return this.accepted("tapback");
  }
  async sendAttachment(params, options) { this.calls.push(["attachment", params, options]); return this.accepted("attachment"); }
  async sendStatus(guid) { this.calls.push(["status", guid]); return this.accepted("status", { send_state: "delivered" }); }
  async editMessage(params) { this.calls.push(["edit", params]); return this.accepted("edit"); }
  async unsendMessage(params) { this.calls.push(["unsend", params]); return this.accepted("unsend"); }
}

function helperReport(overrides = {}) {
  const profile = {
    chatId: 42,
    chatGuid: "iMessage;-;+15550000000",
    expectedSender: "+15551111111",
    ...(overrides.profile || {}),
  };
  const settings = {
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
    ...(overrides.settings || {}),
  };
  return { authenticated: true, ...overrides, profile, settings };
}

class FakeHelperClient extends FakeClient {
  constructor(report = helperReport()) {
    super();
    this.report = report;
    this.importAttachmentsImpl = null;
  }

  async helperStatus() {
    this.calls.push(["helper-status"]);
    return structuredClone(this.report);
  }

  async status() {
    this.calls.push(["status"]);
    return super.status();
  }

  importAttachments(attachments, options) {
    this.calls.push(["import-attachments", attachments, options]);
    return this.importAttachmentsImpl?.(attachments, options) || Promise.resolve([]);
  }
}

function fixture(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-transport-"));
  const client = options.client || new FakeClient(options);
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  const profile = {
    binary: "/opt/homebrew/bin/imsg",
    chatId: 42,
    chatGuid: "iMessage;-;+15550000000",
    expectedSender: "+15551111111",
    mode: "helper",
    featureMode: options.featureMode || "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
    ...(options.profile || {}),
  };
  const stateFile = path.join(directory, "state.json");
  const transport = new ImsgTransport({
    profile,
    stateFile,
    client,
    now: () => now,
    watchRetryBaseMs: options.watchRetryBaseMs,
    watchRetryMaxMs: options.watchRetryMaxMs,
  });
  return { transport, client, profile, stateFile, now: () => now, advance: (milliseconds) => { now += milliseconds; } };
}

test("helper mode constructs the authenticated IPC client from its private config", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-transport-helper-config-"));
  const codexHome = path.join(directory, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  const controller = generateKeyPairSync("ed25519");
  const helper = generateKeyPairSync("ed25519");
  const controllerPrivateKeyPath = path.join(directory, "controller-private.pem");
  const helperPublicKeyPath = path.join(directory, "helper-public.pem");
  const clientConfig = path.join(directory, "controller-client.json");
  writeFileSync(controllerPrivateKeyPath, controller.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(helperPublicKeyPath, helper.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  writeFileSync(clientConfig, JSON.stringify({
    version: 1,
    socketPath: path.join(directory, "helper.sock"),
    controllerPrivateKeyPath,
    helperPublicKeyPath,
    codexHome,
    expectedHelperAttestation: {
      role: "imsg-helper",
      identityHash: "1".repeat(64),
      accountHash: "2".repeat(64),
      conversationHash: "3".repeat(64),
      profileHash: "4".repeat(64),
    },
  }), { mode: 0o600 });
  chmodSync(controllerPrivateKeyPath, 0o600);
  chmodSync(helperPublicKeyPath, 0o644);
  chmodSync(clientConfig, 0o600);

  const transport = new ImsgTransport({
    profile: {
      mode: "helper",
      clientConfig,
      chatId: 42,
      chatGuid: "iMessage;-;+15550000000",
      expectedSender: "+15551111111",
      featureMode: "bridge",
      presentation: "rich",
      polls: true,
      reactions: true,
    },
    stateFile: path.join(directory, "state.json"),
  });
  assert.ok(transport.client instanceof ImsgIpcClient);
  assert.equal(transport.mode, "helper");
});

test("local, basic, and plain transport profiles are rejected", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imsg-transport-rejected-profile-"));
  const base = {
    chatId: 42,
    chatGuid: "iMessage;-;+15550000000",
    expectedSender: "+15551111111",
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
  };
  for (const profile of [
    { ...base, mode: "local" },
    { ...base, mode: "helper", featureMode: "basic" },
    { ...base, mode: "helper", presentation: "plain" },
    { ...base, mode: "helper", polls: false },
  ]) {
    assert.throws(() => new ImsgTransport({
      profile,
      stateFile: path.join(directory, `${profile.mode}-${profile.featureMode}-${profile.presentation}-${profile.polls}.json`),
      client: new FakeClient(),
    }), TypeError);
  }
});

test("helper startup authenticates and verifies the exact configured profile before probing", async () => {
  const client = new FakeHelperClient();
  const { transport } = fixture({
    client,
    profile: { mode: "helper", binary: undefined, clientConfig: "/private/controller-client.json" },
  });
  await transport.start();
  assert.deepEqual(client.calls.slice(0, 4).map(([kind]) => kind), ["helper-status", "status", "start", "watch"]);
  assert.equal(client.calls.filter(([kind]) => kind === "helper-status").length, 1);
  assert.ok(client.calls.some(([kind]) => kind === "watch"));

  for (const report of [
    helperReport({ authenticated: false }),
    helperReport({ profile: { chatId: 99 } }),
    helperReport({ profile: { chatGuid: "iMessage;-;+15550000099" } }),
    helperReport({ profile: { expectedSender: "+15552222222" } }),
    helperReport({ settings: { featureMode: "basic" } }),
    helperReport({ settings: { polls: false } }),
  ]) {
    const mismatch = fixture({
      client: new FakeHelperClient(report),
      profile: { mode: "helper", binary: undefined, clientConfig: "/private/controller-client.json" },
    });
    await assert.rejects(() => mismatch.transport.helperStatus(), (error) => error?.code === "IMSG_HELPER_PROFILE_MISMATCH");
  }
});

test("helper mode awaits authenticated attachment import", async () => {
  const client = new FakeHelperClient();
  let release;
  client.importAttachmentsImpl = () => new Promise((resolve) => { release = resolve; });
  const { transport } = fixture({
    client,
    profile: { mode: "helper", binary: undefined, clientConfig: "/private/controller-client.json" },
  });
  const options = { destinationRoot: "/private/imports", messageKey: "inbound-guid" };
  const importing = transport.importInboundAttachments([{ id: "attachment-1" }], options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, "function");
  assert.deepEqual(client.calls.slice(0, 2).map(([kind]) => kind), ["helper-status", "import-attachments"]);
  release(["/private/imports/image-1.png"]);
  assert.deepEqual(await importing, ["/private/imports/image-1.png"]);
  assert.deepEqual(client.calls.find(([kind]) => kind === "import-attachments").slice(1), [
    [{ id: "attachment-1" }],
    options,
  ]);

});

test("starts an exact-chat watch and filters echoes, other chats, and other senders", async () => {
  const { transport, client } = fixture();
  const actions = [];
  await transport.start({ onAction: (action) => actions.push(action) });
  transport.setActiveThread(THREAD);
  transport.router.setAwaitingPrompt(THREAD.id);
  let sequence = 0;
  const emit = (overrides) => client.watchHandlers.onMessage({
    id: 1,
    guid: `guid-${sequence++}`,
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15551111111",
    is_from_me: false,
    text: "Run tests",
    created_at: "2026-07-12T12:00:00.000Z",
    ...overrides,
  });
  emit({ is_from_me: true });
  emit({ chat_id: 99, chat_guid: "other" });
  emit({ chat_id: 42, chat_guid: "other" });
  emit({ chat_id: 99, chat_guid: "iMessage;-;+15550000000" });
  emit({ chat_id: undefined, chat_guid: undefined });
  emit({ sender: "+15552222222" });
  emit({ id: 4, guid: "id-only-guid", chat_guid: undefined });
  emit({ id: 5, guid: "guid-only-guid", chat_id: undefined });
  emit({ id: 4, guid: "accepted-guid" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.length, 3);
  assert.ok(actions.every((action) => action.threadId === THREAD.id));
  assert.equal(transport.router.lastRowId, 5);
  assert.equal(client.calls[1][0], "watch");
});

test("a mismatched expected sender is durably discarded without creating activity or work", async () => {
  const { transport, client } = fixture();
  const actions = [];
  await transport.start({ onAction: (action) => actions.push(action) });
  transport.setActiveThread(THREAD);
  const mismatch = {
    id: 90,
    guid: "wrong-sender-guid",
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15552222222",
    is_from_me: false,
    text: "This sender is not authorized.",
    created_at: "2026-07-12T12:00:00.000Z",
  };

  client.watchHandlers.onMessage(mismatch);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(actions, []);
  assert.equal(transport.router.lastRowId, 90);
  assert.equal(transport.router.lastUserMessageAt, null);
  assert.deepEqual(transport.pendingActions(), []);
  assert.equal(transport.router.ingest(mismatch), null);
});

test("a new conversation baselines existing history before subscribing", async () => {
  const { transport, client } = fixture({
    latestMessage: {
      id: 150,
      guid: "existing-latest",
      text: "Existing private history",
      created_at: "2026-07-12T11:59:00.000Z",
    },
  });
  const actions = [];
  await transport.start({ onAction: (action) => actions.push(action) });
  assert.deepEqual(actions, []);
  assert.equal(transport.router.lastRowId, 150);
  const watch = client.calls.find(([kind]) => kind === "watch");
  assert.equal(watch[1].since_rowid, 150);
  assert.equal(transport.router.lastUserMessageAt, null);
});

test("acceptInbound acknowledges before best-effort read and tapback failures", async () => {
  const client = new FakeClient({ sideEffectsFail: true });
  const { transport } = fixture({ client });
  await transport.probe();
  transport.setActiveThread(THREAD);
  const action = transport.router.ingest({
    id: 11,
    guid: "durable-inbound",
    text: "Run once",
    created_at: "2026-07-12T12:00:00.000Z",
  });

  assert.equal(await transport.acceptInbound(action), true);
  assert.deepEqual(transport.pendingActions(), []);
  assert.equal(transport.router.ingest({
    id: 11,
    guid: "durable-inbound",
    text: "Run once",
    created_at: "2026-07-12T12:00:00.000Z",
  }), null);
});

test("suppresses an inbound self-chat echo even when it arrives before the send result", async () => {
  const { transport, client } = fixture();
  const actions = [];
  await transport.start({ onAction: (action) => actions.push(action) });
  transport.setActiveThread(THREAD);
  client.onSendRich = async (params) => {
    client.watchHandlers.onMessage({
      id: 201,
      guid: "self-echo-inbound",
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000000",
      sender: "+15551111111",
      is_from_me: false,
      text: params.text,
      created_at: "2026-07-12T12:00:00.000Z",
    });
  };
  await transport.outbound({ kind: "service.notice", code: "self-echo-test", body: "Private service output" });
  assert.deepEqual(actions, []);
  assert.equal(transport.router.lastRowId, 201);
  assert.deepEqual(transport.pendingActions(), []);

  client.onSendRich = null;
  client.watchHandlers.onMessage({
    id: 202,
    guid: "real-identical-inbound",
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15551111111",
    is_from_me: false,
    text: client.calls.find(([kind]) => kind === "rich")[1].text,
    created_at: "2026-07-12T12:00:01.000Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].messageKey, "real-identical-inbound");
});

test("creates one durable native root and sends later task output as replies without repeating its header", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  transport.rememberInbound(THREAD.id, "user-guid");
  const result = await transport.outbound({
    kind: "thread.live-message",
    messageId: "commentary-1",
    thread: THREAD,
    role: "assistant",
    phase: "commentary",
    body: "Checking **three paths**.",
  });
  assert.equal(result.sent, true);
  const first = client.calls.find(([kind]) => kind === "rich")[1];
  assert.match(first.text, /^\S+ Rich formatting\ncodex:\/\/threads\/thread-a\n\/listen · \/link · \/mute\n\nChecking three paths\.$/u);
  assert.equal(first.reply_to, undefined);
  assert.ok(first.text_formatting.some((range) => range.styles.includes("italic")));
  assert.ok(first.text_formatting.some((range) => range.styles.includes("bold")));
  assert.equal(transport.router.nativeThread(THREAD.id).rootGuid, "rich-1");

  await transport.outbound({
    kind: "thread.live-message",
    messageId: "commentary-2",
    thread: THREAD,
    role: "assistant",
    phase: "commentary",
    body: "Then checking the final path.",
  });
  const second = client.calls.filter(([kind]) => kind === "rich")[1][1];
  assert.equal(second.text, "Then checking the final path.");
  assert.equal(second.reply_to, "rich-1");
});

test("two consecutive advanced outputs both send and the second remains in the native reply thread", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const first = await transport.outbound({
    kind: "thread.live-message",
    messageId: "two-output-1",
    thread: THREAD,
    role: "assistant",
    phase: "commentary",
    body: "First update.",
  });
  const second = await transport.outbound({
    kind: "thread.live-message",
    messageId: "two-output-2",
    thread: THREAD,
    role: "assistant",
    phase: "final_answer",
    body: "Second update.",
  });
  assert.deepEqual([first.sent, second.sent], [true, true]);
  const sends = client.calls.filter(([kind]) => kind === "rich");
  assert.equal(sends.length, 2);
  assert.equal(sends[1][1].reply_to, "rich-1");
  assert.notEqual(sends[0][2].operationId, sends[1][2].operationId);
  assert.equal(typeof client.send, "undefined");
});

test("task output uses its durable root instead of a transient explicit inbound GUID", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  await transport.outbound({ kind: "thread.output", thread: THREAD, body: "Root response." });
  const result = await transport.outbound(
    { kind: "thread.output", thread: THREAD, body: "Finished." },
    { replyToGuid: "inbound-completion-guid" },
  );
  assert.equal(result.sent, true);
  assert.equal(client.calls.filter(([kind]) => kind === "rich")[1][1].reply_to, "rich-1");
});

test("never falls back when the advanced rich send is unsupported", async () => {
  const client = new FakeClient({ advanced: true, richUnsupported: true });
  const { transport } = fixture({ client });
  await transport.probe();
  transport.setActiveThread(THREAD);
  const result = await transport.outbound({ kind: "thread.output", thread: THREAD, body: "**Done**" });
  assert.equal(result.sent, false);
  assert.equal(result.status, "UNSUPPORTED");
  assert.deepEqual(client.calls.filter(([kind]) => kind === "rich").map(([kind]) => kind), ["rich"]);
});

test("reasoning and small directories use native polls with durable action mappings", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  await transport.outbound({
    kind: "service.reasoning",
    thread: THREAD,
    current: "high",
    options: [{ value: "none" }, { value: "high", selected: true }],
  });
  await transport.outbound({
    kind: "service.directory",
    directory: {
      groups: [{
        projectKey: "project",
        projectLabel: "Project",
        threads: [
          { id: "thread-a", title: "First", index: 1, status: "idle" },
          { id: "thread-b", title: "Second", index: 2, status: "idle" },
        ],
      }],
    },
  });
  const polls = client.calls.filter(([kind]) => kind === "poll");
  assert.equal(polls.length, 2);
  assert.equal(polls[0][1].question, "Reasoning · high selected");
  assert.ok(polls[0][1].options.some((label) => label === "high · selected"));
  const reasoningVote = transport.router.ingest({
    id: 90,
    guid: "reasoning-vote",
    poll: { kind: "vote", original_guid: "poll-2", vote: { option_id: "option-1" } },
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(reasoningVote.command, "reasoning");
  assert.equal(reasoningVote.argument, "high");
  const directoryVote = transport.router.ingest({
    id: 91,
    guid: "directory-vote",
    poll: { kind: "vote", original_guid: "poll-3", vote: { option_id: "option-1" } },
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(directoryVote.kind, "switch");
  assert.equal(directoryVote.threadId, "thread-b");
});

test("startup rejects a bridge without native poll support", async () => {
  const client = new FakeClient({ advanced: false });
  const { transport } = fixture({ client });
  await assert.rejects(() => transport.probe(), { code: "IMSG_ADVANCED_REQUIRED" });
});

test("large task directories are split into native polls with two to twelve options and no duplicate text menu", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await transport.outbound({
    kind: "service.directory",
    directory: {
      groups: [{
        projectKey: "project",
        projectLabel: "Project",
        threads: Array.from({ length: 25 }, (_, index) => ({
          id: `thread-${index + 1}`,
          title: `Task ${index + 1}`,
          index: index + 1,
          status: "idle",
        })),
      }],
    },
  });
  const polls = client.calls.filter(([kind]) => kind === "poll");
  assert.equal(polls.length, 3);
  assert.ok(polls.every(([, params]) => params.options.length >= 2 && params.options.length <= 12));
  assert.ok(polls.every(([, , options]) => /^outbound:[a-f0-9]{64}$/.test(options.operationId)));
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);
});

test("native task choices distinguish duplicate titles with project, state, queue, recency, and request context", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await transport.outbound({
    kind: "service.directory",
    directory: {
      groups: [{
        projectKey: "project-a",
        projectLabel: "Messaging service",
        threads: [
          {
            id: "duplicate-a",
            title: "Fix transport",
            status: "working",
            stateSince: "2026-07-12T11:55:00.000Z",
            pendingCount: 2,
            requestPreview: "Keep the native thread connected after a helper restart.",
          },
          {
            id: "duplicate-b",
            title: "Fix transport",
            status: "idle",
            activityAt: "2026-07-12T11:00:00.000Z",
            requestPreview: "Review the presentation labels.",
          },
        ],
      }],
    },
  });
  const options = client.calls.find(([kind]) => kind === "poll")[1].options;
  assert.match(options[0], /Fix transport · Messaging service · Working .* · 2 queued · “Keep the native/u);
  assert.match(options[1], /Fix transport · Messaging service · .* ago · “Review the presentation/u);
  assert.notEqual(options[0], options[1]);
});

test("deduplicates explicit delivery IDs without persisting message bodies", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  const event = { kind: "thread.completed", completionId: "completion-one", thread: THREAD, body: "Private final body" };
  assert.equal((await transport.outbound(event)).sent, true);
  assert.equal((await transport.outbound(event)).status, "DUPLICATE");
  assert.equal(client.calls.filter(([kind]) => kind === "rich").length, 1);
  assert.doesNotMatch(JSON.stringify(transport.router.outboundReceipt("completion:completion-one")), /Private final body/);
});

test("an ambiguous accepted send retries with the same stable operation id", async () => {
  class AmbiguousOnceClient extends FakeClient {
    async sendRich(params, options) {
      this.calls.push(["rich", params, options]);
      if (this.calls.filter(([kind]) => kind === "rich").length === 1) {
        return { classification: "ambiguous", accepted: false, reason: "ipc-disconnected" };
      }
      return this.accepted("recovered-guid");
    }
  }
  const client = new AmbiguousOnceClient();
  const { transport } = fixture({ client });
  await transport.probe();
  const event = { kind: "thread.completed", completionId: "stable-retry", thread: THREAD, body: "Finished once." };
  assert.equal((await transport.outbound(event)).status, "AMBIGUOUS");
  assert.equal((await transport.outbound(event)).sent, true);
  const sends = client.calls.filter(([kind]) => kind === "rich");
  assert.equal(sends.length, 2);
  assert.match(sends[0][2].operationId, /^outbound:[a-f0-9]{64}$/);
  assert.equal(sends[1][2].operationId, sends[0][2].operationId);
  assert.equal(transport.router.nativeThread(THREAD.id).rootGuid, "recovered-guid-1");
});

test("uses typing, read, exact tapback, attachments, and the 24-hour activity gate", async () => {
  const { transport, client, advance } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  const action = transport.router.ingest({
    id: 100,
    guid: "inbound-guid",
    text: "Generate it",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(action);
  await transport.setThreadTyping(THREAD.id, true);
  const images = await transport.publishImages(THREAD, ["/tmp/one.png"]);
  assert.equal(images.sent, true);
  assert.equal(transport.notificationStatus().active, true);
  advance(24 * 60 * 60 * 1000 + 1);
  assert.equal(transport.notificationStatus().active, false);
  assert.ok(client.calls.some(([kind]) => kind === "read"));
  assert.ok(client.calls.some(([kind]) => kind === "tapback"));
  assert.ok(client.calls.some(([kind]) => kind === "typing"));
  assert.ok(client.calls.some(([kind]) => kind === "attachment"));
});

test("uses URL previews, explicit effects, send status, edit, and unsend through documented rich methods", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  await transport.outbound({
    kind: "service.notice",
    code: "updated",
    body: "https://example.com/result",
  });
  const completion = { kind: "thread.completed", completionId: "effect-complete", thread: THREAD, body: "Finished." };
  await transport.outbound(completion, { effect: "confetti" });
  const delivery = await transport.deliveryStatus(completion);
  await transport.editMessage("MESSAGE-GUID", "Revised commentary");
  await transport.unsendMessage("MESSAGE-GUID", { partIndex: 0 });

  const richCalls = client.calls.filter(([kind]) => kind === "rich");
  assert.equal(richCalls[0][1].url, "https://example.com/result");
  assert.equal(richCalls[0][1].text, undefined);
  assert.equal(richCalls[1][1].effect, "confetti");
  assert.equal(delivery.classification, "accepted");
  assert.ok(client.calls.some(([kind]) => kind === "status"));
  assert.deepEqual(client.calls.find(([kind]) => kind === "edit")[1], {
    chat_id: 42,
    message_guid: "MESSAGE-GUID",
    text: "Revised commentary",
  });
  assert.deepEqual(client.calls.find(([kind]) => kind === "unsend")[1], {
    chat_id: 42,
    message_guid: "MESSAGE-GUID",
    part_index: 0,
  });
});

test("rich attachments create a header root and reply to it instead of a transient parent", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const result = await transport.publishImages(THREAD, ["/tmp/result.png"], { replyToGuid: "PARENT-GUID" });
  assert.equal(result.sent, true);
  assert.equal(client.calls.find(([kind]) => kind === "attachment")[1].reply_to, "rich-1");
  assert.match(client.calls.find(([kind]) => kind === "attachment")[2].operationId, /^outbound:[a-f0-9]{64}$/);
  assert.match(client.calls.find(([kind]) => kind === "rich")[1].text, /codex:\/\/threads\/thread-a/);
});

test("native roots survive a transport restart", async () => {
  const first = fixture();
  await first.transport.probe();
  await first.transport.outbound({ kind: "thread.output", thread: THREAD, body: "First." });

  const client = new FakeClient();
  const resumed = new ImsgTransport({
    profile: first.profile,
    stateFile: first.stateFile,
    client,
    now: first.now,
  });
  await resumed.probe();
  await resumed.outbound({ kind: "thread.output", thread: THREAD, body: "After restart." });
  const rich = client.calls.find(([kind]) => kind === "rich")[1];
  assert.equal(rich.text, "After restart.");
  assert.equal(rich.reply_to, "rich-1");
});

test("concurrent first sends serialize so only one message becomes the native root", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await Promise.all([
    transport.outbound({ kind: "thread.output", thread: THREAD, body: "First queued." }),
    transport.outbound({ kind: "thread.output", thread: THREAD, body: "Second queued." }),
  ]);
  const rich = client.calls.filter(([kind]) => kind === "rich").map(([, params]) => params);
  assert.equal(rich.length, 2);
  assert.match(rich[0].text, /codex:\/\/threads\/thread-a/);
  assert.equal(rich[0].reply_to, undefined);
  assert.equal(rich[1].text, "Second queued.");
  assert.equal(rich[1].reply_to, "rich-1");
});

test("an accepted root without a GUID is retryable and unsupported native replies never leak top-level", async () => {
  const missingGuidClient = new FakeClient();
  missingGuidClient.sendRich = async function sendRich(params) {
    this.calls.push(["rich", params]);
    return { classification: "accepted", accepted: true, ok: true };
  };
  const missing = fixture({ client: missingGuidClient });
  await missing.transport.probe();
  const missingRootEvent = { kind: "thread.completed", completionId: "missing-root", thread: THREAD, body: "Needs a root." };
  const rootResult = await missing.transport.outbound(missingRootEvent);
  assert.deepEqual({ sent: rootResult.sent, status: rootResult.status, terminal: rootResult.terminal }, {
    sent: false,
    status: "ROOT_GUID_MISSING",
    terminal: false,
  });
  assert.equal(missing.transport.router.nativeThread(THREAD.id), null);
  assert.equal((await missing.transport.outbound(missingRootEvent)).status, "ROOT_GUID_MISSING");
  assert.equal(missingGuidClient.calls.filter(([kind]) => kind === "rich").length, 2);

  const { transport, client } = fixture();
  await transport.probe();
  await transport.outbound({ kind: "thread.output", thread: THREAD, body: "Establish root." });
  client.richUnsupported = true;
  const replyResult = await transport.outbound({ kind: "thread.output", thread: THREAD, body: "Must stay threaded." });
  assert.equal(replyResult.status, "UNSUPPORTED");
  assert.equal(replyResult.terminal, false);
  assert.equal(typeof client.send, "undefined");
});

test("directories are hierarchical project polls and thread menus are poll-first", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await transport.outbound({
    kind: "service.directory",
    directory: {
      groups: [
        { projectKey: "alpha", projectLabel: "Alpha", startedAt: "2026-07-01T00:00:00Z", threads: [{ id: "a", title: "A" }] },
        { projectKey: "beta", projectLabel: "Beta", startedAt: "2026-07-02T00:00:00Z", threads: [{ id: "b", title: "B" }] },
      ],
    },
  });
  const projectPoll = client.calls.find(([kind]) => kind === "poll")[1];
  assert.equal(projectPoll.question, "Choose a project");
  assert.match(projectPoll.options[0], /^\S+ Alpha · 1 task$/u);
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);
  const selectedProject = transport.router.ingest({
    id: 501,
    guid: "project-vote",
    poll: { kind: "vote", original_guid: "poll-1", vote: { option_id: "option-1" } },
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.deepEqual({ kind: selectedProject.kind, projectKey: selectedProject.projectKey }, { kind: "project", projectKey: "beta" });

  await transport.outbound({
    kind: "service.menu",
    label: "THREADS",
    items: Array.from({ length: 13 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, createdAt: "2026-07-12T00:00:00Z" })),
  });
  const polls = client.calls.filter(([kind]) => kind === "poll");
  assert.equal(polls.length, 3);
  assert.deepEqual(polls.slice(1).map(([, params]) => params.options.length), [7, 6]);
});

test("an unavailable native menu poll falls back to the complete text menu", async () => {
  const client = new FakeClient();
  client.sendPoll = async function sendPoll(params) {
    this.calls.push(["poll", params]);
    return { classification: "unsupported" };
  };
  const { transport } = fixture({ client });
  await transport.probe();
  const result = await transport.outbound({
    kind: "service.menu",
    label: "THREADS",
    items: [
      { id: "thread-a", title: "Alpha", index: 1 },
      { id: "thread-b", title: "Beta", index: 2 },
    ],
  });
  assert.equal(result.sent, true);
  assert.deepEqual(client.calls.filter(([kind]) => ["poll", "rich"].includes(kind)).map(([kind]) => kind), ["poll", "rich"]);
  assert.match(client.calls.find(([kind]) => kind === "rich")[1].text, /Alpha[\s\S]+Beta/);
});

test("command-specific thread pickers persist structured control actions", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const result = await transport.sendThreadPicker("mute", [
    { id: "thread-a", title: "Alpha", createdAt: "2026-07-01T00:00:00Z" },
    { id: "thread-b", title: "Beta", createdAt: "2026-07-02T00:00:00Z" },
  ]);
  assert.equal(result.sent, true);
  assert.equal(client.calls.find(([kind]) => kind === "poll")[1].question, "/mute task");
  const action = transport.router.ingest({
    id: 601,
    guid: "mute-vote",
    poll: { kind: "vote", original_guid: "poll-1", vote: { option_id: "option-1" } },
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.deepEqual({ kind: action.kind, command: action.command, threadId: action.threadId }, {
    kind: "control",
    command: "mute",
    threadId: "thread-b",
  });
});

test("a top-level poll vote keeps later unthreaded input on the last user-selected task", async () => {
  const { transport } = fixture();
  await transport.probe();
  await transport.sendThreadPicker("mute", [
    { id: "thread-a", title: "Alpha" },
    { id: "thread-b", title: "Beta" },
  ]);
  const vote = transport.router.ingest({
    id: 701,
    guid: "top-level-poll-vote",
    poll: { kind: "vote", original_guid: "poll-1", vote: { option_id: "option-0" } },
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(vote.threadId, "thread-a");
  await transport.acceptInbound(vote);
  transport.router.touchThread("thread-b", "2026-07-12T12:01:00.000Z");
  const reply = transport.router.ingest({
    id: 702,
    guid: "reply-to-vote",
    reply_to_guid: "top-level-poll-vote",
    text: "This should use the latest task, not the poll's choice.",
    created_at: "2026-07-12T12:02:00.000Z",
  });
  assert.equal(reply.threadId, "thread-a");
});

test("awaiting-prompt pauses only proactive delivery with a retryable result", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.router.setAwaitingPrompt(THREAD.id);
  const paused = await transport.outbound(
    { kind: "thread.completed", completionId: "paused", thread: THREAD, body: "Wait." },
    { proactive: true },
  );
  assert.deepEqual({ sent: paused.sent, status: paused.status, terminal: paused.terminal }, {
    sent: false,
    status: "AWAITING_PROMPT",
    terminal: false,
  });
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);
  assert.equal((await transport.outbound({ kind: "thread.output", thread: THREAD, body: "Requested." })).sent, true);
});

test("typing is reference-counted independently for concurrent tasks", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const other = { ...THREAD, id: "thread-b", title: "Other task" };
  await transport.outbound({ kind: "thread.progress", thread: THREAD, phase: "working" });
  await transport.outbound({ kind: "thread.progress", thread: other, phase: "working" });
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);
  await transport.outbound({ kind: "thread.output", thread: THREAD, body: "A done." });
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);
  await transport.outbound({ kind: "thread.output", thread: other, body: "B done." });
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true, false]);
});

test("watch failures resubscribe once with backoff and stopping cancels recovery", async () => {
  const { transport, client } = fixture({ watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  const errors = [];
  await Promise.all([
    transport.start({ onError: (error) => errors.push(error) }),
    transport.start({ onError: (error) => errors.push(error) }),
  ]);
  assert.equal(client.calls.filter(([kind]) => kind === "watch").length, 1);
  assert.equal(transport.isHealthy(), true);
  assert.equal(client.helperStatusCount, 1);
  const firstHandlers = client.watchHandlers;
  firstHandlers.onError(new Error("bridge exited"));
  firstHandlers.onError(new Error("duplicate failure callback"));
  assert.equal(transport.isHealthy(), false);
  assert.equal(transport.watchRetryTimer?.hasRef?.(), true, "watch recovery must keep the daemon alive");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(client.calls.filter(([kind]) => kind === "watch").length, 2, JSON.stringify(client.calls));
  assert.equal(errors.length, 1);
  assert.equal(client.helperStatusCount, 2);
  assert.equal(client.statusCount, 2);
  assert.equal(transport.isHealthy(), true);
  assert.deepEqual(client.calls.slice(-3).map(([kind]) => kind), ["reset-connection", "start", "watch"]);

  const recoveredHandlers = client.watchHandlers;
  recoveredHandlers.onError(new Error("bridge exited again"));
  await transport.stop();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(client.calls.filter(([kind]) => kind === "watch").length, 2);
});

test("intentional transport shutdown does not publish a false offline edge", async () => {
  const { transport } = fixture();
  const states = [];
  transport.setHealthCallback((health) => states.push(health.healthy));
  await transport.start();
  await transport.stop();
  assert.deepEqual(states, [true]);
});

test("a failed durable inbound handoff invalidates the watch and replays the pending action after recovery", async () => {
  const { transport, client } = fixture({ watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  transport.setActiveThread(THREAD);
  const errors = [];
  let deliveries = 0;
  await transport.start({
    onAction: async () => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("consumer unavailable");
    },
    onError: (error) => errors.push(error),
  });
  client.watchHandlers.onMessage({
    id: 301,
    guid: "durable-recovery-guid",
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15551111111",
    is_from_me: false,
    text: "Run this exactly once.",
    created_at: "2026-07-12T12:00:00.000Z",
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.calls.filter(([kind]) => kind === "watch").length, 2);
  assert.equal(deliveries, 2);
  assert.equal(errors.length, 1);
  assert.equal(transport.isHealthy(), true);
  assert.equal(transport.pendingActions()[0].messageKey, "durable-recovery-guid");
});

test("an inbound persistence exception rolls the watch back to its committed cursor", async () => {
  const { transport, client } = fixture({ watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  transport.setActiveThread(THREAD);
  const actions = [];
  const errors = [];
  await transport.start({ onAction: (action) => actions.push(action), onError: (error) => errors.push(error) });
  const ingest = transport.router.ingest.bind(transport.router);
  let failOnce = true;
  transport.router.ingest = (message) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("state write failed");
    }
    return ingest(message);
  };
  const inbound = {
    id: 302,
    guid: "persistence-retry-guid",
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15551111111",
    is_from_me: false,
    text: "Retry from the committed cursor.",
    created_at: "2026-07-12T12:00:00.000Z",
  };
  client.watchHandlers.onMessage(inbound);
  assert.equal(transport.isHealthy(), false);
  assert.equal(transport.router.lastRowId, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const watches = client.calls.filter(([kind]) => kind === "watch");
  assert.equal(watches.length, 2);
  assert.equal(watches[1][1].since_rowid, undefined);

  client.watchHandlers.onMessage(inbound);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].messageKey, "persistence-retry-guid");
  assert.equal(errors.length, 1);
  assert.equal(transport.router.lastRowId, 302);
});

test("formatting conversion groups styles sharing one UTF-16 range", () => {
  assert.deepEqual(imsgTransportInternals.nativeFormatting([
    { location: 3, length: 4, style: "bold" },
    { location: 3, length: 4, style: "italic" },
  ]), [{ start: 3, length: 4, styles: ["bold", "italic"] }]);
});
