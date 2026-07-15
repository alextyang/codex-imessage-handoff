import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalUserMirrorSender,
  localUserMirrorInternals,
} from "../src/local-user-mirror-sender.mjs";
import { LocalConversationRouter } from "../src/local-conversation-router.mjs";

const SERVICE_IDENTITY = "service@example.com";
const USER_IDENTITY = "owner@example.com";
const CHAT_GUID = "iMessage;-;service@example.com";
const THREAD_ID = "019f57fb-9c0c-7950-935f-597a4e236897";
const ROOT_GUID = "ROOT-GUID-A";

function testClientGuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function bridgeGuid(index) {
  return `MIRROR-GUID-${index}`;
}

function mirrorBodyHash(body) {
  return createHash("sha256").update(`local-user-mirror-body-v1\0${body}`).digest("hex");
}

// Relevant normalization from the deployed e456 mirror reader. Keeping this
// compatibility reader in the regression proves the current journal survives
// an actual old-reader parse instead of merely asserting a field name.
function e456ReadableDelivery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wireMode = value.wireMode === "plain"
    ? "plain"
    : value.wireMode === undefined || value.wireMode === "tagged"
      ? "tagged"
      : null;
  if (!/^[a-f0-9]{64}$/u.test(String(value.reservationId || ""))
    || !String(value.threadId || "").trim()
    || !/^[a-f0-9]{64}$/u.test(String(value.bodyHash || "").toLowerCase())
    || !/^codex-mirror-[a-f0-9]{32}$/u.test(String(value.token || ""))
    || !String(value.rootGuid || "").trim()
    || !wireMode
    || !["prepared", "attempting", "accepted", "ambiguous", "dead-letter"].includes(String(value.status || "").trim())
    || !Number.isFinite(Date.parse(String(value.preparedAt || "")))) return null;
  return {
    reservationId: String(value.reservationId).trim(),
    threadId: String(value.threadId).trim(),
    bodyHash: String(value.bodyHash).trim().toLowerCase(),
    token: String(value.token).trim(),
    wireMode,
    rootGuid: String(value.rootGuid).trim(),
    status: String(value.status).trim(),
    preparedAt: String(value.preparedAt).trim(),
    attemptedAt: Number.isFinite(Date.parse(String(value.attemptedAt || ""))) ? value.attemptedAt : null,
    acceptedAt: Number.isFinite(Date.parse(String(value.acceptedAt || ""))) ? value.acceptedAt : null,
    deadLetteredAt: Number.isFinite(Date.parse(String(value.deadLetteredAt || ""))) ? value.deadLetteredAt : null,
    guid: String(value.guid || "").trim() || null,
  };
}

// Exact wire-body selection used by the deployed e456 sender after its fixed
// journal normalizer has stripped fields it does not know.
function e456WireText(entry, body) {
  return entry?.wireMode === "tagged"
    ? localUserMirrorInternals.taggedText(body, entry.token)
    : String(body);
}

function jsonLines(values) {
  return `${(Array.isArray(values) ? values : [values]).map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function arg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function directChat(overrides = {}) {
  return {
    id: 42,
    guid: CHAT_GUID,
    service: "iMessage",
    is_group: false,
    participants: [SERVICE_IDENTITY],
    ...overrides,
  };
}

function rootRow(overrides = {}) {
  return {
    id: 100,
    guid: ROOT_GUID,
    chat_id: 42,
    chat_guid: CHAT_GUID,
    is_from_me: false,
    text: `Codex\ncodex://threads/${THREAD_ID}`,
    ...overrides,
  };
}

function createClock() {
  let current = Date.parse("2026-07-14T12:00:00.000Z");
  return {
    now: () => current,
    sleep: async (milliseconds) => { current += Math.max(1, Number(milliseconds) || 1); },
    advance: (milliseconds) => { current += Math.max(0, Number(milliseconds) || 0); },
  };
}

function fakeImsg(options = {}) {
  const calls = [];
  const richCalls = [];
  const clientFactoryCalls = [];
  let sendSequence = 0;
  let historyCalls = 0;
  let searchCalls = 0;
  let clientStopCalls = 0;
  let clientGuidSequence = 0;
  const sentRows = [];
  const status = options.status || {
    advanced_features: true,
    v2_ready: true,
    selectors: { clientMessageGuid: true },
    rpc_methods: ["send.rich", "send.rich.client-guid"],
  };
  const account = options.account || { account_login: USER_IDENTITY };
  const chats = options.chats || [directChat()];
  const historyValue = options.history || [rootRow()];
  const searchValue = options.search ?? [rootRow()];

  const resolveValue = async (value, context) => (
    typeof value === "function" ? value(context) : value
  );
  const execFileImpl = (file, args, execOptions, callback) => {
    const call = { file, args: [...args], options: { ...execOptions } };
    calls.push(call);
    queueMicrotask(async () => {
      try {
        if (args[0] === "--version") return callback(null, "imsg 0.13.0\n", "");
        if (args[0] === "status") return callback(null, jsonLines(await resolveValue(status, { args, call })), "");
        if (args[0] === "account") return callback(null, jsonLines(await resolveValue(account, { args, call })), "");
        if (args[0] === "chats") return callback(null, jsonLines(await resolveValue(chats, { args, call })), "");
        if (args[0] === "history") {
          historyCalls += 1;
          const rows = await resolveValue(historyValue, { args, call, historyCalls });
          return callback(null, jsonLines([...(rows || []), ...sentRows]), "");
        }
        if (args[0] === "search") {
          searchCalls += 1;
          const rows = await resolveValue(searchValue, { args, call, searchCalls });
          return callback(null, jsonLines(rows || []), "");
        }
        throw Object.assign(new Error(`Unexpected imsg command: ${args.join(" ")}`), { attempted: false });
      } catch (error) {
        callback(error, "", "");
      }
    });
    return { pid: 999 };
  };
  const client = {
    async sendRich(params) {
      sendSequence += 1;
      const call = { params: structuredClone(params), sendSequence };
      richCalls.push(call);
      const result = await (options.onSendRich
        ? options.onSendRich({ params, call, sendSequence })
        : { ok: true, guid: params.client_guid || `MIRROR-GUID-${sendSequence}` });
      const guid = result?.guid ?? result?.message_guid ?? result?.messageGuid;
      if (guid && options.persistSentRows !== false) {
        const override = typeof options.sentRow === "function"
          ? await options.sentRow({ params, call, sendSequence, result })
          : options.sentRow;
        if (override !== false) {
          sentRows.push({
            id: 1_000 + sendSequence,
            guid,
            chat_id: 42,
            chat_guid: CHAT_GUID,
            is_from_me: true,
            text: params.text,
            thread_originator_guid: params.reply_to,
            reply_to_guid: params.reply_to,
            ...(override && typeof override === "object" ? override : {}),
          });
        }
      }
      return result;
    },
    async stop() { clientStopCalls += 1; },
  };
  const imsgClientFactory = (binary) => {
    clientFactoryCalls.push(binary);
    return client;
  };
  return {
    calls,
    client,
    clientFactoryCalls,
    execFileImpl,
    imsgClientFactory,
    get historyCalls() { return historyCalls; },
    get searchCalls() { return searchCalls; },
    get clientStopCalls() { return clientStopCalls; },
    clientGuidFactory: () => testClientGuid(++clientGuidSequence),
    sendCalls() { return richCalls; },
  };
}

function createSender({
  stateFile,
  router,
  fake,
  clock,
  conversationKey = null,
  discoveryTimeoutMs = 2,
  reconcileTimeoutMs = 2,
} = {}) {
  return new LocalUserMirrorSender({
    stateFile,
    router,
    execFileImpl: fake.execFileImpl,
    imsgClientFactory: fake.imsgClientFactory,
    clientGuidFactory: fake.clientGuidFactory,
    binaryCandidates: ["/test/bin/imsg"],
    allowUnsafeTestBinary: true,
    now: clock.now,
    sleepImpl: clock.sleep,
    discoveryTimeoutMs,
    reconcileTimeoutMs,
    sendTimeoutMs: 50,
    conversationKey,
  });
}

function fixture(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "local-user-mirror-"));
  const routerFile = path.join(directory, "router.json");
  const senderFile = path.join(directory, "sender.json");
  const clock = options.clock || createClock();
  const router = options.router || new LocalConversationRouter({ stateFile: routerFile, now: clock.now });
  router.routeOutboundGuid(ROOT_GUID, THREAD_ID, { root: true });
  const fake = options.fake || fakeImsg(options.fakeOptions);
  const sender = createSender({
    stateFile: senderFile,
    router,
    fake,
    clock,
    discoveryTimeoutMs: options.discoveryTimeoutMs ?? 2,
    reconcileTimeoutMs: options.reconcileTimeoutMs ?? 2,
    conversationKey: options.conversationKey ?? null,
  });
  return { directory, routerFile, senderFile, clock, router, fake, sender };
}

async function initialize(sender, options = {}) {
  return sender.initialize({
    knownRootGuids: [ROOT_GUID],
    knownThreads: [{ threadId: THREAD_ID, rootGuid: ROOT_GUID }],
    ...options,
  });
}

function mirror(overrides = {}) {
  return {
    deliveryId: "delivery-one",
    threadId: THREAD_ID,
    rootGuid: ROOT_GUID,
    body: "Run the complete test suite.",
    phase: "user_message",
    ...overrides,
  };
}

test("pins only a root-proven direct external iMessage chat and rejects unrelated, group, SMS, and self chats", async (t) => {
  const accepted = fixture();
  assert.deepEqual(await initialize(accepted.sender), {
    available: true,
    status: "READY",
    checkedAt: "2026-07-14T12:00:00.000Z",
  });
  assert.equal(statSync(accepted.senderFile).mode & 0o777, 0o600);

  const cases = [
    ["unrelated direct chat", [directChat({ participants: ["someone-else@example.com"] })]],
    ["group", [directChat({ is_group: true, participants: [SERVICE_IDENTITY, "other@example.com"] })]],
    ["SMS", [directChat({ service: "SMS" })]],
    ["self chat", [directChat({ participants: [USER_IDENTITY] })]],
  ];
  for (const [name, chats] of cases) {
    await t.test(name, async () => {
      const item = fixture({ fake: fakeImsg({
        chats,
        search: name === "unrelated direct chat" ? [] : [rootRow()],
        history: [],
      }) });
      const result = await initialize(item.sender);
      assert.equal(result.available, true);
      assert.equal(result.status, "AWAITING_THREAD_ROOT");
      const send = await item.sender.sendMirror(mirror());
      assert.equal(send.classification, "unavailable");
      assert.equal(send.status, "ROOT_NOT_SYNCED");
      assert.equal(send.attempted, false);
      assert.equal(item.fake.sendCalls().length, 0);
    });
  }
});

test("transcript-visible mirrors require standard send.rich, not the caller-GUID extension", async () => {
  const fake = fakeImsg({
    status: {
      advanced_features: true,
      v2_ready: true,
      selectors: { clientMessageGuid: true },
      rpc_methods: ["send.rich"],
    },
  });
  const item = fixture({ fake });
  const status = await initialize(item.sender);
  assert.equal(status.available, true);
  assert.equal(status.status, "READY");
  const result = await item.sender.sendMirror(mirror());
  assert.equal(result.classification, "accepted");
  assert.deepEqual(result.guids, [bridgeGuid(1)]);
  assert.equal(fake.sendCalls().length, 1);
  assert.equal("client_guid" in fake.sendCalls()[0].params, false,
    "new mirrors must use Messages' transcript-visible GUID allocation");
});

test("canonicalizes the expected local sender alias and fails closed on account or chat-sender mismatch", async (t) => {
  const alias = "owner.alias@example.com";
  const accepted = fixture({ fake: fakeImsg({
    account: { account_login: USER_IDENTITY, aliases: [`E:${alias}`] },
    chats: [directChat({ last_addressed_handle: `mailto:${alias}` })],
  }) });
  assert.equal((await initialize(accepted.sender, {
    serviceIdentity: SERVICE_IDENTITY,
    expectedLocalSender: "E:OWNER.ALIAS@EXAMPLE.COM",
  })).status, "READY");
  assert.equal((await accepted.sender.sendMirror(mirror())).classification, "accepted");
  assert.equal(accepted.fake.sendCalls().length, 1);

  await t.test("expected alias is not owned by the active account", async () => {
    const item = fixture();
    const result = await initialize(item.sender, {
      serviceIdentity: SERVICE_IDENTITY,
      expectedLocalSender: alias,
    });
    assert.equal(result.available, false);
    assert.equal(result.status, "SENDER_IDENTITY_MISMATCH");
    assert.equal((await item.sender.sendMirror(mirror())).status, "SENDER_IDENTITY_MISMATCH");
    assert.equal(item.fake.sendCalls().length, 0);
  });

  await t.test("chat was last addressed from a different sender", async () => {
    const item = fixture({ fake: fakeImsg({
      account: { account_login: USER_IDENTITY, aliases: [alias] },
      chats: [directChat({ last_addressed_handle: "different.sender@example.com" })],
    }) });
    const result = await initialize(item.sender, {
      serviceIdentity: SERVICE_IDENTITY,
      expectedLocalSender: alias,
    });
    assert.equal(result.available, false);
    assert.equal(result.status, "CHAT_NOT_FOUND");
    const send = await item.sender.sendMirror(mirror());
    assert.equal(send.sent, false);
    assert.equal(send.attempted, false);
    assert.equal(item.fake.sendCalls().length, 0);
  });
});

test("uses known roots to disambiguate direct chats and retains the pinned binding after restart", async () => {
  const secondGuid = "iMessage;-;alternate-service-chat";
  const fake = fakeImsg({
    chats: [directChat(), directChat({ id: 84, guid: secondGuid })],
    search: [rootRow()],
    history: ({ args }) => Number(arg(args, "--chat-id")) === 42 ? [rootRow()] : [],
  });
  const item = fixture({ fake });
  assert.equal((await initialize(item.sender)).status, "READY");
  assert.equal(fake.searchCalls, 1);

  const restarted = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    discoveryTimeoutMs: 2,
    reconcileTimeoutMs: 2,
  });
  assert.equal((await initialize(restarted, { knownRootGuids: [] })).status, "READY");
  const sent = await restarted.sendMirror(mirror());
  assert.equal(sent.classification, "accepted");
  assert.equal(fake.sendCalls()[0].params.chat_guid, CHAT_GUID);
});

test("discovers a synced header root and sends one clean formatted outgoing reply", async () => {
  const fake = fakeImsg({
    history: [],
    search: [rootRow({
      guid: "REFRESH-HEADER",
      thread_originator_guid: ROOT_GUID,
    })],
  });
  const item = fixture({ fake });
  assert.equal((await initialize(item.sender)).available, true);

  const body = "Review [app.js](/Users/alex/project/app.js:12) and **run tests**.";
  const result = await item.sender.sendMirror(mirror({ body }));
  assert.equal(result.classification, "accepted");
  assert.equal(result.parts, 1);
  const [send] = fake.sendCalls();
  assert.equal(send.params.chat_guid, CHAT_GUID);
  assert.equal(send.params.reply_to, ROOT_GUID);
  assert.equal("to" in send.params, false);
  assert.equal("file" in send.params, false);
  assert.equal("url" in send.params, false);
  assert.equal(fake.calls.some((call) => call.args[0] === "launch"), false);

  const sentText = send.params.text;
  const token = localUserMirrorInternals.markerToken("delivery-one", THREAD_ID, 0);
  assert.equal(sentText.startsWith("Review app.js and run tests."), true);
  assert.equal(sentText.includes("/Users/alex/project/app.js:12"), false);
  assert.equal(localUserMirrorInternals.containsMarker(sentText, token), false);
  assert.equal([...sentText].some((character) => {
    const code = character.codePointAt(0);
    return code >= 0xe0000 && code <= 0xe007f;
  }), false);
  assert.equal(send.params.dd_scan, false);
  const formatting = send.params.text_formatting;
  assert.deepEqual(formatting, [
    { start: 7, length: 6, styles: ["bold"] },
    { start: 18, length: 9, styles: ["bold"] },
  ]);
  assert.equal(formatting.some((range) => range.start + range.length > "Review app.js and run tests.".length), false);

  const execArgv = fake.calls.flatMap((call) => call.args.map(String));
  assert.equal(execArgv.includes("--text"), false);
  assert.equal(execArgv.includes("--format"), false);
  assert.equal(execArgv.some((value) => value.includes(body)), false);
  assert.equal(execArgv.some((value) => value.includes("Review app.js and run tests.")), false);
  assert.equal(execArgv.some((value) => value.includes("/Users/alex/project/app.js:12")), false);
  assert.deepEqual(fake.clientFactoryCalls, ["/test/bin/imsg"]);

  const persisted = readFileSync(item.senderFile, "utf8");
  assert.equal(persisted.includes(body), false);
  assert.equal(persisted.includes("/Users/alex/project/app.js:12"), false);
  assert.equal(Object.values(JSON.parse(persisted).deliveries)[0].wireMode, "plain");
  assert.equal(Object.values(JSON.parse(persisted).deliveries)[0].clientGuidMode, false);
  assert.equal("client_guid" in send.params, false);
  const reservation = JSON.parse(readFileSync(item.routerFile, "utf8")).userMirrorEchoes[0];
  assert.equal(reservation.markerEvidence, false,
    "a current standard reservation must not retain hidden Unicode evidence");
});

test("every standard clean journal status remains readable and at-most-once identifiable to the deployed sender", async () => {
  const body = "Rollback-compatible clean mirror";
  const deliveryId = "rollback-compatible-client-guid";
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);
  assert.equal((await item.sender.sendMirror(mirror({ deliveryId, body }))).classification, "accepted");
  const persisted = Object.values(JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries)[0];
  assert.equal(persisted.wireMode, "plain");
  assert.equal(persisted.clientGuidMode, false);
  assert.equal(persisted.guid, bridgeGuid(1));

  for (const status of ["prepared", "attempting", "ambiguous", "accepted", "dead-letter"]) {
    const candidate = {
      ...persisted,
      status,
      attemptedAt: status === "prepared" ? null : "2026-07-14T12:00:00.000Z",
      acceptedAt: status === "accepted" ? "2026-07-14T12:00:01.000Z" : null,
      deadLetteredAt: status === "dead-letter" ? "2026-07-14T12:15:00.000Z" : null,
    };
    const rollback = e456ReadableDelivery(candidate);
    assert.ok(rollback, `${status} must survive the deployed reader`);
    assert.equal(rollback.status, status);
    assert.equal(rollback.guid, bridgeGuid(1), `${status} retains its at-most-once identity`);
    assert.equal(rollback.wireMode, "plain");
    if (status === "prepared") {
      const rollbackWireText = e456WireText(rollback, body);
      assert.equal(rollbackWireText, body,
        "the deployed prepared path must send the same clean body");
      assert.equal(localUserMirrorInternals.containsMarker(rollbackWireText, token), false);
      assert.equal([...rollbackWireText].some((character) => {
        const code = character.codePointAt(0);
        return code >= 0xe0000 && code <= 0xe007f;
      }), false, "the deployed prepared path must contain no Tags-block characters");
    }
  }
  assert.equal(fake.sendCalls()[0].params.text, body,
    "the current sender must not put the rollback compatibility marker on the wire");
  assert.equal(localUserMirrorInternals.containsMarker(fake.sendCalls()[0].params.text, token), false);
});

test("a deployed sender can safely take over the exact prepared-reservation rollback window", async () => {
  const body = "Crash before the no-resend boundary";
  const deliveryId = "rollback-prepared-reservation";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);

  const reserveUserMirrorEcho = item.router.reserveUserMirrorEcho.bind(item.router);
  let interruptAfterReservation = true;
  item.router.reserveUserMirrorEcho = (reservation) => {
    const result = reserveUserMirrorEcho(reservation);
    if (interruptAfterReservation) {
      interruptAfterReservation = false;
      throw Object.assign(new Error("simulated process loss after durable reservation"), {
        code: "TEST_PROCESS_LOSS",
      });
    }
    return result;
  };
  await assert.rejects(
    item.sender.sendMirror(mirror({ deliveryId, body })),
    { code: "TEST_PROCESS_LOSS" },
  );
  assert.equal(fake.sendCalls().length, 0, "the current bridge was never called");

  const journal = JSON.parse(readFileSync(item.senderFile, "utf8"));
  const currentEntry = journal.deliveries[key];
  const rollbackEntry = e456ReadableDelivery(currentEntry);
  assert.ok(rollbackEntry, "the deployed reader retains the prepared entry");
  assert.equal(rollbackEntry.status, "prepared");
  assert.equal("clientGuidMode" in rollbackEntry, false,
    "the deployed normalizer strips the additive discriminator");

  const durableReservation = JSON.parse(readFileSync(item.routerFile, "utf8"))
    .userMirrorEchoes.find((echo) => echo.reservationId === key);
  assert.ok(durableReservation);
  assert.equal(durableReservation.expectedGuid, null,
    "prepared rollback state has not crossed the GUID-confirmation boundary");
  assert.equal(durableReservation.markerEvidence, false);

  // Simulate e456's complete prepared-send sequence against the durable
  // router file: idempotently reserve its clean body, accept the bridge GUID,
  // then consume the receiver-side echo by exact GUID + exact Reply root.
  const rollbackRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const rollbackWireText = e456WireText(rollbackEntry, body);
  assert.equal(rollbackWireText, body);
  assert.equal(localUserMirrorInternals.containsMarker(rollbackWireText, token), false);
  assert.equal(rollbackRouter.reserveUserMirrorEcho({
    reservationId: rollbackEntry.reservationId,
    threadId: rollbackEntry.threadId,
    text: rollbackWireText,
    rootGuid: rollbackEntry.rootGuid,
  }), key);
  const rollbackBridgeGuid = "E456-BRIDGE-GUID";
  assert.equal(rollbackRouter.confirmUserMirrorEcho(key, rollbackBridgeGuid), true);
  const consumed = rollbackRouter.consumeUserMirrorEcho({
    id: 4_560,
    guid: rollbackBridgeGuid,
    text: rollbackWireText,
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  });
  assert.equal(consumed.reservationId, key);
  assert.equal(consumed.threadId, THREAD_ID);
  assert.equal(consumed.expectedGuid, rollbackBridgeGuid);
  assert.equal(rollbackRouter.userMirrorEchoReceipt(key).guid, rollbackBridgeGuid);
  assert.deepEqual(rollbackRouter.pendingActions(), []);

  // Complete the e456 journal write, then upgrade again. The current reader
  // must honor the accepted legacy GUID and never emit a second mirror.
  journal.deliveries[key] = {
    ...rollbackEntry,
    status: "accepted",
    attemptedAt: "2026-07-14T12:00:00.500Z",
    acceptedAt: "2026-07-14T12:00:01.000Z",
    guid: rollbackBridgeGuid,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const resumedFake = fakeImsg();
  const resumed = createSender({
    stateFile: item.senderFile,
    router: rollbackRouter,
    fake: resumedFake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const duplicate = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(duplicate.classification, "duplicate");
  assert.deepEqual(duplicate.guids, [rollbackBridgeGuid]);
  assert.equal(resumedFake.sendCalls().length, 0,
    "upgrade after the deployed clean send must not mirror twice");
});

test("never substitutes a different locally visible root for the expected task root", async () => {
  const newerRoot = "ROOT-GUID-NEWER";
  const fake = fakeImsg({
    history: [],
    search: ({ searchCalls }) => searchCalls === 1
      ? [rootRow()]
      : [rootRow({ guid: newerRoot })],
  });
  const item = fixture({ fake, discoveryTimeoutMs: 1 });
  assert.equal((await initialize(item.sender)).status, "READY");

  const result = await item.sender.sendMirror(mirror());
  assert.equal(result.classification, "unavailable");
  assert.equal(result.status, "ROOT_NOT_SYNCED");
  assert.equal(result.attempted, false);
  assert.equal(fake.sendCalls().length, 0);
  assert.ok(fake.calls.some((call) => call.args.includes(`codex://threads/${THREAD_ID}`)));
});

test("accepted sends are delivery-idempotent across sender and router restart", async () => {
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);
  const first = await item.sender.sendMirror(mirror());
  assert.equal(first.classification, "accepted");
  assert.deepEqual(first.guids, [bridgeGuid(1)]);
  assert.equal(fake.sendCalls().length, 1);

  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake,
    clock: item.clock,
    discoveryTimeoutMs: 2,
    reconcileTimeoutMs: 2,
  });
  await initialize(resumed);
  const duplicate = await resumed.sendMirror(mirror());
  assert.equal(duplicate.classification, "duplicate");
  assert.deepEqual(duplicate.guids, [bridgeGuid(1)]);
  assert.equal(fake.sendCalls().length, 1);
  assert.equal(resumedRouter.nativeThread(THREAD_ID).latestGuid, bridgeGuid(1));
});

test("a durable receiver receipt prevents stale reservation repair after seen-GUID eviction", async () => {
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);
  assert.equal((await item.sender.sendMirror(mirror())).classification, "accepted");
  const tagged = fake.sendCalls()[0].params.text;
  const reservationId = localUserMirrorInternals.deliveryKey("delivery-one", THREAD_ID, 0);
  assert.equal(item.router.consumeUserMirrorEcho({
    id: 650,
    guid: bridgeGuid(1),
    text: tagged,
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  }).reservationId, reservationId);
  assert.equal(item.router.userMirrorEchoReceipt(reservationId).guid, bridgeGuid(1));
  for (let index = 0; index < 513; index += 1) {
    item.router.discard({ id: 700 + index, guid: `eviction-${index}`, text: "ignored" });
  }
  assert.equal(item.router.hasSeenMessageGuid(bridgeGuid(1)), false);

  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake,
    clock: item.clock,
  });
  await initialize(resumed);
  assert.equal((await resumed.sendMirror(mirror())).classification, "duplicate");
  assert.equal(fake.sendCalls().length, 1);
  assert.equal(resumedRouter.isReservedUserMirrorEcho({
    id: 1_300,
    guid: bridgeGuid(1),
    text: tagged,
    thread_originator_guid: ROOT_GUID,
  }), false, "the receipt is durable proof that the already-consumed guard must not be recreated");
});

test("an exact receiver receipt immediately settles an ambiguous journal without resending", async () => {
  const body = "Recipient already observed this mirror";
  const deliveryId = "receiver-receipt-fast-path";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const guid = "RECEIVER-VERIFIED-GUID";
  const fake = fakeImsg({ history: [rootRow()] });
  const item = fixture({ fake, reconcileTimeoutMs: 10_000 });
  await initialize(item.sender);

  const journal = JSON.parse(readFileSync(item.senderFile, "utf8"));
  journal.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token: localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0),
    wireMode: "plain",
    clientGuidMode: false,
    rootGuid: ROOT_GUID,
    status: "ambiguous",
    preparedAt: "2026-07-14T11:59:59.000Z",
    attemptedAt: "2026-07-14T12:00:00.000Z",
    acceptedAt: null,
    deadLetteredAt: null,
    guid,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  item.router.reserveUserMirrorEcho({ reservationId: key, threadId: THREAD_ID, text: body, rootGuid: ROOT_GUID });
  item.router.confirmUserMirrorEcho(key, guid, { verified: false });
  const receipt = item.router.consumeUserMirrorEcho({
    id: 1_550,
    guid,
    text: body,
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  });
  assert.equal(receipt.reservationId, key);

  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 10_000,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "duplicate");
  assert.deepEqual(result.guids, [guid]);
  assert.equal(fake.sendCalls().length, 0);
  assert.equal(JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key].status, "accepted");
});

test("a settled delivery id with different content is rejected before any new mirror send", async () => {
  const deliveryId = "reused-settled-delivery";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const oldBody = "Original settled content";
  const newBody = "Different content reusing the same id";
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);
  item.router.reserveUserMirrorEcho({
    reservationId: key,
    threadId: THREAD_ID,
    text: oldBody,
    rootGuid: ROOT_GUID,
    bodyHash: mirrorBodyHash(oldBody),
  });
  item.router.confirmUserMirrorEcho(key, "OLD-SETTLED-GUID");
  item.router.consumeUserMirrorEcho({
    id: 1_560,
    guid: "OLD-SETTLED-GUID",
    text: oldBody,
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  });

  await assert.rejects(
    item.sender.sendMirror(mirror({ deliveryId, body: newBody })),
    { code: "IMSG_MIRROR_ECHO_CONFLICT" },
  );
  assert.equal(fake.sendCalls().length, 0,
    "a stale receipt cannot settle or authorize a different body");
});

test("an unbound historical receipt settles only an independently exact attempted GUID", async () => {
  const deliveryId = "legacy-unbound-receipt";
  const body = "Historical caller GUID content";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const guid = testClientGuid(8);
  const fake = fakeImsg({ history: [rootRow()] });
  const item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  item.router.reserveUserMirrorEcho({ reservationId: key, threadId: THREAD_ID, text: body, rootGuid: ROOT_GUID });
  item.router.confirmUserMirrorEcho(key, guid);
  item.router.consumeUserMirrorEcho({
    id: 1_570,
    guid,
    text: body,
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  });
  const routerState = JSON.parse(readFileSync(item.routerFile, "utf8"));
  delete routerState.userMirrorReceipts[key].bodyHash;
  delete routerState.userMirrorReceipts[key].fingerprint;
  writeFileSync(item.routerFile, `${JSON.stringify(routerState, null, 2)}\n`, { mode: 0o600 });

  const senderState = JSON.parse(readFileSync(item.senderFile, "utf8"));
  senderState.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token: localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0),
    wireMode: "plain",
    clientGuidMode: true,
    rootGuid: ROOT_GUID,
    status: "ambiguous",
    preparedAt: "2026-07-14T11:59:59.000Z",
    attemptedAt: "2026-07-14T12:00:00.000Z",
    acceptedAt: null,
    deadLetteredAt: null,
    guid,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(senderState, null, 2)}\n`, { mode: 0o600 });

  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "duplicate");
  assert.deepEqual(result.guids, [guid]);
  assert.equal(fake.sendCalls().length, 0);
});

test("an accepted sender journal repairs a fresh router ledger and GUID route without resending", async () => {
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);
  assert.equal((await item.sender.sendMirror(mirror())).classification, "accepted");

  const repairRouter = new LocalConversationRouter({
    stateFile: path.join(item.directory, "repair-router.json"),
    now: item.clock.now,
  });
  repairRouter.routeOutboundGuid(ROOT_GUID, THREAD_ID, { root: true });
  const reservationId = localUserMirrorInternals.deliveryKey("delivery-one", THREAD_ID, 0);
  const plain = "Run the complete test suite.";
  repairRouter.reserveUserMirrorEcho({
    reservationId,
    threadId: THREAD_ID,
    text: plain,
    rootGuid: ROOT_GUID,
  });

  const resumed = createSender({
    stateFile: item.senderFile,
    router: repairRouter,
    fake,
    clock: item.clock,
  });
  await initialize(resumed);
  const duplicate = await resumed.sendMirror(mirror());
  assert.equal(duplicate.classification, "duplicate");
  assert.equal(fake.sendCalls().length, 1);
  assert.equal(repairRouter.nativeThread(THREAD_ID).latestGuid, bridgeGuid(1));
  assert.equal(repairRouter.consumeUserMirrorEcho({
    id: 700,
    guid: "WRONG-GUID",
    text: plain,
    thread_originator_guid: ROOT_GUID,
  }), null);
  assert.equal(repairRouter.consumeUserMirrorEcho({
    id: 701,
    guid: bridgeGuid(1),
    text: plain,
    thread_originator_guid: ROOT_GUID,
  }).expectedGuid, bridgeGuid(1));
});

test("changing conversation scope clears the pinned chat and accepted delivery journal", async () => {
  const firstKey = "a".repeat(64);
  const secondKey = "b".repeat(64);
  const item = fixture({ conversationKey: firstKey });
  await initialize(item.sender);
  assert.equal((await item.sender.sendMirror(mirror())).classification, "accepted");
  const firstState = JSON.parse(readFileSync(item.senderFile, "utf8"));
  assert.equal(firstState.conversationKey, firstKey);
  assert.ok(firstState.binding);
  assert.equal(Object.keys(firstState.deliveries).length, 1);

  const secondFake = fakeImsg({ history: [], search: [] });
  const switched = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake: secondFake,
    clock: item.clock,
    conversationKey: secondKey,
    discoveryTimeoutMs: 1,
  });
  const capability = await initialize(switched);
  assert.equal(capability.available, true);
  assert.equal(capability.status, "AWAITING_THREAD_ROOT");
  const secondState = JSON.parse(readFileSync(item.senderFile, "utf8"));
  assert.equal(secondState.conversationKey, secondKey);
  assert.equal(secondState.binding, null);
  assert.deepEqual(secondState.deliveries, {});
  assert.equal((await switched.sendMirror(mirror())).status, "ROOT_NOT_SYNCED");
  assert.equal(secondFake.sendCalls().length, 0);
});

test("a genuine same-body message remains actionable while only the exact mirror GUID is suppressed", async () => {
  let mirrorText = null;
  const fake = fakeImsg({
    onSendRich: ({ params }) => {
      mirrorText = params.text;
      return { ok: true, guid: bridgeGuid(1) };
    },
  });
  const item = fixture({ fake });
  await initialize(item.sender);
  await item.sender.sendMirror(mirror({ body: "Identical request" }));

  const genuine = {
    id: 501,
    guid: "GENUINE-GUID",
    text: "Identical request",
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  };
  assert.equal(item.router.consumeUserMirrorEcho(genuine), null);
  const action = item.router.ingest(genuine);
  assert.equal(action.kind, "prompt");
  assert.equal(action.threadId, THREAD_ID);
  assert.equal(action.body, "Identical request");

  const echo = item.router.consumeUserMirrorEcho({
    id: 502,
    guid: bridgeGuid(1),
    text: mirrorText,
    created_at: "2026-07-14T12:00:02.000Z",
    thread_originator_guid: ROOT_GUID,
  });
  assert.equal(echo.threadId, THREAD_ID);
  assert.equal(echo.guid, bridgeGuid(1));
  assert.equal(item.router.lastRowId, 502);
  assert.equal(item.router.nativeThread(THREAD_ID).latestGuid, bridgeGuid(1));
});

test("holds an immediate standard-send echo by exact clean body and Reply root until the bridge GUID arrives", async () => {
  let item;
  let candidate;
  const fake = fakeImsg({
    onSendRich: ({ params }) => {
      candidate = {
        id: 601,
        guid: "EARLY-ECHO-GUID",
        text: params.text,
        created_at: "2026-07-14T12:00:01.000Z",
        thread_originator_guid: ROOT_GUID,
      };
      assert.equal("client_guid" in params, false);
      assert.equal(item.router.consumeUserMirrorEcho(candidate), null,
        "body and Reply root alone must not permanently consume a user message");
      const provisional = item.router.provisionalUserMirrorEcho(candidate);
      assert.equal(provisional.threadId, THREAD_ID);
      assert.equal(provisional.rootGuid, ROOT_GUID);
      return { ok: true, guid: candidate.guid };
    },
  });
  item = fixture({ fake });
  await initialize(item.sender);
  const confirmUserMirrorEcho = item.router.confirmUserMirrorEcho.bind(item.router);
  let statusAtFirstGuidConfirmation = null;
  item.router.confirmUserMirrorEcho = (...args) => {
    statusAtFirstGuidConfirmation ||= Object.values(
      JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries,
    )[0]?.status || null;
    return confirmUserMirrorEcho(...args);
  };
  const result = await item.sender.sendMirror(mirror({ body: "Race the result" }));
  assert.equal(result.classification, "accepted");
  assert.equal(statusAtFirstGuidConfirmation, "attempting",
    "the durable no-resend boundary must precede exact-GUID reservation");
  const consumed = item.router.consumeUserMirrorEcho(candidate);
  assert.equal(consumed.threadId, THREAD_ID);
  assert.equal(consumed.expectedGuid, candidate.guid);
  assert.equal(item.router.consumeUserMirrorEcho(candidate), null);
  assert.equal(item.router.lastRowId, 601);
  assert.deepEqual(item.router.pendingActions(), []);
});

test("a no-GUID standard response remains ambiguous without permanently consuming a body-only candidate", async () => {
  let item;
  let delivered = false;
  const fake = fakeImsg({
    history: () => delivered
      ? [
        rootRow(),
        {
          id: 6_101,
          guid: "EARLY-NO-RESULT-GUID",
          chat_id: 42,
          chat_guid: CHAT_GUID,
          is_from_me: true,
          text: "Normalized before bridge result",
          thread_originator_guid: ROOT_GUID,
          reply_to_guid: ROOT_GUID,
        },
      ]
      : [rootRow()],
    onSendRich: ({ params }) => {
      const candidate = {
        id: 6_102,
        guid: "EARLY-NO-RESULT-GUID",
        text: "Normalized before bridge result",
        created_at: "2026-07-14T12:00:01.000Z",
        thread_originator_guid: ROOT_GUID,
      };
      assert.equal("client_guid" in params, false);
      assert.equal(item.router.consumeUserMirrorEcho(candidate), null);
      assert.equal(item.router.provisionalUserMirrorEcho(candidate).threadId, THREAD_ID);
      delivered = true;
      assert.equal(localUserMirrorInternals.containsMarker(params.text,
        localUserMirrorInternals.markerToken("normalized-no-guid", THREAD_ID, 0)), false);
      return { ok: true, queued: true };
    },
  });
  item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  const result = await item.sender.sendMirror(mirror({
    deliveryId: "normalized-no-guid",
    body: "Normalized before bridge result",
  }));
  assert.equal(result.classification, "ambiguous");
  assert.deepEqual(result.guids, []);
  const reservationId = localUserMirrorInternals.deliveryKey("normalized-no-guid", THREAD_ID, 0);
  assert.equal(item.router.userMirrorEchoReceipt(reservationId), null);
  const reservation = JSON.parse(readFileSync(item.routerFile, "utf8")).userMirrorEchoes
    .find((echo) => echo.reservationId === reservationId);
  assert.ok(reservation);
  assert.equal(reservation.expectedGuid, null);
  assert.deepEqual(item.router.pendingActions(), []);
  assert.equal(fake.sendCalls().length, 1);
});

test("a nominal bridge acceptance remains ambiguous without exact local GUID and Reply-root proof", async (t) => {
  await t.test("accepted response has no GUID", async () => {
    const fake = fakeImsg({
      onSendRich: () => ({ ok: true, queued: true }),
    });
    const item = fixture({ fake, reconcileTimeoutMs: 1 });
    await initialize(item.sender);

    const result = await item.sender.sendMirror(mirror({ deliveryId: "accepted-without-guid" }));
    assert.equal(result.classification, "ambiguous");
    assert.equal(result.sent, false);
    assert.equal(result.fallbackSafe, false);
    assert.equal(fake.sendCalls().length, 1);
  });

  for (const [name, rowContext] of [
    ["accepted GUID row has no Reply root", { thread_originator_guid: null, reply_to_guid: null }],
    ["accepted GUID row has only an incidental reply parent", { thread_originator_guid: null, reply_to_guid: ROOT_GUID }],
    ["accepted GUID row has the wrong Reply root", { thread_originator_guid: "WRONG-ROOT", reply_to_guid: "WRONG-ROOT" }],
  ]) {
    await t.test(name, async () => {
      const fake = fakeImsg({ sentRow: rowContext });
      const item = fixture({ fake, reconcileTimeoutMs: 1 });
      await initialize(item.sender);

      const result = await item.sender.sendMirror(mirror({ deliveryId: name }));
      assert.equal(result.classification, "ambiguous");
      assert.equal(result.sent, false);
      assert.equal(result.fallbackSafe, false);
      assert.equal(fake.sendCalls().length, 1);
    });
  }

  await t.test("accepted GUID is rejected when its clean body does not match", async () => {
    const fake = fakeImsg({ sentRow: { text: "Normalized by Messages" } });
    const item = fixture({ fake, reconcileTimeoutMs: 1 });
    await initialize(item.sender);

    const result = await item.sender.sendMirror(mirror({ deliveryId: "normalized-marker" }));
    assert.equal(result.classification, "ambiguous");
    assert.deepEqual(result.guids, []);
    assert.equal(fake.sendCalls().length, 1);
  });
});

test("an ambiguous attempted send never retries or permits helper fallback, including after restart", async () => {
  const fake = fakeImsg({
    history: ({ historyCalls }) => historyCalls === 1 ? [rootRow()] : [rootRow()],
    onSendRich: () => { throw new Error("transport closed after write"); },
  });
  const item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  const first = await item.sender.sendMirror(mirror({ body: "Potentially accepted" }));
  assert.equal(first.classification, "ambiguous");
  assert.equal(first.terminal, false);
  assert.equal(first.retryable, true);
  assert.equal(first.attempted, true);
  assert.equal(first.fallbackSafe, false);
  assert.equal(fake.sendCalls().length, 1);

  const again = await item.sender.sendMirror(mirror({ body: "Potentially accepted" }));
  assert.equal(again.classification, "ambiguous");
  assert.equal(again.retryable, true);
  assert.equal(again.fallbackSafe, false);
  assert.equal(fake.sendCalls().length, 1);

  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake,
    clock: item.clock,
    discoveryTimeoutMs: 1,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const afterRestart = await resumed.sendMirror(mirror({ body: "Potentially accepted" }));
  assert.equal(afterRestart.classification, "ambiguous");
  assert.equal(afterRestart.retryable, true);
  assert.equal(afterRestart.fallbackSafe, false);
  assert.equal(fake.sendCalls().length, 1);
});

test("a pre-upgrade tagged journal still reconciles without resending", async () => {
  let legacyCommitted = false;
  const deliveryId = "legacy-tagged-journal";
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const tagged = localUserMirrorInternals.taggedText("Legacy mirror", token);
  const fake = fakeImsg({
    history: () => legacyCommitted
      ? [rootRow(), {
        id: 8_001,
        guid: "LEGACY-MIRROR-GUID",
        chat_id: 42,
        chat_guid: CHAT_GUID,
        is_from_me: true,
        text: tagged,
        thread_originator_guid: ROOT_GUID,
      }]
      : [rootRow()],
    onSendRich: () => { throw Object.assign(new Error("lost after write"), { attempted: true }); },
  });
  const item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  const request = mirror({ deliveryId, body: "Legacy mirror" });
  assert.equal((await item.sender.sendMirror(request)).classification, "ambiguous");
  assert.equal(fake.sendCalls().length, 1);

  const journal = JSON.parse(readFileSync(item.senderFile, "utf8"));
  const [key] = Object.keys(journal.deliveries);
  delete journal.deliveries[key].wireMode;
  delete journal.deliveries[key].clientGuidMode;
  journal.deliveries[key].guid = null;
  journal.deliveries[key].status = "attempting";
  writeFileSync(item.senderFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  legacyCommitted = true;

  const legacyRouter = new LocalConversationRouter({
    stateFile: path.join(item.directory, "legacy-router.json"),
    now: item.clock.now,
  });
  legacyRouter.routeOutboundGuid(ROOT_GUID, THREAD_ID, { root: true });
  legacyRouter.reserveUserMirrorEcho({
    reservationId: key,
    threadId: THREAD_ID,
    text: tagged,
    rootGuid: ROOT_GUID,
  });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: legacyRouter,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const recovered = await resumed.sendMirror(request);
  assert.equal(recovered.classification, "duplicate");
  assert.deepEqual(recovered.guids, ["LEGACY-MIRROR-GUID"]);
  assert.equal(fake.sendCalls().length, 1);
});

test("a definitively-unsent legacy prepared journal is upgraded to a clean standard send", async () => {
  const body = "Legacy prepared mirror";
  const deliveryId = "legacy-prepared-journal";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const tagged = localUserMirrorInternals.taggedText(body, token);
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);

  const state = JSON.parse(readFileSync(item.senderFile, "utf8"));
  state.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token,
    // Missing wireMode is the pre-upgrade tagged format.
    rootGuid: ROOT_GUID,
    status: "prepared",
    preparedAt: "2026-07-14T12:00:00.000Z",
    attemptedAt: null,
    acceptedAt: null,
    deadLetteredAt: null,
    guid: null,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  // Simulate a crash after the old sender reserved its tagged body but before
  // it persisted `attempting`. No bridge write can have happened yet.
  item.router.reserveUserMirrorEcho({
    reservationId: key,
    threadId: THREAD_ID,
    text: tagged,
    rootGuid: ROOT_GUID,
  });

  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "accepted");
  assert.deepEqual(result.guids, [bridgeGuid(1)]);
  assert.equal(fake.sendCalls().length, 1);
  assert.equal("client_guid" in fake.sendCalls()[0].params, false);
  assert.equal(fake.sendCalls()[0].params.text, body);
  assert.equal(localUserMirrorInternals.containsMarker(fake.sendCalls()[0].params.text, token), false);

  const migrated = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
  assert.equal(migrated.wireMode, "plain");
  assert.equal(migrated.clientGuidMode, false);
  assert.equal(migrated.guid, bridgeGuid(1));
  assert.equal(migrated.status, "accepted");
});

test("legacy conversion releases its stale reservation before mutating the e456-readable journal", async () => {
  const body = "Crash between reservation release and conversion";
  const deliveryId = "legacy-conversion-boundary";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const tagged = localUserMirrorInternals.taggedText(body, token);
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);

  const state = JSON.parse(readFileSync(item.senderFile, "utf8"));
  state.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token,
    wireMode: "tagged",
    clientGuidMode: false,
    rootGuid: ROOT_GUID,
    status: "prepared",
    preparedAt: "2026-07-14T12:00:00.000Z",
    attemptedAt: null,
    acceptedAt: null,
    deadLetteredAt: null,
    guid: null,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  item.router.reserveUserMirrorEcho({ reservationId: key, threadId: THREAD_ID, text: tagged, rootGuid: ROOT_GUID });

  const release = item.router.releaseUserMirrorEcho.bind(item.router);
  item.router.releaseUserMirrorEcho = (reservationId) => {
    const before = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
    assert.equal(before.wireMode, "tagged", "the rollback-compatible journal must still be unchanged");
    assert.equal(release(reservationId), true);
    throw Object.assign(new Error("simulated loss before conversion persistence"), { code: "TEST_PROCESS_LOSS" });
  };
  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  await assert.rejects(
    resumed.sendMirror(mirror({ deliveryId, body })),
    { code: "TEST_PROCESS_LOSS" },
  );
  assert.equal(fake.sendCalls().length, 0);
  const unchanged = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
  assert.equal(unchanged.wireMode, "tagged");
  assert.equal(unchanged.status, "prepared");

  const rollbackEntry = e456ReadableDelivery(unchanged);
  assert.ok(rollbackEntry);
  const rollbackText = e456WireText(rollbackEntry, body);
  assert.equal(localUserMirrorInternals.containsMarker(rollbackText, token), true);
  const rollbackRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  assert.equal(rollbackRouter.reserveUserMirrorEcho({
    reservationId: key,
    threadId: THREAD_ID,
    text: rollbackText,
    rootGuid: ROOT_GUID,
  }), key, "e456 can rebuild its original reservation after the boundary crash");
  assert.equal(rollbackRouter.confirmUserMirrorEcho(key, "E456-CONVERSION-GUID"), true);
  assert.equal(rollbackRouter.consumeUserMirrorEcho({
    id: 4_561,
    guid: "E456-CONVERSION-GUID",
    text: rollbackText,
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  }).guid, "E456-CONVERSION-GUID");
});

test("a rollback rewrite after a definitely-unsent failure safely retries the clean standard path", async () => {
  const body = "Resume after rollback rejected the send";
  const deliveryId = "rollback-definitely-unsent-rewrite";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const originalFake = fakeImsg({
    onSendRich: () => ({ classification: "unsupported", retrySafe: true }),
  });
  const item = fixture({ fake: originalFake });
  await initialize(item.sender);
  const unavailable = await item.sender.sendMirror(mirror({ deliveryId, body }));
  assert.equal(unavailable.classification, "unavailable");
  assert.equal(unavailable.attempted, false);

  const state = JSON.parse(readFileSync(item.senderFile, "utf8"));
  assert.equal(state.deliveries[key].guid, null);
  assert.equal(state.deliveries[key].clientGuidMode, false);
  assert.equal(state.deliveries[key].status, "prepared");
  assert.equal(state.deliveries[key].attemptedAt, null);
  state.deliveries[key] = e456ReadableDelivery(state.deliveries[key]);
  assert.equal("clientGuidMode" in state.deliveries[key], false,
    "e456 rewrites only fields known to its fixed journal schema");
  writeFileSync(item.senderFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const resumedFake = fakeImsg();
  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake: resumedFake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const accepted = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(accepted.classification, "accepted");
  assert.equal(resumedFake.sendCalls().length, 1);
  assert.equal("client_guid" in resumedFake.sendCalls()[0].params, false);
  assert.equal(resumedFake.sendCalls()[0].params.text, body);
  const restored = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
  assert.equal(restored.wireMode, "plain");
  assert.equal(restored.clientGuidMode, false);
  assert.equal(restored.guid, bridgeGuid(1));
  assert.equal(restored.status, "accepted");
});

test("an attempted:false result persists retryability before releasing its attempted guard", async () => {
  const body = "Definitely not dispatched before process loss";
  const deliveryId = "attempted-false-release-boundary";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  let nativeAttempted = false;
  const originalFake = fakeImsg({
    onSendRich: () => {
      nativeAttempted = true;
      throw Object.assign(new Error("bridge child was never started"), { attempted: false });
    },
  });
  const item = fixture({ fake: originalFake });
  await initialize(item.sender);
  const release = item.router.releaseUserMirrorEcho.bind(item.router);
  item.router.releaseUserMirrorEcho = (reservationId) => {
    if (!nativeAttempted) return release(reservationId);
    throw Object.assign(new Error("simulated loss before guard release"), { code: "TEST_PROCESS_LOSS" });
  };

  await assert.rejects(
    item.sender.sendMirror(mirror({ deliveryId, body })),
    { code: "TEST_PROCESS_LOSS" },
  );
  const crashJournal = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
  assert.equal(crashJournal.status, "prepared",
    "the durable definitely-unsent result precedes receiver cleanup");
  assert.equal(crashJournal.attemptedAt, null);
  const crashReservation = JSON.parse(readFileSync(item.routerFile, "utf8"))
    .userMirrorEchoes.find((echo) => echo.reservationId === key);
  assert.equal(crashReservation.dispatchMayHaveOccurred, true,
    "the stale guard remains fail-closed until prepared recovery releases it");

  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumedFake = fakeImsg();
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake: resumedFake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "accepted");
  assert.equal(resumedFake.sendCalls().length, 1,
    "prepared recovery removes the stale guard and performs the one real send");
});

test("a definitely-unsent caller-GUID migration is converted to a transcript-visible standard send", async () => {
  const body = "Resume an interrupted journal migration";
  const deliveryId = "interrupted-legacy-migration";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const tagged = localUserMirrorInternals.taggedText(body, token);
  const persistedGuid = "11111111-1111-4111-8111-111111111111";
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);

  const state = JSON.parse(readFileSync(item.senderFile, "utf8"));
  state.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token,
    wireMode: "client-guid",
    rootGuid: ROOT_GUID,
    status: "prepared",
    preparedAt: "2026-07-14T12:00:00.000Z",
    attemptedAt: null,
    acceptedAt: null,
    deadLetteredAt: null,
    guid: persistedGuid,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  item.router.reserveUserMirrorEcho({
    reservationId: key,
    threadId: THREAD_ID,
    text: tagged,
    rootGuid: ROOT_GUID,
  });

  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "accepted");
  assert.deepEqual(result.guids, [bridgeGuid(1)]);
  assert.equal(fake.sendCalls().length, 1);
  assert.equal("client_guid" in fake.sendCalls()[0].params, false);
  assert.equal(fake.sendCalls()[0].params.text, body);
  const normalized = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
  assert.equal(normalized.wireMode, "plain");
  assert.equal(normalized.clientGuidMode, false);
  assert.equal(normalized.guid, bridgeGuid(1));
});

test("an earlier definitely-unsent tagged caller-GUID journal resumes as a clean standard send", async () => {
  const body = "Resume an earlier tagged client-GUID entry";
  const deliveryId = "earlier-tagged-client-guid";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const assignedGuid = "22222222-2222-4222-8222-222222222222";
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);

  const state = JSON.parse(readFileSync(item.senderFile, "utf8"));
  state.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token,
    wireMode: "tagged",
    clientGuidMode: true,
    rootGuid: ROOT_GUID,
    status: "prepared",
    preparedAt: "2026-07-14T12:00:00.000Z",
    attemptedAt: null,
    acceptedAt: null,
    deadLetteredAt: null,
    guid: assignedGuid,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  item.router.reserveUserMirrorEcho({
    reservationId: key,
    threadId: THREAD_ID,
    text: localUserMirrorInternals.taggedText(body, token),
    rootGuid: ROOT_GUID,
  });

  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "accepted");
  assert.equal(fake.sendCalls().length, 1);
  assert.equal("client_guid" in fake.sendCalls()[0].params, false);
  assert.equal(fake.sendCalls()[0].params.text, body);
  assert.equal(localUserMirrorInternals.containsMarker(fake.sendCalls()[0].params.text, token), false);

  const normalized = JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key];
  assert.equal(normalized.wireMode, "plain",
    "all client-GUID generations must converge to the no-Unicode envelope");
  assert.equal(normalized.clientGuidMode, false);
  assert.equal(normalized.guid, bridgeGuid(1));
  const reservation = JSON.parse(readFileSync(item.routerFile, "utf8"))
    .userMirrorEchoes.find((echo) => echo.reservationId === key);
  assert.equal(reservation.markerEvidence, false,
    "the stale tagged reservation must be rebuilt from the clean body");
});

test("legacy attempt evidence is never resent even when its stale journal status says prepared", async () => {
  const body = "Possibly dispatched legacy mirror";
  const deliveryId = "legacy-stale-prepared-status";
  const key = localUserMirrorInternals.deliveryKey(deliveryId, THREAD_ID, 0);
  const token = localUserMirrorInternals.markerToken(deliveryId, THREAD_ID, 0);
  const fake = fakeImsg({ history: [rootRow()] });
  const item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);

  const state = JSON.parse(readFileSync(item.senderFile, "utf8"));
  state.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(body),
    token,
    wireMode: "plain",
    rootGuid: ROOT_GUID,
    status: "prepared",
    preparedAt: "2026-07-14T11:59:59.000Z",
    attemptedAt: "2026-07-14T12:00:00.000Z",
    acceptedAt: null,
    deadLetteredAt: null,
    guid: null,
  };
  writeFileSync(item.senderFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const resumed = createSender({
    stateFile: item.senderFile,
    router: item.router,
    fake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const result = await resumed.sendMirror(mirror({ deliveryId, body }));
  assert.equal(result.classification, "ambiguous");
  assert.equal(fake.sendCalls().length, 0, "attempt evidence forbids replay");
  assert.equal(JSON.parse(readFileSync(item.senderFile, "utf8")).deliveries[key].status, "ambiguous");
});

test("an attempted historical caller-owned GUID is reconciled by exact GUID, body, chat, and root without resending", async () => {
  const item = fixture({ reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  const request = mirror({ deliveryId: "delayed-normalized-guid", body: "Delayed normalized mirror" });
  const journal = JSON.parse(readFileSync(item.senderFile, "utf8"));
  const key = localUserMirrorInternals.deliveryKey(request.deliveryId, THREAD_ID, 0);
  journal.deliveries[key] = {
    reservationId: key,
    threadId: THREAD_ID,
    bodyHash: mirrorBodyHash(request.body),
    token: localUserMirrorInternals.markerToken(request.deliveryId, THREAD_ID, 0),
    wireMode: "plain",
    clientGuidMode: true,
    rootGuid: ROOT_GUID,
    status: "attempting",
    preparedAt: "2026-07-14T11:59:59.000Z",
    attemptedAt: "2026-07-14T12:00:00.000Z",
    acceptedAt: null,
    deadLetteredAt: null,
    guid: testClientGuid(1),
  };
  writeFileSync(item.senderFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

  const historicalFake = fakeImsg({
    history: [
      rootRow(),
      {
        id: 9_001,
        guid: testClientGuid(1),
        chat_id: 42,
        chat_guid: CHAT_GUID,
        is_from_me: true,
        text: "Delayed normalized mirror",
        thread_originator_guid: ROOT_GUID,
        reply_to_guid: ROOT_GUID,
      },
    ],
  });
  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake: historicalFake,
    clock: item.clock,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const recovered = await resumed.sendMirror(request);
  assert.equal(recovered.classification, "duplicate");
  assert.deepEqual(recovered.guids, [testClientGuid(1)]);
  assert.equal(historicalFake.sendCalls().length, 0);
  assert.equal(resumedRouter.nativeThread(THREAD_ID).latestGuid, testClientGuid(1));
});

test("a crash-bound standard entry never resends and unresolved ambiguity dead-letters visibly after fifteen minutes", async () => {
  const fake = fakeImsg({
    onSendRich: () => { throw Object.assign(new Error("connection closed after write"), { attempted: true }); },
  });
  const item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  const request = mirror({ deliveryId: "crash-bound", body: "Potentially committed once" });
  assert.equal((await item.sender.sendMirror(request)).classification, "ambiguous");
  assert.equal(fake.sendCalls().length, 1);

  const persisted = JSON.parse(readFileSync(item.senderFile, "utf8"));
  const [key] = Object.keys(persisted.deliveries);
  persisted.deliveries[key].status = "attempting";
  writeFileSync(item.senderFile, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

  const resumedRouter = new LocalConversationRouter({ stateFile: item.routerFile, now: item.clock.now });
  const resumed = createSender({
    stateFile: item.senderFile,
    router: resumedRouter,
    fake,
    clock: item.clock,
    discoveryTimeoutMs: 1,
    reconcileTimeoutMs: 1,
  });
  await initialize(resumed);
  const held = await resumed.sendMirror(request);
  assert.equal(held.classification, "ambiguous");
  assert.equal(held.terminal, false);
  assert.equal(held.retryable, true);
  assert.equal(fake.sendCalls().length, 1, "an attempting crash journal must never issue a second local send");

  item.clock.advance(15 * 60 * 1000);
  const deadLetter = await resumed.sendMirror(request);
  assert.equal(deadLetter.classification, "dead-letter");
  assert.equal(deadLetter.status, "MIRROR_UNVERIFIED");
  assert.equal(deadLetter.sent, false);
  assert.equal(deadLetter.terminal, false, "the daemon must publish the separate user-visible failure notice first");
  assert.equal(deadLetter.fallbackSafe, false);
  assert.equal(fake.sendCalls().length, 1);

  const late = {
    id: 77_001,
    guid: "UNKNOWN-STANDARD-GUID",
    text: "Potentially committed once",
    created_at: "2026-07-14T12:00:01.000Z",
    thread_originator_guid: ROOT_GUID,
  };
  assert.equal(resumedRouter.consumeUserMirrorEcho(late), null,
    "clean body and Reply root alone never permanently consume a genuine user message");
  assert.equal(readFileSync(item.senderFile, "utf8").includes("Potentially committed once"), false);
});

test("a missing synced root is retryable but never sends or falls back unthreaded", async () => {
  const fake = fakeImsg({ history: [], search: [] });
  const item = fixture({ fake, discoveryTimeoutMs: 1 });
  await initialize(item.sender);
  const result = await item.sender.sendMirror(mirror());
  assert.equal(result.classification, "unavailable");
  assert.equal(result.status, "ROOT_NOT_SYNCED");
  assert.equal(result.retryable, true);
  assert.equal(result.attempted, false);
  assert.equal(result.fallbackSafe, false);
  assert.equal(fake.sendCalls().length, 0);
});

test("long Unicode mirrors use bounded clean native multipart replies", async () => {
  const fake = fakeImsg();
  const item = fixture({ fake });
  await initialize(item.sender);
  const body = "🙂".repeat(60_000);
  const result = await item.sender.sendMirror(mirror({ deliveryId: "long-delivery", body }));
  assert.equal(result.classification, "accepted");
  assert.equal(result.parts, 3);
  const sends = fake.sendCalls();
  assert.equal(sends.length, 3);
  const texts = sends.map((call) => call.params.text);
  assert.deepEqual(texts.map((text) => text.match(/^\((\d+)\/(\d+)\)/u)?.slice(1)), [
    ["1", "3"],
    ["2", "3"],
    ["3", "3"],
  ]);
  assert.ok(texts.every((text) => Buffer.byteLength(text, "utf8") < 100 * 1024));
  const tokens = texts.map((_, index) => localUserMirrorInternals.markerToken("long-delivery", THREAD_ID, index));
  assert.ok(texts.every((text, index) => !localUserMirrorInternals.containsMarker(text, tokens[index])));
  assert.ok(texts.every((text) => ![...text].some((character) => {
    const code = character.codePointAt(0);
    return code >= 0xe0000 && code <= 0xe007f;
  })));
  assert.ok(sends.every((call) => call.params.reply_to === ROOT_GUID));

  const duplicate = await item.sender.sendMirror(mirror({ deliveryId: "long-delivery", body }));
  assert.equal(duplicate.classification, "duplicate");
  assert.equal(fake.sendCalls().length, 3);
});

test("multipart delivery continues after one part becomes ambiguous and never retries that part blindly", async () => {
  const fake = fakeImsg({
    onSendRich: ({ sendSequence, params }) => {
      if (sendSequence === 1) throw Object.assign(new Error("connection closed after write"), { attempted: true });
      assert.equal("client_guid" in params, false);
      return { ok: true, guid: bridgeGuid(sendSequence) };
    },
  });
  const item = fixture({ fake, reconcileTimeoutMs: 1 });
  await initialize(item.sender);
  const body = "🙂".repeat(60_000);
  const request = mirror({ deliveryId: "partially-ambiguous", body });
  const result = await item.sender.sendMirror(request);
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.parts, 3);
  assert.deepEqual(result.guids, [bridgeGuid(2), bridgeGuid(3)]);
  assert.equal(fake.sendCalls().length, 3);
  assert.deepEqual(fake.sendCalls().map((call) => call.params.text.match(/^\((\d+)\/(\d+)\)/u)?.slice(1)), [
    ["1", "3"],
    ["2", "3"],
    ["3", "3"],
  ]);

  const retried = await item.sender.sendMirror(request);
  assert.equal(retried.classification, "ambiguous");
  assert.deepEqual(retried.guids, [bridgeGuid(2), bridgeGuid(3)]);
  assert.equal(fake.sendCalls().length, 3);
});
