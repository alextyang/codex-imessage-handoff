import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseMenuSelection, parseSlashCommand } from "../../protocol/presentation.ts";

const STATE_VERSION = 5;
const DEFAULT_MENU_TTL_MS = 10 * 60 * 1000;
const DEFAULT_AWAITING_PROMPT_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 128;
const MAX_SEEN = 512;
const MAX_GUID_ROUTES = 512;
const MAX_POLLS = 64;
const MAX_RECEIPTS = 512;
const MAX_THREADS = 512;
const MAX_OUTBOUND_ECHOES = 128;

const THREAD_COMMANDS = new Set([
  "thread",
  "request",
  "message",
  "turn",
  "history",
  "reasoning",
  "listen",
  "link",
  "mute",
  "unmute",
  "retry",
  "dismiss",
  "cancel",
]);
const POLL_ACTION_KINDS = new Set([
  "control",
  "switch",
  "project",
  "projects",
  "threads",
  "refresh",
  "search",
  "thread-picker",
]);

function emptyState(conversationKey = null) {
  return {
    version: STATE_VERSION,
    conversationKey,
    activeThreadId: null,
    activeThreadUpdatedAt: null,
    mostRecentThreadId: null,
    mostRecentThreadAt: null,
    lastUserThreadId: null,
    lastUserThreadAt: null,
    awaitingPrompt: null,
    threads: {},
    menu: null,
    pending: [],
    seen: [],
    guidRoutes: {},
    polls: {},
    outboundReceipts: {},
    outboundEchoes: [],
    lastUserMessageAt: null,
    lastRowId: 0,
  };
}

function cleanString(value, limit = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= limit ? text : null;
}

function finiteRowId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function isoString(value, fallback = null) {
  const text = cleanString(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : fallback;
}

function emptyThreadState() {
  return {
    rootGuid: null,
    latestGuid: null,
    muted: false,
    listen: false,
    lastActivityAt: null,
  };
}

function normalizeThreadState(value) {
  const state = emptyThreadState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  state.rootGuid = cleanString(value.rootGuid, 256);
  state.latestGuid = cleanString(value.latestGuid, 256);
  state.muted = value.muted === true;
  state.listen = value.listen === true;
  state.lastActivityAt = isoString(value.lastActivityAt);
  return state;
}

function normalizePollAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = cleanString(value.kind, 40);
  if (!kind || !POLL_ACTION_KINDS.has(kind)) return null;
  const action = { kind };
  for (const key of ["command", "argument", "threadId", "projectKey", "prompt"]) {
    const item = cleanString(value[key], key === "prompt" ? 32_000 : 512);
    if (item) action[key] = item;
  }
  if (Number.isSafeInteger(Number(value.page)) && Number(value.page) >= 0) action.page = Number(value.page);
  if (value.awaitingPrompt === true) action.awaitingPrompt = true;
  if (kind === "switch" && !action.threadId) return null;
  if (kind === "project" && !action.projectKey) return null;
  if (kind === "control" && !action.command) return null;
  if (kind === "thread-picker" && !THREAD_COMMANDS.has(action.command)) return null;
  return action;
}

function cleanReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const reference = cleanString(item, 256);
    return reference && /^(?:thread|project):/.test(reference) ? [reference] : [];
  }).slice(0, 500);
}

function cleanAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = cleanString(value.kind, 40);
  const threadId = cleanString(value.threadId, 200);
  const messageKey = cleanString(value.messageKey, 256);
  if (!kind || !messageKey) return null;
  const action = { kind, messageKey };
  if (threadId) action.threadId = threadId;
  for (const key of ["command", "argument", "body", "prompt", "projectKey", "guid", "replyToGuid", "threadOriginatorGuid", "createdAt"]) {
    const item = cleanString(value[key], key === "body" || key === "prompt" ? 32_000 : 512);
    if (item) action[key] = item;
  }
  if (Number.isSafeInteger(Number(value.page)) && Number(value.page) >= 0) action.page = Number(value.page);
  for (const key of ["awaitingPrompt", "fromAwaitingPrompt"]) {
    if (value[key] === true) action[key] = true;
  }
  if (Array.isArray(value.attachments)) action.attachments = value.attachments.slice(0, 5);
  return action;
}

function normalizeState(value, expectedConversationKey = null) {
  const requestedConversationKey = cleanString(expectedConversationKey, 128);
  if (!value || typeof value !== "object" || Number(value.version) !== STATE_VERSION) {
    return emptyState(requestedConversationKey);
  }
  const storedConversationKey = cleanString(value.conversationKey, 128);
  if (requestedConversationKey && storedConversationKey !== requestedConversationKey) {
    return emptyState(requestedConversationKey);
  }
  const state = emptyState(requestedConversationKey || storedConversationKey);
  state.activeThreadId = cleanString(value.activeThreadId, 200);
  state.activeThreadUpdatedAt = cleanString(value.activeThreadUpdatedAt, 64);
  state.mostRecentThreadId = cleanString(value.mostRecentThreadId, 200) || state.activeThreadId;
  state.mostRecentThreadAt = isoString(value.mostRecentThreadAt)
    || isoString(value.activeThreadUpdatedAt);
  state.lastUserThreadId = cleanString(value.lastUserThreadId, 200);
  state.lastUserThreadAt = isoString(value.lastUserThreadAt);
  if (value.awaitingPrompt && typeof value.awaitingPrompt === "object" && !Array.isArray(value.awaitingPrompt)) {
    const threadId = cleanString(value.awaitingPrompt.threadId, 200);
    const selectedAt = isoString(value.awaitingPrompt.selectedAt);
    const expiresAt = isoString(value.awaitingPrompt.expiresAt);
    if (threadId && selectedAt && expiresAt) state.awaitingPrompt = { threadId, selectedAt, expiresAt };
  }
  if (value.threads && typeof value.threads === "object" && !Array.isArray(value.threads)) {
    const entries = Object.entries(value.threads)
      .flatMap(([threadId, thread]) => {
        const cleanThreadId = cleanString(threadId, 200);
        return cleanThreadId ? [[cleanThreadId, normalizeThreadState(thread)]] : [];
      })
      .sort((left, right) => (Date.parse(left[1].lastActivityAt || "") || 0) - (Date.parse(right[1].lastActivityAt || "") || 0))
      .slice(-MAX_THREADS);
    state.threads = Object.fromEntries(entries);
  }
  if (state.mostRecentThreadId && !state.threads[state.mostRecentThreadId]) {
    state.threads[state.mostRecentThreadId] = {
      ...emptyThreadState(),
      lastActivityAt: state.mostRecentThreadAt,
    };
  }
  if (value.menu && typeof value.menu === "object") {
    const expiresAt = cleanString(value.menu.expiresAt, 64);
    const references = cleanReferences(value.menu.references);
    if (expiresAt && references.length) state.menu = { expiresAt, references };
  }
  state.pending = Array.isArray(value.pending) ? value.pending.map(cleanAction).filter(Boolean).slice(-MAX_PENDING) : [];
  state.seen = Array.isArray(value.seen) ? value.seen.map((item) => cleanString(item, 256)).filter(Boolean).slice(-MAX_SEEN) : [];
  if (value.guidRoutes && typeof value.guidRoutes === "object" && !Array.isArray(value.guidRoutes)) {
    for (const [guid, threadId] of Object.entries(value.guidRoutes).slice(-MAX_GUID_ROUTES)) {
      const cleanGuid = cleanString(guid, 256);
      const cleanThread = cleanString(threadId, 200);
      if (cleanGuid && cleanThread) state.guidRoutes[cleanGuid] = cleanThread;
    }
  }
  if (value.polls && typeof value.polls === "object" && !Array.isArray(value.polls)) {
    for (const [guid, poll] of Object.entries(value.polls).slice(-MAX_POLLS)) {
      const cleanGuid = cleanString(guid, 256);
      if (!cleanGuid || !poll || typeof poll !== "object") continue;
      const expiresAt = cleanString(poll.expiresAt, 64);
      const options = poll.options && typeof poll.options === "object" && !Array.isArray(poll.options)
        ? Object.fromEntries(Object.entries(poll.options).flatMap(([id, action]) => {
          const cleanId = cleanString(id, 256);
          const cleanValue = normalizePollAction(action);
          return cleanId && cleanValue ? [[cleanId, cleanValue]] : [];
        }))
        : {};
      if (expiresAt && Object.keys(options).length) state.polls[cleanGuid] = { expiresAt, options };
    }
  }
  if (value.outboundReceipts && typeof value.outboundReceipts === "object" && !Array.isArray(value.outboundReceipts)) {
    for (const [eventId, receipt] of Object.entries(value.outboundReceipts).slice(-MAX_RECEIPTS)) {
      const cleanEventId = cleanString(eventId, 256);
      if (!cleanEventId || !receipt || typeof receipt !== "object") continue;
      const classification = cleanString(receipt.classification, 32);
      const updatedAt = cleanString(receipt.updatedAt, 64);
      const guids = Array.isArray(receipt.guids)
        ? receipt.guids.map((guid) => cleanString(guid, 256)).filter(Boolean).slice(0, 32)
        : [];
      if (classification && updatedAt) state.outboundReceipts[cleanEventId] = { classification, updatedAt, guids };
    }
  }
  if (Array.isArray(value.outboundEchoes)) {
    state.outboundEchoes = value.outboundEchoes.flatMap((echo) => {
      if (!echo || typeof echo !== "object" || Array.isArray(echo)) return [];
      const fingerprint = cleanString(echo.fingerprint, 64);
      const expiresAt = isoString(echo.expiresAt);
      const remaining = Number(echo.remaining);
      return fingerprint && /^[a-f0-9]{64}$/i.test(fingerprint) && expiresAt
        && Number.isSafeInteger(remaining) && remaining > 0
        ? [{ fingerprint: fingerprint.toLowerCase(), expiresAt, remaining: Math.min(remaining, 32) }]
        : [];
    }).slice(-MAX_OUTBOUND_ECHOES);
  }
  state.lastUserMessageAt = cleanString(value.lastUserMessageAt, 64);
  state.lastRowId = finiteRowId(value.lastRowId);
  return state;
}

function readState(file, conversationKey = null) {
  if (!existsSync(file)) return emptyState(cleanString(conversationKey, 128));
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")), conversationKey);
  } catch {
    return emptyState(cleanString(conversationKey, 128));
  }
}

function conversationNeedsReset(file, conversationKey) {
  const expected = cleanString(conversationKey, 128);
  if (!expected) return false;
  if (!existsSync(file)) return true;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return cleanString(value?.conversationKey, 128) !== expected;
  } catch {
    return true;
  }
}

function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function threadState(state, threadId, { create = false } = {}) {
  const id = cleanString(threadId, 200);
  if (!id) return null;
  if (!state.threads[id] && create) state.threads[id] = emptyThreadState();
  return state.threads[id] || null;
}

function pruneThreadStates(state) {
  const entries = Object.entries(state.threads);
  if (entries.length <= MAX_THREADS) return;
  entries.sort((left, right) => {
    const leftAt = Date.parse(left[1].lastActivityAt || "") || 0;
    const rightAt = Date.parse(right[1].lastActivityAt || "") || 0;
    return leftAt - rightAt;
  });
  state.threads = Object.fromEntries(entries.slice(-MAX_THREADS));
}

function routeGuid(state, guid, threadId) {
  const cleanGuid = cleanString(guid, 256);
  const cleanThread = cleanString(threadId, 200);
  if (!cleanGuid || !cleanThread) return false;
  if (state.guidRoutes[cleanGuid] && state.guidRoutes[cleanGuid] !== cleanThread) return false;
  delete state.guidRoutes[cleanGuid];
  state.guidRoutes[cleanGuid] = cleanThread;
  const entries = Object.entries(state.guidRoutes);
  if (entries.length > MAX_GUID_ROUTES) state.guidRoutes = Object.fromEntries(entries.slice(-MAX_GUID_ROUTES));
  return true;
}

function threadForGuid(state, guid) {
  const cleanGuid = cleanString(guid, 256);
  if (!cleanGuid) return null;
  const routed = state.guidRoutes[cleanGuid];
  if (routed) return routed;
  for (const [threadId, thread] of Object.entries(state.threads)) {
    if (thread?.rootGuid === cleanGuid || thread?.latestGuid === cleanGuid) return threadId;
  }
  return null;
}

function touchThreadState(state, threadId, at, { latestGuid = null, rootGuid = null } = {}) {
  const cleanThread = cleanString(threadId, 200);
  if (!cleanThread) return null;
  const activityAt = isoString(at, new Date().toISOString());
  const item = threadState(state, cleanThread, { create: true });
  const cleanLatest = cleanString(latestGuid, 256);
  const cleanRoot = cleanString(rootGuid, 256);
  if (cleanRoot) item.rootGuid = cleanRoot;
  if (cleanLatest) item.latestGuid = cleanLatest;
  item.lastActivityAt = activityAt;
  state.mostRecentThreadId = cleanThread;
  state.mostRecentThreadAt = activityAt;
  pruneThreadStates(state);
  return item;
}

function messageKey(message) {
  return cleanString(message?.guid, 256)
    || (finiteRowId(message?.id) ? `row:${finiteRowId(message.id)}` : null);
}

function echoFingerprint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? createHash("sha256").update(`imsg-outbound:${text}`).digest("hex") : null;
}

function pruneOutboundEchoes(state, nowMs) {
  const before = state.outboundEchoes.length;
  state.outboundEchoes = state.outboundEchoes.filter((echo) => Date.parse(echo.expiresAt) > nowMs && echo.remaining > 0);
  return state.outboundEchoes.length !== before;
}

function normalizeMessage(message) {
  const key = messageKey(message);
  if (!key) return null;
  return {
    key,
    id: finiteRowId(message?.id),
    guid: cleanString(message?.guid, 256),
    text: typeof message?.text === "string" ? message.text.trim() : "",
    createdAt: cleanString(message?.created_at || message?.createdAt, 64) || new Date().toISOString(),
    replyToGuid: cleanString(message?.reply_to_guid || message?.replyToGuid, 256),
    threadOriginatorGuid: cleanString(message?.thread_originator_guid || message?.threadOriginatorGuid, 256),
    attachments: Array.isArray(message?.attachments) ? message.attachments.slice(0, 5) : [],
    poll: message?.poll && typeof message.poll === "object" ? message.poll : null,
    isReaction: message?.is_reaction === true || message?.isReaction === true,
  };
}

function pollSelection(message, state, nowMs) {
  const poll = message.poll;
  if (!poll || String(poll.kind || "").toLowerCase() !== "vote") return null;
  const originalGuid = cleanString(poll.original_guid || poll.originalGuid, 256);
  const optionId = cleanString(poll.vote?.option_id || poll.vote?.optionId, 256);
  const registration = originalGuid ? state.polls[originalGuid] : null;
  if (!registration || !optionId || Date.parse(registration.expiresAt) <= nowMs) return { kind: "stale-poll" };
  return normalizePollAction(registration.options[optionId]) || { kind: "stale-poll" };
}

function actionFromPoll(message, state, nowMs) {
  return pollSelection(message, state, nowMs);
}

export class LocalConversationRouter {
  constructor({ stateFile, conversationKey = null, now = () => Date.now(), menuTtlMs = DEFAULT_MENU_TTL_MS } = {}) {
    if (!stateFile) throw new TypeError("LocalConversationRouter requires stateFile.");
    this.stateFile = path.resolve(stateFile);
    this.now = now;
    this.menuTtlMs = menuTtlMs;
    this.conversationReset = conversationNeedsReset(this.stateFile, conversationKey);
    this.state = readState(this.stateFile, conversationKey);
  }

  get activeThreadId() { return this.state.activeThreadId; }
  get mostRecentThreadId() { return this.state.mostRecentThreadId; }
  get lastUserThreadId() { return this.state.lastUserThreadId; }
  get lastRowId() { return this.state.lastRowId; }
  get lastUserMessageAt() { return this.state.lastUserMessageAt; }
  get awaitingPrompt() {
    const awaiting = this.#currentAwaitingPrompt();
    return awaiting ? structuredClone(awaiting) : null;
  }
  get incomingPaused() { return Boolean(this.#currentAwaitingPrompt()); }

  #currentAwaitingPrompt() {
    const awaiting = this.state.awaitingPrompt;
    if (!awaiting) return null;
    if (Date.parse(awaiting.expiresAt || "") > this.now()) return awaiting;
    this.state.awaitingPrompt = null;
    writeState(this.stateFile, this.state);
    return null;
  }

  setActiveThread(threadId, updatedAt = new Date(this.now()).toISOString()) {
    this.state.activeThreadId = cleanString(threadId, 200);
    this.state.activeThreadUpdatedAt = cleanString(updatedAt, 64) || new Date(this.now()).toISOString();
    if (this.state.activeThreadId && !this.state.mostRecentThreadId) {
      touchThreadState(this.state, this.state.activeThreadId, this.state.activeThreadUpdatedAt);
    }
    writeState(this.stateFile, this.state);
  }

  nativeThread(threadId) {
    const item = threadState(this.state, threadId);
    return item ? structuredClone(item) : null;
  }

  threadReplyTarget(threadId) {
    const item = threadState(this.state, threadId);
    return item?.rootGuid || item?.latestGuid || null;
  }

  touchThread(threadId, updatedAt = new Date(this.now()).toISOString()) {
    const item = touchThreadState(this.state, threadId, updatedAt);
    if (!item) return null;
    writeState(this.stateFile, this.state);
    return structuredClone(item);
  }

  setThreadRoot(threadId, guid, updatedAt = new Date(this.now()).toISOString()) {
    const cleanGuid = cleanString(guid, 256);
    const cleanThread = cleanString(threadId, 200);
    if (!cleanGuid || !cleanThread) return null;
    routeGuid(this.state, cleanGuid, cleanThread);
    const item = touchThreadState(this.state, cleanThread, updatedAt, { rootGuid: cleanGuid, latestGuid: cleanGuid });
    writeState(this.stateFile, this.state);
    return structuredClone(item);
  }

  setThreadMuted(threadId, muted = true) {
    const item = threadState(this.state, threadId, { create: true });
    if (!item) return false;
    item.muted = muted === true;
    pruneThreadStates(this.state);
    writeState(this.stateFile, this.state);
    return item.muted;
  }

  isThreadMuted(threadId) {
    return threadState(this.state, threadId)?.muted === true;
  }

  setThreadListen(threadId, listen = true) {
    const item = threadState(this.state, threadId, { create: true });
    if (!item) return false;
    item.listen = listen === true;
    pruneThreadStates(this.state);
    writeState(this.stateFile, this.state);
    return item.listen;
  }

  consumeThreadListen(threadId) {
    const item = threadState(this.state, threadId);
    if (!item?.listen) return false;
    item.listen = false;
    writeState(this.stateFile, this.state);
    return true;
  }

  setAwaitingPrompt(threadId, selectedAt = new Date(this.now()).toISOString(), ttlMs = DEFAULT_AWAITING_PROMPT_TTL_MS) {
    const cleanThread = cleanString(threadId, 200);
    const cleanAt = isoString(selectedAt, new Date(this.now()).toISOString());
    if (!cleanThread) return false;
    this.state.awaitingPrompt = {
      threadId: cleanThread,
      selectedAt: cleanAt,
      expiresAt: new Date(this.now() + Math.max(1_000, Number(ttlMs) || DEFAULT_AWAITING_PROMPT_TTL_MS)).toISOString(),
    };
    this.state.lastUserThreadId = cleanThread;
    this.state.lastUserThreadAt = cleanAt;
    touchThreadState(this.state, cleanThread, cleanAt);
    writeState(this.stateFile, this.state);
    return true;
  }

  clearAwaitingPrompt(threadId = null) {
    if (!this.#currentAwaitingPrompt()) return false;
    const cleanThread = cleanString(threadId, 200);
    if (cleanThread && this.state.awaitingPrompt.threadId !== cleanThread) return false;
    this.state.awaitingPrompt = null;
    writeState(this.stateFile, this.state);
    return true;
  }

  shouldPauseIncoming(threadId = null) {
    const awaiting = this.#currentAwaitingPrompt();
    const cleanThread = cleanString(threadId, 200);
    return Boolean(awaiting && cleanThread && awaiting.threadId === cleanThread);
  }

  isAwaitingPromptFor(threadId) {
    const cleanThread = cleanString(threadId, 200);
    return Boolean(cleanThread && this.#currentAwaitingPrompt()?.threadId === cleanThread);
  }

  setMenu(references, ttlMs = this.menuTtlMs) {
    const clean = cleanReferences(references);
    this.state.menu = clean.length
      ? { references: clean, expiresAt: new Date(this.now() + Math.max(1_000, Number(ttlMs) || this.menuTtlMs)).toISOString() }
      : null;
    writeState(this.stateFile, this.state);
  }

  routeOutboundGuid(guid, threadId, options = {}) {
    const cleanGuid = cleanString(guid, 256);
    const cleanThread = cleanString(threadId, 200);
    if (!cleanGuid || !cleanThread) return null;
    routeGuid(this.state, cleanGuid, cleanThread);
    const current = threadState(this.state, cleanThread);
    const explicitRoot = options.root === true || options.isRoot === true;
    const rootGuid = explicitRoot || !current?.rootGuid ? cleanGuid : null;
    const item = touchThreadState(this.state, cleanThread, options.createdAt || new Date(this.now()).toISOString(), {
      rootGuid,
      latestGuid: cleanGuid,
    });
    writeState(this.stateFile, this.state);
    return structuredClone(item);
  }

  routeInboundGuid(guid, threadId, options = {}) {
    const cleanGuid = cleanString(guid, 256);
    const cleanThread = cleanString(threadId, 200);
    if (!cleanGuid || !cleanThread) return null;
    routeGuid(this.state, cleanGuid, cleanThread);
    const originator = cleanString(options.threadOriginatorGuid || options.thread_originator_guid, 256);
    const parent = cleanString(options.replyToGuid || options.reply_to_guid, 256);
    if (originator) routeGuid(this.state, originator, cleanThread);
    if (parent) routeGuid(this.state, parent, cleanThread);
    const current = threadState(this.state, cleanThread);
    const rootGuid = !current?.rootGuid && originator ? originator : null;
    const item = touchThreadState(this.state, cleanThread, options.createdAt || new Date(this.now()).toISOString(), {
      rootGuid,
      latestGuid: cleanGuid,
    });
    writeState(this.stateFile, this.state);
    return structuredClone(item);
  }

  registerPoll(guid, options, ttlMs = this.menuTtlMs) {
    const cleanGuid = cleanString(guid, 256);
    if (!cleanGuid || !options || typeof options !== "object") return;
    const cleanOptions = Object.fromEntries(Object.entries(options).flatMap(([id, action]) => {
      const cleanId = cleanString(id, 256);
      const cleanActionValue = normalizePollAction(action);
      return cleanId && cleanActionValue ? [[cleanId, cleanActionValue]] : [];
    }));
    if (!Object.keys(cleanOptions).length) return;
    this.state.polls[cleanGuid] = {
      expiresAt: new Date(this.now() + Math.max(1_000, Number(ttlMs) || this.menuTtlMs)).toISOString(),
      options: cleanOptions,
    };
    const entries = Object.entries(this.state.polls);
    if (entries.length > MAX_POLLS) this.state.polls = Object.fromEntries(entries.slice(-MAX_POLLS));
    writeState(this.stateFile, this.state);
  }

  outboundReceipt(eventIdValue) {
    const eventId = cleanString(eventIdValue, 256);
    return eventId && this.state.outboundReceipts[eventId]
      ? structuredClone(this.state.outboundReceipts[eventId])
      : null;
  }

  recordOutboundReceipt(eventIdValue, receipt = {}) {
    const eventId = cleanString(eventIdValue, 256);
    const classification = cleanString(receipt.classification, 32);
    if (!eventId || !classification) return false;
    this.state.outboundReceipts[eventId] = {
      classification,
      updatedAt: new Date(this.now()).toISOString(),
      guids: Array.isArray(receipt.guids)
        ? receipt.guids.map((guid) => cleanString(guid, 256)).filter(Boolean).slice(0, 32)
        : [],
    };
    const entries = Object.entries(this.state.outboundReceipts);
    if (entries.length > MAX_RECEIPTS) this.state.outboundReceipts = Object.fromEntries(entries.slice(-MAX_RECEIPTS));
    writeState(this.stateFile, this.state);
    return true;
  }

  pendingActions() { return this.state.pending.map((action) => structuredClone(action)); }

  initializeConversation(latestMessage = null) {
    const advanced = latestMessage ? this.discard(latestMessage) : false;
    if (!advanced) writeState(this.stateFile, this.state);
    this.conversationReset = false;
    return { initialized: true, baselined: advanced, lastRowId: this.state.lastRowId };
  }

  reserveOutboundEcho(text, ttlMs = 15_000) {
    const fingerprint = echoFingerprint(text);
    if (!fingerprint) return null;
    const nowMs = this.now();
    pruneOutboundEchoes(this.state, nowMs);
    const expiresAt = new Date(nowMs + Math.max(1_000, Number(ttlMs) || 15_000)).toISOString();
    const existing = this.state.outboundEchoes.find((echo) => echo.fingerprint === fingerprint);
    if (existing) {
      existing.remaining = Math.min(32, existing.remaining + 1);
      existing.expiresAt = expiresAt;
    } else {
      this.state.outboundEchoes.push({ fingerprint, remaining: 1, expiresAt });
      this.state.outboundEchoes = this.state.outboundEchoes.slice(-MAX_OUTBOUND_ECHOES);
    }
    writeState(this.stateFile, this.state);
    return fingerprint;
  }

  releaseOutboundEcho(fingerprintValue) {
    const fingerprint = cleanString(fingerprintValue, 64)?.toLowerCase();
    if (!fingerprint) return false;
    pruneOutboundEchoes(this.state, this.now());
    const index = this.state.outboundEchoes.findIndex((echo) => echo.fingerprint === fingerprint);
    if (index < 0) return false;
    if (this.state.outboundEchoes[index].remaining > 1) this.state.outboundEchoes[index].remaining -= 1;
    else this.state.outboundEchoes.splice(index, 1);
    writeState(this.stateFile, this.state);
    return true;
  }

  consumeOutboundEcho(rawMessage) {
    const priorState = structuredClone(this.state);
    try {
      return this.#consumeOutboundEcho(rawMessage);
    } catch (error) {
      // Never retain an inbound cursor or deduplication marker in memory when
      // its durable write failed. The watch can then resubscribe from the last
      // committed row and safely receive the message again.
      this.state = priorState;
      throw error;
    }
  }

  #consumeOutboundEcho(rawMessage) {
    const message = normalizeMessage(rawMessage);
    const fingerprint = echoFingerprint(message?.text);
    if (!message || !fingerprint || this.state.seen.includes(message.key)
      || this.state.pending.some((action) => action.messageKey === message.key)) return false;
    pruneOutboundEchoes(this.state, this.now());
    const index = this.state.outboundEchoes.findIndex((echo) => echo.fingerprint === fingerprint);
    if (index < 0) return false;
    if (this.state.outboundEchoes[index].remaining > 1) this.state.outboundEchoes[index].remaining -= 1;
    else this.state.outboundEchoes.splice(index, 1);
    this.state.seen.push(message.key);
    this.state.seen = [...new Set(this.state.seen)].slice(-MAX_SEEN);
    this.state.lastRowId = Math.max(this.state.lastRowId, message.id);
    writeState(this.stateFile, this.state);
    return true;
  }

  discard(rawMessage) {
    const priorState = structuredClone(this.state);
    try {
      return this.#discard(rawMessage);
    } catch (error) {
      this.state = priorState;
      throw error;
    }
  }

  #discard(rawMessage) {
    const message = normalizeMessage(rawMessage);
    if (!message) return false;
    if (this.state.pending.some((item) => item.messageKey === message.key)) return false;
    if (this.state.seen.includes(message.key)) return false;
    this.state.seen.push(message.key);
    this.state.seen = [...new Set(this.state.seen)].slice(-MAX_SEEN);
    this.state.lastRowId = Math.max(this.state.lastRowId, message.id);
    writeState(this.stateFile, this.state);
    return true;
  }

  ingest(rawMessage) {
    const priorState = structuredClone(this.state);
    try {
      return this.#ingest(rawMessage);
    } catch (error) {
      this.state = priorState;
      throw error;
    }
  }

  #ingest(rawMessage) {
    const message = normalizeMessage(rawMessage);
    if (!message || message.isReaction) return null;
    const existing = this.state.pending.find((item) => item.messageKey === message.key);
    if (existing) return structuredClone(existing);
    if (this.state.seen.includes(message.key)) return null;

    const nowMs = this.now();
    const replyThreadId = threadForGuid(this.state, message.replyToGuid);
    const originatorThreadId = threadForGuid(this.state, message.threadOriginatorGuid);
    const explicitThreadId = replyThreadId || originatorThreadId || null;
    const awaitingPrompt = this.#currentAwaitingPrompt();
    let targetThreadId = explicitThreadId || this.state.lastUserThreadId;
    let action = actionFromPoll(message, this.state, nowMs);
    const slash = message.text ? parseSlashCommand(message.text) : null;
    const selection = message.text ? parseMenuSelection(message.text) : null;
    const menuValid = this.state.menu && Date.parse(this.state.menu.expiresAt) > nowMs;
    let consumedAwaitingPrompt = false;

    if (!action && slash) {
      const command = slash.command === "recent" ? "threads" : slash.command;
      if (THREAD_COMMANDS.has(command) && !explicitThreadId) {
        action = { kind: "thread-picker", command, argument: slash.argument };
      } else {
        const globalCommand = command === "help" || command === "projects" || command === "search" || command === "threads" || command === "refresh";
        action = globalCommand
          ? { kind: command, command, argument: slash.argument }
          : { kind: "control", command, threadId: targetThreadId, argument: slash.argument };
      }
    } else if (!action && selection && this.state.menu) {
      const reference = menuValid ? this.state.menu.references[selection.index] : null;
      if (!reference) action = { kind: "stale-menu", threadId: targetThreadId };
      else if (reference.startsWith("project:")) action = { kind: "project", projectKey: reference.slice("project:".length) };
      else action = { kind: "switch", threadId: reference.slice("thread:".length), prompt: selection.prompt };
    } else if (!action && message.text.startsWith("/")) {
      action = { kind: "unknown-command", threadId: targetThreadId };
    } else if (!action && (message.text || message.attachments.length)) {
      if (!explicitThreadId && awaitingPrompt?.threadId) {
        targetThreadId = awaitingPrompt.threadId;
        consumedAwaitingPrompt = true;
      }
      action = targetThreadId
        ? { kind: "prompt", threadId: targetThreadId, body: message.text, attachments: message.attachments }
        : { kind: "no-thread" };
    }
    if (!action) return null;

    if (action.kind === "switch" && action.threadId) {
      if (action.prompt) {
        this.state.awaitingPrompt = null;
      } else {
        action.awaitingPrompt = true;
        this.state.awaitingPrompt = {
          threadId: action.threadId,
          selectedAt: message.createdAt,
          expiresAt: new Date(nowMs + DEFAULT_AWAITING_PROMPT_TTL_MS).toISOString(),
        };
      }
    } else if (consumedAwaitingPrompt) {
      action.fromAwaitingPrompt = true;
      this.state.awaitingPrompt = null;
    }

    action = cleanAction({
      ...action,
      messageKey: message.key,
      guid: message.guid,
      replyToGuid: message.replyToGuid,
      threadOriginatorGuid: message.threadOriginatorGuid,
      createdAt: message.createdAt,
    });
    if (!action) return null;
    if (action.threadId) {
      this.state.lastUserThreadId = action.threadId;
      this.state.lastUserThreadAt = message.createdAt;
      const shouldRouteMessage = !message.poll
        && (action.kind !== "switch" || Boolean(action.prompt) || Boolean(explicitThreadId));
      if (shouldRouteMessage && message.guid) {
        routeGuid(this.state, message.guid, action.threadId);
        if (message.replyToGuid) routeGuid(this.state, message.replyToGuid, action.threadId);
        if (message.threadOriginatorGuid) routeGuid(this.state, message.threadOriginatorGuid, action.threadId);
        const current = threadState(this.state, action.threadId);
        touchThreadState(this.state, action.threadId, message.createdAt, {
          rootGuid: !current?.rootGuid && message.threadOriginatorGuid ? message.threadOriginatorGuid : null,
          latestGuid: message.guid,
        });
      } else {
        touchThreadState(this.state, action.threadId, message.createdAt);
      }
    }
    this.state.pending.push(action);
    this.state.pending = this.state.pending.slice(-MAX_PENDING);
    this.state.lastUserMessageAt = message.createdAt;
    this.state.lastRowId = Math.max(this.state.lastRowId, message.id);
    writeState(this.stateFile, this.state);
    return structuredClone(action);
  }

  acknowledge(messageKeyValue) {
    const key = cleanString(messageKeyValue, 256);
    if (!key) return false;
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((item) => item.messageKey !== key);
    if (before === this.state.pending.length) return false;
    this.state.seen.push(key);
    this.state.seen = [...new Set(this.state.seen)].slice(-MAX_SEEN);
    writeState(this.stateFile, this.state);
    return true;
  }
}
