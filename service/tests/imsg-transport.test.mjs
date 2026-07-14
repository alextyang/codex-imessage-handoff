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
  projectStartedAt: "2026-07-01T00:00:00.000Z",
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
        pollCaptionControl: this.advanced,
        pollVoting: this.advanced,
        typing: this.advanced,
        readReceipts: this.advanced,
        tapbacks: this.advanced,
        customEmojiTapbacks: this.advanced,
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
  async tapback(params, options) {
    this.calls.push(["tapback", params, options]);
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
    commandContextTtlMs: options.commandContextTtlMs,
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

test("the watch marks every authorized inbound event read, including ignored reactions and polls", async () => {
  const { transport, client } = fixture();
  const actions = [];
  await transport.start({ onAction: (action) => actions.push(action) });
  const base = {
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15551111111",
    is_from_me: false,
    created_at: "2026-07-12T12:00:00.000Z",
  };

  client.watchHandlers.onMessage({
    ...base,
    id: 700,
    guid: "ignored-reaction",
    text: "Loved",
    is_reaction: true,
    reaction_type: "love",
    is_reaction_add: true,
    reacted_to_guid: "unknown-root",
  });
  client.watchHandlers.onMessage({
    ...base,
    id: 701,
    guid: "ignored-foreign-poll",
    text: "",
    poll: { kind: "vote", original_guid: "unknown-poll", vote: { option_id: "unknown-option" } },
  });
  client.watchHandlers.onMessage({
    ...base,
    id: 702,
    guid: "unauthorized-event",
    sender: "+15552222222",
    text: "Do not acknowledge this sender.",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(actions, []);
  assert.equal(client.calls.filter(([kind]) => kind === "read").length, 2);
  assert.equal(transport.router.lastRowId, 702, "the unauthorized row is discarded durably");
  assert.equal(transport.router.lastUserMessageAt, null);
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

test("startup retries the read receipt once for a durable pending inbox", async () => {
  const { transport, client } = fixture();
  await transport.start();
  transport.setActiveThread(THREAD);
  transport.router.setDefaultThread(THREAD.id, "2026-07-12T12:00:00.000Z");
  const pending = transport.router.ingest({
    id: 151,
    guid: "pending-before-restart",
    text: "Resume this durable prompt.",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(pending.kind, "prompt");
  await transport.stop();
  client.calls.length = 0;

  await transport.start();
  assert.equal(transport.pendingActions().length, 1);
  assert.equal(client.calls.filter(([kind]) => kind === "read").length, 1);
  await transport.stop();
});

test("read and semantic-reaction failures cannot prevent durable inbound acknowledgement", async () => {
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

  assert.equal(await transport.observeInbound(action), false);
  assert.equal(await transport.acceptInbound(action, { reaction: "🔕" }), true);
  assert.deepEqual(transport.pendingActions(), []);
  assert.equal(transport.router.pendingConfirmations().length, 1);
  assert.equal(transport.router.ingest({
    id: 11,
    guid: "durable-inbound",
    text: "Run once",
    created_at: "2026-07-12T12:00:00.000Z",
  }), null);
});

test("new-task acceptance atomically clears setup routing and installs its durable default task", async () => {
  const { transport, profile, stateFile } = fixture();
  const flowId = "new-flow-accepted";
  transport.router.setActiveNewFlow(flowId);
  transport.router.setAwaitingNewPrompt(flowId);
  const action = transport.router.ingest({
    id: 11_000,
    guid: "new-task-first-prompt",
    text: "Build the accepted task.",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(action.kind, "new-prompt");
  // Model a replay that restored the temporary lease before acceptance.
  transport.router.setAwaitingNewPrompt(flowId);

  assert.equal(await transport.acceptInbound(action, {
    reaction: "✨",
    newThreadCompletion: {
      flowId,
      threadId: "created-task-a",
      updatedAt: action.createdAt,
    },
  }), true);

  const resumed = new ImsgTransport({ profile, stateFile, client: new FakeClient() });
  assert.deepEqual(resumed.pendingActions(), []);
  assert.equal(resumed.router.activeNewFlowId, null);
  assert.equal(resumed.router.awaitingNewPrompt, null);
  assert.equal(resumed.router.lastUserThreadId, "created-task-a");
});

test("quarantined actions atomically retain their failure confirmation without adding routes", async () => {
  const client = new FakeClient({ sideEffectsFail: true });
  const { transport } = fixture({ client });
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "quarantine-root");
  const inbound = {
    id: 11_001,
    guid: "quarantined-command",
    text: "/cancel",
    thread_originator_guid: "quarantine-root",
    created_at: "2026-07-12T12:00:00.000Z",
  };
  const action = transport.router.ingest(inbound);
  const routesBeforeQuarantine = structuredClone(transport.router.state.guidRoutes);

  assert.equal(await transport.quarantineInbound(action), true);
  assert.deepEqual(transport.pendingActions(), []);
  assert.deepEqual(transport.router.state.guidRoutes, routesBeforeQuarantine);
  assert.deepEqual(transport.router.pendingConfirmations().map((item) => ({
    messageGuid: item.messageGuid,
    reaction: item.reaction,
  })), [{ messageGuid: inbound.guid, reaction: "❌" }]);
  assert.equal(transport.router.ingest(inbound), null);
});

test("semantic confirmations retry with one operation id after the next accepted inbound", async () => {
  class AmbiguousOnceTapbackClient extends FakeClient {
    async tapback(params, options) {
      this.calls.push(["tapback", params, options]);
      if (this.calls.filter(([kind]) => kind === "tapback").length === 1) {
        return { classification: "ambiguous", accepted: false, reason: "ipc-disconnected" };
      }
      return this.accepted("tapback");
    }
  }
  const client = new AmbiguousOnceTapbackClient();
  const { transport } = fixture({ client });
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "confirmation-root");
  const commandMessage = {
    id: 12,
    guid: "confirmation-command",
    text: "/mute",
    thread_originator_guid: "confirmation-root",
    created_at: "2026-07-12T12:00:00.000Z",
  };
  const command = transport.router.ingest(commandMessage);

  assert.equal(await transport.acceptInbound(command, { reaction: "🔕" }), true);
  assert.deepEqual(transport.pendingActions(), []);
  const [queued] = transport.router.pendingConfirmations();
  assert.equal(queued.reaction, "🔕");
  assert.equal(transport.router.ingest(commandMessage), null, "confirmation failure must not replay the command");

  const prompt = transport.router.ingest({
    id: 13,
    guid: "confirmation-followup",
    text: "Continue without a generic reaction.",
    thread_originator_guid: "confirmation-root",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  assert.equal(await transport.acceptInbound(prompt), true);
  assert.deepEqual(transport.router.pendingConfirmations(), []);
  const attempts = client.calls.filter(([kind]) => kind === "tapback");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(([, params]) => params.reaction), ["🔕", "🔕"]);
  assert.deepEqual(attempts.map(([, , options]) => options.operationId), [queued.operationId, queued.operationId]);
  assert.equal(attempts.some(([, params]) => params.reaction === "like"), false);
});

test("a confirmation appended during an active flush is drained in the same pass", async () => {
  let settleFirstTapback;
  class DeferredFirstTapbackClient extends FakeClient {
    async tapback(params, options) {
      this.calls.push(["tapback", params, options]);
      if (this.calls.filter(([kind]) => kind === "tapback").length === 1) {
        return new Promise((resolve) => { settleFirstTapback = resolve; });
      }
      return this.accepted("tapback");
    }
  }
  const client = new DeferredFirstTapbackClient();
  const { transport } = fixture({ client });
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "concurrent-confirmation-root");

  const first = transport.router.ingest({
    id: 12_001,
    guid: "concurrent-confirmation-first",
    text: "/mute",
    thread_originator_guid: "concurrent-confirmation-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  const firstAcceptance = transport.acceptInbound(first, { reaction: "🔕" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.calls.filter(([kind]) => kind === "tapback").length, 1);

  const second = transport.router.ingest({
    id: 12_002,
    guid: "concurrent-confirmation-second",
    text: "/listen",
    thread_originator_guid: "concurrent-confirmation-root",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  const secondAcceptance = transport.acceptInbound(second, { reaction: "👂" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.calls.filter(([kind]) => kind === "tapback").length, 1);

  settleFirstTapback({ classification: "accepted", accepted: true });
  assert.deepEqual(await Promise.all([firstAcceptance, secondAcceptance]), [true, true]);
  assert.deepEqual(transport.router.pendingConfirmations(), []);
  assert.deepEqual(
    client.calls.filter(([kind]) => kind === "tapback").map(([, params]) => params.message_guid),
    ["concurrent-confirmation-first", "concurrent-confirmation-second"],
  );
});

test("startup drains persisted semantic confirmations without replaying accepted actions", async () => {
  class AmbiguousTapbackClient extends FakeClient {
    async tapback(params, options) {
      this.calls.push(["tapback", params, options]);
      return { classification: "ambiguous", accepted: false, reason: "ipc-disconnected" };
    }
  }
  const firstClient = new AmbiguousTapbackClient();
  const { transport, profile, stateFile } = fixture({ client: firstClient });
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "startup-confirmation-root");
  const inbound = {
    id: 14,
    guid: "startup-confirmation-command",
    text: "/listen",
    thread_originator_guid: "startup-confirmation-root",
    created_at: "2026-07-12T12:00:00.000Z",
  };
  const action = transport.router.ingest(inbound);
  await transport.acceptInbound(action, { reaction: "👂" });
  const [queued] = transport.router.pendingConfirmations();
  assert.ok(queued);

  const recoveredClient = new FakeClient();
  const recovered = new ImsgTransport({ profile, stateFile, client: recoveredClient });
  await recovered.start();
  assert.deepEqual(recovered.pendingActions(), []);
  assert.deepEqual(recovered.router.pendingConfirmations(), []);
  assert.equal(recovered.router.ingest(inbound), null);
  const retry = recoveredClient.calls.find(([kind]) => kind === "tapback");
  assert.equal(retry[1].reaction, "👂");
  assert.equal(retry[2].operationId, queued.operationId);
  await recovered.stop();
});

test("a terminal confirmation lookup cannot block later durable confirmations", async () => {
  class AuthorizingClient extends FakeClient {
    constructor() {
      super();
      this.deletedAvailable = false;
    }

    async authorizeMessageGuid(params) {
      this.calls.push(["authorize", params]);
      if (params.message_guid === "deleted-confirmation" && !this.deletedAvailable) {
        return {
          classification: "terminal",
          accepted: false,
          authorized: false,
          terminal: true,
          reason: "message-not-found",
        };
      }
      return { classification: "accepted", accepted: true, authorized: true, terminal: false };
    }
  }
  const client = new AuthorizingClient();
  const { transport } = fixture({ client });
  await transport.probe();
  transport.setActiveThread(THREAD);
  const deleted = transport.router.ingest({
    id: 14_001,
    guid: "deleted-confirmation",
    text: "/mute",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  const deliverable = transport.router.ingest({
    id: 14_002,
    guid: "deliverable-confirmation",
    text: "/listen",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  transport.router.acknowledgeWithConfirmation(deleted.messageKey, {
    messageGuid: deleted.guid,
    reaction: "🔕",
  });
  transport.router.acknowledgeWithConfirmation(deliverable.messageKey, {
    messageGuid: deliverable.guid,
    reaction: "👂",
  });
  const [deletedEntry, deliverableEntry] = transport.router.pendingConfirmations();

  assert.equal(await transport._flushConfirmationOutbox(), 1);
  assert.deepEqual(transport.router.pendingConfirmations(), [deletedEntry]);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "tapback").map(([, params]) => params.message_guid), [
    "deliverable-confirmation",
  ]);

  client.deletedAvailable = true;
  assert.equal(await transport._flushConfirmationOutbox(), 1);
  assert.deepEqual(transport.router.pendingConfirmations(), []);
  const attempts = client.calls.filter(([kind]) => kind === "tapback");
  assert.equal(attempts[1][2].operationId, deletedEntry.operationId);
  assert.equal(attempts[0][2].operationId, deliverableEntry.operationId);
});

test("watch recovery drains retained semantic confirmations with their original operation id", async () => {
  class ToggleTapbackClient extends FakeClient {
    constructor() {
      super();
      this.acceptTapbacks = false;
    }

    async tapback(params, options) {
      this.calls.push(["tapback", params, options]);
      return this.acceptTapbacks
        ? this.accepted("tapback")
        : { classification: "ambiguous", accepted: false, reason: "ipc-disconnected" };
    }
  }
  const client = new ToggleTapbackClient();
  const { transport } = fixture({ client, watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  await transport.start();
  transport.router.setThreadRoot(THREAD.id, "recovery-confirmation-root");
  const action = transport.router.ingest({
    id: 15,
    guid: "recovery-confirmation-command",
    text: "/unmute",
    thread_originator_guid: "recovery-confirmation-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(action, { reaction: "🔔" });
  const [queued] = transport.router.pendingConfirmations();
  assert.ok(queued);

  client.acceptTapbacks = true;
  client.watchHandlers.onError(new Error("helper restarted"));
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(transport.isHealthy(), true);
  assert.deepEqual(transport.router.pendingConfirmations(), []);
  const attempts = client.calls.filter(([kind]) => kind === "tapback");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(([, , options]) => options.operationId), [queued.operationId, queued.operationId]);
  await transport.stop();
});

test("watch recovery makes a fresh confirmation attempt after an old connection settles", async () => {
  let settleFirstTapback;
  class DeferredTapbackClient extends FakeClient {
    async tapback(params, options) {
      this.calls.push(["tapback", params, options]);
      if (this.calls.filter(([kind]) => kind === "tapback").length === 1) {
        return new Promise((resolve) => { settleFirstTapback = resolve; });
      }
      return this.accepted("tapback");
    }
  }
  const client = new DeferredTapbackClient();
  const { transport } = fixture({ client });
  await transport.start();
  transport.router.setThreadRoot(THREAD.id, "racing-confirmation-root");
  const action = transport.router.ingest({
    id: 16,
    guid: "racing-confirmation-command",
    text: "/mute",
    thread_originator_guid: "racing-confirmation-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });

  const acceptance = transport.acceptInbound(action, { reaction: "🔕" });
  await new Promise((resolve) => setImmediate(resolve));
  const [queued] = transport.router.pendingConfirmations();
  assert.ok(queued);
  assert.equal(client.calls.filter(([kind]) => kind === "tapback").length, 1);

  const recovery = transport._recoverWatch();
  while (client.calls.filter(([kind]) => kind === "watch").length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  settleFirstTapback({ classification: "ambiguous", accepted: false, reason: "old-connection" });
  await Promise.all([acceptance, recovery]);

  assert.deepEqual(transport.router.pendingConfirmations(), []);
  const attempts = client.calls.filter(([kind]) => kind === "tapback");
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(([, , options]) => options.operationId), [queued.operationId, queued.operationId]);
  await transport.stop();
});

test("read observation reports an ambiguous bridge result without degrading the watch", async () => {
  class AmbiguousReadClient extends FakeClient {
    async markRead(params) {
      this.calls.push(["read", params]);
      return {
        classification: "ambiguous",
        failureSource: "remote-error",
        remoteCode: -32603,
        remoteCategory: "internal-error",
      };
    }
  }
  const { transport } = fixture({ client: new AmbiguousReadClient() });
  await transport.start({ onAction: () => {} });

  assert.equal(await transport.observeInbound({}), false);
  assert.equal(transport.healthStatus().healthy, true);
  assert.deepEqual(transport.healthStatus().readObservation, {
    status: "ambiguous",
    checkedAt: "2026-07-12T12:00:00.000Z",
    failureSource: "remote-error",
    remoteCode: -32603,
    remoteCategory: "internal-error",
    remoteMessage: "The RPC operation failed internally.",
  });
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
    body: "Checking **three paths**.\nOpen [app.py](/Users/alex/Project/app.py:12).",
  });
  assert.equal(result.sent, true);
  const [header, first] = client.calls.filter(([kind]) => kind === "rich").map(([, params]) => params);
  assert.match(header.text, /^📐 iMessage handoff\n\S+ Rich formatting\n\n○ unknown\n↩️ Reasoning: Codex default\n\ncodex:\/\/threads\/thread-a\n\n👍 listen · 👎 mute · ❓ status \+ history\n\/link · \/cancel$/u);
  assert.equal(header.reply_to, undefined);
  assert.equal(first.text, "Checking three paths.\nOpen app.py.");
  assert.doesNotMatch(first.text, /\/Users\/alex/u);
  assert.equal(first.reply_to, "rich-1");
  assert.ok(first.text_formatting.some((range) => range.styles.includes("italic")));
  assert.ok(first.text_formatting.some((range) => range.styles.includes("bold")));
  assert.ok(first.text_formatting.some((range) => range.styles.includes("bold")
    && first.text.slice(range.start, range.start + range.length) === "app.py"));
  for (const label of ["iMessage handoff", "Rich formatting"]) {
    assert.ok(header.text_formatting.some((range) => range.styles.includes("bold")
      && header.text.slice(range.start, range.start + range.length) === label));
  }
  assert.equal(transport.router.nativeThread(THREAD.id).rootGuid, "rich-1");

  await transport.outbound({
    kind: "thread.live-message",
    messageId: "commentary-2",
    thread: THREAD,
    role: "assistant",
    phase: "commentary",
    body: "Then checking the final path.",
  });
  const second = client.calls.filter(([kind]) => kind === "rich")[2][1];
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
  assert.equal(sends.length, 3);
  assert.equal(sends[1][1].reply_to, "rich-1");
  assert.equal(sends[2][1].reply_to, "rich-1");
  assert.notEqual(sends[1][2].operationId, sends[2][2].operationId);
  assert.equal(typeof client.send, "undefined");
});

test("every task-scoped bubble, poll, and attachment stays on one native reply root and remains reply-addressable", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const thread = {
    ...THREAD,
    status: "working",
    stateSince: "2026-07-12T11:56:00.000Z",
    reasoningEffort: "high",
    pendingCount: 1,
  };
  const results = [];
  results.push(await transport.outbound({ kind: "thread.header", deliveryId: "header-root", thread }));
  results.push(await transport.outbound({
    kind: "thread.live-message",
    messageId: "mirror-user",
    thread,
    role: "user",
    body: "Run the continuity matrix.",
  }));
  results.push(await transport.outbound({
    kind: "thread.live-message",
    messageId: "mirror-commentary",
    thread,
    role: "assistant",
    phase: "commentary",
    body: "Checking native descendants.",
  }));
  results.push(await transport.outbound({
    kind: "thread.detail",
    deliveryId: "detail-working",
    thread,
    state: "working",
    stateSince: thread.stateSince,
    reasoningEffort: "high",
    requestPreview: "Run the continuity matrix.",
    assistantMessages: [
      { body: "First reasoning bucket.", phase: "commentary" },
      { body: "Second reasoning bucket.", phase: "commentary" },
    ],
  }));
  results.push(await transport.outbound({
    kind: "thread.turn",
    deliveryId: "turn-current",
    thread,
    turn: {
      request: "Run the continuity matrix.",
      assistantMessages: [{ body: "Still connected.", phase: "commentary" }],
      finalResponse: "Continuity held.",
    },
  }));
  results.push(await transport.outbound({
    kind: "thread.history",
    deliveryId: "history-current",
    thread,
    turns: [{ request: "Earlier request.", finalResponse: "Earlier response." }],
  }));
  results.push(await transport.outbound({
    kind: "service.reasoning",
    deliveryId: "reasoning-current",
    thread,
    current: "high",
    options: [{ value: "none" }, { value: "high", selected: true }],
  }));
  results.push(await transport.outbound({
    kind: "service.notice",
    deliveryId: "notice-current",
    code: "updated",
    thread,
    body: "Automatic updates resumed.",
  }));
  results.push(await transport.publishImages(thread, ["/tmp/continuity.png"], { deliveryId: "continuity-image" }));
  results.push(await transport.outbound({
    kind: "thread.completed",
    completionId: "continuity-complete",
    thread,
    body: "All cases completed.",
  }));

  assert.ok(results.every((result) => result.sent === true), JSON.stringify(results));
  const rootGuid = results[0].guids[0];
  assert.equal(rootGuid, "rich-1");
  const taskCalls = client.calls.filter(([kind]) => ["rich", "poll", "attachment"].includes(kind));
  assert.equal(taskCalls[0][0], "rich");
  assert.equal(taskCalls[0][1].reply_to, undefined);
  assert.match(taskCalls[0][1].text, /codex:\/\/threads\/thread-a/u);
  for (const [kind, params] of taskCalls.slice(1)) {
    assert.equal(params.reply_to, rootGuid, `${kind} escaped the task's native root`);
  }
  assert.equal(taskCalls.filter(([, params]) => /codex:\/\/threads\/thread-a/u.test(params.text || "")).length, 1);

  transport.router.setThreadRoot("thread-b", "root-b");
  const routedGuids = [...new Set(results.flatMap((result) => result.guids || []))];
  for (const [index, guid] of routedGuids.entries()) {
    const action = transport.router.ingest({
      id: 2_000 + index,
      guid: `reply-${index}`,
      text: "/thread",
      thread_originator_guid: guid,
      reply_to_guid: "root-b",
      created_at: "2026-07-12T12:05:00.000Z",
    });
    assert.equal(action.kind, "control");
    assert.equal(action.threadId, THREAD.id, `reply to ${guid} lost its Codex task`);
    assert.equal(action.threadOriginatorGuid, guid);
    transport.router.acknowledge(action.messageKey);
  }
});

test("interleaved task output never crosses native roots or lets background activity steal the default task", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const alpha = { ...THREAD, id: "thread-alpha", title: "Alpha" };
  const beta = { ...THREAD, id: "thread-beta", title: "Beta" };
  const alphaFirst = await transport.outbound({ kind: "thread.output", deliveryId: "alpha-first", thread: alpha, body: "Alpha one." });
  const betaFirst = await transport.outbound({ kind: "thread.output", deliveryId: "beta-first", thread: beta, body: "Beta one." });
  const alphaRoot = alphaFirst.guids[0];
  const betaRoot = betaFirst.guids[0];
  assert.notEqual(alphaRoot, betaRoot);

  const selectAlpha = transport.router.ingest({
    id: 2_100,
    guid: "select-alpha",
    text: "/thread",
    thread_originator_guid: alphaRoot,
    created_at: "2026-07-12T12:00:01.000Z",
  });
  assert.equal(selectAlpha.threadId, alpha.id);
  transport.router.acknowledge(selectAlpha.messageKey);

  await transport.outbound({ kind: "thread.live-message", messageId: "alpha-user", thread: alpha, role: "user", body: "Alpha two." });
  await transport.outbound({ kind: "thread.completed", completionId: "beta-complete", thread: beta, body: "Beta done." });
  await transport.outbound({ kind: "service.notice", deliveryId: "beta-notice", code: "updated", thread: beta, body: "Beta updated." });

  const rich = client.calls.filter(([kind]) => kind === "rich").map(([, params]) => params);
  const alphaBodies = rich.filter((params) => ["Alpha one.", "👤 Alpha two."].includes(params.text));
  const betaBodies = rich.filter((params) => ["Beta one.", "Beta done.", "Beta updated."].includes(params.text));
  assert.ok(alphaBodies.every((params) => params.reply_to === alphaRoot));
  assert.ok(betaBodies.every((params) => params.reply_to === betaRoot));
  assert.equal(transport.router.lastUserThreadId, alpha.id);

  const unthreaded = transport.router.ingest({
    id: 2_101,
    guid: "unthreaded-after-beta",
    text: "Continue the task I last addressed.",
    reply_to_guid: betaFirst.guids.at(-1),
    created_at: "2026-07-12T12:00:02.000Z",
  });
  assert.equal(unthreaded.kind, "prompt");
  assert.equal(unthreaded.threadId, alpha.id);
});

test("manual header resends are separate replies under the existing root and uniquely idempotent", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const thread = { ...THREAD, status: "idle", activityAt: "2026-07-12T11:55:00.000Z", reasoningEffort: "medium" };
  const initial = await transport.outbound({ kind: "thread.output", deliveryId: "initial", thread, body: "Last response." });
  const rootGuid = initial.guids[0];
  const firstHeader = { kind: "thread.header", deliveryId: "manual-open-one", thread };
  const secondHeader = { kind: "thread.header", deliveryId: "manual-open-two", thread };
  assert.equal((await transport.outbound(firstHeader)).sent, true);
  assert.equal((await transport.outbound(firstHeader)).status, "DUPLICATE");
  assert.equal((await transport.outbound(secondHeader)).sent, true);
  await transport.outbound({
    kind: "thread.turn",
    deliveryId: "manual-open-turn",
    thread,
    turn: { request: "Last request.", finalResponse: "Last response." },
  });

  const rich = client.calls.filter(([kind]) => kind === "rich");
  const headers = rich.filter(([, params]) => /codex:\/\/threads\/thread-a/u.test(params.text || ""));
  assert.equal(headers.length, 3);
  assert.equal(headers[0][1].reply_to, undefined);
  assert.ok(headers.slice(1).every(([, params]) => params.reply_to === rootGuid));
  assert.notEqual(headers[1][2].operationId, headers[2][2].operationId);
  assert.match(headers[1][1].text, /○ 5m ago\n⚙️ Reasoning: Medium/u);
  const turn = rich.find(([, params]) => params.text?.includes("Last request."));
  assert.equal(turn[1].reply_to, rootGuid);
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

test("oversized rich output is split into bounded formatted replies on the native task root", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const content = "🙂".repeat(40_000);
  const result = await transport.outbound({
    kind: "thread.output",
    deliveryId: "oversized-output",
    thread: THREAD,
    body: `**${content}**`,
  });

  const richCalls = client.calls.filter(([kind]) => kind === "rich");
  assert.equal(result.sent, true);
  assert.ok(richCalls.length >= 3, "header plus at least two bounded body parts are required");
  const rootGuid = richCalls[0][1].reply_to ? null : "rich-1";
  assert.equal(rootGuid, "rich-1");
  const bodyCalls = richCalls.slice(1);
  assert.deepEqual(bodyCalls.map(([, params]) => params.reply_to), bodyCalls.map(() => rootGuid));
  assert.ok(bodyCalls.every(([, params]) => Buffer.byteLength(params.text, "utf8") < 128 * 1024));
  assert.ok(bodyCalls.every(([, params], index) => params.text.startsWith(`(${index + 1}/${bodyCalls.length})\n\n`)));
  assert.ok(bodyCalls.every(([, params]) => (params.text_formatting || []).every((range) => (
    range.start >= 0 && range.length > 0 && range.start + range.length <= params.text.length
  ))));
  const reconstructed = bodyCalls.map(([, params]) => params.text.replace(/^\(\d+\/\d+\)\n\n/, "")).join("");
  assert.equal(reconstructed, content);
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
  assert.equal(polls[0][1].question, "Reasoning · 🔍 High");
  assert.ok(polls[0][1].options.some((label) => label === "🔍 High · selected"));
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

test("reasoning polls suppress captions and turn Add Choice into a durable search action", async () => {
  const { transport, client, stateFile } = fixture();
  await transport.probe();
  const result = await transport.outbound({
    kind: "service.reasoning",
    deliveryId: "reasoning-add-choice",
    thread: THREAD,
    current: "high",
    options: [{ value: "none" }, { value: "high", selected: true }],
  });
  const pollGuid = result.guids.at(-1);
  const pollCall = client.calls.find(([kind]) => kind === "poll");
  assert.equal(pollCall[1].send_caption, false);
  assert.equal(pollCall[1].reply_to, result.guids[0]);

  const resumed = new ImsgTransport({
    profile: transport.profile,
    stateFile,
    client: new FakeClient(),
    now: transport.now,
  });
  const search = resumed.router.ingest({
    id: 2_200,
    guid: "reasoning-added-choice",
    created_at: "2026-07-12T12:00:01.000Z",
    poll: {
      kind: "created",
      original_guid: pollGuid,
      options_diff: [{ option_id: "custom-search", text: "helper retry timeout" }],
    },
  });
  assert.deepEqual({ kind: search.kind, command: search.command, argument: search.argument }, {
    kind: "search",
    command: "search",
    argument: "helper retry timeout",
  });
  assert.equal(resumed.router.pendingActions()[0].argument, "helper retry timeout");
});

test("startup rejects an otherwise advanced bridge that cannot suppress poll captions", async () => {
  class CaptionedPollClient extends FakeClient {
    async status() {
      const status = await super.status();
      status.capabilities.pollCaptionControl = false;
      return status;
    }
  }
  const { transport } = fixture({ client: new CaptionedPollClient() });
  await assert.rejects(() => transport.probe(), { code: "IMSG_ADVANCED_REQUIRED" });
});

for (const capability of ["readReceipts", "tapbacks"]) {
  test(`startup rejects an otherwise advanced bridge without ${capability}`, async () => {
    class MissingConfirmationClient extends FakeClient {
      async status() {
        const status = await super.status();
        status.capabilities[capability] = false;
        return status;
      }
    }
    const { transport } = fixture({ client: new MissingConfirmationClient() });
    await assert.rejects(() => transport.probe(), { code: "IMSG_ADVANCED_REQUIRED" });
  });
}

test("startup rejects a bridge without native poll support", async () => {
  const client = new FakeClient({ advanced: false });
  const { transport } = fixture({ client });
  await assert.rejects(() => transport.probe(), { code: "IMSG_ADVANCED_REQUIRED" });
});

test("large task directories are split into payload-safe native polls with no duplicate text menu", async () => {
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
  assert.deepEqual(polls.map(([, params]) => params.options.length), [7, 7, 6, 6]);
  assert.ok(polls.every(([, params]) => params.options.length >= 2 && params.options.length <= 7));
  assert.ok(polls.every(([, , options]) => /^outbound:[a-f0-9]{64}$/.test(options.operationId)));
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);
});

test("CJK and emoji-heavy poll labels are chunked and truncated within the native UTF-8 payload limit", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await transport.outbound({
    kind: "service.directory",
    directory: {
      groups: [{
        projectKey: "unicode-project",
        projectLabel: `项目${"界".repeat(80)}`,
        threads: Array.from({ length: 15 }, (_, index) => ({
          id: `unicode-thread-${index}`,
          title: `${"🧭".repeat(50)}${"任务".repeat(80)} ${index}`,
          requestPreview: `${"進捗".repeat(80)}${"🛠️".repeat(30)}`,
          status: "idle",
          index: index + 1,
        })),
      }],
    },
  });

  const polls = client.calls.filter(([kind]) => kind === "poll");
  assert.ok(polls.length > Math.ceil(16 / 7), "large UTF-8 labels should create additional poll parts");
  assert.equal(polls.flatMap(([, params]) => params.options).length, 16);
  for (const [, params] of polls) {
    assert.ok(params.options.length >= 2 && params.options.length <= 7);
    assert.ok(
      imsgTransportInternals.pollDefinitionPayloadBytes(params.question, params.options) <= 4096 - 32,
      `poll payload exceeded the guarded native limit: ${params.question}`,
    );
    for (const label of params.options) {
      assert.equal(label, label.toWellFormed(), "poll labels must not contain split or lone surrogate code units");
      assert.ok(Buffer.byteLength(label, "utf8") > 0);
    }
  }
});

test("native task choices stay compact while preserving status, title, project, and idle recency", async () => {
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
  assert.match(options[0], /^◷ \S+ Fix transport · Messaging service$/u);
  assert.match(options[1], /^○ \S+ Fix transport · Messaging service · 1h ago$/u);
  assert.ok(options.every((label) => !label.includes("queued") && !label.includes("“")));
  assert.notEqual(options[0], options[1]);
});

test("compact poll labels never split family, skin-tone, or flag graphemes", () => {
  const prefix = "x".repeat(50);
  for (const grapheme of ["👨‍👩‍👧‍👦", "👍🏽", "🇺🇸"]) {
    assert.equal(
      imsgTransportInternals.compact(`${prefix}${grapheme}tail`, 52),
      `${prefix}${grapheme}…`,
    );
  }
});

test("multipart poll planning retains every recent project beyond the former menu cap", () => {
  const choices = Array.from({ length: 50 }, (_, index) => ({
    label: `○ 📦 Project ${index + 1}`,
    action: { kind: "new-project", flowId: "flow-many", projectKey: `project-${index + 1}` },
  }));
  const plan = imsgTransportInternals.pollPlan("New task · project", choices);

  assert.deepEqual(plan.chunks.flat(), choices);
  assert.equal(plan.questions.length, plan.chunks.length);
  assert.ok(plan.chunks.length > 6);
  assert.ok(plan.chunks.every((chunk) => chunk.length >= 2 && chunk.length <= 7));
  assert.ok(plan.questions.every((question, index) => question.endsWith(`· ${index + 1}/${plan.chunks.length}`)));
});

test("deduplicates explicit delivery IDs without persisting message bodies", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  const event = { kind: "thread.completed", completionId: "completion-one", thread: THREAD, body: "Private final body" };
  assert.equal((await transport.outbound(event)).sent, true);
  assert.equal((await transport.outbound(event)).status, "DUPLICATE");
  assert.equal(client.calls.filter(([kind]) => kind === "rich").length, 2);
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
  assert.equal(sends.length, 3);
  assert.match(sends[0][2].operationId, /^outbound:[a-f0-9]{64}$/);
  assert.equal(sends[1][2].operationId, sends[0][2].operationId);
  assert.equal(transport.router.nativeThread(THREAD.id).rootGuid, "recovered-guid-1");
});

test("ambiguous delivery results retain only canonical remote diagnostics", async () => {
  class DiagnosticClient extends FakeClient {
    async sendRich(params, options) {
      this.calls.push(["rich", params, options]);
      return {
        classification: "ambiguous",
        accepted: false,
        reason: "transport-or-send-failure",
        failureSource: "remote-error",
        remoteCode: -32603,
        remoteCategory: "poll-reply-target-unresolved",
        remoteMessage: "private-person@example.com PRIVATE-GUID",
        rawError: "private message content",
      };
    }
  }
  const { transport } = fixture({ client: new DiagnosticClient() });
  await transport.probe();
  const result = await transport.outbound({
    kind: "thread.completed",
    completionId: "remote-diagnostic",
    thread: THREAD,
    body: "Finished.",
  });

  assert.deepEqual(result, {
    sent: false,
    status: "AMBIGUOUS",
    terminal: false,
    failureSource: "remote-error",
    remoteCode: -32603,
    remoteCategory: "poll-reply-target-unresolved",
    remoteMessage: "The poll reply target could not be resolved.",
    parts: 0,
    guids: [],
  });
  assert.equal(JSON.stringify(result).includes("private-person"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE-GUID"), false);
});

test("uses read receipts routinely, tapbacks only for action commands, default-task typing, attachments, and the 24-hour gate", async () => {
  const { transport, client, advance } = fixture();
  await transport.probe();
  transport.setActiveThread(THREAD);
  transport.router.setThreadRoot(THREAD.id, "thread-root");
  const action = transport.router.ingest({
    id: 100,
    guid: "inbound-guid",
    text: "Generate it",
    thread_originator_guid: "thread-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.observeInbound(action);
  await transport.acceptInbound(action);
  assert.equal(client.calls.some(([kind]) => kind === "tapback"), false);
  const control = transport.router.ingest({
    id: 101,
    guid: "mute-command",
    text: "/mute",
    thread_originator_guid: "thread-root",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  await transport.observeInbound(control);
  await transport.acceptInbound(control, { reaction: "🔕" });
  await transport.setThreadTyping(THREAD.id, true);
  const images = await transport.publishImages(THREAD, ["/tmp/one.png"]);
  assert.equal(images.sent, true);
  assert.equal(transport.notificationStatus().active, true);
  advance(24 * 60 * 60 * 1000 + 2_000);
  assert.equal(transport.notificationStatus().active, false);
  assert.ok(client.calls.some(([kind]) => kind === "read"));
  assert.deepEqual(client.calls.filter(([kind]) => kind === "tapback").map(([, params]) => params.message_guid), ["mute-command"]);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "tapback").map(([, params]) => params.reaction), ["🔕"]);
  assert.ok(client.calls.some(([kind]) => kind === "typing"));
  assert.ok(client.calls.some(([kind]) => kind === "attachment"));
});

test("read receipts observe every inbound while only explicit semantic confirmations react", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "action-root");
  const messages = [
    "Continue normally.",
    "/thread",
    "/reasoning",
    "/reasoning high",
    "/listen",
    "/link",
    "/mute",
    "/unmute",
    "/retry",
    "/dismiss",
    "/cancel",
  ];
  const actions = [];
  const confirmations = new Map([
    [3, "🔍"],
    [4, "👂"],
    [5, "🔗"],
    [6, "🔕"],
    [7, "🔔"],
    [8, "🔄"],
    [9, "🗑️"],
    [10, "🛑"],
  ]);
  for (const [index, text] of messages.entries()) {
    const action = transport.router.ingest({
      id: 2_400 + index,
      guid: `confirmation-${index}`,
      text,
      thread_originator_guid: "action-root",
      created_at: `2026-07-12T12:00:${String(index).padStart(2, "0")}.000Z`,
    });
    actions.push(action);
    await transport.observeInbound(action);
    await transport.acceptInbound(action, { reaction: confirmations.get(index) });
  }
  assert.equal(client.calls.filter(([kind]) => kind === "read").length, messages.length);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "tapback").map(([, params]) => params.message_guid), [
    "confirmation-3",
    "confirmation-4",
    "confirmation-5",
    "confirmation-6",
    "confirmation-7",
    "confirmation-8",
    "confirmation-9",
    "confirmation-10",
  ]);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "tapback").map(([, params]) => params.reaction), [...confirmations.values()]);
  assert.equal(client.calls.some(([kind, params]) => kind === "tapback" && params.reaction === "like"), false);
  assert.equal(actions[0].kind, "prompt");
  assert.equal(actions[1].command, "thread");
  assert.equal(actions[2].command, "reasoning");
  assert.equal(actions[5].command, "link");
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
  assert.equal(rich.length, 3);
  assert.match(rich[0].text, /codex:\/\/threads\/thread-a/);
  assert.equal(rich[0].reply_to, undefined);
  assert.equal(rich[1].text, "First queued.");
  assert.equal(rich[1].reply_to, "rich-1");
  assert.equal(rich[2].text, "Second queued.");
  assert.equal(rich[2].reply_to, "rich-1");
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

test("directories poll recent tasks first with Projects last and thread menus remain poll-only", async () => {
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
  const recentPoll = client.calls.find(([kind]) => kind === "poll")[1];
  assert.equal(recentPoll.question, "Recent tasks");
  assert.match(recentPoll.options[0], /^○ \S+ A/u);
  assert.match(recentPoll.options.at(-1), /^\S+ Projects$/u);
  assert.equal(recentPoll.send_caption, false);
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);
  const selectedTask = transport.router.ingest({
    id: 501,
    guid: "project-vote",
    poll: { kind: "vote", original_guid: "poll-1", vote: { option_id: "option-1" } },
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.deepEqual({ kind: selectedTask.kind, threadId: selectedTask.threadId }, { kind: "switch", threadId: "b" });

  await transport.outbound({
    kind: "service.menu",
    label: "THREADS",
    items: Array.from({ length: 13 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, createdAt: "2026-07-12T00:00:00Z" })),
  });
  const polls = client.calls.filter(([kind]) => kind === "poll");
  assert.equal(polls.length, 3);
  assert.deepEqual(polls.slice(1).map(([, params]) => params.options.length), [7, 7]);

  await transport.outbound({
    kind: "service.menu",
    label: "THREADS",
    items: Array.from({ length: 11 }, (_, index) => ({
      id: `long-task-${index}`,
      title: `Long task ${index} ${"context ".repeat(30)}`,
      createdAt: "2026-07-12T00:00:00Z",
    })),
  });
  const longPolls = client.calls.filter(([kind]) => kind === "poll").slice(3);
  assert.equal(longPolls.reduce((count, [, params]) => count + params.options.length, 0), 12);
  assert.ok(longPolls.every(([, params]) => params.options.length <= 7));
  assert.ok(longPolls.every(([, params]) => (
    imsgTransportInternals.pollDefinitionPayloadBytes(params.question, params.options) <= 4096 - 32
  )));
});

test("an unavailable native menu poll fails closed without a plaintext selection fallback", async () => {
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
  assert.equal(result.sent, false);
  assert.equal(result.status, "UNSUPPORTED");
  assert.deepEqual(client.calls.filter(([kind]) => ["poll", "rich"].includes(kind)).map(([kind]) => kind), ["poll"]);
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

test("generic action pickers persist new-task flows, refresh actions, and Add Choice search", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const result = await transport.sendActionPicker("New task · project", [
    { label: "○ 🧰 Messaging", action: { kind: "new-project", flowId: "flow-a", projectKey: "project-a" } },
    { label: "○ 📦 Other task", action: { kind: "new-project", flowId: "flow-a", projectKey: "other-tasks" } },
  ], {
    addedChoiceAction: { kind: "new-project-search", flowId: "flow-a" },
    refreshAction: { kind: "new-project-search", flowId: "flow-a" },
    operationScope: "new-thread:flow-a:project",
  });
  assert.equal(result.sent, true);
  const poll = client.calls.find(([kind]) => kind === "poll");
  assert.equal(poll[1].send_caption, false);
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);

  const vote = transport.router.ingest({
    id: 7_500,
    guid: "new-project-vote",
    created_at: "2026-07-12T12:00:00.000Z",
    poll: { kind: "vote", original_guid: result.guids[0], vote: { option_id: "option-0" } },
  });
  assert.deepEqual({ kind: vote.kind, flowId: vote.flowId, projectKey: vote.projectKey }, {
    kind: "new-project",
    flowId: "flow-a",
    projectKey: "project-a",
  });
  transport.router.acknowledge(vote.messageKey);

  const added = transport.router.ingest({
    id: 7_501,
    guid: "new-project-added",
    created_at: "2026-07-12T12:00:01.000Z",
    poll: {
      kind: "created",
      original_guid: result.guids[0],
      options_diff: [{ id: "new-option", text: "Release" }],
    },
  });
  assert.deepEqual({ kind: added.kind, flowId: added.flowId, argument: added.argument }, {
    kind: "new-project-search",
    flowId: "flow-a",
    argument: "Release",
  });
});

test("task-scoped action pickers stay in the native reply thread and preserve response correlation", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "native-root-guid");

  const result = await transport.sendActionPicker("Codex needs your approval", [
    {
      label: "Allow once",
      action: {
        kind: "control",
        command: "respond",
        threadId: THREAD.id,
        argument: "allow-token",
      },
    },
    {
      label: "Deny",
      action: {
        kind: "control",
        command: "respond",
        threadId: THREAD.id,
        argument: "deny-token",
      },
    },
  ], {
    threadId: THREAD.id,
    operationScope: "server-request:approval-a",
    allowAddedChoiceSearch: true,
    addedChoiceAction: {
      kind: "control",
      command: "respond",
      threadId: THREAD.id,
      commandArgument: "other-token",
    },
  });

  assert.equal(result.sent, true);
  assert.equal(result.parts, 1);
  const pollGuid = result.guids[0];
  const pollCall = client.calls.find(([kind]) => kind === "poll");
  assert.equal(pollCall[1].reply_to, "native-root-guid");
  assert.equal(transport.router.nativeThread(THREAD.id).rootGuid, "native-root-guid");
  assert.equal(transport.router.nativeThread(THREAD.id).latestGuid, pollGuid);

  const selected = transport.router.ingest({
    id: 7_510,
    guid: "approval-vote",
    created_at: "2026-07-12T12:00:01.000Z",
    poll: { kind: "vote", original_guid: pollGuid, vote: { option_id: "option-0" } },
  });
  assert.deepEqual({
    kind: selected.kind,
    command: selected.command,
    threadId: selected.threadId,
    argument: selected.argument,
  }, {
    kind: "control",
    command: "respond",
    threadId: THREAD.id,
    argument: "allow-token",
  });
  transport.router.acknowledge(selected.messageKey);

  const added = transport.router.ingest({
    id: 7_511,
    guid: "approval-other",
    created_at: "2026-07-12T12:00:02.000Z",
    poll: {
      kind: "created",
      original_guid: pollGuid,
      options_diff: [{ option_id: "approval-other-option", text: "Only for this file" }],
    },
  });
  assert.deepEqual({
    kind: added.kind,
    command: added.command,
    threadId: added.threadId,
    argument: added.argument,
    commandArgument: added.commandArgument,
  }, {
    kind: "control",
    command: "respond",
    threadId: THREAD.id,
    argument: "Only for this file",
    commandArgument: "other-token",
  });
  transport.router.acknowledge(added.messageKey);

  const reply = transport.router.ingest({
    id: 7_512,
    guid: "approval-poll-reply",
    reply_to_guid: pollGuid,
    thread_originator_guid: "native-root-guid",
    text: "Continue in this task",
    created_at: "2026-07-12T12:00:03.000Z",
  });
  assert.deepEqual({ kind: reply.kind, threadId: reply.threadId, body: reply.body }, {
    kind: "prompt",
    threadId: THREAD.id,
    body: "Continue in this task",
  });
});

test("task-scoped action pickers fail closed when their native reply root is missing", async () => {
  const { transport, client } = fixture();
  await transport.probe();

  const result = await transport.sendActionPicker("Codex needs your approval", [
    {
      label: "Allow once",
      action: { kind: "control", command: "respond", threadId: THREAD.id, argument: "allow-token" },
    },
    {
      label: "Deny",
      action: { kind: "control", command: "respond", threadId: THREAD.id, argument: "deny-token" },
    },
  ], {
    threadId: THREAD.id,
    operationScope: "server-request:approval-without-root",
  });

  assert.deepEqual(result, {
    sent: false,
    status: "NO_REPLY_CONTEXT",
    terminal: false,
    parts: 0,
    guids: [],
    attempted: false,
  });
  assert.equal(client.calls.some(([kind]) => kind === "poll"), false);
});

test("task picker votes and Add Choice searches preserve the original command argument", async () => {
  const { transport } = fixture();
  await transport.probe();
  const result = await transport.sendThreadPicker("history", [
    { id: "thread-a", title: "Alpha", createdAt: "2026-07-01T00:00:00Z" },
    { id: "thread-b", title: "Beta", createdAt: "2026-07-02T00:00:00Z" },
  ], { argument: "5", operationScope: "local-action:history-five" });

  const selected = transport.router.ingest({
    id: 2_250,
    guid: "history-five-vote",
    poll: { kind: "vote", original_guid: result.guids[0], vote: { option_id: "option-1" } },
    created_at: "2026-07-12T12:00:01.000Z",
  });
  assert.deepEqual({
    kind: selected.kind,
    command: selected.command,
    threadId: selected.threadId,
    argument: selected.argument,
  }, {
    kind: "control",
    command: "history",
    threadId: "thread-b",
    argument: "5",
  });
  transport.router.acknowledge(selected.messageKey);

  const search = transport.router.ingest({
    id: 2_251,
    guid: "history-five-search",
    poll: {
      kind: "created",
      original_guid: result.guids[0],
      options_diff: [{ option_id: "history-search-added", text: "older deployment" }],
    },
    created_at: "2026-07-12T12:00:02.000Z",
  });
  assert.deepEqual({
    kind: search.kind,
    command: search.command,
    argument: search.argument,
    commandArgument: search.commandArgument,
  }, {
    kind: "search",
    command: "history",
    argument: "older deployment",
    commandArgument: "5",
  });
});

test("a one-task unmute picker stays a poll, adds navigation, supports search, and does not auto-apply", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const result = await transport.sendThreadPicker("unmute", [{
    id: "muted-thread",
    title: "Muted task",
    projectLabel: "Messaging",
    status: "idle",
    activityAt: "2026-07-12T11:55:00.000Z",
  }], { operationScope: "local-action:unmute-one" });
  assert.equal(result.sent, true);
  assert.equal(result.parts, 1);
  const poll = client.calls.find(([kind]) => kind === "poll");
  assert.equal(poll[1].question, "/unmute task");
  assert.equal(poll[1].send_caption, false);
  assert.equal(poll[1].options.length, 2);
  assert.match(poll[1].options[0], /^○ \S+ Muted task/u);
  assert.match(poll[1].options[1], /Recent tasks$/u);
  assert.equal(client.calls.some(([kind]) => kind === "rich"), false);

  const selected = transport.router.ingest({
    id: 2_300,
    guid: "unmute-choice",
    created_at: "2026-07-12T12:00:01.000Z",
    poll: { kind: "vote", original_guid: result.guids[0], vote: { option_id: "option-0" } },
  });
  assert.deepEqual({ kind: selected.kind, command: selected.command, threadId: selected.threadId }, {
    kind: "control",
    command: "unmute",
    threadId: "muted-thread",
  });
  transport.router.acknowledge(selected.messageKey);

  const search = transport.router.ingest({
    id: 2_301,
    guid: "unmute-add-choice",
    created_at: "2026-07-12T12:00:02.000Z",
    poll: {
      kind: "created",
      original_guid: result.guids[0],
      options_diff: [{ option_id: "search-added", text: "another muted task" }],
    },
  });
  assert.deepEqual({ kind: search.kind, argument: search.argument }, { kind: "search", argument: "another muted task" });
});

test("project polls put status before identity and omit project task counts", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await transport.outbound({
    kind: "service.menu",
    label: "PROJECTS",
    deliveryId: "projects-status-order",
    items: [{
      projectKey: "project-alpha",
      projectLabel: "Alpha project",
      title: "Alpha project",
      status: "working",
      stateSince: "2026-07-12T11:58:00.000Z",
      activityAt: "2026-07-12T11:58:00.000Z",
      threadCount: 47,
    }],
  });
  const poll = client.calls.find(([kind]) => kind === "poll")[1];
  assert.match(poll.options[0], /^◷ \S+ Alpha project/u);
  assert.doesNotMatch(poll.options[0], /47|tasks?/iu);
  assert.match(poll.options[1], /Recent tasks$/u);
  assert.equal(poll.send_caption, false);
});

test("menu operation IDs survive cursor movement and ambiguous retries", async () => {
  class AmbiguousPollOnceClient extends FakeClient {
    async sendPoll(params, options) {
      this.calls.push(["poll", params, options]);
      if (this.calls.filter(([kind]) => kind === "poll").length === 1) {
        return { classification: "ambiguous", accepted: false, reason: "ipc-disconnected" };
      }
      return this.accepted("poll", {
        poll: { options: params.options.map((label, index) => ({ id: `option-${index}`, text: label })) },
      });
    }
  }
  const client = new AmbiguousPollOnceClient();
  const { transport } = fixture({ client });
  await transport.probe();
  const event = {
    kind: "service.directory",
    deliveryId: "stable-directory",
    directory: {
      groups: [{
        projectKey: "project",
        projectLabel: "Project",
        threads: [
          { id: "thread-a", title: "Alpha", status: "idle" },
          { id: "thread-b", title: "Beta", status: "pending" },
        ],
      }],
    },
  };
  assert.equal((await transport.outbound(event)).status, "AMBIGUOUS");
  transport.router.discard({
    id: 9_999,
    guid: "cursor-advanced",
    text: "",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  assert.equal((await transport.outbound(event)).sent, true);
  const polls = client.calls.filter(([kind]) => kind === "poll");
  assert.equal(polls.length, 2);
  assert.match(polls[0][2].operationId, /^outbound:[a-f0-9]{64}$/u);
  assert.equal(polls[1][2].operationId, polls[0][2].operationId);
  assert.ok(polls.every(([, params]) => params.send_caption === false));
});

test("a failed unmute poll does not poison the serialized outbound queue", async () => {
  class ThrowPollOnceClient extends FakeClient {
    async sendPoll(params, options) {
      this.calls.push(["poll", params, options]);
      if (this.calls.filter(([kind]) => kind === "poll").length === 1) throw new Error("bridge restarted");
      return this.accepted("poll", {
        poll: { options: params.options.map((label, index) => ({ id: `option-${index}`, text: label })) },
      });
    }
  }
  const client = new ThrowPollOnceClient();
  const { transport } = fixture({ client });
  await transport.probe();
  await assert.rejects(() => transport.sendThreadPicker("unmute", [
    { id: "thread-a", title: "Alpha", status: "idle" },
  ], { operationScope: "unmute-recovery" }), /bridge restarted/);
  const recovered = await transport.outbound({
    kind: "service.notice",
    deliveryId: "after-unmute-failure",
    code: "updated",
    body: "The next action still works.",
  });
  assert.equal(recovered.sent, true);
  assert.equal(client.calls.find(([kind]) => kind === "rich")[1].text, "The next action still works.");
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

test("typing follows only the current default task across interleaved work", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  const other = { ...THREAD, id: "thread-b", title: "Other task" };
  transport.router.setThreadRoot(THREAD.id, "root-a");
  const selectA = transport.router.ingest({
    id: 800,
    guid: "select-a",
    text: "/thread",
    thread_originator_guid: "root-a",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(selectA);
  await transport.outbound({ kind: "thread.progress", thread: THREAD, phase: "working" });
  await transport.outbound({ kind: "thread.progress", thread: other, phase: "working" });
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);
  await transport.outbound({ kind: "thread.output", thread: THREAD, body: "A done." });
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true, false]);
  transport.router.setThreadRoot(other.id, "root-b");
  const selectB = transport.router.ingest({
    id: 801,
    guid: "select-b",
    text: "/thread",
    thread_originator_guid: "root-b",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  await transport.acceptInbound(selectB);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true, false, true]);
  await transport.outbound({ kind: "thread.output", thread: other, body: "B done." });
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true, false, true, false]);
});

test("typing clears on the injected command-context deadline without another message", async () => {
  const { transport, client, advance } = fixture({ commandContextTtlMs: 25 });
  await transport.probe();
  transport.router.setThreadRoot(THREAD.id, "typing-expiry-root");
  const selected = transport.router.ingest({
    id: 799,
    guid: "typing-expiry-selection",
    text: "/thread",
    thread_originator_guid: "typing-expiry-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(selected);
  await transport.setThreadTyping(THREAD.id, true);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);

  setTimeout(() => advance(26), 5).unref?.();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true, false]);
});

test("manual selection immediately exposes typing for an already-running default task", async () => {
  const { transport, client } = fixture();
  await transport.probe();
  await transport.setThreadTyping(THREAD.id, true);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing"), []);

  transport.router.setMenu([`thread:${THREAD.id}`]);
  const selection = transport.router.ingest({
    id: 802,
    guid: "manual-select-running",
    text: "1",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  assert.equal(selection.kind, "switch");
  assert.equal(selection.awaitingPrompt, true);
  await transport.acceptInbound(selection);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);

  const prompt = transport.router.ingest({
    id: 803,
    guid: "manual-selected-prompt",
    text: "Continue the task.",
    created_at: "2026-07-12T12:00:01.000Z",
  });
  assert.equal(prompt.threadId, THREAD.id);
  assert.equal(prompt.fromAwaitingPrompt, true);
  await transport.acceptInbound(prompt);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);

  await transport.setThreadTyping(THREAD.id, false);
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

test("watch recovery immediately restores typing for the current default working task", async () => {
  const { transport, client } = fixture({ watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  await transport.start();
  transport.router.setThreadRoot(THREAD.id, "typing-recovery-root");
  const selected = transport.router.ingest({
    id: 804,
    guid: "typing-recovery-select",
    text: "/thread",
    thread_originator_guid: "typing-recovery-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(selected);
  await transport.setThreadTyping(THREAD.id, true);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true]);

  client.watchHandlers.onError(new Error("bridge restarted"));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(transport.isHealthy(), true);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [true, false, true]);
});

test("watch recovery retries a failed typing clear on the fresh helper connection", async () => {
  class FailFirstTypingClearClient extends FakeClient {
    async setTyping(params, value) {
      this.calls.push(["typing", params, value]);
      if (value === false && !this.failedTypingClear) {
        this.failedTypingClear = true;
        throw new Error("old helper connection closed");
      }
      return this.accepted("typing");
    }
  }
  const client = new FailFirstTypingClearClient();
  const { transport } = fixture({ client, watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  await transport.start();
  transport.router.setThreadRoot(THREAD.id, "typing-retry-root");
  const selected = transport.router.ingest({
    id: 806,
    guid: "typing-retry-select",
    text: "/thread",
    thread_originator_guid: "typing-retry-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(selected);
  await transport.setThreadTyping(THREAD.id, true);

  client.watchHandlers.onError(new Error("helper connection failed"));
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(transport.isHealthy(), true);
  assert.deepEqual(client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]), [
    true,
    false,
    false,
    true,
  ]);
});

test("watch failure and stop force typing off even after the local typing cache resets", async () => {
  const { transport, client } = fixture({ watchRetryBaseMs: 100, watchRetryMaxMs: 100 });
  await transport.start();
  transport.router.setThreadRoot(THREAD.id, "typing-stop-root");
  const selected = transport.router.ingest({
    id: 805,
    guid: "typing-stop-select",
    text: "/thread",
    thread_originator_guid: "typing-stop-root",
    created_at: "2026-07-12T12:00:00.000Z",
  });
  await transport.acceptInbound(selected);
  await transport.setThreadTyping(THREAD.id, true);
  client.watchHandlers.onError(new Error("watch failed before stop"));
  await new Promise((resolve) => setImmediate(resolve));
  await transport.stop();

  const values = client.calls.filter(([kind]) => kind === "typing").map((call) => call[2]);
  assert.deepEqual(values, [true, false, false]);
  assert.equal(values.at(-1), false);
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

test("a watch invalidated while durable actions replay schedules another recovery", async () => {
  const { transport, client } = fixture({ watchRetryBaseMs: 10, watchRetryMaxMs: 20 });
  transport.setActiveThread(THREAD);
  transport.router.ingest({
    id: 311,
    guid: "recovery-replay-race-guid",
    chat_id: 42,
    chat_guid: "iMessage;-;+15550000000",
    sender: "+15551111111",
    is_from_me: false,
    text: "Keep this pending through two watch failures.",
    created_at: "2026-07-12T12:00:00.000Z",
  });

  let releaseReplay;
  let replayStarted;
  const replayStartedPromise = new Promise((resolve) => { replayStarted = resolve; });
  const releaseReplayPromise = new Promise((resolve) => { releaseReplay = resolve; });
  let deliveries = 0;
  await transport.start({
    onAction: async () => {
      deliveries += 1;
      if (deliveries === 1) {
        replayStarted();
        await releaseReplayPromise;
      }
    },
  });

  client.watchHandlers.onError(new Error("first watch exited"));
  await replayStartedPromise;
  assert.equal(client.calls.filter(([kind]) => kind === "watch").length, 2);
  client.watchHandlers.onError(new Error("recovered watch exited during replay"));
  releaseReplay();

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(client.calls.filter(([kind]) => kind === "watch").length, 3, JSON.stringify(client.calls));
  assert.equal(deliveries, 2);
  assert.equal(transport.isHealthy(), true);
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
  assert.equal(client.calls.filter(([kind]) => kind === "read").length, 0);
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
  assert.equal(client.calls.filter(([kind]) => kind === "read").length, 1);
});

test("formatting conversion groups styles sharing one UTF-16 range", () => {
  assert.deepEqual(imsgTransportInternals.nativeFormatting([
    { location: 3, length: 4, style: "bold" },
    { location: 3, length: 4, style: "italic" },
  ]), [{ start: 3, length: 4, styles: ["bold", "italic"] }]);
});
