import { execFile as nodeExecFile } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  canonicalImsgIdentity,
  extractImsgAccountIdentities,
  imsgAccountFingerprint,
  imsgIdentityHashes,
} from "./imsg-ipc-protocol.mjs";
import { imsgTransportInternals } from "./imsg-transport.mjs";
import { ImsgClient } from "./imsg-client.mjs";
import { IMSG_RPC_SEND_TIMEOUT_MS } from "./imsg-timeouts.mjs";
import { richTextIntent } from "../../protocol/rich-presentation.ts";

const STATE_VERSION = 1;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 8_000;
const DEFAULT_SEND_TIMEOUT_MS = IMSG_RPC_SEND_TIMEOUT_MS;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERIES = 4096;
const AMBIGUOUS_DEAD_LETTER_MS = 15 * 60 * 1000;
const AMBIGUOUS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MARKER_START = "\u{E0001}";
const MARKER_END = "\u{E007F}";
const WIRE_MODE_PLAIN = "plain";
const WIRE_MODE_TAGGED = "tagged";
const BINARY_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/imsg",
  "/usr/local/bin/imsg",
]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hash(label, value) {
  return createHash("sha256").update(`${label}\0${String(value ?? "")}`).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function markerToken(deliveryId, threadId, index) {
  return `codex-mirror-${hash("local-user-mirror-marker-v1", `${deliveryId}\0${threadId}\0${index}`).slice(0, 32)}`;
}

function invisibleTag(value) {
  let output = MARKER_START;
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (!Number.isSafeInteger(code) || code < 0x20 || code > 0x7e) {
      throw new TypeError("A user-mirror marker must contain printable ASCII only.");
    }
    output += String.fromCodePoint(0xe0000 + code);
  }
  return `${output}${MARKER_END}`;
}

function taggedText(text, token) {
  return `${String(text)}${invisibleTag(token)}`;
}

function containsMarker(text, token) {
  return typeof text === "string" && text.includes(invisibleTag(token));
}

function parseJsonLines(stdout, maxBytes = MAX_OUTPUT_BYTES) {
  const buffer = Buffer.from(String(stdout ?? ""));
  if (buffer.byteLength > maxBytes) throw codedError("IMSG_LOCAL_OUTPUT_TOO_LARGE", "The local imsg command returned too much data.");
  const lines = buffer.toString("utf8").split(/\r?\n/u).filter((line) => line.trim());
  try {
    return lines.map((line) => JSON.parse(line)).filter((value) => value && typeof value === "object" && !Array.isArray(value));
  } catch {
    throw codedError("IMSG_LOCAL_OUTPUT_INVALID", "The local imsg command returned invalid JSON.");
  }
}

function execFilePromise(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    const { onChild, onSettled, ...execOptions } = options || {};
    try {
      child = execFileImpl(file, args, execOptions, (error, stdout = "", stderr = "") => {
        try { onSettled?.(child); } catch {}
        if (error) {
          error.stdout = stdout;
          error.stderr = "";
          error.attempted = Boolean(child);
          reject(error);
        } else {
          resolve({ stdout, stderr: "", attempted: Boolean(child) });
        }
      });
      try { onChild?.(child); } catch {}
    } catch (error) {
      error.attempted = false;
      reject(error);
    }
  });
}

function emptyState(conversationKey = null) {
  return { version: STATE_VERSION, conversationKey: clean(conversationKey) || null, binding: null, deliveries: {} };
}

function normalizedDelivery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reservationId = clean(value.reservationId);
  const threadId = clean(value.threadId);
  const bodyHash = clean(value.bodyHash).toLowerCase();
  const token = clean(value.token);
  const rootGuid = clean(value.rootGuid);
  const status = clean(value.status);
  const preparedAt = clean(value.preparedAt);
  // Journals written before wireMode existed always used the legacy Unicode
  // Tags-block suffix. Preserve their crash reconciliation without putting
  // that suffix on newly prepared mirrors.
  const wireMode = value.wireMode === WIRE_MODE_PLAIN
    ? WIRE_MODE_PLAIN
    : value.wireMode === undefined || value.wireMode === WIRE_MODE_TAGGED
      ? WIRE_MODE_TAGGED
      : null;
  if (!/^[a-f0-9]{64}$/u.test(reservationId) || !threadId || !/^[a-f0-9]{64}$/u.test(bodyHash)
    || !/^codex-mirror-[a-f0-9]{32}$/u.test(token) || !rootGuid
    || !wireMode
    || !["prepared", "attempting", "accepted", "ambiguous", "dead-letter"].includes(status)
    || !Number.isFinite(Date.parse(preparedAt))) return null;
  return {
    reservationId,
    threadId,
    bodyHash,
    token,
    wireMode,
    rootGuid,
    status,
    preparedAt,
    attemptedAt: Number.isFinite(Date.parse(value.attemptedAt || "")) ? value.attemptedAt : null,
    acceptedAt: Number.isFinite(Date.parse(value.acceptedAt || "")) ? value.acceptedAt : null,
    deadLetteredAt: Number.isFinite(Date.parse(value.deadLetteredAt || "")) ? value.deadLetteredAt : null,
    guid: clean(value.guid) || null,
  };
}

function readState(file, expectedConversationKey = null) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    const conversationKey = clean(expectedConversationKey);
    if (value?.version !== STATE_VERSION || (conversationKey && clean(value.conversationKey) !== conversationKey)) {
      return emptyState(conversationKey);
    }
    const binding = value.binding && typeof value.binding === "object" && !Array.isArray(value.binding)
      && /^[a-f0-9]{64}$/u.test(clean(value.binding.accountFingerprint))
      && /^[a-f0-9]{64}$/u.test(clean(value.binding.recipientHash))
      && Number.isSafeInteger(Number(value.binding.chatId)) && Number(value.binding.chatId) > 0
      && clean(value.binding.chatGuid)
      ? {
        accountFingerprint: clean(value.binding.accountFingerprint),
        recipientHash: clean(value.binding.recipientHash),
        senderHash: /^[a-f0-9]{64}$/u.test(clean(value.binding.senderHash)) ? clean(value.binding.senderHash) : null,
        chatId: Number(value.binding.chatId),
        chatGuid: clean(value.binding.chatGuid),
      }
      : null;
    const deliveries = {};
    for (const [key, item] of Object.entries(value.deliveries || {}).slice(-MAX_DELIVERIES)) {
      if (!/^[a-f0-9]{64}$/u.test(key)) continue;
      const normalized = normalizedDelivery(item);
      if (normalized) deliveries[key] = normalized;
    }
    return { version: STATE_VERSION, conversationKey: conversationKey || clean(value.conversationKey) || null, binding, deliveries };
  } catch {
    return emptyState(expectedConversationKey);
  }
}

function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function messageGuid(value) {
  return clean(value?.guid ?? value?.message_guid ?? value?.messageGuid);
}

function participantValues(chat) {
  return (Array.isArray(chat?.participants) ? chat.participants : [])
    .map((value) => typeof value === "string" ? value : value?.handle ?? value?.identifier ?? value?.address)
    .map(clean)
    .filter(Boolean);
}

function directChatMatches(chat, recipientIdentity) {
  if (!chat || chat.is_group === true || clean(chat.service).toLocaleLowerCase("en-US") !== "imessage") return false;
  const participants = [...new Set(participantValues(chat).map(canonicalImsgIdentity).filter(Boolean))];
  return participants.length === 1 && participants[0] === recipientIdentity;
}

function directExternalChat(chat, ownIdentities) {
  if (!chat || chat.is_group === true || clean(chat.service).toLocaleLowerCase("en-US") !== "imessage") return false;
  const participants = [...new Set(participantValues(chat).map(canonicalImsgIdentity).filter(Boolean))];
  return participants.length === 1 && !ownIdentities.has(participants[0]);
}

function chatUsesSender(chat, expectedIdentity) {
  if (!expectedIdentity) return true;
  const value = clean(chat?.last_addressed_handle ?? chat?.lastAddressedHandle ?? chat?.account_login ?? chat?.accountLogin);
  return canonicalImsgIdentity(value) === expectedIdentity;
}

function rowBelongsToChat(row, binding) {
  const id = Number(row?.chat_id ?? row?.chatId);
  const guid = clean(row?.chat_guid ?? row?.chatGuid);
  return id === binding.chatId || (guid && guid === binding.chatGuid);
}

function rowRootGuid(row) {
  return clean(row?.thread_originator_guid ?? row?.threadOriginatorGuid) || messageGuid(row);
}

function rootForThread(rows, binding, threadId, expectedRoot = "") {
  const uri = `codex://threads/${threadId}`;
  const candidates = new Set((rows || [])
    .filter((row) => rowBelongsToChat(row, binding) && row?.is_from_me !== true && String(row?.text || "").includes(uri))
    .map(rowRootGuid)
    .filter(Boolean));
  const expected = clean(expectedRoot);
  if (expected) return candidates.has(expected) ? expected : null;
  return candidates.size === 1 ? [...candidates][0] : null;
}

function deliveryKey(deliveryId, threadId, index) {
  return hash("local-user-mirror-delivery-v1", `${deliveryId}\0${threadId}\0${index}`);
}

function deliveryResult(classification, details = {}) {
  return {
    classification,
    sent: classification === "accepted" || classification === "duplicate",
    attempted: details.attempted === true,
    terminal: classification === "accepted" || classification === "duplicate",
    status: classification === "accepted" ? "SENT"
      : classification === "duplicate" ? "DUPLICATE"
        : classification === "ambiguous" ? "AMBIGUOUS"
          : classification === "dead-letter" ? "MIRROR_UNVERIFIED"
          : details.status || "UNAVAILABLE",
    ...details,
  };
}

/**
 * A target-locked sender for the active macOS user's half of one direct
 * iMessage conversation. It intentionally has no generic recipient, URL,
 * attachment, watch, launch, or Messages-process lifecycle API.
 */
export class LocalUserMirrorSender {
  constructor({
    stateFile,
    router,
    execFileImpl = nodeExecFile,
    binaryCandidates = BINARY_CANDIDATES,
    now = Date.now,
    sleepImpl = sleep,
    discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    reconcileTimeoutMs = DEFAULT_RECONCILE_TIMEOUT_MS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    conversationKey = null,
    imsgClientFactory = null,
    allowUnsafeTestBinary = false,
  } = {}) {
    if (!stateFile || !router) throw new TypeError("LocalUserMirrorSender requires private state and a conversation router.");
    this.stateFile = path.resolve(stateFile);
    this.router = router;
    this.execFileImpl = execFileImpl;
    this.binaryCandidates = [...binaryCandidates];
    this.now = now;
    this.sleep = sleepImpl;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.reconcileTimeoutMs = reconcileTimeoutMs;
    this.sendTimeoutMs = sendTimeoutMs;
    this.conversationKey = clean(conversationKey) || null;
    this.imsgClientFactory = imsgClientFactory || ((binary) => new ImsgClient({
      binary,
      candidates: [binary],
      sendTimeoutMs: this.sendTimeoutMs,
    }));
    this.allowUnsafeTestBinary = allowUnsafeTestBinary;
    this.state = readState(this.stateFile, this.conversationKey);
    this.binary = null;
    this.accountFingerprint = null;
    this.accountIdentities = new Set();
    this.expectedLocalSender = null;
    this.expectedLocalSenderRaw = "";
    this.chats = [];
    this.chain = Promise.resolve();
    this.activeChildren = new Set();
    this.client = null;
    this.stopping = false;
    this.capability = { available: false, status: "NOT_INITIALIZED", checkedAt: null };
  }

  capabilityStatus() {
    return { ...this.capability };
  }

  initialize(options = {}) {
    this.capability = { available: false, status: "INITIALIZING", checkedAt: new Date(this.now()).toISOString() };
    return this.#enqueue(() => this.#initialize(options));
  }

  sendMirror(message) {
    return this.#enqueue(() => this.#sendMirror(message));
  }

  async stop() {
    this.stopping = true;
    for (const child of this.activeChildren) {
      try { child?.kill?.("SIGTERM"); } catch {}
    }
    this.activeChildren.clear();
    await this.client?.stop?.().catch(() => {});
    this.client = null;
  }

  #enqueue(operation) {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async #run(args, { timeout = 10_000, maxBuffer = MAX_OUTPUT_BYTES } = {}) {
    if (this.stopping) throw codedError("IMSG_LOCAL_STOPPED", "The local user-mirror sender is stopping.", { attempted: false });
    if (!this.binary) throw codedError("IMSG_LOCAL_NOT_READY", "The local imsg binary is not ready.", { attempted: false });
    return execFilePromise(this.execFileImpl, this.binary, args, {
      timeout,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
      onChild: (child) => { if (child) this.activeChildren.add(child); },
      onSettled: (child) => { if (child) this.activeChildren.delete(child); },
    });
  }

  async #runJson(args, options = {}) {
    const { stdout } = await this.#run(args, options);
    return parseJsonLines(stdout, options.maxBuffer);
  }

  async #locateBinary() {
    for (const candidate of this.binaryCandidates) {
      try {
        const resolved = this.allowUnsafeTestBinary ? candidate : realpathSync(candidate);
        if (!this.allowUnsafeTestBinary) {
          const link = lstatSync(candidate);
          const metadata = statSync(resolved);
          accessSync(resolved, fsConstants.X_OK);
          const uid = process.getuid?.();
          if ((!link.isFile() && !link.isSymbolicLink()) || !metadata.isFile()
            || (metadata.mode & 0o022) !== 0 || ![0, uid].includes(metadata.uid)) continue;
        }
        this.binary = resolved;
        await this.#run(["--version"], { timeout: 5_000, maxBuffer: 64 * 1024 });
        this.client = this.imsgClientFactory(resolved);
        return resolved;
      } catch {
        this.binary = null;
      }
    }
    throw codedError("IMSG_LOCAL_NOT_FOUND", "The normal-profile imsg CLI is unavailable.", { attempted: false });
  }

  async #initialize({ serviceIdentity = "", expectedLocalSender = "", knownRootGuids = [], knownThreads = [] } = {}) {
    try {
      if (!this.binary) await this.#locateBinary();
      const status = (await this.#runJson(["status", "--json"], { timeout: 8_000, maxBuffer: 512 * 1024 }))[0];
      const methods = new Set(Array.isArray(status?.rpc_methods) ? status.rpc_methods : []);
      if (status?.advanced_features !== true || status?.v2_ready !== true || !methods.has("send.rich")) {
        return this.#unavailable("ACTIVATION_REQUIRED");
      }
      const account = (await this.#runJson(["account", "--json"], { timeout: 8_000, maxBuffer: 512 * 1024 }))[0];
      const identities = extractImsgAccountIdentities(account);
      const accountFingerprint = imsgAccountFingerprint(identities);
      if (!accountFingerprint) return this.#unavailable("ACCOUNT_UNAVAILABLE");
      this.accountFingerprint = accountFingerprint;
      this.accountIdentities = new Set(identities.map(canonicalImsgIdentity).filter(Boolean));
      if (clean(expectedLocalSender)) this.expectedLocalSenderRaw = clean(expectedLocalSender);
      this.expectedLocalSender = canonicalImsgIdentity(this.expectedLocalSenderRaw);
      if (this.expectedLocalSender && !this.accountIdentities.has(this.expectedLocalSender)) {
        return this.#unavailable("SENDER_IDENTITY_MISMATCH");
      }
      const requestedRecipient = canonicalImsgIdentity(serviceIdentity);
      if (requestedRecipient && this.accountIdentities.has(requestedRecipient)) {
        return this.#unavailable("SELF_CHAT_REJECTED");
      }
      const chats = await this.#runJson(["chats", "--limit", "250", "--json"], { timeout: 10_000 });
      this.chats = chats.filter((chat) => requestedRecipient
        ? directChatMatches(chat, requestedRecipient)
        : directExternalChat(chat, this.accountIdentities))
        .filter((chat) => chatUsesSender(chat, this.expectedLocalSender));
      if (requestedRecipient && this.chats.length === 0) return this.#unavailable("CHAT_NOT_FOUND");
      const roots = [...new Set(knownRootGuids.map(clean).filter(Boolean))];
      const matches = [];
      const known = (Array.isArray(knownThreads) ? knownThreads : [])
        .map((thread) => ({ threadId: clean(thread?.threadId ?? thread?.id), rootGuid: clean(thread?.rootGuid) }))
        .filter((thread) => thread.threadId && thread.rootGuid)
        .slice(0, 12);
      const matchingChatIds = new Set();
      for (const thread of known) {
        const rows = await this.#runJson([
          "search", "--query", `codex://threads/${thread.threadId}`, "--match", "contains", "--limit", "50", "--json",
        ], { timeout: 10_000 }).catch(() => []);
        for (const row of rows) {
          if (row?.is_from_me !== true && (rowRootGuid(row) === thread.rootGuid || messageGuid(row) === thread.rootGuid)) {
            const id = Number(row?.chat_id ?? row?.chatId);
            if (Number.isSafeInteger(id) && id > 0) matchingChatIds.add(id);
          }
        }
      }
      matches.push(...this.chats.filter((chat) => matchingChatIds.has(Number(chat.id))));
      if (!known.length && roots.length) {
        for (const chat of this.chats) {
          const rows = await this.#history(Number(chat.id), 500).catch(() => []);
          if (roots.some((guid) => rows.some((row) => messageGuid(row) === guid))) matches.push(chat);
        }
      }
      if (!matches.length && roots.length && this.state.binding?.accountFingerprint === accountFingerprint) {
        const priorChat = this.chats.find((chat) => Number(chat.id) === this.state.binding.chatId
          && clean(chat.guid) === this.state.binding.chatGuid);
        if (priorChat) {
          const rows = await this.#history(Number(priorChat.id), 500).catch(() => []);
          if (roots.some((guid) => rows.some((row) => messageGuid(row) === guid))) matches.push(priorChat);
        }
      }
      let selected = matches.length === 1 ? matches[0] : null;
      if (!selected && roots.length === 0 && this.state.binding?.accountFingerprint === accountFingerprint) {
        selected = this.chats.find((chat) => Number(chat.id) === this.state.binding.chatId
          && clean(chat.guid) === this.state.binding.chatGuid) || null;
      }
      if (matches.length > 1) return this.#unavailable("CHAT_AMBIGUOUS");
      if (selected) this.#bindChat(selected);
      else if (roots.length || this.state.binding?.accountFingerprint !== accountFingerprint) {
        this.state = emptyState(this.conversationKey);
        writeState(this.stateFile, this.state);
      }
      this.capability = {
        available: true,
        status: this.state.binding ? "READY" : "AWAITING_THREAD_ROOT",
        checkedAt: new Date(this.now()).toISOString(),
      };
      return this.capabilityStatus();
    } catch (error) {
      return this.#unavailable(error?.code || "PROBE_FAILED");
    }
  }

  #unavailable(status) {
    this.capability = { available: false, status, checkedAt: new Date(this.now()).toISOString() };
    return this.capabilityStatus();
  }

  #bindChat(chat) {
    const chatId = Number(chat?.id ?? chat?.chat_id);
    const chatGuid = clean(chat?.guid ?? chat?.chat_guid);
    const participant = participantValues(chat)[0];
    const recipientHash = imsgIdentityHashes(participant)[0];
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !chatGuid || !recipientHash
      || !directExternalChat(chat, this.accountIdentities)
      || !chatUsesSender(chat, this.expectedLocalSender)) return false;
    const binding = {
      accountFingerprint: this.accountFingerprint,
      recipientHash,
      senderHash: this.expectedLocalSender ? imsgIdentityHashes(this.expectedLocalSender)[0] : null,
      chatId,
      chatGuid,
    };
    const prior = this.state.binding;
    if (!prior || prior.accountFingerprint !== binding.accountFingerprint
      || prior.recipientHash !== binding.recipientHash
      || prior.senderHash !== binding.senderHash
      || prior.chatId !== binding.chatId || prior.chatGuid !== binding.chatGuid) {
      this.state = { ...emptyState(this.conversationKey), binding };
      writeState(this.stateFile, this.state);
    } else {
      this.state.binding = binding;
    }
    this.capability = { available: true, status: "READY", checkedAt: new Date(this.now()).toISOString() };
    return true;
  }

  async #discoverBindingForRoot(threadId, expectedRoot) {
    const deadline = this.now() + this.discoveryTimeoutMs;
    do {
      const rows = await this.#runJson([
        "search", "--query", `codex://threads/${threadId}`, "--match", "contains", "--limit", "50", "--json",
      ], { timeout: 10_000 }).catch(() => []);
      const matchingRows = rows.filter((row) => row?.is_from_me !== true
        && (rowRootGuid(row) === expectedRoot || messageGuid(row) === expectedRoot));
      const candidateIds = new Set(matchingRows.map((row) => Number(row?.chat_id ?? row?.chatId)).filter((id) => Number.isSafeInteger(id) && id > 0));
      const matches = this.chats.filter((chat) => candidateIds.has(Number(chat.id)));
      if (matches.length === 1 && this.#bindChat(matches[0])) return true;
      if (matches.length > 1) return false;
      // A just-synchronized chat may not have been in the initialization list.
      const chats = await this.#runJson(["chats", "--limit", "250", "--json"], { timeout: 10_000 }).catch(() => []);
      this.chats = chats.filter((chat) => directExternalChat(chat, this.accountIdentities)
        && chatUsesSender(chat, this.expectedLocalSender));
      const refreshed = this.chats.filter((chat) => candidateIds.has(Number(chat.id)));
      if (refreshed.length === 1 && this.#bindChat(refreshed[0])) return true;
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(300, Math.max(1, deadline - this.now())));
    } while (this.now() < deadline);
    return false;
  }

  async #revalidateBinding() {
    try {
      const status = (await this.#runJson(["status", "--json"], { timeout: 8_000, maxBuffer: 512 * 1024 }))[0];
      const methods = new Set(Array.isArray(status?.rpc_methods) ? status.rpc_methods : []);
      if (status?.advanced_features !== true || status?.v2_ready !== true || !methods.has("send.rich")) {
        return this.#unavailable("ACTIVATION_REQUIRED");
      }
      const account = (await this.#runJson(["account", "--json"], { timeout: 8_000, maxBuffer: 512 * 1024 }))[0];
      const identities = extractImsgAccountIdentities(account);
      const fingerprint = imsgAccountFingerprint(identities);
      const identitySet = new Set(identities.map(canonicalImsgIdentity).filter(Boolean));
      if (!fingerprint || (this.expectedLocalSender && !identitySet.has(this.expectedLocalSender))) {
        return this.#unavailable("SENDER_IDENTITY_MISMATCH");
      }
      this.accountFingerprint = fingerprint;
      this.accountIdentities = identitySet;
      const chats = await this.#runJson(["chats", "--limit", "250", "--json"], { timeout: 10_000 });
      this.chats = chats.filter((chat) => directExternalChat(chat, identitySet)
        && chatUsesSender(chat, this.expectedLocalSender));
      if (this.state.binding) {
        const selected = this.chats.find((chat) => Number(chat.id) === this.state.binding.chatId
          && clean(chat.guid) === this.state.binding.chatGuid);
        if (!selected || this.state.binding.accountFingerprint !== fingerprint) {
          this.state = emptyState(this.conversationKey);
          writeState(this.stateFile, this.state);
        }
      }
      this.capability = {
        available: true,
        status: this.state.binding ? "READY" : "AWAITING_THREAD_ROOT",
        checkedAt: new Date(this.now()).toISOString(),
      };
      return this.capabilityStatus();
    } catch (error) {
      return this.#unavailable(error?.code || "PROBE_FAILED");
    }
  }

  async #history(chatId = this.state.binding?.chatId, limit = 500) {
    if (!Number.isSafeInteger(Number(chatId)) || Number(chatId) <= 0) return [];
    return this.#runJson(["history", "--chat-id", String(chatId), "--limit", String(limit), "--json"], { timeout: 12_000 });
  }

  async #localRoot(threadId, expectedRoot) {
    const binding = this.state.binding;
    const deadline = this.now() + this.discoveryTimeoutMs;
    do {
      const history = await this.#history().catch(() => []);
      if (expectedRoot && history.some((row) => messageGuid(row) === expectedRoot)) return expectedRoot;
      const rows = await this.#runJson([
        "search", "--query", `codex://threads/${threadId}`, "--match", "contains", "--limit", "50", "--json",
      ], { timeout: 10_000 }).catch(() => []);
      const discovered = rootForThread(rows, binding, threadId, expectedRoot);
      if (discovered) return discovered;
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(300, Math.max(1, deadline - this.now())));
    } while (this.now() < deadline);
    return null;
  }

  async #findTaggedMessage(entry, expectedGuid = "") {
    const requiredGuid = clean(expectedGuid);
    const rows = await this.#history().catch(() => []);
    return rows.find((row) => {
      const contextRoot = clean(row?.thread_originator_guid ?? row?.threadOriginatorGuid);
      const cleanBodyMatches = entry.wireMode !== WIRE_MODE_PLAIN
        || hash("local-user-mirror-body-v1", typeof row?.text === "string" ? row.text : "") === entry.bodyHash;
      return row?.is_from_me === true
        && (requiredGuid ? messageGuid(row) === requiredGuid : containsMarker(row?.text, entry.token))
        && cleanBodyMatches
        && contextRoot === entry.rootGuid;
    }) || null;
  }

  async #reconcile(entry, expectedGuid = "") {
    const deadline = this.now() + this.reconcileTimeoutMs;
    do {
      const found = await this.#findTaggedMessage(entry, expectedGuid);
      if (found) return found;
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(400, Math.max(1, deadline - this.now())));
    } while (this.now() < deadline);
    return null;
  }

  #saveDelivery(key, entry) {
    try {
      this.state.deliveries[key] = entry;
      const entries = Object.entries(this.state.deliveries);
      if (entries.length > MAX_DELIVERIES) {
        const removable = entries
          .filter(([, value]) => value.status === "accepted"
            || (["ambiguous", "dead-letter"].includes(value.status)
              && this.now() - Date.parse(value.attemptedAt || value.preparedAt) > AMBIGUOUS_RETENTION_MS))
          .sort((left, right) => Date.parse(left[1].acceptedAt || left[1].preparedAt) - Date.parse(right[1].acceptedAt || right[1].preparedAt));
        while (Object.keys(this.state.deliveries).length > MAX_DELIVERIES && removable.length) {
          delete this.state.deliveries[removable.shift()[0]];
        }
        if (Object.keys(this.state.deliveries).length > MAX_DELIVERIES) {
          throw codedError("IMSG_LOCAL_MIRROR_LEDGER_FULL", "The local user-mirror ledger is full.", { attempted: false });
        }
      }
      writeState(this.stateFile, this.state);
    } catch (error) {
      this.state = readState(this.stateFile, this.conversationKey);
      this.#unavailable("STATE_WRITE_FAILED");
      throw error;
    }
  }

  #unresolvedPart(key, entry) {
    const attemptedAt = Date.parse(entry.attemptedAt || entry.preparedAt);
    if (Number.isFinite(attemptedAt) && this.now() - attemptedAt >= AMBIGUOUS_DEAD_LETTER_MS) {
      entry.status = "dead-letter";
      entry.deadLetteredAt ||= new Date(this.now()).toISOString();
      this.#saveDelivery(key, entry);
      // Keep the receiver reservation until its independent TTL expires. A
      // very late committed bubble must still be suppressed rather than
      // becoming a second Codex prompt after the failure notice is delivered.
      return { classification: "dead-letter", reservationId: key, attempted: true };
    }
    entry.status = "ambiguous";
    this.#saveDelivery(key, entry);
    return { classification: "ambiguous", reservationId: key, attempted: true };
  }

  async #sendPart({ deliveryId, threadId, rootGuid, intent, index }) {
    const key = deliveryKey(deliveryId, threadId, index);
    const token = markerToken(deliveryId, threadId, index);
    const bodyHash = hash("local-user-mirror-body-v1", intent.text);
    let entry = this.state.deliveries[key];
    if (entry && (entry.threadId !== threadId || entry.rootGuid !== rootGuid
      || entry.bodyHash !== bodyHash || entry.token !== token)) {
      throw codedError("IMSG_LOCAL_MIRROR_CONFLICT", "A local user-mirror delivery id was reused.", { attempted: false });
    }
    if (!entry) {
      entry = {
        reservationId: key,
        threadId,
        bodyHash,
        token,
        wireMode: WIRE_MODE_PLAIN,
        rootGuid,
        status: "prepared",
        preparedAt: new Date(this.now()).toISOString(),
        attemptedAt: null,
        acceptedAt: null,
        deadLetteredAt: null,
        guid: null,
      };
      this.#saveDelivery(key, entry);
    }
    const text = entry.wireMode === WIRE_MODE_TAGGED
      ? taggedText(intent.text, token)
      : String(intent.text);
    const receiverReceiptGuid = clean(this.router.userMirrorEchoReceipt?.(key)?.guid);
    if (!entry.guid && receiverReceiptGuid) entry.guid = receiverReceiptGuid;
    if (!receiverReceiptGuid && ["attempting", "ambiguous", "dead-letter"].includes(entry.status)) {
      // Re-establish or migrate the body-free receiver reservation before any
      // crash reconciliation. This never sends; it only preserves late-echo
      // suppression if the router restarted between the RPC write and result.
      this.router.reserveUserMirrorEcho({ reservationId: key, threadId, text, rootGuid });
    }
    if (entry.status === "accepted") {
      if (entry.guid) {
        const hasDurableReceiverReceipt = receiverReceiptGuid === entry.guid;
        if (!hasDurableReceiverReceipt && !this.router.hasSeenMessageGuid(entry.guid)) {
          this.router.reserveUserMirrorEcho({ reservationId: key, threadId, text, rootGuid });
        }
        this.router.confirmUserMirrorEcho(key, entry.guid);
        this.router.routeOutboundGuid(entry.guid, threadId);
      }
      return { classification: "duplicate", guid: entry.guid, reservationId: key };
    }
    if (entry.status === "dead-letter") {
      return { classification: "dead-letter", reservationId: key, attempted: true };
    }
    if (["attempting", "ambiguous"].includes(entry.status)) {
      const recovered = await this.#reconcile(entry, entry.guid || "");
      if (!recovered) {
        // `attempting` is already beyond the crash-ambiguity boundary: the
        // process may have died after the RPC write but before its result. It
        // is therefore reconciled exactly like an explicit timeout and is
        // never reset to a state that can send again.
        return this.#unresolvedPart(key, entry);
      } else {
        entry.status = "accepted";
        entry.guid = messageGuid(recovered) || entry.guid;
        entry.acceptedAt = new Date(this.now()).toISOString();
        this.#saveDelivery(key, entry);
        if (entry.guid) {
          this.router.confirmUserMirrorEcho(key, entry.guid);
          this.router.routeOutboundGuid(entry.guid, threadId);
        }
        return { classification: "duplicate", guid: entry.guid, reservationId: key };
      }
    }

    this.router.reserveUserMirrorEcho({ reservationId: key, threadId, text, rootGuid });
    entry.status = "attempting";
    entry.attemptedAt = new Date(this.now()).toISOString();
    this.#saveDelivery(key, entry);
    let result;
    try {
      const formatting = imsgTransportInternals.nativeFormatting(intent.ranges).slice(0, 512);
      result = await this.client.sendRich({
        chat_guid: this.state.binding.chatGuid,
        text,
        text_formatting: formatting,
        reply_to: rootGuid,
        // The bridge can return the constructed message GUID immediately on
        // this path. Its queued/text-search verifier required a hidden unique
        // suffix and could associate simultaneous equal text with the wrong
        // row. Exact GUID + exact Reply-root verification still follows.
        dd_scan: false,
      });
    } catch (error) {
      if (error?.attempted === false) {
        this.router.releaseUserMirrorEcho(key);
        entry.status = "prepared";
        entry.attemptedAt = null;
        this.#saveDelivery(key, entry);
        this.#unavailable("SEND_UNAVAILABLE");
        return { classification: "unavailable", reservationId: key, attempted: false, fallbackSafe: true };
      }
      const recovered = await this.#reconcile(entry);
      if (recovered) result = { classification: "accepted", ok: true, guid: messageGuid(recovered) };
      else {
        return this.#unresolvedPart(key, entry);
      }
    }
    if (result?.classification === "unsupported" || result?.retrySafe === true) {
      this.router.releaseUserMirrorEcho(key);
      entry.status = "prepared";
      entry.attemptedAt = null;
      this.#saveDelivery(key, entry);
      this.#unavailable("SEND_UNSUPPORTED");
      return { classification: "unavailable", reservationId: key, attempted: false, fallbackSafe: true };
    }
    if (result?.classification === "ambiguous") {
      const candidateGuid = messageGuid(result);
      if (candidateGuid) entry.guid = candidateGuid;
      const recovered = await this.#reconcile(entry, candidateGuid);
      if (!recovered) {
        return this.#unresolvedPart(key, entry);
      }
      result = { classification: "accepted", ok: true, guid: messageGuid(recovered) };
    }
    const guid = messageGuid(result) || clean(this.router.userMirrorEchoReceipt?.(key)?.guid);
    if (guid) entry.guid = guid;
    // A bridge acknowledgement is only provisional. `send.rich` may return
    // ok/queued without a GUID, and its built-in verifier does not prove that
    // the row retained the requested native Reply root. Accept only after the
    // exact returned GUID is visible locally on the exact root. If the bridge
    // returned no GUID, only a legacy journal's marker plus exact root can
    // identify the row and supply its GUID. New clean-text sends remain
    // fail-closed when the bridge omits authoritative GUID evidence.
    const verified = await this.#reconcile(entry, guid);
    const verifiedGuid = messageGuid(verified);
    if (!verified || !verifiedGuid || (guid && verifiedGuid !== guid)) {
      return this.#unresolvedPart(key, entry);
    }
    entry.guid = verifiedGuid;
    entry.status = "accepted";
    entry.acceptedAt = new Date(this.now()).toISOString();
    this.#saveDelivery(key, entry);
    if (entry.guid) {
      this.router.confirmUserMirrorEcho(key, entry.guid);
      this.router.routeOutboundGuid(entry.guid, threadId);
    }
    return { classification: "accepted", guid: entry.guid, reservationId: key };
  }

  async #sendMirror(message = {}) {
    const deliveryId = clean(message.deliveryId);
    const threadId = clean(message.threadId);
    const body = typeof message.body === "string" ? message.body : "";
    const expectedRoot = clean(message.rootGuid);
    if (!deliveryId || !threadId || !body.trim() || !expectedRoot) {
      return deliveryResult("unavailable", { status: "INVALID_MIRROR", attempted: false, fallbackSafe: true });
    }
    if (!this.capability.available || !this.state.binding) {
      const initializing = this.capability.status === "INITIALIZING";
      if (!this.capability.available) {
        if (!initializing) {
          const refreshed = await this.#initialize({
            expectedLocalSender: this.expectedLocalSenderRaw,
            knownRootGuids: [expectedRoot],
            knownThreads: [{ threadId, rootGuid: expectedRoot }],
          });
          if (refreshed.available) return this.#sendMirror(message);
        }
        return deliveryResult("unavailable", {
          status: this.capability.status,
          attempted: false,
          retryable: initializing,
          fallbackSafe: !initializing,
        });
      }
      const discovered = await this.#discoverBindingForRoot(threadId, expectedRoot);
      if (!discovered) {
        return deliveryResult("unavailable", { status: "ROOT_NOT_SYNCED", attempted: false, retryable: true, fallbackSafe: false });
      }
    }
    const validation = await this.#revalidateBinding();
    if (!validation.available) {
      return deliveryResult("unavailable", { status: validation.status, attempted: false, fallbackSafe: true });
    }
    if (!this.state.binding) {
      const discovered = await this.#discoverBindingForRoot(threadId, expectedRoot);
      if (!discovered) {
        return deliveryResult("unavailable", { status: "ROOT_NOT_SYNCED", attempted: false, retryable: true, fallbackSafe: false });
      }
    }
    const rootGuid = await this.#localRoot(threadId, expectedRoot);
    if (!rootGuid) {
      return deliveryResult("unavailable", { status: "ROOT_NOT_SYNCED", attempted: false, retryable: true, fallbackSafe: false });
    }
    const intent = richTextIntent(body, {
      richText: true,
      event: { kind: "thread.live-message", role: "user", phase: message.phase || "user_message" },
    });
    const parts = imsgTransportInternals.splitTextIntent(intent);
    const guids = [];
    let duplicateOnly = true;
    let ambiguous = false;
    let deadLetter = false;
    for (let index = 0; index < parts.length; index += 1) {
      const part = await this.#sendPart({ deliveryId, threadId, rootGuid, intent: parts[index], index });
      if (part.guid) guids.push(part.guid);
      if (part.classification === "accepted") duplicateOnly = false;
      if (part.classification === "unavailable") {
        return deliveryResult("unavailable", {
          status: "SEND_UNSUPPORTED",
          attempted: guids.length > 0,
          retryable: guids.length > 0,
          fallbackSafe: guids.length === 0 && part.fallbackSafe === true,
          guids,
          parts: index,
        });
      }
      if (part.classification === "ambiguous") {
        ambiguous = true;
      }
      if (part.classification === "dead-letter") {
        deadLetter = true;
        break;
      }
    }
    if (deadLetter) {
      return deliveryResult("dead-letter", {
        attempted: true,
        retryable: false,
        fallbackSafe: false,
        guids,
        parts: parts.length,
      });
    }
    if (ambiguous) {
      return deliveryResult("ambiguous", {
        attempted: true,
        retryable: true,
        guids,
        parts: parts.length,
        fallbackSafe: false,
      });
    }
    return deliveryResult(duplicateOnly ? "duplicate" : "accepted", {
      attempted: !duplicateOnly,
      guids,
      parts: parts.length,
      fallbackSafe: false,
    });
  }
}

export const localUserMirrorInternals = Object.freeze({
  containsMarker,
  deliveryKey,
  directChatMatches,
  invisibleTag,
  markerToken,
  parseJsonLines,
  rootForThread,
  taggedText,
});
