import path from "node:path";
import { createHash } from "node:crypto";
import { REQUIRED_PINNED_IMSG_CAPABILITIES } from "./imsg-client.mjs";
import { createImsgIpcClientFromConfig } from "./imsg-ipc-client.mjs";
import { safeImsgFailureDetails } from "./imsg-rpc-diagnostics.mjs";
import { LocalConversationRouter } from "./local-conversation-router.mjs";
import { renderRichOutboundIntents, richTextIntent } from "../../protocol/rich-presentation.ts";
import {
  projectIdentityEmoji,
  relativeTime,
  renderThreadHeader,
  statusGlyph,
  threadIdentityEmoji,
} from "../../protocol/presentation.ts";

const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Apple's Polls extension duplicates each option label in its JSON payload and
// rejects definitions larger than 4 KiB. Seven compact menu rows fit beneath
// that limit in the deployed bridge while keeping multi-part directories
// balanced; the native UI's nominal option count is not the real limit.
const MAX_POLL_OPTIONS = 7;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_DEFINITION_BYTES = 4096;
const POLL_PAYLOAD_SAFETY_BYTES = 32;
// Apple's poll JSON repeats the active sender on the item and every option.
// An iMessage phone/email handle is bounded well below this reserve, so model
// that hidden bridge field while keeping the identity itself out of the
// controller process.
const POLL_CREATOR_HANDLE_RESERVE_BYTES = 300;
const MAX_POLL_QUESTION_BYTES = 256;
const POLL_OPTION_IDENTIFIER = "00000000-0000-0000-0000-000000000000";
// Stay comfortably below imsg's 128 KiB per-text-field boundary so native
// formatting and JSON framing never turn a valid transcript into a retry loop.
const MAX_TEXT_BUBBLE_BYTES = 96 * 1024;
const MULTIPART_PREFIX_RESERVE_BYTES = 32;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function eventId(event) {
  if (event?.kind === "thread.completed" && event.completionId) return `completion:${event.completionId}`;
  if (event?.kind === "thread.live-message" && event.messageId) return `live:${event.messageId}`;
  if (event?.kind === "thread.detail" && event.deliveryId) return `detail:${event.deliveryId}`;
  if (event?.kind && event?.deliveryId) return `${event.kind}:${event.deliveryId}`;
  return null;
}

function outboundOperationId(chatGuid, scope) {
  const value = clean(scope);
  if (!value) return null;
  const digest = createHash("sha256")
    .update(`imsg-outbound-v1:${clean(chatGuid)}:${value}`)
    .digest("hex");
  return `outbound:${digest}`;
}

function target(profile) {
  return { chat_id: Number(profile.chatId) };
}

function nativeFormatting(ranges) {
  const grouped = new Map();
  for (const range of ranges || []) {
    const start = Number(range.location);
    const length = Number(range.length);
    const style = clean(range.style);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || !style) continue;
    const key = `${start}:${length}`;
    const entry = grouped.get(key) || { start, length, styles: [] };
    if (!entry.styles.includes(style)) entry.styles.push(style);
    grouped.set(key, entry);
  }
  return [...grouped.values()].sort((left, right) => left.start - right.start || left.length - right.length);
}

function maxUtf8ChunkEnd(text, start, byteBudget) {
  let end = start;
  let bytes = 0;
  for (const character of text.slice(start)) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > byteBudget) break;
    bytes += nextBytes;
    end += character.length;
  }
  if (end >= text.length || end <= start) return end;

  // Prefer a readable boundary, but never shrink a part below half of the
  // payload that already fits. This keeps pathological long lines bounded.
  const earliest = start + Math.floor((end - start) / 2);
  for (const separator of ["\n\n", "\n", " "]) {
    const boundary = text.lastIndexOf(separator, end - 1);
    if (boundary >= earliest) return boundary + separator.length;
  }
  return end;
}

function splitTextIntent(intent, maxBytes = MAX_TEXT_BUBBLE_BYTES) {
  if (intent?.kind !== "text" || Buffer.byteLength(intent.text, "utf8") <= maxBytes) return [intent];
  const contentBudget = Math.max(1, maxBytes - MULTIPART_PREFIX_RESERVE_BYTES);
  const slices = [];
  for (let start = 0; start < intent.text.length;) {
    const end = maxUtf8ChunkEnd(intent.text, start, contentBudget);
    if (end <= start) throw new TypeError("A Messages text part could not be bounded safely.");
    slices.push({ start, end });
    start = end;
  }
  return slices.map(({ start, end }, index) => {
    const prefix = `(${index + 1}/${slices.length})\n\n`;
    const ranges = (intent.ranges || []).flatMap((range) => {
      const rangeStart = Number(range.location);
      const rangeEnd = rangeStart + Number(range.length);
      const intersectionStart = Math.max(start, rangeStart);
      const intersectionEnd = Math.min(end, rangeEnd);
      return intersectionEnd > intersectionStart
        ? [{
          location: prefix.length + intersectionStart - start,
          length: intersectionEnd - intersectionStart,
          style: range.style,
        }]
        : [];
    });
    const text = `${prefix}${intent.text.slice(start, end)}`;
    return { kind: "text", text, fallbackText: text, ranges };
  });
}

function messageGuid(result) {
  return clean(result?.guid || result?.message_guid || result?.messageGuid);
}

function resultStatus(result) {
  if (result?.classification === "accepted") return { sent: true, status: "SENT", terminal: true, guid: messageGuid(result) || null };
  if (result?.classification === "ambiguous") {
    return {
      sent: false,
      status: "AMBIGUOUS",
      terminal: false,
      ...safeImsgFailureDetails(result),
    };
  }
  return { sent: false, status: "UNSUPPORTED", terminal: false };
}

function taskHeader(thread, now = Date.now()) {
  return clean(thread?.id) ? renderThreadHeader(thread, now) : "";
}

function balancedPollChunks(items, count) {
  const base = Math.floor(items.length / count);
  const remainder = items.length % count;
  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks.every((chunk) => chunk.length >= MIN_POLL_OPTIONS && chunk.length <= MAX_POLL_OPTIONS) ? chunks : [];
}

function truncateUtf8(value, maxBytes, suffix = "…") {
  const text = String(value || "").toWellFormed();
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const ending = Buffer.byteLength(suffix, "utf8") <= limit ? suffix : "";
  const contentLimit = limit - Buffer.byteLength(ending, "utf8");
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > contentLimit) break;
    result += character;
    bytes += size;
  }
  return `${result.trimEnd()}${ending}`;
}

function pollDefinitionPayloadBytes(question, choices, creatorHandleBytes = POLL_CREATOR_HANDLE_RESERVE_BYTES) {
  const creatorHandle = "x".repeat(Math.max(0, Number(creatorHandleBytes) || 0));
  const labels = (choices || []).map((choice) => clean(choice?.label ?? choice).toWellFormed());
  const root = {
    item: {
      title: clean(question).toWellFormed(),
      orderedPollOptions: labels.map((label) => ({
        canBeEdited: false,
        attributedText: label,
        text: label,
        optionIdentifier: POLL_OPTION_IDENTIFIER,
        creatorHandle,
      })),
      creatorHandle,
    },
    version: 1,
  };
  return Buffer.byteLength(JSON.stringify(root), "utf8");
}

function multipartPollQuestion(question, index, count) {
  const base = clean(question).toWellFormed() || "Choose";
  if (count <= 1) return truncateUtf8(base, MAX_POLL_QUESTION_BYTES);
  const suffix = ` · ${index + 1}/${count}`;
  return `${truncateUtf8(base, MAX_POLL_QUESTION_BYTES - Buffer.byteLength(suffix, "utf8"), "")}${suffix}`;
}

function fitPollChunk(question, choices) {
  const limit = MAX_POLL_DEFINITION_BYTES - POLL_PAYLOAD_SAFETY_BYTES;
  const normalized = choices.map((choice) => ({
    ...choice,
    label: clean(choice?.label).toWellFormed() || "Task",
  }));
  if (pollDefinitionPayloadBytes(question, normalized) <= limit) return normalized;

  let low = 1;
  let high = Math.max(...normalized.map((choice) => Buffer.byteLength(choice.label, "utf8")));
  let fitted = null;
  while (low <= high) {
    const budget = Math.floor((low + high) / 2);
    const candidate = normalized.map((choice) => ({
      ...choice,
      label: truncateUtf8(choice.label, budget),
    }));
    if (candidate.every((choice) => choice.label)
      && pollDefinitionPayloadBytes(question, candidate) <= limit) {
      fitted = candidate;
      low = budget + 1;
    } else {
      high = budget - 1;
    }
  }
  return fitted || [];
}

function pollPlan(question, items) {
  if (!Array.isArray(items) || items.length < MIN_POLL_OPTIONS) return { questions: [], chunks: [] };
  const minimumCount = Math.ceil(items.length / MAX_POLL_OPTIONS);
  const maximumCount = Math.max(minimumCount, Math.floor(items.length / MIN_POLL_OPTIONS));
  for (let count = minimumCount; count <= maximumCount; count += 1) {
    const chunks = balancedPollChunks(items, count);
    if (!chunks.length) continue;
    const questions = chunks.map((_chunk, index) => multipartPollQuestion(question, index, count));
    if (chunks.every((chunk, index) => pollDefinitionPayloadBytes(questions[index], chunk)
      <= MAX_POLL_DEFINITION_BYTES - POLL_PAYLOAD_SAFETY_BYTES)) {
      return { questions, chunks };
    }
  }

  const chunks = balancedPollChunks(items, maximumCount);
  const questions = chunks.map((_chunk, index) => multipartPollQuestion(question, index, maximumCount));
  const fitted = chunks.map((chunk, index) => fitPollChunk(questions[index], chunk));
  return fitted.every((chunk) => chunk.length >= MIN_POLL_OPTIONS)
    ? { questions, chunks: fitted }
    : { questions: [], chunks: [] };
}

function pollChunks(items, question = "Choose") {
  return pollPlan(question, items).chunks;
}

function graphemeSegments(value) {
  const text = String(value || "");
  if (typeof Intl?.Segmenter === "function") {
    try {
      return Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
        (entry) => entry.segment,
      );
    } catch {}
  }
  return [...text];
}

function compact(value, limit = 72) {
  const text = clean(value).replace(/\s+/g, " ").toWellFormed();
  const characters = graphemeSegments(text);
  return characters.length <= limit
    ? text
    : `${characters.slice(0, Math.max(1, limit - 1)).join("").trimEnd()}…`;
}

function taskChoice(thread, action = null, now = Date.now()) {
  const id = clean(thread?.id);
  if (!id) return null;
  const status = clean(thread?.status).toLowerCase();
  const normalizedStatus = status === "running" ? "working" : status === "queued" ? "pending" : status;
  const glyph = normalizedStatus === "working"
    ? "◷"
    : normalizedStatus === "pending"
      ? "◶"
      : normalizedStatus === "error" || normalizedStatus === "failed"
        ? "▲"
        : "○";
  const title = compact(clean(thread?.title) || "Untitled task", 52);
  const project = compact(thread?.projectLabel || (thread?.groupKind === "other" ? "Other tasks" : "Codex"), 34);
  const idleRecency = glyph === "○"
    ? relativeTime(thread?.activityAt || thread?.stateSince, now)
    : "";
  return {
    label: compact(`${glyph} ${threadIdentityEmoji(thread)} ${title} · ${project}${idleRecency ? ` · ${idleRecency}` : ""}`, 110),
    action: action || { kind: "switch", threadId: id, awaitingPrompt: true },
  };
}

function projectChoice(project, now = Date.now()) {
  const projectKey = clean(project?.projectKey);
  if (!projectKey) return null;
  const projectLabel = clean(project?.projectLabel || project?.title) || "Project";
  const threads = Array.isArray(project?.threads) ? project.threads : [];
  const status = clean(project?.status).toLowerCase();
  const latestAt = project?.activityAt || threads.map((thread) => thread?.activityAt || thread?.stateSince)
    .filter(Boolean).sort().at(-1);
  const context = latestAt ? relativeTime(latestAt, now) : "";
  return {
    label: compact(`${statusGlyph(status)} ${projectIdentityEmoji(project)} ${projectLabel}${context ? ` · ${context}` : ""}`, 160),
    action: { kind: "project", projectKey },
  };
}

function navigationChoice(label, action) {
  return {
    label: `${projectIdentityEmoji({ projectLabel: label })} ${label}`,
    action,
  };
}

function directoryChoices(event, now = Date.now()) {
  if (event?.kind !== "service.directory") return { question: null, choices: [] };
  const groups = event.directory?.groups || [];
  const threads = groups
    .flatMap((group) => (group.threads || []).map((thread) => ({
      ...thread,
      projectLabel: group.projectLabel || "Other tasks",
    })))
    .filter((thread) => thread?.id)
    .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
    .map((thread) => taskChoice(thread, null, now))
    .filter(Boolean);
  const choices = [...threads, navigationChoice("Projects", { kind: "projects" })];
  if (choices.length < MIN_POLL_OPTIONS) choices.unshift(navigationChoice("Refresh", { kind: "refresh" }));
  return {
    question: "Recent tasks",
    choices,
  };
}

function menuChoices(event, now = Date.now()) {
  if (event?.kind !== "service.menu" || !["PROJECTS", "THREADS"].includes(event.label)) {
    return { question: null, choices: [] };
  }
  const items = event.items || [];
  const choices = event.label === "PROJECTS"
    ? [...items.map((item) => projectChoice(item, now)).filter(Boolean), navigationChoice("Recent tasks", { kind: "threads" })]
    : [...items.map((item) => taskChoice(item, null, now)).filter(Boolean), navigationChoice("Projects", { kind: "projects" })];
  if (choices.length < MIN_POLL_OPTIONS) choices.unshift(navigationChoice("Refresh", { kind: "refresh" }));
  return { question: event.label === "PROJECTS" ? "Projects" : "Tasks", choices };
}

function exactURL(value) {
  const text = clean(value);
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : null;
}

function pollOptionMap(result, commands) {
  const options = Array.isArray(result?.poll?.options) ? result.poll.options : [];
  const mapping = {};
  for (let index = 0; index < Math.min(options.length, commands.length); index += 1) {
    const id = clean(options[index]?.id || options[index]?.option_id || options[index]?.optionId);
    if (id) mapping[id] = commands[index];
  }
  return mapping;
}

function pollOptionLabels(result) {
  const mapping = {};
  for (const option of Array.isArray(result?.poll?.options) ? result.poll.options : []) {
    const id = clean(option?.id || option?.option_id || option?.optionId);
    const label = clean(option?.text || option?.label || option?.title || option?.value);
    if (id && label) mapping[id] = label;
  }
  return mapping;
}

export class ImsgTransport {
  constructor({
    profile,
    stateFile,
    client,
    now = () => Date.now(),
    logger = null,
    watchRetryBaseMs = 500,
    watchRetryMaxMs = 30_000,
    commandContextTtlMs,
    onHealthChange = null,
  } = {}) {
    if (!profile || !Number.isSafeInteger(Number(profile.chatId)) || Number(profile.chatId) <= 0 || !clean(profile.chatGuid)) {
      throw new TypeError("ImsgTransport requires an explicit Messages chat.");
    }
    if (!stateFile) throw new TypeError("ImsgTransport requires a private state file.");
    this.profile = { ...profile, chatId: Number(profile.chatId), chatGuid: clean(profile.chatGuid) };
    this.mode = clean(profile.mode);
    if (this.mode !== "helper") {
      throw new TypeError("ImsgTransport supports only the authenticated advanced Messages helper.");
    }
    if (profile.featureMode !== "bridge"
      || profile.presentation !== "rich"
      || profile.polls !== true
      || profile.reactions !== true) {
      throw new TypeError("ImsgTransport requires advanced bridge mode with rich presentation.");
    }
    this.profile.featureMode = "bridge";
    this.profile.presentation = "rich";
    this.profile.polls = true;
    this.client = client || createImsgIpcClientFromConfig(profile.clientConfig);
    const conversationKey = createHash("sha256").update(`imsg-chat:${this.profile.chatGuid}`).digest("hex");
    this.router = new LocalConversationRouter({
      stateFile: path.resolve(stateFile),
      conversationKey,
      now,
      commandContextTtlMs,
    });
    this.now = now;
    this.logger = logger;
    this.capabilityStatus = null;
    this.verifiedHelperStatus = null;
    this.subscription = null;
    this.activeThread = null;
    this.typing = false;
    this.typingClearConfirmed = true;
    this.typingCleanupPromise = null;
    this.typingExpiryTimer = null;
    this.confirmationFlushPromise = null;
    this.typingThreads = new Set();
    this.readObservation = null;
    this.sendQueue = Promise.resolve();
    this.watchCallbacks = null;
    this.watchSubscribePromise = null;
    this.startPromise = null;
    this.watchRetryTimer = null;
    this.watchRetryMs = Math.max(10, Number(watchRetryBaseMs) || 500);
    this.watchRetryBaseMs = this.watchRetryMs;
    this.watchRetryMaxMs = Math.max(this.watchRetryBaseMs, Number(watchRetryMaxMs) || 30_000);
    this.watchGeneration = 0;
    this.lifecycleGeneration = 0;
    this.watchHealthy = false;
    this.recoveryPromise = null;
    this.healthCallback = typeof onHealthChange === "function" ? onHealthChange : null;
    this.stopped = true;
  }

  get activeThreadId() { return this.router.activeThreadId; }
  get lastRowId() { return this.router.lastRowId; }

  healthStatus() {
    const healthy = !this.stopped && this.watchHealthy && Boolean(this.subscription);
    return {
      healthy,
      activeWatch: healthy,
      recovering: Boolean(this.recoveryPromise || this.watchRetryTimer),
      mode: this.mode,
      readObservation: this.readObservation ? { ...this.readObservation } : null,
    };
  }

  isHealthy() { return this.healthStatus().healthy; }

  setHealthCallback(callback) {
    this.healthCallback = typeof callback === "function" ? callback : null;
    return this;
  }

  _setWatchHealth(healthy, { notify = true } = {}) {
    const next = healthy === true;
    if (this.watchHealthy === next) return;
    this.watchHealthy = next;
    if (notify) {
      try { this.healthCallback?.(this.healthStatus()); } catch {}
    }
  }

  async helperStatus() {
    if (this.mode !== "helper") throw new TypeError("Helper status is available only in helper mode.");
    if (this.verifiedHelperStatus) return this.verifiedHelperStatus;
    const status = await this.client.helperStatus();
    const actual = status?.profile;
    const settings = status?.settings;
    const expected = {
      chatId: this.profile.chatId,
      chatGuid: this.profile.chatGuid,
      expectedSender: clean(this.profile.expectedSender),
      featureMode: "bridge",
      presentation: "rich",
      polls: true,
      reactions: true,
    };
    const exact = status?.authenticated === true
      && actual?.chatId === expected.chatId
      && actual?.chatGuid === expected.chatGuid
      && actual?.expectedSender === expected.expectedSender
      && settings?.featureMode === expected.featureMode
      && settings?.presentation === expected.presentation
      && settings?.polls === expected.polls
      && settings?.reactions === expected.reactions;
    if (!exact) {
      throw Object.assign(
        new Error("The authenticated Messages helper profile does not match the configured transport."),
        { code: "IMSG_HELPER_PROFILE_MISMATCH" },
      );
    }
    this.verifiedHelperStatus = status;
    return status;
  }

  async importInboundAttachments(attachments, options = {}) {
    await this.helperStatus();
    return this.client.importAttachments(attachments, options);
  }

  async probe({ refresh = false } = {}) {
    await this.helperStatus();
    const status = await this.client.status({ refresh });
    const capabilities = status?.capabilities || {};
    if (!status?.available || status?.advanced !== true
      || REQUIRED_PINNED_IMSG_CAPABILITIES.some((name) => capabilities[name] !== true)) {
      throw Object.assign(
        new Error("The authenticated advanced Messages bridge is unavailable or incomplete."),
        { code: "IMSG_ADVANCED_REQUIRED" },
      );
    }
    this.capabilityStatus = status;
    return status;
  }

  richCapabilities() {
    const available = this.capabilityStatus?.advanced === true;
    return {
      richText: available && this.capabilityStatus?.capabilities?.richText === true,
      effects: available && this.capabilityStatus?.capabilities?.effects === true,
      urlPreviews: available && this.capabilityStatus?.capabilities?.urlPreviews === true,
      polls: available && this.capabilityStatus?.capabilities?.polls === true,
      pollCaptionControl: available && this.capabilityStatus?.capabilities?.pollCaptionControl === true,
      replies: available && this.capabilityStatus?.capabilities?.replies === true,
      typing: available && this.capabilityStatus?.capabilities?.typing === true,
      readReceipts: available && this.capabilityStatus?.capabilities?.readReceipts === true,
      tapbacks: available && this.capabilityStatus?.capabilities?.tapbacks === true,
      customEmojiTapbacks: available && this.capabilityStatus?.capabilities?.customEmojiTapbacks === true,
      attachments: available && this.capabilityStatus?.capabilities?.attachments === true,
      sendStatus: this.capabilityStatus?.capabilities?.sendStatus === true,
      edits: available && this.capabilityStatus?.capabilities?.edits === true,
      unsend: available && this.capabilityStatus?.capabilities?.unsend === true,
    };
  }

  async start({ onAction, onError } = {}) {
    if (this.startPromise) return this.startPromise;
    const attempt = this._start({ onAction, onError });
    this.startPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = null;
    }
  }

  async _start({ onAction, onError } = {}) {
    if (!this.stopped) {
      if (!this.watchHealthy) await this._recoverWatch();
      else {
        await this._subscribeWatch();
        await this._flushConfirmationOutboxAfterReconnect();
        await this._observePendingInbound();
      }
      return this;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    await this.helperStatus();
    await this.probe({ refresh: true });
    if (this.router.conversationReset) {
      const latestMessage = await this.client.latestMessage(target(this.profile));
      this.router.initializeConversation(latestMessage);
    }
    await this.client.start();
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      await this.client.stop();
      return this;
    }
    this.stopped = false;
    this.watchCallbacks = { onAction, onError };
    await this._subscribeWatch();
    await this._flushConfirmationOutboxAfterReconnect();
    await this._observePendingInbound();
    return this;
  }

  _watchParams() {
    return {
      ...target(this.profile),
      ...(this.router.lastRowId ? { since_rowid: this.router.lastRowId } : {}),
      attachments: true,
      include_reactions: this.profile.reactions !== false,
      debounce_ms: 500,
    };
  }

  async _subscribeWatch() {
    if (this.stopped) return false;
    if (this.subscription) return true;
    if (this.watchSubscribePromise) return this.watchSubscribePromise;
    const attempt = this._subscribeWatchAttempt();
    this.watchSubscribePromise = attempt;
    try {
      return await attempt;
    } finally {
      if (this.watchSubscribePromise === attempt) this.watchSubscribePromise = null;
    }
  }

  async _subscribeWatchAttempt() {
    if (this.stopped) return false;
    const generation = ++this.watchGeneration;
    const watch = await this.client.subscribeWatch(this._watchParams(), {
      onMessage: (message) => {
        if (this.stopped || generation !== this.watchGeneration) return;
        try {
          const hasChatId = message.chat_id !== undefined && message.chat_id !== null;
          const hasChatGuid = Boolean(clean(message.chat_guid));
          if (!hasChatId && !hasChatGuid) return;
          if (hasChatId && Number(message.chat_id) !== this.profile.chatId) return;
          if (hasChatGuid && clean(message.chat_guid) !== this.profile.chatGuid) return;
          if (message.is_from_me === true) {
            this.router.discard(message);
            return;
          }
          if (this.profile.expectedSender && clean(message.sender) !== clean(this.profile.expectedSender)) {
            this.router.discard(message);
            return;
          }
          if (this.router.consumeOutboundEcho(message)) return;
          const action = this.router.ingest(message);
          // A receipt is visible to the sender, so emit it only after the inbox
          // cursor/action has been committed. Ignored reactions and poll rows
          // also reach this point after their durable discard.
          this.observeInbound().catch(() => {});
          if (action) {
            Promise.resolve(this.watchCallbacks?.onAction?.(action, message))
              .catch((error) => this._handleWatchError(error, generation));
          }
        } catch (error) {
          // Persistence failures must invalidate the watch. LocalConversationRouter
          // rolls its in-memory cursor back, so resubscription starts at the last
          // committed row without logging any inbound content or handles.
          this._handleWatchError(error, generation);
        }
      },
      onError: (error) => this._handleWatchError(error, generation),
    });
    if (this.stopped || generation !== this.watchGeneration) {
      try { await watch?.unsubscribe?.(); } catch {}
      return false;
    }
    this.subscription = watch;
    this.watchRetryMs = this.watchRetryBaseMs;
    this._setWatchHealth(true);
    return true;
  }

  _handleWatchError(error, generation) {
    if (this.stopped || generation !== this.watchGeneration || !error) return;
    this._queueTypingCleanup();
    this.subscription = null;
    this.watchGeneration += 1;
    this._setWatchHealth(false);
    this.verifiedHelperStatus = null;
    this.capabilityStatus = null;
    try { this.watchCallbacks?.onError?.(error); } catch {}
    this._scheduleWatchRecovery();
  }

  _scheduleWatchRecovery() {
    if (this.stopped) return;
    if (this.watchRetryTimer) return;
    const delay = this.watchRetryMs;
    this.watchRetryMs = Math.min(this.watchRetryMaxMs, Math.max(this.watchRetryBaseMs, delay * 2));
    this.watchRetryTimer = setTimeout(async () => {
      this.watchRetryTimer = null;
      if (this.stopped) return;
      try {
        await this._recoverWatch();
      } catch (retryError) {
        if (this.stopped) return;
        try { this.watchCallbacks?.onError?.(retryError); } catch {}
        this._scheduleWatchRecovery();
      }
    }, delay);
    // Keep the daemon alive while its only external socket is unavailable.
    // If this timer is unreferenced, a helper restart can close the IPC socket,
    // leave no referenced handles, and let Node exit before recovery runs.
  }

  async _recoverWatch() {
    if (this.stopped) return false;
    if (this.recoveryPromise) return this.recoveryPromise;
    const lifecycleGeneration = this.lifecycleGeneration;
    const attempt = (async () => {
      const pendingTypingCleanup = this.typingCleanupPromise;
      this.subscription = null;
      this._setWatchHealth(false);
      this.verifiedHelperStatus = null;
      this.capabilityStatus = null;
      this.typing = false;
      // A helper/watch failure invalidates the whole authenticated session.
      // Reconnect from a clean socket so recovery always reauthenticates,
      // reprobes, restarts the pinned RPC child, and only then resubscribes.
      await this.client.resetConnection?.();
      if (pendingTypingCleanup) await pendingTypingCleanup;
      await this.helperStatus();
      await this.probe({ refresh: true });
      await this.client.start();
      if (this.stopped || lifecycleGeneration !== this.lifecycleGeneration) return false;
      const subscribed = await this._subscribeWatch();
      if (!subscribed || this.stopped || lifecycleGeneration !== this.lifecycleGeneration) return false;
      const subscribedGeneration = this.watchGeneration;
      await this._flushConfirmationOutboxAfterReconnect();
      await this._observePendingInbound();
      try {
        for (const action of this.router.pendingActions()) {
          await this.watchCallbacks?.onAction?.(action, null);
        }
      } catch (error) {
        this.subscription = null;
        this.watchGeneration += 1;
        this._setWatchHealth(false);
        throw error;
      }
      // A recovered subscription can fail again while durable actions are
      // replaying. Do not let the earlier recovery report success after its
      // generation was invalidated: the retry timer awaiting this promise
      // must see a failure so it schedules the next resubscription.
      if (this.stopped || lifecycleGeneration !== this.lifecycleGeneration) return false;
      if (subscribedGeneration !== this.watchGeneration || !this.subscription || !this.watchHealthy) {
        throw Object.assign(new Error("The recovered Messages watch was invalidated during replay."), {
          code: "IMSG_WATCH_INVALIDATED",
        });
      }
      if (!this.typingClearConfirmed) await this._forceTypingOff();
      await this._syncDefaultTyping();
      return true;
    })();
    this.recoveryPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (this.recoveryPromise === attempt) this.recoveryPromise = null;
    }
  }

  async stop() {
    this.lifecycleGeneration += 1;
    this.stopped = true;
    this.watchGeneration += 1;
    this._setWatchHealth(false, { notify: false });
    if (this.watchRetryTimer) clearTimeout(this.watchRetryTimer);
    this.watchRetryTimer = null;
    this.typingThreads.clear();
    if (this.typingExpiryTimer) clearTimeout(this.typingExpiryTimer);
    this.typingExpiryTimer = null;
    try { await this.typingCleanupPromise; } catch {}
    await this._forceTypingOff();
    try { await this.subscription?.unsubscribe?.(); } catch {}
    this.subscription = null;
    this.watchCallbacks = null;
    this.verifiedHelperStatus = null;
    await this.client.stop();
  }

  setActiveThread(thread, updatedAt = new Date(this.now()).toISOString()) {
    this.activeThread = thread || null;
    this.router.setActiveThread(thread?.id || null, updatedAt);
  }

  setMenu(references) { this.router.setMenu(references); }
  pendingActions() { return this.router.pendingActions(); }
  acknowledge(messageKey) { return this.router.acknowledge(messageKey); }

  rememberInbound(threadId, guid) {
    const id = clean(threadId);
    const message = clean(guid);
    if (id && message) this.router.routeInboundGuid(message, id);
  }

  async observeInbound() {
    const capabilities = this.richCapabilities();
    const readAttempt = capabilities.readReceipts
      ? this.client.markRead(target(this.profile))
      : null;
    const [readResult, typingResult] = await Promise.allSettled([
      readAttempt || Promise.resolve({ classification: "unsupported" }),
      this._syncDefaultTyping(),
    ]);
    const readValue = readResult.status === "fulfilled" ? readResult.value : null;
    const readStatus = !capabilities.readReceipts
      ? "unsupported"
      : readResult.status === "rejected"
        ? "error"
        : readValue?.classification === "accepted"
          ? "accepted"
          : readValue?.classification === "ambiguous"
            ? "ambiguous"
            : "unsupported";
    this.readObservation = {
      status: readStatus,
      checkedAt: new Date(this.now()).toISOString(),
      ...safeImsgFailureDetails(readValue || {}),
    };
    return readStatus === "accepted" && typingResult.status === "fulfilled";
  }

  async _observePendingInbound() {
    if (!this.router.pendingActions().length) return false;
    return this.observeInbound();
  }

  async _settleInbound(action, options = {}, { routeAcceptedGuid = true } = {}) {
    const threadId = clean(action?.threadId);
    const guid = clean(action?.guid);
    const hasExplicitReplyContext = Boolean(clean(action?.threadOriginatorGuid));
    const shouldRouteGuid = action?.kind === "prompt"
      || (action?.kind === "control" && hasExplicitReplyContext)
      || (action?.kind === "switch" && (Boolean(clean(action?.prompt)) || hasExplicitReplyContext));
    if (routeAcceptedGuid && threadId && guid && shouldRouteGuid) {
      this.router.routeInboundGuid(guid, threadId, {
        replyToGuid: action?.replyToGuid,
        threadOriginatorGuid: action?.threadOriginatorGuid,
        createdAt: action?.createdAt,
      });
    }
    // Commit acceptance and its optional semantic confirmation together. The
    // action can never be replayed just because the presentation-only tapback
    // is temporarily unavailable; the outbox retries it with one stable id.
    const reaction = clean(options.reaction);
    const acknowledged = this.router.acknowledgeWithConfirmation(action?.messageKey, {
      messageGuid: guid,
      reaction,
      remove: options.removeReaction === true,
    }, {
      newThreadCompletion: options.newThreadCompletion,
    });
    await Promise.allSettled([
      this._syncDefaultTyping(),
      this._flushConfirmationOutbox(),
    ]);
    return acknowledged;
  }

  acceptInbound(action, options = {}) {
    return this._settleInbound(action, options);
  }

  quarantineInbound(action, options = {}) {
    return this._settleInbound(action, {
      ...options,
      reaction: clean(options.reaction) || "❌",
    }, { routeAcceptedGuid: false });
  }

  _flushConfirmationOutbox() {
    if (this.confirmationFlushPromise) return this.confirmationFlushPromise;
    const attempt = (async () => {
      if (!this.richCapabilities().tapbacks) return 0;
      let delivered = 0;
      const visited = new Set();
      let blocked = false;
      while (!blocked) {
        const pending = this.router.pendingConfirmations()
          .filter((confirmation) => !visited.has(confirmation.operationId));
        if (!pending.length) break;
        for (const confirmation of pending) {
          visited.add(confirmation.operationId);
          if (typeof this.client.authorizeMessageGuid === "function") {
            let authorization;
            try {
              authorization = await this.client.authorizeMessageGuid({
                ...target(this.profile),
                message_guid: confirmation.messageGuid,
                operation_id: confirmation.operationId,
              });
            } catch {
              // Lookup failures can be transient (database lock, helper reset).
              // Preserve ordering and retry from this entry after reconnect.
              blocked = true;
              break;
            }
            const canAttempt = authorization?.classification === "accepted"
              && (authorization?.authorized === true || authorization?.recoveredOperation === true);
            if (!canAttempt) {
              // A deleted or otherwise terminal item stays in the bounded durable
              // outbox, but must not prevent independent later confirmations.
              if (authorization?.terminal === true) continue;
              blocked = true;
              break;
            }
          }
          let result;
          try {
            result = await this.client.tapback({
              ...target(this.profile),
              message_guid: confirmation.messageGuid,
              reaction: confirmation.reaction,
              ...(confirmation.remove ? { remove: true } : {}),
            }, { operationId: confirmation.operationId });
          } catch {
            blocked = true;
            break;
          }
          if (result?.classification !== "accepted") {
            if (result?.terminal === true || result?.classification === "unsupported") continue;
            blocked = true;
            break;
          }
          try {
            if (this.router.completeConfirmation(confirmation.operationId)) delivered += 1;
          } catch {
            blocked = true;
            break;
          }
        }
      }
      return delivered;
    })().catch(() => 0);
    this.confirmationFlushPromise = attempt;
    attempt.finally(() => {
      if (this.confirmationFlushPromise === attempt) this.confirmationFlushPromise = null;
    });
    return attempt;
  }

  async _flushConfirmationOutboxAfterReconnect() {
    // A confirmation attempt from the failed connection may still be settling
    // while its replacement watch comes online. Let that attempt resolve, then
    // always make a fresh pass on the authenticated replacement connection.
    const previousAttempt = this.confirmationFlushPromise;
    if (previousAttempt) {
      try { await previousAttempt; } catch {}
      if (this.confirmationFlushPromise === previousAttempt) {
        this.confirmationFlushPromise = null;
      }
    }
    return this._flushConfirmationOutbox();
  }

  async reactInbound(guid, reaction, { remove = false } = {}) {
    const messageGuidValue = clean(guid);
    const reactionValue = clean(reaction);
    if (!messageGuidValue || !reactionValue || !this.richCapabilities().tapbacks) {
      return { classification: "unsupported" };
    }
    return this.client.tapback({
      ...target(this.profile),
      message_guid: messageGuidValue,
      reaction: reactionValue,
      ...(remove ? { remove: true } : {}),
    });
  }

  async _setTypingState(typing = true) {
    if (!this.richCapabilities().typing) return { classification: "unsupported" };
    if (this.typing === typing && (typing || this.typingClearConfirmed)) {
      return { classification: "accepted", accepted: true };
    }
    const result = await this.client.setTyping(target(this.profile), typing);
    if (result?.classification === "accepted") {
      this.typing = typing;
      this.typingClearConfirmed = !typing;
    }
    return result;
  }

  async _forceTypingOff() {
    this.typing = false;
    try {
      const result = await this.client.setTyping(target(this.profile), false);
      const accepted = result?.classification === "accepted";
      if (accepted) this.typingClearConfirmed = true;
      return accepted;
    } catch {
      return false;
    }
  }

  _queueTypingCleanup() {
    this.typing = false;
    this.typingClearConfirmed = false;
    const attempt = this._forceTypingOff();
    this.typingCleanupPromise = attempt;
    attempt.then(() => {
      if (this.typingCleanupPromise === attempt) this.typingCleanupPromise = null;
    });
    return attempt;
  }

  async setThreadTyping(threadId, typing = true) {
    const id = clean(threadId);
    if (!id) return this._syncDefaultTyping();
    if (typing) this.typingThreads.add(id);
    else this.typingThreads.delete(id);
    return this._syncDefaultTyping();
  }

  async syncWorkingThreads(threadIds = []) {
    this.typingThreads = new Set((threadIds || []).map(clean).filter(Boolean));
    return this._syncDefaultTyping();
  }

  _syncDefaultTyping() {
    const defaultThreadId = clean(this.router.recentDefaultThreadId);
    const shouldType = Boolean(defaultThreadId && this.typingThreads.has(defaultThreadId));
    if (this.typingExpiryTimer) clearTimeout(this.typingExpiryTimer);
    this.typingExpiryTimer = null;
    if (shouldType) {
      const expiresAt = Date.parse(this.router.recentDefaultExpiresAt || "");
      if (Number.isFinite(expiresAt)) {
        this.typingExpiryTimer = setTimeout(() => {
          this.typingExpiryTimer = null;
          this._syncDefaultTyping().catch(() => {});
        }, Math.max(1, expiresAt - this.now() + 1));
        this.typingExpiryTimer.unref?.();
      }
    }
    return this._setTypingState(shouldType);
  }

  _enqueue(operation) {
    const queued = this.sendQueue.then(operation, operation);
    this.sendQueue = queued.catch(() => {});
    return queued;
  }

  async _attemptTextSend(text, operation) {
    const reservation = this.router.reserveOutboundEcho(text);
    try {
      const result = await operation();
      if (!result || !["accepted", "ambiguous"].includes(result.classification)) {
        this.router.releaseOutboundEcho(reservation);
      }
      return result;
    } catch (error) {
      this.router.releaseOutboundEcho(reservation);
      throw error;
    }
  }

  async _sendText(intent, { replyToGuid, effect, subject, operationId } = {}) {
    const capabilities = this.richCapabilities();
    if (replyToGuid && !capabilities.replies) {
      return { classification: "unsupported", reason: "native-replies-unavailable" };
    }
    const url = !replyToGuid && !effect && !subject && intent.ranges.length === 0 && capabilities.urlPreviews
      ? exactURL(intent.text)
      : null;
    return this._attemptTextSend(intent.text, () => this.client.sendRich({
      ...target(this.profile),
      ...(url ? { url } : {
        text: intent.text,
        text_formatting: nativeFormatting(intent.ranges),
        ...(capabilities.effects && effect ? { effect } : {}),
        ...(subject ? { subject } : {}),
      }),
      ...(capabilities.replies && replyToGuid ? { reply_to: replyToGuid } : {}),
    }, operationId ? { operationId } : undefined));
  }

  async _sendPoll(intent, event, { replyToGuid, operationId } = {}) {
    if (replyToGuid && !this.richCapabilities().replies) return { classification: "unsupported", reason: "native-replies-unavailable" };
    if (!this.richCapabilities().polls) return { classification: "unsupported", reason: "native-polls-unavailable" };
    const sent = await this.client.sendPoll({
      ...target(this.profile),
      question: intent.question,
      options: intent.options.map((option) => option.label),
      send_caption: false,
      ...(this.richCapabilities().replies && replyToGuid ? { reply_to: replyToGuid } : {}),
    }, operationId ? { operationId } : undefined);
    if (sent.classification === "accepted") {
      const mapping = pollOptionMap(sent, intent.options.map((option) => {
        const threadId = clean(event?.thread?.id);
        const value = option.command.replace(/^\/reasoning\s+/, "");
        return { kind: "control", command: "reasoning", threadId, argument: value };
      }));
      const guid = messageGuid(sent);
      if (guid && Object.keys(mapping).length) {
        this.router.registerPoll(guid, mapping, {
          allowAddedChoiceSearch: true,
          optionLabels: pollOptionLabels(sent),
        });
      }
      return sent;
    }
    if (sent.classification === "ambiguous") return sent;
    return sent;
  }

  async _sendChoicePolls(question, choices, options = {}) {
    if (!this.richCapabilities().polls) {
      return { sent: false, status: "UNSUPPORTED", terminal: false, parts: 0, guids: [], attempted: false };
    }
    const plan = pollPlan(question, choices);
    const { chunks, questions } = plan;
    if (!chunks.length) {
      return { sent: false, status: "NO_POLL", terminal: false, parts: 0, guids: [], attempted: false };
    }
    const guids = [];
    const choiceDigest = createHash("sha256")
      .update(JSON.stringify(choices.map((choice) => ({ label: choice.label, action: choice.action }))))
      .digest("hex");
    const operationScope = clean(options.operationScope) || `choice:${choiceDigest}`;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const pollQuestion = questions[index];
      const sent = await this.client.sendPoll({
        ...target(this.profile),
        question: pollQuestion,
        options: chunk.map((choice) => choice.label),
        send_caption: false,
      }, { operationId: outboundOperationId(this.profile.chatGuid, `${operationScope}:part:${index}`) });
      const normalized = resultStatus(sent);
      if (!normalized.sent) {
        const safeTextFallback = sent?.classification === "unsupported" && guids.length === 0;
        return { ...normalized, parts: guids.length, guids, attempted: !safeTextFallback };
      }
      if (!normalized.guid) {
        return { sent: false, status: "POLL_GUID_MISSING", terminal: false, parts: guids.length, guids, attempted: true };
      }
      const mapping = pollOptionMap(sent, chunk.map((choice) => choice.action));
      if (Object.keys(mapping).length !== chunk.length) {
        return { sent: false, status: "POLL_OPTIONS_MISSING", terminal: false, parts: guids.length, guids, attempted: true };
      }
      guids.push(normalized.guid);
      this.router.registerPoll(normalized.guid, mapping, {
        allowAddedChoiceSearch: options.allowAddedChoiceSearch !== false,
        addChoiceCommand: clean(options.addChoiceCommand),
        addChoiceArgument: clean(options.addChoiceArgument),
        addedChoiceAction: options.addedChoiceAction,
        refreshAction: options.refreshAction,
        optionLabels: pollOptionLabels(sent),
      });
    }
    return { sent: true, status: "SENT", terminal: true, parts: guids.length, guids, attempted: true };
  }

  async _sendNativeMenu(event) {
    const menu = event?.kind === "service.directory" ? directoryChoices(event, this.now()) : menuChoices(event, this.now());
    if (!menu.question || !menu.choices.length) {
      return { sent: false, status: "NO_POLL", terminal: false, parts: 0, guids: [], attempted: false };
    }
    return this._sendChoicePolls(menu.question, menu.choices, {
      allowAddedChoiceSearch: true,
      operationScope: eventId(event),
    });
  }

  sendThreadPicker(command, items, options = {}) {
    const normalizedCommand = clean(command).toLowerCase();
    const commandArgument = clean(options.argument);
    const choices = (items || []).map((thread) => taskChoice(thread, {
      kind: "control",
      command: normalizedCommand,
      threadId: clean(thread?.id),
      ...(commandArgument ? { argument: commandArgument } : {}),
    }, this.now())).filter(Boolean);
    if (choices.length < MIN_POLL_OPTIONS) choices.push(navigationChoice("Recent tasks", { kind: "threads" }));
    const question = clean(options.question) || `${normalizedCommand ? `/${normalizedCommand}` : "Choose"} task`;
    return this._enqueue(() => this._sendChoicePolls(question, choices, {
      allowAddedChoiceSearch: true,
      addChoiceCommand: normalizedCommand,
      addChoiceArgument: commandArgument,
      operationScope: clean(options.operationScope),
    }));
  }

  sendActionPicker(question, choices, options = {}) {
    const normalized = (choices || []).flatMap((choice) => {
      const label = clean(choice?.label);
      return label && choice?.action ? [{ label, action: choice.action }] : [];
    });
    return this._enqueue(() => this._sendChoicePolls(clean(question) || "Choose", normalized, {
      allowAddedChoiceSearch: options.allowAddedChoiceSearch !== false,
      addChoiceCommand: clean(options.addChoiceCommand),
      addChoiceArgument: clean(options.addChoiceArgument),
      addedChoiceAction: options.addedChoiceAction,
      refreshAction: options.refreshAction,
      operationScope: clean(options.operationScope),
    }));
  }

  outbound(event, options = {}) {
    return this._enqueue(() => this._outbound(event, options));
  }

  async _outbound(event, options = {}) {
    const threadId = clean(event?.thread?.id);
    if (options.proactive === true && this.router.shouldPauseIncoming?.(threadId)) {
      return { sent: false, status: "AWAITING_PROMPT", terminal: false, parts: 0, guids: [] };
    }
    if (event?.kind === "thread.progress") {
      await this.setThreadTyping(event?.thread?.id, true);
      return { sent: false, status: "TYPING", terminal: true, parts: 0 };
    }
    const id = eventId(event);
    const prior = id ? this.router.outboundReceipt(id) : null;
    if (prior?.classification === "accepted") {
      return { sent: true, status: "DUPLICATE", terminal: true, parts: prior.guids.length };
    }
    if (!threadId && (event?.kind === "service.directory"
      || (event?.kind === "service.menu" && event.label !== "COMMANDS"))) {
      const menuResult = await this._sendNativeMenu(event);
      return menuResult;
    }
    let rootGuid = threadId ? clean(this.router.nativeThread(threadId)?.rootGuid) : "";
    const guids = [];
    if (threadId && (!rootGuid || event?.kind === "thread.header")) {
      const header = richTextIntent(taskHeader(event.thread, this.now()), {
        richText: this.richCapabilities().richText,
        event: { kind: "thread.header", thread: event.thread },
      });
      const establishingRoot = !rootGuid;
      const headerScope = id
        ? `${id}:${establishingRoot ? "root" : "header"}`
        : `thread-header:${threadId}:${establishingRoot ? "root" : "repeat"}`;
      const headerResult = await this._sendText(header, {
        replyToGuid: rootGuid,
        effect: options.effect,
        subject: options.subject,
        operationId: outboundOperationId(this.profile.chatGuid, headerScope),
      });
      const normalizedHeader = resultStatus(headerResult);
      if (!normalizedHeader.sent || !normalizedHeader.guid) {
        if (id && headerResult?.classification !== "accepted") {
          this.router.recordOutboundReceipt(id, { classification: headerResult?.classification || "unsupported", guids });
        }
        return {
          ...normalizedHeader,
          sent: false,
          status: normalizedHeader.sent ? "ROOT_GUID_MISSING" : normalizedHeader.status,
          terminal: false,
          parts: guids.length,
          guids,
        };
      }
      guids.push(normalizedHeader.guid);
      this.router.routeOutboundGuid(normalizedHeader.guid, threadId, { root: establishingRoot });
      if (establishingRoot) rootGuid = normalizedHeader.guid;
      if (event?.kind === "thread.header") {
        if (id) this.router.recordOutboundReceipt(id, { classification: "accepted", guids });
        return { sent: true, status: "SENT", terminal: true, parts: 1, guids };
      }
    }
    const intents = renderRichOutboundIntents(event, {
      // Native Messages reply threads carry the task context. Rendering as if
      // the event's own task were active prevents presentation.ts from adding
      // a second title to every bubble.
      presentation: { context: { activeThread: threadId ? event.thread : (options.activeThread || this.activeThread) } },
      capabilities: this.richCapabilities(),
    }).flatMap((intent) => splitTextIntent(intent));
    for (let index = 0; index < intents.length; index += 1) {
      const intent = intents[index];
      // Only Codex-task output belongs in an iMessage reply thread. Global
      // service responses stay at the conversation's top level.
      const replyToGuid = threadId ? rootGuid : "";
      const operationId = outboundOperationId(this.profile.chatGuid, id && `${id}:part:${index}`);
      const result = intent.kind === "poll"
        ? await this._sendPoll(intent, event, { replyToGuid, operationId })
        : await this._sendText(intent, { replyToGuid, effect: options.effect, subject: options.subject, operationId });
      const normalized = resultStatus(result);
      if (normalized.guid) {
        guids.push(normalized.guid);
        if (threadId) this.router.routeOutboundGuid(normalized.guid, threadId);
      }
      if (!normalized.sent) {
        if (id) {
          this.router.recordOutboundReceipt(id, { classification: result?.classification || "unsupported", guids });
        }
        return {
          ...normalized,
          sent: false,
          terminal: false,
          parts: guids.length,
          guids,
        };
      }
    }
    if (id) this.router.recordOutboundReceipt(id, { classification: "accepted", guids });
    if (["thread.output", "thread.completed"].includes(event?.kind)
      || (event?.kind === "thread.live-message" && event.role === "assistant" && event.phase !== "commentary")) {
      await this.setThreadTyping(threadId, false);
    }
    return { sent: guids.length > 0, status: "SENT", terminal: true, parts: guids.length, guids };
  }

  publishImages(thread, files, options = {}) {
    return this._enqueue(() => this._publishImages(thread, files, options));
  }

  async _publishImages(thread, files, options = {}) {
    const threadId = clean(thread?.id);
    const imageScope = clean(options.deliveryId || options.replyToGuid)
      || `files:${createHash("sha256").update(JSON.stringify((files || []).map((file) => clean(file)))).digest("hex")}`;
    if (options.proactive === true && this.router.shouldPauseIncoming?.(threadId)) {
      return { sent: false, status: "AWAITING_PROMPT", terminal: false, guids: [] };
    }
    const guids = [];
    let rootGuid = threadId ? clean(this.router.nativeThread(threadId)?.rootGuid) : "";
    if (threadId && !rootGuid && (files || []).length) {
      const header = richTextIntent(taskHeader(thread, this.now()), { richText: this.richCapabilities().richText });
      const rootResult = await this._sendText(header, {
        operationId: outboundOperationId(this.profile.chatGuid, `images:${threadId}:${imageScope}:root`),
      });
      const normalizedRoot = resultStatus(rootResult);
      if (!normalizedRoot.sent || !normalizedRoot.guid) {
        return {
          ...normalizedRoot,
          sent: false,
          status: normalizedRoot.sent ? "ROOT_GUID_MISSING" : normalizedRoot.status,
          terminal: false,
          guids,
        };
      }
      rootGuid = normalizedRoot.guid;
      guids.push(rootGuid);
      this.router.routeOutboundGuid(rootGuid, threadId, { root: true });
    }
    for (const [index, file] of (files || []).slice(0, 5).entries()) {
      let result;
      if (rootGuid && !this.richCapabilities().attachments) {
        return { sent: false, status: "UNSUPPORTED", terminal: false, guids };
      }
      if (this.richCapabilities().attachments) {
        result = await this.client.sendAttachment({
          ...target(this.profile),
          file,
          ...(rootGuid ? { reply_to: rootGuid } : {}),
        }, {
          operationId: outboundOperationId(this.profile.chatGuid, `images:${threadId}:${imageScope}:part:${index}`),
        });
      }
      if (!result) return { sent: false, status: "UNSUPPORTED", terminal: false, guids };
      const normalized = resultStatus(result);
      if (!normalized.sent) return { ...normalized, guids };
      if (normalized.guid) {
        guids.push(normalized.guid);
        if (threadId) this.router.routeOutboundGuid(normalized.guid, threadId);
      }
    }
    return { sent: true, status: "SENT", terminal: true, guids };
  }

  sendStatus(guid) {
    if (!this.richCapabilities().sendStatus) return Promise.resolve({ classification: "unsupported", reason: "send-status-unavailable" });
    return this.client.sendStatus(guid);
  }

  async deliveryStatus(eventOrId) {
    const id = typeof eventOrId === "string" ? eventOrId : eventId(eventOrId);
    const receipt = id ? this.router.outboundReceipt(id) : null;
    const guids = Array.isArray(receipt?.guids) ? receipt.guids : [];
    if (!guids.length) return { classification: "unsupported", reason: "no-outbound-guid", statuses: [] };
    const statuses = await Promise.all(guids.map((guid) => this.sendStatus(guid)));
    return { classification: statuses.some((status) => status?.classification === "ambiguous") ? "ambiguous" : "accepted", statuses };
  }

  editMessage(guid, text, options = {}) {
    if (!this.richCapabilities().edits) return Promise.resolve({ classification: "unsupported", reason: "edit-unavailable" });
    return this.client.editMessage({
      ...target(this.profile),
      message_guid: guid,
      text,
      ...(options.partIndex !== undefined ? { part_index: options.partIndex } : {}),
    });
  }

  unsendMessage(guid, options = {}) {
    if (!this.richCapabilities().unsend) return Promise.resolve({ classification: "unsupported", reason: "unsend-unavailable" });
    return this.client.unsendMessage({
      ...target(this.profile),
      message_guid: guid,
      ...(options.partIndex !== undefined ? { part_index: options.partIndex } : {}),
    });
  }

  notificationStatus() {
    const at = Date.parse(this.router.lastUserMessageAt || "");
    const active = Number.isFinite(at) && this.now() - at <= ACTIVITY_WINDOW_MS;
    return { active, status: active ? "ACTIVE" : "INACTIVE", lastUserMessageAt: this.router.lastUserMessageAt };
  }
}

export const imsgTransportInternals = Object.freeze({
  nativeFormatting,
  directoryChoices,
  menuChoices,
  pollChunks,
  pollPlan,
  pollDefinitionPayloadBytes,
  truncateUtf8,
  pollOptionMap,
  eventId,
  exactURL,
  outboundOperationId,
  taskHeader,
  compact,
});
