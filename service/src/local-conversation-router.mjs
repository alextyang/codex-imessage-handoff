import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseMenuSelection, parseSlashCommand } from "../../protocol/presentation.ts";

const STATE_VERSION = 5;
const DEFAULT_MENU_TTL_MS = 10 * 60 * 1000;
const DEFAULT_AWAITING_PROMPT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_COMMAND_CONTEXT_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 128;
const MAX_SEEN = 512;
const MAX_GUID_ROUTES = 4096;
const MAX_POLLS = 64;
const MAX_RECEIPTS = 512;
const MAX_THREADS = 512;
const MAX_OUTBOUND_ECHOES = 128;
const MAX_CONFIRMATIONS = 512;

const THREAD_COMMANDS = new Set([
  "thread",
  "open",
  "request",
  "message",
  "turn",
  "history",
  "reasoning",
  "listen",
  "link",
  "mute",
  "unmute",
  "status",
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
  "new-project",
  "new-project-search",
  "new-reasoning",
  "new-reasoning-refresh",
  "default-reasoning",
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
    awaitingNewPrompt: null,
    activeNewFlowId: null,
    threads: {},
    menu: null,
    pending: [],
    seen: [],
    guidRoutes: {},
    polls: {},
    outboundReceipts: {},
    outboundEchoes: [],
    confirmationOutbox: [],
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
  for (const key of ["command", "argument", "threadId", "projectKey", "prompt", "flowId"]) {
    const item = cleanString(value[key], key === "prompt" ? 32_000 : 512);
    if (item) action[key] = item;
  }
  if (Number.isSafeInteger(Number(value.page)) && Number(value.page) >= 0) action.page = Number(value.page);
  if (value.awaitingPrompt === true) action.awaitingPrompt = true;
  if (kind === "switch" && !action.threadId) return null;
  if (kind === "project" && !action.projectKey) return null;
  if (kind === "control" && !action.command) return null;
  if (kind === "thread-picker" && !THREAD_COMMANDS.has(action.command)) return null;
  if (["new-project", "new-project-search", "new-reasoning", "new-reasoning-refresh"].includes(kind) && !action.flowId) return null;
  if (kind === "new-project" && !action.projectKey) return null;
  if (kind === "new-reasoning" && !action.argument) return null;
  if (kind === "default-reasoning" && !action.argument) return null;
  return action;
}

function normalizePollMetadata(value) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const knownOptionIds = new Set();
  const knownOptionLabels = new Set();
  const addId = (item) => {
    const clean = cleanString(item, 256);
    if (clean) knownOptionIds.add(clean);
  };
  const addLabel = (item) => {
    const clean = cleanString(item, 2_000);
    if (clean) knownOptionLabels.add(clean.toLocaleLowerCase());
  };
  const collect = (items) => {
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === "string") addLabel(item);
        else if (item && typeof item === "object") {
          addId(item.id ?? item.option_id ?? item.optionId ?? item.guid);
          addLabel(item.text ?? item.title ?? item.label ?? item.value ?? item.name);
        }
      }
    } else if (items && typeof items === "object") {
      for (const [id, item] of Object.entries(items)) {
        addId(id);
        if (typeof item === "string") addLabel(item);
        else if (item && typeof item === "object") {
          addId(item.id ?? item.option_id ?? item.optionId ?? item.guid);
          addLabel(item.text ?? item.title ?? item.label ?? item.value ?? item.name);
        }
      }
    }
  };
  for (const item of Array.isArray(metadata.knownOptionIds) ? metadata.knownOptionIds : []) addId(item);
  for (const item of Array.isArray(metadata.knownOptionLabels) ? metadata.knownOptionLabels : []) addLabel(item);
  collect(metadata.options);
  collect(metadata.optionLabels);
  collect(metadata.knownOptions);
  return {
    addChoiceSearch: metadata.addChoiceSearch === true
      || metadata.allowAddChoiceSearch === true
      || metadata.allowAddedChoiceSearch === true
      || metadata.addChoiceAsSearch === true,
    addChoiceCommand: cleanString(
      metadata.addChoiceCommand
        ?? metadata.addedChoiceCommand
        ?? metadata.addChoiceSearchCommand,
      40,
    ),
    addChoiceArgument: cleanString(
      metadata.addChoiceArgument
        ?? metadata.addedChoiceArgument
        ?? metadata.addChoiceCommandArgument,
      512,
    ),
    refreshAction: normalizePollAction(metadata.refreshAction ?? metadata.staleAction),
    addedChoiceAction: normalizePollAction(metadata.addedChoiceAction),
    knownOptionIds: [...knownOptionIds].slice(-500),
    knownOptionLabels: [...knownOptionLabels].slice(-500),
  };
}

function inferredAddChoiceCommand(options, explicitCommand = null) {
  const requested = cleanString(explicitCommand, 40)?.toLowerCase();
  if (requested && THREAD_COMMANDS.has(requested)) return requested;
  const controls = Object.values(options || {}).filter((action) => action?.kind === "control");
  if (!controls.length || controls.some((action) => action.argument)) return null;
  const commands = new Set(controls.map((action) => cleanString(action.command, 40)?.toLowerCase()).filter(Boolean));
  return commands.size === 1 && THREAD_COMMANDS.has([...commands][0]) ? [...commands][0] : null;
}

function inferredPollRefreshAction(options, metadata = {}) {
  const explicit = normalizePollAction(metadata.refreshAction);
  if (explicit) return explicit;

  const pickerCommand = cleanString(metadata.addChoiceCommand, 40)?.toLowerCase();
  if (pickerCommand && THREAD_COMMANDS.has(pickerCommand)) {
    const action = { kind: "thread-picker", command: pickerCommand };
    const argument = cleanString(metadata.addChoiceArgument, 512);
    if (argument) action.argument = argument;
    return action;
  }

  const controls = Object.values(options || {}).filter((action) => action?.kind === "control");
  const commands = new Set(controls.map((action) => cleanString(action.command, 40)?.toLowerCase()).filter(Boolean));
  const threadIds = new Set(controls.map((action) => cleanString(action.threadId, 200)).filter(Boolean));
  if (!controls.length || commands.size !== 1) return null;
  const command = [...commands][0];
  if (command === "reasoning" && threadIds.size === 1) {
    return { kind: "control", command, threadId: [...threadIds][0] };
  }
  const action = { kind: "thread-picker", command };
  const argumentsFound = new Set(controls.map((item) => cleanString(item.argument, 512)).filter(Boolean));
  if (argumentsFound.size === 1) action.argument = [...argumentsFound][0];
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
  for (const key of ["command", "argument", "commandArgument", "body", "prompt", "projectKey", "flowId", "guid", "replyToGuid", "threadOriginatorGuid", "createdAt"]) {
    const item = cleanString(value[key], key === "body" || key === "prompt" ? 32_000 : 512);
    if (item) action[key] = item;
  }
  if (Number.isSafeInteger(Number(value.page)) && Number(value.page) >= 0) action.page = Number(value.page);
  for (const key of ["awaitingPrompt", "fromAwaitingPrompt"]) {
    if (value[key] === true) action[key] = true;
  }
  if (typeof value.enabled === "boolean") action.enabled = value.enabled;
  if (Array.isArray(value.attachments)) action.attachments = value.attachments.slice(0, 5);
  return action;
}

function confirmationOperationId(messageKey, messageGuid, reaction, remove = false) {
  return `confirmation:${createHash("sha256")
    .update(`imsg-confirmation-v1\u0000${messageKey}\u0000${messageGuid}\u0000${reaction}\u0000${remove ? "remove" : "add"}`)
    .digest("hex")}`;
}

function newConfirmation(messageKeyValue, value, now = Date.now()) {
  const messageKey = cleanString(messageKeyValue, 256);
  const messageGuid = cleanString(value?.messageGuid ?? value?.guid, 256);
  const reaction = cleanString(value?.reaction, 128);
  if (!messageKey || !messageGuid || !reaction) return null;
  const remove = value?.remove === true;
  return {
    operationId: confirmationOperationId(messageKey, messageGuid, reaction, remove),
    messageKey,
    messageGuid,
    reaction,
    remove,
    createdAt: new Date(now).toISOString(),
  };
}

function normalizeConfirmation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messageKey = cleanString(value.messageKey, 256);
  const messageGuid = cleanString(value.messageGuid, 256);
  const reaction = cleanString(value.reaction, 128);
  const operationId = cleanString(value.operationId, 160);
  const createdAt = isoString(value.createdAt);
  const remove = value.remove === true;
  if (!messageKey || !messageGuid || !reaction || !operationId || !createdAt) return null;
  if (operationId !== confirmationOperationId(messageKey, messageGuid, reaction, remove)) return null;
  return { operationId, messageKey, messageGuid, reaction, remove, createdAt };
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
  if (value.awaitingNewPrompt && typeof value.awaitingNewPrompt === "object" && !Array.isArray(value.awaitingNewPrompt)) {
    const flowId = cleanString(value.awaitingNewPrompt.flowId, 64);
    const selectedAt = isoString(value.awaitingNewPrompt.selectedAt);
    const expiresAt = isoString(value.awaitingNewPrompt.expiresAt);
    if (flowId && selectedAt && expiresAt) state.awaitingNewPrompt = { flowId, selectedAt, expiresAt };
  }
  state.activeNewFlowId = cleanString(value.activeNewFlowId, 64);
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
      if (expiresAt && Object.keys(options).length) {
        const metadata = normalizePollMetadata(poll);
        const addChoiceCommand = inferredAddChoiceCommand(options, metadata.addChoiceCommand);
        const refreshAction = inferredPollRefreshAction(options, { ...metadata, addChoiceCommand });
        state.polls[cleanGuid] = {
          expiresAt,
          options,
          ...(metadata.addChoiceSearch ? { addChoiceSearch: true } : {}),
          ...(addChoiceCommand ? { addChoiceCommand } : {}),
          ...(metadata.addChoiceArgument ? { addChoiceArgument: metadata.addChoiceArgument } : {}),
          ...(refreshAction ? { refreshAction } : {}),
          ...(metadata.addedChoiceAction ? { addedChoiceAction: metadata.addedChoiceAction } : {}),
          knownOptionIds: [...new Set([...Object.keys(options), ...metadata.knownOptionIds])].slice(-500),
          knownOptionLabels: metadata.knownOptionLabels,
        };
      }
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
  if (Array.isArray(value.confirmationOutbox)) {
    state.confirmationOutbox = value.confirmationOutbox
      .map(normalizeConfirmation)
      .filter(Boolean)
      .slice(-MAX_CONFIRMATIONS);
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
  const rawReplyToGuid = message?.reply_to_guid ?? message?.replyToGuid;
  const rawThreadOriginatorGuid = message?.thread_originator_guid ?? message?.threadOriginatorGuid;
  return {
    key,
    id: finiteRowId(message?.id),
    guid: cleanString(message?.guid, 256),
    text: typeof message?.text === "string" ? message.text.trim() : "",
    createdAt: cleanString(message?.created_at || message?.createdAt, 64) || new Date().toISOString(),
    replyToGuid: cleanString(rawReplyToGuid, 256),
    threadOriginatorGuid: cleanString(rawThreadOriginatorGuid, 256),
    hasThreadOriginatorGuid: typeof rawThreadOriginatorGuid === "string" && rawThreadOriginatorGuid.trim().length > 0,
    attachments: Array.isArray(message?.attachments) ? message.attachments.slice(0, 5) : [],
    poll: message?.poll && typeof message.poll === "object" ? message.poll : null,
    isReaction: message?.is_reaction === true || message?.isReaction === true,
    reactionType: cleanString(message?.reaction_type ?? message?.reactionType, 40)?.toLowerCase() || null,
    isReactionAdd: typeof (message?.is_reaction_add ?? message?.isReactionAdd) === "boolean"
      ? (message?.is_reaction_add ?? message?.isReactionAdd)
      : null,
    reactedToGuid: cleanString(message?.reacted_to_guid ?? message?.reactedToGuid, 256),
  };
}

function threadsForGuid(state, guid) {
  const cleanGuid = cleanString(guid, 256);
  if (!cleanGuid) return [];
  const matches = new Set();
  const routed = state.guidRoutes[cleanGuid];
  if (routed) matches.add(routed);
  for (const [threadId, thread] of Object.entries(state.threads)) {
    if (thread?.rootGuid === cleanGuid || thread?.latestGuid === cleanGuid) matches.add(threadId);
  }
  return [...matches];
}

function routeOriginatorGuid(state, guid, threadId) {
  const cleanGuid = cleanString(guid, 256);
  const cleanThread = cleanString(threadId, 200);
  if (!cleanGuid || !cleanThread) return false;
  const matches = threadsForGuid(state, cleanGuid);
  if (matches.some((match) => match !== cleanThread)) return false;
  return routeGuid(state, cleanGuid, cleanThread);
}

function resolveNativeReplyContext(message, state) {
  // Messages populates reply_to_guid on ordinary top-level messages with the
  // immediately preceding message. Only thread_originator_guid denotes a
  // native Reply conversation and is therefore safe to use for task routing.
  if (!message.hasThreadOriginatorGuid) return { explicit: false, threadId: null, error: null };
  const matches = threadsForGuid(state, message.threadOriginatorGuid);
  if (matches.length > 1) return { explicit: true, threadId: null, error: { kind: "ambiguous-reply-context" } };
  if (matches.length === 0) return { explicit: true, threadId: null, error: { kind: "stale-reply-context" } };
  return { explicit: true, threadId: matches[0], error: null };
}

function actionFromReaction(message, state) {
  if (!message.isReaction) return { action: null, consumed: false };
  let matches = threadsForGuid(state, message.reactedToGuid);
  if (matches.length === 0 && message.hasThreadOriginatorGuid) {
    matches = threadsForGuid(state, message.threadOriginatorGuid);
  }
  if (matches.length !== 1 || typeof message.isReactionAdd !== "boolean") {
    return { action: null, consumed: true };
  }
  const threadId = matches[0];
  if (message.reactionType === "like") {
    return {
      action: { kind: "reaction-control", command: "listen", enabled: message.isReactionAdd, threadId },
      consumed: true,
    };
  }
  if (message.reactionType === "dislike") {
    return {
      action: {
        kind: "reaction-control",
        command: message.isReactionAdd ? "mute" : "unmute",
        threadId,
      },
      consumed: true,
    };
  }
  if (message.reactionType === "question" && message.isReactionAdd) {
    return { action: { kind: "reaction-control", command: "inspect", threadId }, consumed: true };
  }
  return { action: null, consumed: true };
}

function uniquePollRegistrationForOption(state, optionId) {
  const cleanOptionId = cleanString(optionId, 256);
  if (!cleanOptionId) return null;
  const matches = Object.entries(state.polls).filter(([, registration]) => (
    registration?.options
    && Object.prototype.hasOwnProperty.call(registration.options, cleanOptionId)
  ));
  return matches.length === 1 ? matches[0][1] : null;
}

function uniquePollRegistrationForKnownOptions(state, candidates) {
  const candidateIds = new Set(candidates.map((candidate) => cleanString(candidate?.id, 256)).filter(Boolean));
  if (!candidateIds.size) return null;
  const matches = Object.values(state.polls).filter((registration) => {
    const knownIds = new Set([
      ...Object.keys(registration?.options || {}),
      ...(Array.isArray(registration?.knownOptionIds) ? registration.knownOptionIds : []),
    ]);
    return [...candidateIds].some((id) => knownIds.has(id));
  });
  return matches.length === 1 ? matches[0] : null;
}

function pollSelection(message, state, nowMs) {
  const poll = message.poll;
  if (!poll || String(poll.kind || "").toLowerCase() !== "vote") return { action: null, consumed: false };
  const originalGuid = cleanString(poll.original_guid || poll.originalGuid, 256);
  const optionId = cleanString(poll.vote?.option_id || poll.vote?.optionId, 256);
  const directRegistration = originalGuid ? state.polls[originalGuid] : null;
  // Messages assigns different local GUIDs to the same poll on its sender and
  // receiver. Native votes preserve the poll option UUID, however. When the
  // remote poll GUID is unknown, resolve that UUID only if it identifies one
  // and only one active service registration; collisions and foreign polls
  // remain consumed without side effects.
  const registration = directRegistration
    || (originalGuid && optionId ? uniquePollRegistrationForOption(state, optionId) : null);
  // Poll rows are emitted for every native poll in the conversation, not just
  // polls created by this service. An unknown poll is therefore ordinary
  // ambient Messages traffic and must not produce a stale-poll response.
  if (!registration) return { action: null, consumed: true };
  const expiresAtMs = Date.parse(registration.expiresAt);
  if (!optionId || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { action: normalizePollAction(registration.refreshAction) || { kind: "stale-poll" }, consumed: true };
  }
  return {
    action: normalizePollAction(registration.options[optionId])
      || normalizePollAction(registration.refreshAction)
      || { kind: "stale-poll" },
    consumed: true,
  };
}

function pollOptionEntries(value) {
  const entries = [];
  const append = (item, fallbackId = null) => {
    if (typeof item === "string") {
      const text = cleanString(item, 2_000);
      if (text) entries.push({ id: cleanString(fallbackId, 256), text });
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const id = cleanString(item.id ?? item.option_id ?? item.optionId ?? item.guid ?? fallbackId, 256);
    const text = cleanString(item.text ?? item.title ?? item.label ?? item.value ?? item.name, 2_000);
    if (id || text) entries.push({ id, text });
  };
  if (Array.isArray(value)) {
    for (const item of value) append(item);
  } else if (value && typeof value === "object") {
    for (const [id, item] of Object.entries(value)) append(item, id);
  }
  return entries;
}

function pollAddedChoice(message, state, nowMs) {
  const poll = message.poll;
  if (!poll || String(poll.kind || "").toLowerCase() !== "created") return { action: null, consumed: false };
  const originalGuid = cleanString(poll.original_guid || poll.originalGuid, 256);
  const candidates = [
    ...pollOptionEntries(poll.options_diff ?? poll.optionsDiff),
    ...pollOptionEntries(poll.created?.options_diff ?? poll.created?.optionsDiff),
    ...pollOptionEntries(poll.options),
    ...pollOptionEntries(poll.created?.options),
    ...pollOptionEntries(poll.option),
    ...pollOptionEntries(poll.created?.option),
  ];
  const directRegistration = originalGuid ? state.polls[originalGuid] : null;
  // Poll GUIDs are device-local. A cross-device Add Choice snapshot can still
  // be attributed safely when its stable option UUIDs identify exactly one
  // active registration. Unknown and colliding snapshots remain ambient
  // Messages traffic and are consumed without side effects.
  const registration = directRegistration
    || (originalGuid ? uniquePollRegistrationForKnownOptions(state, candidates) : null);
  // Initial snapshots for user-created polls look the same as Add Choice
  // updates. Only a durable registration proves the poll belongs to us.
  if (!registration) return { action: null, consumed: true };
  const expiresAtMs = Date.parse(registration.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { action: normalizePollAction(registration.refreshAction) || { kind: "stale-poll" }, consumed: true };
  }
  if (registration.addChoiceSearch !== true) return { action: null, consumed: true };

  const knownIds = new Set(Array.isArray(registration.knownOptionIds) ? registration.knownOptionIds : Object.keys(registration.options));
  const knownLabels = new Set(Array.isArray(registration.knownOptionLabels) ? registration.knownOptionLabels : []);
  const added = [];
  for (const candidate of candidates) {
    const normalizedLabel = candidate.text?.toLocaleLowerCase() || null;
    const isKnown = (candidate.id && knownIds.has(candidate.id)) || (normalizedLabel && knownLabels.has(normalizedLabel));
    if (!isKnown && candidate.text) added.push(candidate);
    if (candidate.id) knownIds.add(candidate.id);
    if (normalizedLabel) knownLabels.add(normalizedLabel);
  }
  registration.knownOptionIds = [...knownIds].slice(-500);
  registration.knownOptionLabels = [...knownLabels].slice(-500);
  const query = added.at(-1)?.text || null;
  const addedChoiceAction = normalizePollAction(registration.addedChoiceAction);
  return {
    action: query
      ? addedChoiceAction
        ? { ...addedChoiceAction, argument: query }
        : {
          kind: "search",
          command: registration.addChoiceCommand || "search",
          argument: query,
          ...(registration.addChoiceArgument ? { commandArgument: registration.addChoiceArgument } : {}),
        }
      : null,
    consumed: true,
  };
}

function actionFromPoll(message, state, nowMs) {
  const vote = pollSelection(message, state, nowMs);
  if (vote.consumed) return vote;
  const addedChoice = pollAddedChoice(message, state, nowMs);
  if (addedChoice.consumed) return addedChoice;
  return message.poll ? { action: null, consumed: true } : { action: null, consumed: false };
}

export class LocalConversationRouter {
  constructor({
    stateFile,
    conversationKey = null,
    now = () => Date.now(),
    menuTtlMs = DEFAULT_MENU_TTL_MS,
    commandContextTtlMs = DEFAULT_COMMAND_CONTEXT_TTL_MS,
  } = {}) {
    if (!stateFile) throw new TypeError("LocalConversationRouter requires stateFile.");
    this.stateFile = path.resolve(stateFile);
    this.now = now;
    this.menuTtlMs = menuTtlMs;
    const requestedCommandTtl = Number(commandContextTtlMs);
    this.commandContextTtlMs = Number.isFinite(requestedCommandTtl) && requestedCommandTtl >= 0
      ? requestedCommandTtl
      : DEFAULT_COMMAND_CONTEXT_TTL_MS;
    this.conversationReset = conversationNeedsReset(this.stateFile, conversationKey);
    this.state = readState(this.stateFile, conversationKey);
  }

  get activeThreadId() { return this.state.activeThreadId; }
  get mostRecentThreadId() { return this.state.mostRecentThreadId; }
  get lastUserThreadId() { return this.state.lastUserThreadId; }
  get recentDefaultThreadId() { return this.#recentCommandThreadId(); }
  get recentDefaultExpiresAt() {
    const threadId = this.#recentCommandThreadId();
    const updatedAt = Date.parse(this.state.lastUserThreadAt || "");
    return threadId && Number.isFinite(updatedAt)
      ? new Date(updatedAt + this.commandContextTtlMs).toISOString()
      : null;
  }
  get lastRowId() { return this.state.lastRowId; }
  get lastUserMessageAt() { return this.state.lastUserMessageAt; }
  get awaitingPrompt() {
    const awaiting = this.#currentAwaitingPrompt();
    return awaiting ? structuredClone(awaiting) : null;
  }
  get awaitingNewPrompt() {
    const awaiting = this.#currentAwaitingNewPrompt();
    return awaiting ? structuredClone(awaiting) : null;
  }
  get activeNewFlowId() { return cleanString(this.state.activeNewFlowId, 64); }
  get incomingPaused() { return Boolean(this.#currentAwaitingPrompt() || this.#currentAwaitingNewPrompt()); }

  #currentAwaitingPrompt() {
    const awaiting = this.state.awaitingPrompt;
    if (!awaiting) return null;
    if (Date.parse(awaiting.expiresAt || "") > this.now()) return awaiting;
    this.state.awaitingPrompt = null;
    writeState(this.stateFile, this.state);
    return null;
  }

  #currentAwaitingNewPrompt() {
    const awaiting = this.state.awaitingNewPrompt;
    if (!awaiting) return null;
    if (Date.parse(awaiting.expiresAt || "") > this.now()) return awaiting;
    this.state.awaitingNewPrompt = null;
    writeState(this.stateFile, this.state);
    return null;
  }

  #recentCommandThreadId(nowMs = this.now()) {
    const threadId = cleanString(this.state.lastUserThreadId, 200);
    const updatedAt = Date.parse(this.state.lastUserThreadAt || "");
    if (!threadId || !Number.isFinite(updatedAt)) return null;
    return nowMs - updatedAt <= this.commandContextTtlMs ? threadId : null;
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

  setDefaultThread(threadId, updatedAt = new Date(this.now()).toISOString()) {
    const cleanThread = cleanString(threadId, 200);
    const cleanAt = isoString(updatedAt, new Date(this.now()).toISOString());
    if (!cleanThread) return false;
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

  setAwaitingNewPrompt(flowId, selectedAt = new Date(this.now()).toISOString(), ttlMs = DEFAULT_AWAITING_PROMPT_TTL_MS) {
    const cleanFlow = cleanString(flowId, 64);
    const cleanAt = isoString(selectedAt, new Date(this.now()).toISOString());
    if (!cleanFlow) return false;
    this.state.awaitingNewPrompt = {
      flowId: cleanFlow,
      selectedAt: cleanAt,
      expiresAt: new Date(this.now() + Math.max(1_000, Number(ttlMs) || DEFAULT_AWAITING_PROMPT_TTL_MS)).toISOString(),
    };
    writeState(this.stateFile, this.state);
    return true;
  }

  clearAwaitingNewPrompt(flowId = null) {
    if (!this.#currentAwaitingNewPrompt()) return false;
    const cleanFlow = cleanString(flowId, 64);
    if (cleanFlow && this.state.awaitingNewPrompt.flowId !== cleanFlow) return false;
    this.state.awaitingNewPrompt = null;
    writeState(this.stateFile, this.state);
    return true;
  }

  setActiveNewFlow(flowId) {
    const cleanFlow = cleanString(flowId, 64);
    if (!cleanFlow) return false;
    this.state.activeNewFlowId = cleanFlow;
    writeState(this.stateFile, this.state);
    return true;
  }

  clearActiveNewFlow(flowId = null) {
    const active = cleanString(this.state.activeNewFlowId, 64);
    const cleanFlow = cleanString(flowId, 64);
    if (!active || (cleanFlow && cleanFlow !== active)) return false;
    this.state.activeNewFlowId = null;
    writeState(this.stateFile, this.state);
    return true;
  }

  shouldPauseIncoming(threadId = null) {
    if (this.#currentAwaitingNewPrompt()) return true;
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
    const originatorRouted = originator
      ? routeOriginatorGuid(this.state, originator, cleanThread)
      : false;
    const current = threadState(this.state, cleanThread);
    const rootGuid = !current?.rootGuid && originatorRouted ? originator : null;
    const item = touchThreadState(this.state, cleanThread, options.createdAt || new Date(this.now()).toISOString(), {
      rootGuid,
      latestGuid: cleanGuid,
    });
    writeState(this.stateFile, this.state);
    return structuredClone(item);
  }

  registerPoll(guid, options, ttlOrMetadata = this.menuTtlMs) {
    const cleanGuid = cleanString(guid, 256);
    if (!cleanGuid || !options || typeof options !== "object") return;
    const cleanOptions = Object.fromEntries(Object.entries(options).flatMap(([id, action]) => {
      const cleanId = cleanString(id, 256);
      const cleanActionValue = normalizePollAction(action);
      return cleanId && cleanActionValue ? [[cleanId, cleanActionValue]] : [];
    }));
    if (!Object.keys(cleanOptions).length) return;
    const metadata = normalizePollMetadata(
      ttlOrMetadata && typeof ttlOrMetadata === "object" && !Array.isArray(ttlOrMetadata)
        ? ttlOrMetadata
        : {},
    );
    const configuredTtlMs = ttlOrMetadata && typeof ttlOrMetadata === "object" && !Array.isArray(ttlOrMetadata)
      ? Number(ttlOrMetadata.ttlMs)
      : Number(ttlOrMetadata);
    const addChoiceCommand = inferredAddChoiceCommand(cleanOptions, metadata.addChoiceCommand);
    const refreshAction = inferredPollRefreshAction(cleanOptions, { ...metadata, addChoiceCommand });
    this.state.polls[cleanGuid] = {
      expiresAt: new Date(this.now() + Math.max(1_000, configuredTtlMs || this.menuTtlMs)).toISOString(),
      options: cleanOptions,
      ...(metadata.addChoiceSearch ? { addChoiceSearch: true } : {}),
      ...(addChoiceCommand ? { addChoiceCommand } : {}),
      ...(metadata.addChoiceArgument ? { addChoiceArgument: metadata.addChoiceArgument } : {}),
      ...(refreshAction ? { refreshAction } : {}),
      ...(metadata.addedChoiceAction ? { addedChoiceAction: metadata.addedChoiceAction } : {}),
      knownOptionIds: [...new Set([...Object.keys(cleanOptions), ...metadata.knownOptionIds])].slice(-500),
      knownOptionLabels: metadata.knownOptionLabels,
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
  pendingConfirmations() { return this.state.confirmationOutbox.map((item) => structuredClone(item)); }

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
    if (!message) return null;
    const existing = this.state.pending.find((item) => item.messageKey === message.key);
    if (existing) return structuredClone(existing);
    if (this.state.seen.includes(message.key)) return null;

    const nowMs = this.now();
    const replyContext = resolveNativeReplyContext(message, this.state);
    const explicitThreadId = replyContext.threadId;
    const awaitingPrompt = this.#currentAwaitingPrompt();
    const awaitingNewPrompt = this.#currentAwaitingNewPrompt();
    let targetThreadId = explicitThreadId || this.state.lastUserThreadId;
    const reactionResult = actionFromReaction(message, this.state);
    if (reactionResult.consumed && !reactionResult.action) {
      this.#discard(rawMessage);
      return null;
    }
    const pollResult = reactionResult.consumed
      ? { action: null, consumed: false }
      : actionFromPoll(message, this.state, nowMs);
    if (pollResult.consumed && !pollResult.action) {
      // Poll rows can carry a visible question/caption in `text`; never let
      // that transport metadata fall through and become a Codex prompt.
      this.#discard(rawMessage);
      return null;
    }
    // Poll registrations are the authoritative context for poll events. This
    // also prevents a foreign poll's native reply metadata from being treated
    // as a stale task reply before the poll can be silently discarded.
    let action = reactionResult.consumed
      ? reactionResult.action
      : pollResult.consumed
        ? pollResult.action
        : replyContext.error;
    const slash = message.text ? parseSlashCommand(message.text) : null;
    const selection = message.text ? parseMenuSelection(message.text) : null;
    const menuValid = this.state.menu && Date.parse(this.state.menu.expiresAt) > nowMs;
    let consumedAwaitingPrompt = false;

    if (!action && slash) {
      const command = slash.command === "recent" ? "threads" : slash.command;
      if (THREAD_COMMANDS.has(command) && !explicitThreadId) {
        if (command === "cancel" && (awaitingNewPrompt?.flowId || this.state.activeNewFlowId)) {
          action = { kind: "new-cancel", flowId: awaitingNewPrompt?.flowId || this.state.activeNewFlowId };
        } else if (command === "cancel" && awaitingPrompt?.threadId) {
          targetThreadId = awaitingPrompt.threadId;
          consumedAwaitingPrompt = true;
          action = { kind: "control", command, argument: slash.argument, threadId: targetThreadId };
        } else if (this.#recentCommandThreadId(nowMs)) {
          targetThreadId = this.#recentCommandThreadId(nowMs);
          action = { kind: "control", command, argument: slash.argument, threadId: targetThreadId };
        } else {
          action = { kind: "thread-picker", command, argument: slash.argument };
        }
      } else {
        const globalCommand = command === "help"
          || command === "new"
          || command === "defaultreasoning"
          || command === "projects"
          || command === "search"
          || command === "threads"
          || command === "refresh";
        action = globalCommand
          ? {
            kind: command,
            command,
            argument: slash.argument,
            ...(command === "new" && message.attachments.length ? { attachments: message.attachments } : {}),
          }
          : { kind: "control", command, threadId: targetThreadId, argument: slash.argument };
      }
    } else if (!action && selection && this.state.menu && !explicitThreadId) {
      const reference = menuValid ? this.state.menu.references[selection.index] : null;
      if (!reference) action = { kind: "stale-menu", threadId: targetThreadId };
      else if (reference.startsWith("project:")) action = { kind: "project", projectKey: reference.slice("project:".length) };
      else action = { kind: "switch", threadId: reference.slice("thread:".length), prompt: selection.prompt };
    } else if (!action && message.text.startsWith("/")) {
      action = { kind: "unknown-command", threadId: targetThreadId };
    } else if (!action && (message.text || message.attachments.length)) {
      if (!explicitThreadId && awaitingNewPrompt?.flowId) {
        action = {
          kind: "new-prompt",
          flowId: awaitingNewPrompt.flowId,
          body: message.text,
          attachments: message.attachments,
        };
        this.state.awaitingNewPrompt = null;
      } else if (!explicitThreadId && awaitingPrompt?.threadId) {
        targetThreadId = awaitingPrompt.threadId;
        consumedAwaitingPrompt = true;
      }
      if (!action) {
        action = targetThreadId
          ? { kind: "prompt", threadId: targetThreadId, body: message.text, attachments: message.attachments }
          : { kind: "no-thread" };
      }
    }
    if (!action) {
      if (pollResult.consumed) this.#discard(rawMessage);
      return null;
    }

    if (action.kind === "prompt" && explicitThreadId && awaitingPrompt?.threadId === explicitThreadId) {
      consumedAwaitingPrompt = true;
    }

    if (action.kind === "new-cancel") {
      this.state.awaitingNewPrompt = null;
      this.state.activeNewFlowId = null;
    } else if (action.kind === "switch" && action.threadId) {
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
        && !message.isReaction
        && (action.kind !== "switch" || Boolean(action.prompt) || Boolean(explicitThreadId));
      if (shouldRouteMessage && message.guid) {
        routeGuid(this.state, message.guid, action.threadId);
        const originatorRouted = message.threadOriginatorGuid
          ? routeOriginatorGuid(this.state, message.threadOriginatorGuid, action.threadId)
          : false;
        const current = threadState(this.state, action.threadId);
        touchThreadState(this.state, action.threadId, message.createdAt, {
          rootGuid: !current?.rootGuid && originatorRouted ? message.threadOriginatorGuid : null,
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

  acknowledgeWithConfirmation(messageKeyValue, confirmation = null, settlement = null) {
    const key = cleanString(messageKeyValue, 256);
    if (!key) return false;
    const before = this.state.pending.length;
    if (!this.state.pending.some((item) => item.messageKey === key)) return false;
    const priorState = structuredClone(this.state);
    try {
      this.state.pending = this.state.pending.filter((item) => item.messageKey !== key);
      if (before === this.state.pending.length) return false;
      this.state.seen.push(key);
      this.state.seen = [...new Set(this.state.seen)].slice(-MAX_SEEN);
      const queued = newConfirmation(key, confirmation, this.now());
      if (queued) {
        this.state.confirmationOutbox = [
          ...this.state.confirmationOutbox.filter((item) => item.operationId !== queued.operationId),
          queued,
        ].slice(-MAX_CONFIRMATIONS);
      }
      const completedFlowId = cleanString(settlement?.newThreadCompletion?.flowId, 64);
      const completedThreadId = cleanString(settlement?.newThreadCompletion?.threadId, 200);
      if (completedFlowId && completedThreadId) {
        if (this.state.awaitingNewPrompt?.flowId === completedFlowId) this.state.awaitingNewPrompt = null;
        if (this.state.activeNewFlowId === completedFlowId) this.state.activeNewFlowId = null;
        const completedAt = isoString(
          settlement?.newThreadCompletion?.updatedAt,
          new Date(this.now()).toISOString(),
        );
        this.state.lastUserThreadId = completedThreadId;
        this.state.lastUserThreadAt = completedAt;
        touchThreadState(this.state, completedThreadId, completedAt);
      }
      writeState(this.stateFile, this.state);
      return true;
    } catch (error) {
      this.state = priorState;
      throw error;
    }
  }

  acknowledge(messageKeyValue) {
    return this.acknowledgeWithConfirmation(messageKeyValue);
  }

  completeConfirmation(operationIdValue) {
    const operationId = cleanString(operationIdValue, 160);
    if (!operationId) return false;
    const before = this.state.confirmationOutbox.length;
    if (!this.state.confirmationOutbox.some((item) => item.operationId === operationId)) return false;
    const priorState = structuredClone(this.state);
    try {
      this.state.confirmationOutbox = this.state.confirmationOutbox
        .filter((item) => item.operationId !== operationId);
      if (before === this.state.confirmationOutbox.length) return false;
      writeState(this.stateFile, this.state);
      return true;
    } catch (error) {
      this.state = priorState;
      throw error;
    }
  }
}
