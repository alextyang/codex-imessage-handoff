import path from "node:path";
import { createHash } from "node:crypto";
import { createImsgIpcClientFromConfig } from "./imsg-ipc-client.mjs";
import { LocalConversationRouter } from "./local-conversation-router.mjs";
import { renderRichOutboundIntents, richTextIntent } from "../../protocol/rich-presentation.ts";
import { projectIdentityEmoji, relativeTime, threadIdentityEmoji } from "../../protocol/presentation.ts";

const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_POLL_OPTIONS = 12;
const MIN_POLL_OPTIONS = 2;

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

function messageGuid(result) {
  return clean(result?.guid || result?.message_guid || result?.messageGuid);
}

function resultStatus(result) {
  if (result?.classification === "accepted") return { sent: true, status: "SENT", terminal: true, guid: messageGuid(result) || null };
  if (result?.classification === "ambiguous") return { sent: false, status: "AMBIGUOUS", terminal: false };
  return { sent: false, status: "UNSUPPORTED", terminal: false };
}

function markdownEscape(value) {
  return clean(value).replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}

function taskHeader(thread) {
  const id = clean(thread?.id);
  if (!id) return "";
  return `${threadIdentityEmoji(thread)} **${markdownEscape(thread?.title) || "Untitled task"}**\n`
    + `codex://threads/${encodeURIComponent(id)}\n`
    + "/listen · /link · /mute";
}

function pollChunks(items) {
  if (!Array.isArray(items) || items.length < MIN_POLL_OPTIONS) return [];
  const count = Math.ceil(items.length / MAX_POLL_OPTIONS);
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

function compact(value, limit = 72) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function taskChoice(thread, action = null, now = Date.now()) {
  const id = clean(thread?.id);
  if (!id) return null;
  const status = clean(thread?.status).toLowerCase();
  const pending = Math.max(0, Number(thread?.pendingCount) || 0);
  const stateAt = thread?.stateSince || thread?.activityAt;
  const age = stateAt ? relativeTime(stateAt, now) : "unknown";
  const state = status === "working" || status === "running"
    ? `Working ${age.replace(/ ago$/, "")}`
    : status === "pending" || status === "queued"
      ? `Pending ${age.replace(/ ago$/, "")}`
      : status === "error" || status === "failed"
        ? `Needs attention · ${age}`
        : age;
  const context = [
    compact(thread?.projectLabel || (thread?.groupKind === "other" ? "Other tasks" : ""), 30),
    state,
    pending > 0 ? `${pending} queued` : "",
    thread?.requestPreview ? `“${compact(thread.requestPreview, 54)}”` : "",
  ].filter(Boolean).join(" · ");
  return {
    label: compact(`${threadIdentityEmoji(thread)} ${clean(thread?.title) || "Untitled task"}${context ? ` · ${context}` : ""}`, 160),
    action: action || { kind: "switch", threadId: id, awaitingPrompt: true },
  };
}

function projectChoice(project, now = Date.now()) {
  const projectKey = clean(project?.projectKey);
  if (!projectKey) return null;
  const projectLabel = clean(project?.projectLabel || project?.title) || "Project";
  const threads = Array.isArray(project?.threads) ? project.threads : [];
  const threadCount = Math.max(0, Number(project?.threadCount) || threads.length);
  const pendingCount = threads.filter((thread) => ["pending", "queued", "working", "running"].includes(clean(thread?.status).toLowerCase())
    || Number(thread?.pendingCount) > 0).length;
  const latestAt = project?.activityAt || threads.map((thread) => thread?.activityAt || thread?.stateSince)
    .filter(Boolean).sort().at(-1);
  const context = [
    threadCount ? `${threadCount} ${threadCount === 1 ? "task" : "tasks"}` : "",
    pendingCount ? `${pendingCount} active` : "",
    latestAt ? relativeTime(latestAt, now) : "",
  ].filter(Boolean).join(" · ");
  return {
    label: compact(`${projectIdentityEmoji(project)} ${projectLabel}${context ? ` · ${context}` : ""}`, 160),
    action: { kind: "project", projectKey },
  };
}

function directoryChoices(event, now = Date.now()) {
  if (event?.kind !== "service.directory") return { question: null, choices: [] };
  const groups = event.directory?.groups || [];
  const projects = [
    ...groups.map((group) => projectChoice(group, now)),
    ...(event.directory?.collapsedProjects || []).map((project) => projectChoice(project, now)),
  ].filter(Boolean);
  const uniqueProjects = [...new Map(projects.map((choice) => [choice.action.projectKey, choice])).values()];
  if (uniqueProjects.length >= MIN_POLL_OPTIONS) return { question: "Choose a project", choices: uniqueProjects };
  const threads = groups
    .flatMap((group) => (group.threads || []).map((thread) => ({
      ...thread,
      projectLabel: group.projectLabel || "Other tasks",
    })))
    .filter((thread) => thread?.id)
    .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
    .map((thread) => taskChoice(thread, null, now))
    .filter(Boolean);
  return { question: "Choose a task", choices: threads };
}

function menuChoices(event, now = Date.now()) {
  if (event?.kind !== "service.menu" || !["PROJECTS", "THREADS"].includes(event.label)) {
    return { question: null, choices: [] };
  }
  const items = event.items || [];
  return event.label === "PROJECTS"
    ? { question: "Choose a project", choices: items.map((item) => projectChoice(item, now)).filter(Boolean) }
    : { question: "Choose a task", choices: items.map((item) => taskChoice(item, null, now)).filter(Boolean) };
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

export class ImsgTransport {
  constructor({
    profile,
    stateFile,
    client,
    now = () => Date.now(),
    logger = null,
    watchRetryBaseMs = 500,
    watchRetryMaxMs = 30_000,
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
    this.router = new LocalConversationRouter({ stateFile: path.resolve(stateFile), conversationKey, now });
    this.now = now;
    this.logger = logger;
    this.capabilityStatus = null;
    this.verifiedHelperStatus = null;
    this.subscription = null;
    this.activeThread = null;
    this.typing = false;
    this.typingThreads = new Set();
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
    const required = ["watch", "richText", "replies", "polls", "pollVoting", "typing", "attachments"];
    if (!status?.available || status?.advanced !== true || required.some((name) => capabilities[name] !== true)) {
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
      replies: available && this.capabilityStatus?.capabilities?.replies === true,
      typing: available && this.capabilityStatus?.capabilities?.typing === true,
      readReceipts: available && this.capabilityStatus?.capabilities?.readReceipts === true,
      tapbacks: available && this.capabilityStatus?.capabilities?.tapbacks === true,
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
      else await this._subscribeWatch();
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
    this.subscription = null;
    this.watchGeneration += 1;
    this._setWatchHealth(false);
    this.verifiedHelperStatus = null;
    this.capabilityStatus = null;
    this.typing = false;
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
      this.subscription = null;
      this._setWatchHealth(false);
      this.verifiedHelperStatus = null;
      this.capabilityStatus = null;
      this.typing = false;
      // A helper/watch failure invalidates the whole authenticated session.
      // Reconnect from a clean socket so recovery always reauthenticates,
      // reprobes, restarts the pinned RPC child, and only then resubscribes.
      await this.client.resetConnection?.();
      await this.helperStatus();
      await this.probe({ refresh: true });
      await this.client.start();
      if (this.stopped || lifecycleGeneration !== this.lifecycleGeneration) return false;
      const subscribed = await this._subscribeWatch();
      if (!subscribed || this.stopped || lifecycleGeneration !== this.lifecycleGeneration) return false;
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
    try { await this._setTypingState(false); } catch {}
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

  async acceptInbound(action) {
    const threadId = clean(action?.threadId);
    const guid = clean(action?.guid);
    const hasExplicitReplyContext = Boolean(clean(action?.replyToGuid) || clean(action?.threadOriginatorGuid));
    const shouldRouteGuid = action?.kind === "prompt"
      || (action?.kind === "control" && hasExplicitReplyContext)
      || (action?.kind === "switch" && (Boolean(clean(action?.prompt)) || hasExplicitReplyContext));
    if (threadId && guid && shouldRouteGuid) {
      this.router.routeInboundGuid(guid, threadId, {
        replyToGuid: action?.replyToGuid,
        threadOriginatorGuid: action?.threadOriginatorGuid,
        createdAt: action?.createdAt,
      });
    }
    // The Codex action is already accepted at this point. Make that durable
    // before optional UI niceties so a transient bridge failure cannot replay it.
    const acknowledged = this.acknowledge(action?.messageKey);
    const capabilities = this.richCapabilities();
    await Promise.allSettled([
      ...(capabilities.readReceipts ? [this.client.markRead(target(this.profile))] : []),
      ...(capabilities.tapbacks && action?.guid
        ? [this.client.tapback({ ...target(this.profile), message_guid: action.guid, reaction: "like" })]
        : []),
    ]);
    return acknowledged;
  }

  async _setTypingState(typing = true) {
    if (!this.richCapabilities().typing) return { classification: "unsupported" };
    if (this.typing === typing) return { classification: "accepted", accepted: true };
    const result = await this.client.setTyping(target(this.profile), typing);
    if (result?.classification === "accepted") this.typing = typing;
    return result;
  }

  async setThreadTyping(threadId, typing = true) {
    const id = clean(threadId) || "__unscoped__";
    if (typing) this.typingThreads.add(id);
    else this.typingThreads.delete(id);
    return this._setTypingState(this.typingThreads.size > 0);
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
    const sent = await this._attemptTextSend(intent.question, () => this.client.sendPoll({
      ...target(this.profile),
      question: intent.question,
      options: intent.options.map((option) => option.label),
      ...(this.richCapabilities().replies && replyToGuid ? { reply_to: replyToGuid } : {}),
    }, operationId ? { operationId } : undefined));
    if (sent.classification === "accepted") {
      const mapping = pollOptionMap(sent, intent.options.map((option) => {
        const threadId = clean(event?.thread?.id);
        const value = option.command.replace(/^\/reasoning\s+/, "");
        return { kind: "control", command: "reasoning", threadId, argument: value };
      }));
      const guid = messageGuid(sent);
      if (guid && Object.keys(mapping).length) this.router.registerPoll(guid, mapping);
      return sent;
    }
    if (sent.classification === "ambiguous") return sent;
    return sent;
  }

  async _sendChoicePolls(question, choices) {
    if (!this.richCapabilities().polls) {
      return { sent: false, status: "UNSUPPORTED", terminal: false, parts: 0, guids: [], attempted: false };
    }
    const chunks = pollChunks(choices);
    if (!chunks.length) {
      return { sent: false, status: "NO_POLL", terminal: false, parts: 0, guids: [], attempted: false };
    }
    const guids = [];
    const choiceDigest = createHash("sha256")
      .update(JSON.stringify(choices.map((choice) => ({ label: choice.label, action: choice.action }))))
      .digest("hex");
    const operationScope = `choice:${this.router.lastRowId || "startup"}:${choiceDigest}`;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const pollQuestion = chunks.length > 1 ? `${question} · ${index + 1}/${chunks.length}` : question;
      const sent = await this._attemptTextSend(pollQuestion, () => this.client.sendPoll({
        ...target(this.profile),
        question: pollQuestion,
        options: chunk.map((choice) => choice.label),
      }, { operationId: outboundOperationId(this.profile.chatGuid, `${operationScope}:part:${index}`) }));
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
      this.router.registerPoll(normalized.guid, mapping);
    }
    return { sent: true, status: "SENT", terminal: true, parts: guids.length, guids, attempted: true };
  }

  async _sendNativeMenu(event) {
    const menu = event?.kind === "service.directory" ? directoryChoices(event, this.now()) : menuChoices(event, this.now());
    if (!menu.question || !menu.choices.length) {
      return { sent: false, status: "NO_POLL", terminal: false, parts: 0, guids: [], attempted: false };
    }
    return this._sendChoicePolls(menu.question, menu.choices);
  }

  sendThreadPicker(command, items, options = {}) {
    const normalizedCommand = clean(command).toLowerCase();
    const choices = (items || []).map((thread) => taskChoice(thread, {
      kind: "control",
      command: normalizedCommand,
      threadId: clean(thread?.id),
    }, this.now())).filter(Boolean);
    const question = clean(options.question) || `${normalizedCommand ? `/${normalizedCommand}` : "Choose"} task`;
    return this._enqueue(() => this._sendChoicePolls(question, choices));
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
    if (!threadId && ["service.directory", "service.menu"].includes(event?.kind)) {
      const menuResult = await this._sendNativeMenu(event);
      if (menuResult.sent || menuResult.attempted) return menuResult;
    }
    let rootGuid = threadId ? clean(this.router.nativeThread(threadId)?.rootGuid) : "";
    const intents = renderRichOutboundIntents(event, {
      // Native Messages reply threads carry the task context. Rendering as if
      // the event's own task were active prevents presentation.ts from adding
      // a second title to every bubble.
      presentation: { context: { activeThread: threadId ? event.thread : (options.activeThread || this.activeThread) } },
      capabilities: this.richCapabilities(),
    });
    const guids = [];
    for (let index = 0; index < intents.length; index += 1) {
      let intent = intents[index];
      let establishingRoot = Boolean(threadId && !rootGuid);
      if (establishingRoot && intent.kind === "poll") {
        const header = richTextIntent(taskHeader(event.thread), { richText: this.richCapabilities().richText });
        const rootResult = await this._sendText(header, {
          effect: options.effect,
          subject: options.subject,
          operationId: outboundOperationId(this.profile.chatGuid, id && `${id}:root`),
        });
        const normalizedRoot = resultStatus(rootResult);
        if (!normalizedRoot.sent || !normalizedRoot.guid) {
          if (id && rootResult?.classification !== "accepted") {
            this.router.recordOutboundReceipt(id, { classification: rootResult?.classification || "unsupported", guids });
          }
          return {
            sent: false,
            status: normalizedRoot.sent ? "ROOT_GUID_MISSING" : normalizedRoot.status,
            terminal: false,
            parts: guids.length,
            guids,
          };
        }
        rootGuid = normalizedRoot.guid;
        guids.push(rootGuid);
        this.router.routeOutboundGuid(rootGuid, threadId, { root: true });
        establishingRoot = false;
      } else if (establishingRoot && intent.kind === "text") {
        intent = richTextIntent(`${taskHeader(event.thread)}\n\n${intent.fallbackText}`, {
          richText: this.richCapabilities().richText,
          event,
        });
      }
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
        if (threadId) {
          this.router.routeOutboundGuid(normalized.guid, threadId, { root: establishingRoot });
          if (establishingRoot) rootGuid = normalized.guid;
        }
      }
      if (!normalized.sent || (establishingRoot && !normalized.guid)) {
        if (id && !(establishingRoot && result?.classification === "accepted")) {
          this.router.recordOutboundReceipt(id, { classification: result?.classification || "unsupported", guids });
        }
        return {
          ...normalized,
          sent: false,
          status: normalized.sent ? "ROOT_GUID_MISSING" : normalized.status,
          terminal: false,
          parts: guids.length,
          guids,
        };
      }
    }
    if (id) this.router.recordOutboundReceipt(id, { classification: "accepted", guids });
    if (["thread.output", "thread.completed"].includes(event?.kind)
      || (event?.kind === "thread.live-message" && event.role === "assistant" && event.phase !== "commentary")
      || event?.kind === "service.notice") {
      await this.setThreadTyping(threadId, false);
    }
    return { sent: intents.length > 0, status: "SENT", terminal: true, parts: intents.length, guids };
  }

  publishImages(thread, files, options = {}) {
    return this._enqueue(() => this._publishImages(thread, files, options));
  }

  async _publishImages(thread, files, options = {}) {
    const threadId = clean(thread?.id);
    const imageScope = clean(options.deliveryId || options.replyToGuid)
      || `row:${this.router.lastRowId || "startup"}`;
    if (options.proactive === true && this.router.shouldPauseIncoming?.(threadId)) {
      return { sent: false, status: "AWAITING_PROMPT", terminal: false, guids: [] };
    }
    const guids = [];
    let rootGuid = threadId ? clean(this.router.nativeThread(threadId)?.rootGuid) : "";
    if (threadId && !rootGuid && (files || []).length) {
      const header = richTextIntent(taskHeader(thread), { richText: this.richCapabilities().richText });
      const rootResult = await this._sendText(header, {
        operationId: outboundOperationId(this.profile.chatGuid, `images:${threadId}:${imageScope}:root`),
      });
      const normalizedRoot = resultStatus(rootResult);
      if (!normalizedRoot.sent || !normalizedRoot.guid) {
        return {
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
  pollOptionMap,
  eventId,
  exactURL,
  outboundOperationId,
  taskHeader,
});
