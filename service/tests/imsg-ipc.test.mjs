import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  IpcFrameDecoder,
  canonicalImsgIdentity,
  challengeTranscript,
  controllerIdentityHash,
  createControllerAttestation,
  createHelperAttestation,
  extractImsgAccountIdentities,
  generateIpcKeyPair,
  imsgAccountFingerprint,
  ipcPublicKeyFingerprint,
  signIpcTranscript,
  verifyIpcTranscript,
} from "../src/imsg-ipc-protocol.mjs";
import { ImsgHelperServer, inspectLocalImsgIdentity } from "../src/imsg-helper-server.mjs";
import { ImsgIpcClient, createImsgIpcClientFromConfig } from "../src/imsg-ipc-client.mjs";
import { REQUIRED_PINNED_IMSG_CAPABILITIES } from "../src/imsg-client.mjs";

function temporary() {
  const root = mkdtempSync(path.join(os.tmpdir(), "imsg-ipc-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

class FakeImsgClient {
  constructor() {
    this.calls = [];
    this.handlers = null;
    this.child = null;
    this.rpcReady = false;
  }

  async status() {
    return {
      available: true,
      basic: true,
      advanced: true,
      capabilities: {
        watch: true,
        richText: true,
        replies: true,
        polls: true,
        pollCaptionControl: true,
        pollVoting: true,
        tapbacks: true,
        typing: true,
        readReceipts: true,
        attachments: true,
        sendStatus: true,
      },
      rpcMethods: ["send.rich", "watch.subscribe", "watch.unsubscribe"],
    };
  }

  async latestMessage() { return { guid: "LATEST", chat_id: 42, sender: "+12145550196", attachments: [] }; }
  async start() { this.calls.push(["start"]); this.child = new EventEmitter(); this.rpcReady = true; return this; }
  async stop() { this.calls.push(["stop"]); this.rpcReady = false; this.child = null; }
  async sendRich(params) { this.calls.push(["sendRich", params]); return this.accepted("RICH-1"); }
  async sendAttachment(params) {
    this.calls.push(["sendAttachment", params, readFileSync(params.file)]);
    return this.accepted("ATTACHMENT-1");
  }
  async sendPoll(params) { this.calls.push(["sendPoll", params]); return this.accepted("POLL-1"); }
  async sendPollVote(params, options) { this.calls.push(["sendPollVote", params, options]); return this.accepted("VOTE-1"); }
  async tapback(params) { this.calls.push(["tapback", params]); return this.accepted("TAPBACK-1"); }
  async setTyping(params, typing) { this.calls.push(["typing", params, typing]); return this.accepted("TYPING-1"); }
  async markRead(params) { this.calls.push(["read", params]); return this.accepted("READ-1"); }
  async sendStatus(guid) { this.calls.push(["status", guid]); return this.accepted("STATUS-1", { send_state: "delivered" }); }
  async editMessage(params) { this.calls.push(["edit", params]); return this.accepted("EDIT-1"); }
  async unsendMessage(params) { this.calls.push(["unsend", params]); return this.accepted("UNSEND-1"); }

  async subscribeWatch(params, handlers) {
    this.calls.push(["watch", params]);
    this.handlers = handlers;
    return { subscription: 7, unsubscribe: async () => { this.handlers = null; return true; } };
  }

  accepted(guid, extra = {}) {
    return { classification: "accepted", accepted: true, ambiguous: false, unsupported: false, guid, ...extra };
  }
}

async function fixture(t, options = {}) {
  const temporaryRoot = temporary();
  t.after(temporaryRoot.cleanup);
  const helperKeys = generateIpcKeyPair();
  const controllerKeys = generateIpcKeyPair();
  const accountIdentities = ["E:helper@example.com", "tel:+14155550100"];
  const profile = {
    binary: "/private/fake/imsg",
    chatId: 42,
    chatGuid: "iMessage;-;+12145550196",
    expectedSender: "+12145550196",
    localIdentity: "helper@example.com",
    accountFingerprint: imsgAccountFingerprint(accountIdentities),
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
  };
  const user = os.userInfo();
  const processIdentity = { uid: process.getuid(), username: user.username, home: realpathSync(os.homedir()) };
  const controllerHome = path.join(temporaryRoot.root, "codex-home");
  mkdirSync(controllerHome, { mode: 0o700 });
  const controllerAttestation = createControllerAttestation({
    uid: process.getuid(),
    username: user.username,
    codexHome: realpathSync(controllerHome),
  });
  const helperAttestation = createHelperAttestation(profile, processIdentity);
  const expectedHelperAttestation = Object.fromEntries([
    ["role", "imsg-helper"],
    ...["identityHash", "accountHash", "conversationHash", "profileHash"].map((key) => [key, helperAttestation[key]]),
  ]);
  const fake = options.fake || new FakeImsgClient();
  const messagesRoot = path.join(temporaryRoot.root, "messages");
  const stagingRoot = path.join(temporaryRoot.root, "staging");
  mkdirSync(messagesRoot, { recursive: true, mode: 0o700 });
  const server = new ImsgHelperServer({
    socketPath: path.join(temporaryRoot.root, "exchange", "helper.sock"),
    privateKey: helperKeys.privateKey,
    controllerPublicKey: controllerKeys.publicKey,
    expectedControllerIdentityHash: controllerIdentityHash(controllerAttestation),
    profile,
    client: fake,
    inspectIdentity: () => ({ identities: accountIdentities, accountFingerprint: profile.accountFingerprint }),
    inspectChat: () => ({ chatId: 42, chatGuid: profile.chatGuid, service: "iMessage", isGroup: false, participants: [profile.expectedSender] }),
    expectedUid: process.getuid(),
    expectedUsername: user.username,
    expectedHome: os.homedir(),
    messagesAttachmentRoot: messagesRoot,
    stagingRoot,
  });
  await server.start();
  t.after(() => server.stop());
  const client = new ImsgIpcClient({
    socketPath: server.socketPath,
    privateKey: options.controllerPrivateKey || controllerKeys.privateKey,
    helperPublicKey: helperKeys.publicKey,
    controllerAttestation,
    expectedHelperAttestation: options.expectedHelperAttestation || expectedHelperAttestation,
  });
  t.after(() => client.stop());
  return {
    ...temporaryRoot,
    server,
    client,
    fake,
    profile,
    helperKeys,
    controllerKeys,
    controllerHome,
    controllerAttestation,
    expectedHelperAttestation,
    messagesRoot,
    stagingRoot,
  };
}

test("shared identity normalization covers Apple prefixes and account envelopes", () => {
  assert.equal(canonicalImsgIdentity("tel:+1 (214) 555-0196"), canonicalImsgIdentity("+12145550196"));
  assert.equal(canonicalImsgIdentity("P:+12145550196"), canonicalImsgIdentity("+12145550196"));
  assert.equal(canonicalImsgIdentity("mailto:Person@Example.com"), canonicalImsgIdentity("E:person@example.com"));
  const identities = extractImsgAccountIdentities({
    account: { login: "E:one@example.com", aliases: ["tel:+14155550100"] },
    accounts: [{ account_login: "two@example.com", handles: ["P:+12145550196"] }],
  });
  assert.deepEqual(identities, ["E:one@example.com", "tel:+14155550100", "two@example.com", "P:+12145550196"]);
  assert.equal(imsgAccountFingerprint(identities), imsgAccountFingerprint([...identities].reverse()));
});

test("IPC key helpers accept PEM and Node KeyObjects", () => {
  const keys = generateIpcKeyPair();
  const privateKey = createPrivateKey(keys.privateKey);
  const publicKey = createPublicKey(keys.publicKey);
  const transcript = Buffer.from("key-object-test");
  const signature = signIpcTranscript(privateKey, transcript);
  assert.equal(verifyIpcTranscript(publicKey, transcript, signature), true);
  assert.equal(ipcPublicKeyFingerprint(publicKey), ipcPublicKeyFingerprint(keys.publicKey));
});

test("live account inspection uses the bridge account command and shared fingerprint", () => {
  let args;
  const result = inspectLocalImsgIdentity({
    binary: "/private/fake/imsg",
    run: (_binary, values) => {
      args = values;
      return `${JSON.stringify({ accounts: [{ login: "E:helper@example.com", aliases: ["tel:+14155550100"] }] })}\n`;
    },
  });
  assert.deepEqual(args, ["account", "--json"]);
  assert.equal(result.accountFingerprint, imsgAccountFingerprint(result.identities));
});

test("mutually authenticated proxy exposes only the pinned profile and advanced bridge methods", async (t) => {
  const { client, fake, profile } = await fixture(t);
  const helper = await client.helperStatus();
  assert.deepEqual(helper.profile, { chatId: profile.chatId, chatGuid: profile.chatGuid, expectedSender: profile.expectedSender });
  assert.equal(helper.profile.localIdentity, undefined);
  await client.start();
  const sent = await client.sendRich({ chat_id: 42, text: "hello", text_formatting: [] });
  assert.equal(sent.classification, "accepted");
  assert.deepEqual(fake.calls.find(([kind]) => kind === "sendRich")[1], {
    chat_id: 42,
    text: "hello",
    text_formatting: [],
  });
  const status = await client.sendStatus("RICH-1");
  assert.equal(status.send_state, "delivered");
  assert.deepEqual(fake.calls.find(([kind]) => kind === "status"), ["status", "RICH-1"]);
  const read = await client.markRead({ chat_id: 42 });
  assert.equal(read.classification, "accepted");
  assert.deepEqual(fake.calls.find(([kind]) => kind === "read"), ["read", { chat_id: 42 }]);
  const reaction = await client.tapback({ chat_id: 42, message_guid: "RICH-1", reaction: "like" });
  assert.equal(reaction.classification, "accepted");
  assert.deepEqual(fake.calls.find(([kind]) => kind === "tapback"), [
    "tapback",
    { chat_id: 42, message_guid: "RICH-1", reaction: "like" },
  ]);

  const calls = fake.calls.length;
  const rejected = await client.sendRich({ chat_id: 99, text: "wrong target", text_formatting: [] });
  assert.equal(rejected.classification, "ambiguous");
  assert.equal(fake.calls.length, calls);
});

test("helper IPC preserves safe RPC diagnostics while stripping raw remote error fields", async (t) => {
  const fake = new FakeImsgClient();
  fake.sendPoll = async (params) => {
    fake.calls.push(["sendPoll", params]);
    return {
      classification: "ambiguous",
      accepted: false,
      ambiguous: true,
      unsupported: false,
      retrySafe: false,
      reason: "transport-or-send-failure",
      failureSource: "remote-error",
      remoteCode: -32603,
      remoteCategory: "poll-reply-target-unresolved",
      remoteMessage: "private-person@example.com must never cross IPC",
      rawError: "Could not resolve reply target for poll: PRIVATE-GUID",
    };
  };
  const { client, server } = await fixture(t, { fake });
  await client.start();
  const result = await client.sendPoll({
    chat_id: 42,
    question: "Choose",
    options: ["One", "Two"],
    reply_to: "PRIVATE-GUID",
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
  assert.equal(JSON.stringify(result).includes("PRIVATE-GUID"), false);
  assert.equal(JSON.stringify(result).includes("private-person"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.helperStatus().health.healthy, true, "explicit remote errors must not retire a healthy RPC session");
});

test("helper startup rejects imsg builds missing any required pinned capability", async (t) => {
  for (const capability of REQUIRED_PINNED_IMSG_CAPABILITIES) {
    await t.test(capability, async (subtest) => {
      const fake = new FakeImsgClient();
      fake.status = async () => {
        const status = await FakeImsgClient.prototype.status.call(fake);
        delete status.capabilities[capability];
        return status;
      };

      await assert.rejects(
        fixture(subtest, { fake }),
        (error) => error?.code === "IMSG_PINNED_MODE_UNAVAILABLE",
      );
    });
  }
});

test("closing a diagnostics connection leaves the helper pinned RPC running", async (t) => {
  const { client, fake } = await fixture(t);
  await client.start();
  assert.equal(fake.rpcReady, true);

  await client.close();
  assert.equal(fake.rpcReady, true);
  assert.equal(fake.calls.some(([kind]) => kind === "stop"), false);

  const helper = await client.helperStatus();
  assert.equal(helper.profile.chatId, 42);
  assert.equal(fake.rpcReady, true);
});

test("wrong controller key and mismatched helper attestation fail closed", async (t) => {
  const wrongController = generateIpcKeyPair();
  const first = await fixture(t, { controllerPrivateKey: wrongController.privateKey });
  await assert.rejects(first.client.connect(), (error) => ["IMSG_IPC_DISCONNECTED", "IMSG_IPC_UNAVAILABLE"].includes(error.code));

  const second = await fixture(t, {
    expectedHelperAttestation: {
      role: "imsg-helper",
      identityHash: "1".repeat(64),
      accountHash: "2".repeat(64),
      conversationHash: "3".repeat(64),
      profileHash: "4".repeat(64),
    },
  });
  await assert.rejects(second.client.connect(), (error) => ["IMSG_IPC_AUTH_FAILED", "IMSG_IPC_DISCONNECTED"].includes(error.code));
});

test("watch filtering and attachment staging keep raw paths on their owning side", async (t) => {
  const { client, fake, messagesRoot, root, stagingRoot } = await fixture(t);
  await client.start();
  const source = path.join(messagesRoot, "incoming.png");
  writeFileSync(source, Buffer.from("incoming-image"), { mode: 0o600 });
  const received = [];
  let resolveInbound;
  const inbound = new Promise((resolve) => { resolveInbound = resolve; });
  await client.subscribeWatch({ chat_id: 42, attachments: true }, { onMessage: (message) => { received.push(message); resolveInbound(); } });
  fake.handlers.onMessage({ guid: "WRONG", chat_id: 42, chat_guid: "iMessage;-;+12145550196", sender: "+19995550199", is_from_me: false });
  fake.handlers.onMessage({ guid: "INBOUND-1", chat_id: 42, chat_guid: "iMessage;-;+12145550196", sender: "+12145550196", is_from_me: false, attachments: [{ path: source }] });
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("watch event timed out")), 1_000);
    timer.unref?.();
  });
  await Promise.race([inbound, timeout]);
  assert.deepEqual(received.map((message) => message.guid), ["INBOUND-1"]);

  const imported = await client.importAttachments(received[0].attachments, {
    destinationRoot: path.join(root, "controller-attachments"),
    messageKey: "INBOUND-1",
  });
  assert.equal(imported.length, 1);
  assert.equal(readFileSync(imported[0], "utf8"), "incoming-image");

  const outbound = path.join(root, "outbound.png");
  writeFileSync(outbound, Buffer.from("outbound-image"), { mode: 0o600 });
  const result = await client.sendAttachment({ chat_id: 42, file: outbound });
  assert.equal(result.classification, "accepted");
  const call = fake.calls.find(([kind]) => kind === "sendAttachment");
  assert.notEqual(call[1].file, outbound);
  assert.equal(call[2].toString(), "outbound-image");
  assert.equal(call[1].file.startsWith(`${stagingRoot}${path.sep}`), true);
  assert.equal(existsSync(call[1].file), false, "the helper releases staged files after the send result");
});

test("accepted mutations retain their exact result across controller and helper crashes", async (t) => {
  const first = await fixture(t);
  const operationId = `outbound:${"a".repeat(64)}`;
  const params = { chat_id: 42, text: "Send exactly once", text_formatting: [] };
  await first.client.start();
  const accepted = await first.client.sendRich(params, { operationId });
  const repeated = await first.client.sendRich(params, { operationId });
  assert.equal(accepted.guid, "RICH-1");
  assert.equal(repeated.guid, accepted.guid);
  assert.equal(first.fake.calls.filter(([kind]) => kind === "sendRich").length, 1);

  const crashed = first.server.waitForFatal();
  first.fake.child.emit("close", 1);
  assert.equal((await crashed).code, "IMSG_RPC_CLOSED");
  await first.client.stop();
  await first.server.stop();
  const secondFake = new FakeImsgClient();
  const user = os.userInfo();
  const accountIdentities = ["E:helper@example.com", "tel:+14155550100"];
  const secondServer = new ImsgHelperServer({
    socketPath: first.server.socketPath,
    privateKey: first.helperKeys.privateKey,
    controllerPublicKey: first.controllerKeys.publicKey,
    expectedControllerIdentityHash: controllerIdentityHash(first.controllerAttestation),
    profile: first.profile,
    client: secondFake,
    inspectIdentity: () => ({ identities: accountIdentities, accountFingerprint: first.profile.accountFingerprint }),
    inspectChat: () => ({
      chatId: first.profile.chatId,
      chatGuid: first.profile.chatGuid,
      service: "iMessage",
      isGroup: false,
      participants: [first.profile.expectedSender],
    }),
    expectedUid: process.getuid(),
    expectedUsername: user.username,
    expectedHome: os.homedir(),
    messagesAttachmentRoot: first.messagesRoot,
    stagingRoot: first.stagingRoot,
  });
  await secondServer.start();
  t.after(() => secondServer.stop());
  const secondClient = new ImsgIpcClient({
    socketPath: secondServer.socketPath,
    privateKey: first.controllerKeys.privateKey,
    helperPublicKey: first.helperKeys.publicKey,
    controllerAttestation: first.controllerAttestation,
    expectedHelperAttestation: first.expectedHelperAttestation,
  });
  t.after(() => secondClient.stop());
  await secondClient.start();
  const recovered = await secondClient.sendRich(params, { operationId });
  assert.equal(recovered.guid, accepted.guid);
  assert.equal(secondFake.calls.some(([kind]) => kind === "sendRich"), false);
});

test("an accepted send fails closed and makes the helper unhealthy when its durable ledger cannot be written", async (t) => {
  const current = await fixture(t);
  await current.client.start();
  const operationDirectory = path.join(
    current.stagingRoot,
    "operations",
    current.expectedHelperAttestation.profileHash,
  );
  chmodSync(operationDirectory, 0o500);
  t.after(() => {
    if (existsSync(operationDirectory)) chmodSync(operationDirectory, 0o700);
  });

  const fatal = current.server.waitForFatal();
  const result = await current.client.sendRich(
    { chat_id: 42, text: "The transport must not claim this succeeded", text_formatting: [] },
    { operationId: `outbound:${"d".repeat(64)}` },
  );
  assert.equal(result.classification, "ambiguous");
  assert.equal(current.fake.calls.filter(([kind]) => kind === "sendRich").length, 1);
  const failure = await fatal;
  assert.equal(failure.code, "IMSG_OPERATION_STORE_FAILED");
  assert.equal(current.server.helperStatus().health.healthy, false);
  assert.deepEqual(readdirSync(operationDirectory).filter((name) => name.endsWith(".json")), []);
});

test("pinned RPC child death makes the helper fatal for supervisor restart", async (t) => {
  const { client, fake, server } = await fixture(t);
  await client.start();
  const failure = server.waitForFatal();
  fake.child.emit("close", 1);
  const error = await failure;
  assert.equal(error.code, "IMSG_RPC_CLOSED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.server, null);
});

test("client factory enforces private config/key permissions and shared hashes", (t) => {
  const { root, cleanup } = temporary();
  t.after(cleanup);
  const helperKeys = generateIpcKeyPair();
  const controllerKeys = generateIpcKeyPair();
  const codexHome = path.join(root, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  const controller = createControllerAttestation({ uid: process.getuid(), username: os.userInfo().username, codexHome: realpathSync(codexHome) });
  const privateKeyPath = path.join(root, "controller.pem");
  const publicKeyPath = path.join(root, "helper.pub");
  const configPath = path.join(root, "client.json");
  writeFileSync(privateKeyPath, controllerKeys.privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, helperKeys.publicKey, { mode: 0o644 });
  const expectedHelperAttestation = {
    role: "imsg-helper",
    identityHash: "1".repeat(64),
    accountHash: "2".repeat(64),
    conversationHash: "3".repeat(64),
    profileHash: "4".repeat(64),
  };
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    socketPath: path.join(root, "helper.sock"),
    privateKeyPath,
    helperPublicKeyPath: publicKeyPath,
    codexHome,
    expectedControllerIdentityHash: controllerIdentityHash(controller),
    expectedHelperAttestation,
  }), { mode: 0o600 });
  const client = createImsgIpcClientFromConfig(configPath);
  assert.equal(client instanceof ImsgIpcClient, true);
  chmodSync(configPath, 0o644);
  assert.throws(() => createImsgIpcClientFromConfig(configPath), { code: "IMSG_IPC_FILE_UNSAFE" });
});

test("frame decoder rejects oversized input before unbounded buffering", () => {
  const decoder = new IpcFrameDecoder({ maxFrameBytes: 64 });
  assert.throws(() => decoder.push(Buffer.alloc(65, 0x61)), { code: "IMSG_IPC_FRAME_TOO_LARGE" });
});

test("pre-auth decoding bounds frame bursts and transcript nesting", () => {
  const decoder = new IpcFrameDecoder({ maxFramesPerPush: 2 });
  assert.throws(() => decoder.push("{}\n{}\n{}\n"), { code: "IMSG_IPC_FRAME_BURST" });
  let nested = {};
  for (let index = 0; index < 20; index += 1) nested = { nested };
  assert.throws(
    () => challengeTranscript({ serverNonce: "a".repeat(43), helperAttestation: nested }),
    { code: "IMSG_IPC_VALUE_TOO_DEEP" },
  );
});
