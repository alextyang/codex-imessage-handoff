#!/usr/bin/env node
import os from "node:os";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readConfig } from "./config.mjs";
import { findThreadBySource, listThreads } from "./thread-store.mjs";
import {
  assertClaimedThreadUnchanged,
  assertThreadReadyForIMessageRun,
  captureThreadRunCheckpoint,
  getThreadDetail,
  getLatestRequest,
  getTurn,
  getHistory,
  readThreadHistory,
} from "./thread-history.mjs";
import { buildThreadDirectory } from "./thread-directory.mjs";
import {
  getDefaultReasoning,
  getReasoningOverride,
  listDefaultReasoningOptions,
  listReasoningOptions,
  reasoningAwarenessReaction,
  REASONING_PRESENTATION,
  setDefaultReasoning,
  setReasoningOverride,
} from "./thread-settings.mjs";
import { ImsgTransport } from "./imsg-transport.mjs";
import { LocalUserMirrorSender } from "./local-user-mirror-sender.mjs";
import { safeImsgFailureDetails } from "./imsg-rpc-diagnostics.mjs";
import { RemoteControlCodexRuntime } from "./remote-control-runner.mjs";
import {
  RemoteControlAvailability,
  remoteControlPresenceState,
} from "./remote-control-availability.mjs";
import { normalizeCreatedThread } from "./new-thread-catalog.mjs";
import { readSidebarTitleRecords } from "./sidebar-title-index.mjs";
import { SidebarTitleArbiter } from "./sidebar-title-arbiter.mjs";
import { RunManager } from "./run-manager.mjs";
import { RolloutActivityMonitor } from "./rollout-activity-monitor.mjs";
import { RolloutReconcileScheduler } from "./rollout-reconcile-scheduler.mjs";
import { ServerRequestBroker } from "./server-request-broker.mjs";
import { FailureQueue } from "./failure-queue.mjs";
import { isImmediateLocalAction, isTerminalLocalActionFailure, LocalActionDispatch } from "./local-action-dispatch.mjs";
import { loadClaimedJobs, markClaimedJobState, removeClaimedJob, saveClaimedJob } from "./claimed-store.mjs";
import { admitClaimedJob } from "./claimed-job-admission.mjs";
import { unconfirmedRecoveryDisposition } from "./recovered-run-policy.mjs";
import { CompletionMonitor } from "./completion-monitor.mjs";
import { MultiLiveMirror } from "./multi-live-mirror.mjs";
import { LiveMirrorRetryBackoff } from "./live-mirror-backoff.mjs";
import { servicePaths } from "./paths.mjs";
import { ServiceReadiness } from "./service-readiness.mjs";
import { PresenceTracker } from "./presence-tracker.mjs";
import { shouldSuppressSubmittedUserMirror, submittedUserMirrorMode } from "./submitted-user-mirror-policy.mjs";
import { NewThreadFlowStore } from "./new-thread-flow.mjs";
import {
  resumeNewProjectSelection,
  resumeNewPromptCollection,
  resumeNewThreadCreation,
} from "./new-thread-orchestration.mjs";
import {
  settleLocalActionOutcome,
} from "./local-action-settlement.mjs";
import { projectIdentityEmoji, statusGlyph } from "../../protocol/presentation.ts";
import {
  manualSelectionCancellationNotice,
  manualSelectionLease,
  presentManualSelection,
} from "./manual-selection-flow.mjs";

const paths = servicePaths();
const serviceReadiness = new ServiceReadiness(paths.serviceReadinessState);
serviceReadiness.markStarting();
const config = readConfig();
const imsgTransport = new ImsgTransport({ profile: config.imsg, stateFile: paths.imsgState, logger: log });
const localUserMirrorSender = new LocalUserMirrorSender({
  stateFile: paths.localUserMirrorState,
  router: imsgTransport.router,
  conversationKey: createHash("sha256").update(`imsg-chat:${config.imsg.chatGuid}`).digest("hex"),
});
serviceReadiness.setHealthCheck(() => imsgTransport.healthStatus());
const remoteControlAvailability = new RemoteControlAvailability();
serviceReadiness.setCapabilityCheck(() => ({
  remoteControl: remoteControlAvailability.snapshot(),
  localUserMirror: localUserMirrorSender.capabilityStatus(),
}));
const presenceTracker = new PresenceTracker(paths.presenceState);
const PRESENCE_OFFLINE_DEBOUNCE_MS = 30_000;
let presenceOfflineTimer = null;
function observePresence(state) {
  presenceTracker.observe(state, {
    active: imsgTransport.notificationStatus().active,
    deliver: (event) => sendOutbound(event),
  }).catch(() => log("A Codex presence transition remains pending."));
}
function observeRemoteControlAvailability(value) {
  serviceReadiness.refreshCapabilities();
  const state = remoteControlPresenceState(value);
  if (state === "online") {
    if (presenceOfflineTimer) clearTimeout(presenceOfflineTimer);
    presenceOfflineTimer = null;
    observePresence("online");
    return;
  }
  if (state !== "offline") {
    if (presenceOfflineTimer) clearTimeout(presenceOfflineTimer);
    presenceOfflineTimer = null;
    return;
  }
  if (presenceOfflineTimer) return;
  presenceOfflineTimer = setTimeout(() => {
    presenceOfflineTimer = null;
    if (remoteControlPresenceState(remoteControlAvailability.snapshot()) === "offline") observePresence("offline");
  }, PRESENCE_OFFLINE_DEBOUNCE_MS);
  presenceOfflineTimer.unref?.();
}
function markRemoteControlAvailable() {
  observeRemoteControlAvailability(remoteControlAvailability.observeAvailable());
}
function markRemoteControlFailure(error) {
  observeRemoteControlAvailability(remoteControlAvailability.observeFailure(error));
}
const completions = new CompletionMonitor(paths.completionState);
const multiLiveMirror = new MultiLiveMirror({ stateDirectory: paths.multiLiveMirrorState });
const liveMirrorBackoffs = new Map();
const failedRuns = new FailureQueue();
const newThreadFlows = new NewThreadFlowStore();
const localActionContext = new AsyncLocalStorage();
const codexRuntime = new RemoteControlCodexRuntime();
const retryableCodexErrors = new Set([
  "CODEX_DISCONNECTED",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_REMOTE_PROTOCOL_ERROR",
  "CODEX_TIMEOUT",
  "CODEX_UNAVAILABLE",
  "CODEX_REMOTE_UNAVAILABLE",
  "CODEX_HOST_OFFLINE",
  "CODEX_HOST_UNAVAILABLE",
  "CODEX_REMOTE_ENROLLMENT_REQUIRED",
  "CODEX_REMOTE_PAIRING_REQUIRED",
  "CODEX_REMOTE_FORBIDDEN",
  "CODEX_AUTH_REQUIRED",
  "CODEX_AUTH_STALE",
]);

function clearServiceReadiness() {
  try { serviceReadiness.markStopped(); } catch {}
}

function createCodexRunner() {
  return codexRuntime.createRunner();
}

function shouldDeferCodexRun(error) {
  return error?.code === "BUSY" || retryableCodexErrors.has(error?.code);
}

const manualCodexRecoveryErrors = new Set([
  "CODEX_REMOTE_ENROLLMENT_REQUIRED",
  "CODEX_REMOTE_PAIRING_REQUIRED",
  "CODEX_REMOTE_FORBIDDEN",
  "CODEX_HOST_UNAVAILABLE",
  "CODEX_AUTH_REQUIRED",
  "CODEX_AUTH_STALE",
]);

function codexRetryPolicy(error) {
  if (error?.code === "BUSY") {
    return { key: "codex-busy", initialMs: 15_000, maxMs: 60_000, factor: 2 };
  }
  if (manualCodexRecoveryErrors.has(error?.code)) {
    return { key: "codex-setup", initialMs: 2 * 60_000, maxMs: 30 * 60_000, factor: 2 };
  }
  return { key: "codex-availability", initialMs: 15_000, maxMs: 5 * 60_000, factor: 2 };
}

function deferCodexRetry(context, error) {
  const policy = codexRetryPolicy(error);
  return context.deferWithBackoff(policy.key, policy);
}

const pendingNotices = new Set();
const claimingReplyIds = new Map();
const discardRetryTimers = new Map();
const ingestChains = new Map();
const ingestPendingCounts = new Map();
const ingestLatestAt = new Map();
const cancelledThrough = new Map();
let stopped = false;
let syncTimer = null;
let syncChain = Promise.resolve([]);
let settingsWarningLogged = false;
let catalogById = new Map();
const sidebarTitleArbiter = new SidebarTitleArbiter();
let completionMonitoringStarted = false;
let completionScanInFlight = null;
let completionScanRequested = false;
const liveMirrorRetryTimers = new Map();
let releaseStartupWork;
let startupWorkReleased = false;
const startupWorkReady = new Promise((resolve) => { releaseStartupWork = resolve; });

function allowStartupWork() {
  if (startupWorkReleased) return;
  startupWorkReleased = true;
  releaseStartupWork();
}

async function deliverLocalCompletion(completion) {
  const thread = catalogById.get(String(completion.threadId || ""));
  if (thread) await imsgTransport.setThreadTyping(thread.id, false).catch(() => {});
  const activity = await notificationStatus();
  if (activity?.active !== true) return { status: activity?.status || "INACTIVE" };
  if (thread && imsgTransport.router.shouldPauseIncoming(thread.id)) return { status: "AWAITING_PROMPT" };
  const listening = thread ? imsgTransport.router.nativeThread(thread.id)?.listen === true : false;
  if (thread && !listening && imsgTransport.router.isThreadMuted(thread.id)) {
    imsgTransport.router.consumeThreadListen(thread.id);
    return { status: "SUPPRESSED_INACTIVE" };
  }
  if (thread) {
    const mirror = await drainSelectedLiveMirror(thread);
    if (mirror.pending) return { status: "IN_PROGRESS" };
  }
  const label = thread
    ? threadLabel(thread)
    : { id: completion.threadId, title: "Codex task", projectLabel: "Codex" };
  const result = await sendOutbound({
    kind: "thread.completed",
    completionId: completion.completionId,
    thread: label,
    body: completion.body,
    completedAt: completion.completedAt,
  }, { signal: AbortSignal.timeout(15_000), proactive: true });
  if (result?.terminal !== false && thread) imsgTransport.router.consumeThreadListen(thread.id);
  return result;
}

async function scanKnownCompletions() {
  if (catalogById.size === 0) return;
  await completions.reconcile([...catalogById.values()], { deliver: deliverLocalCompletion });
}

function scheduleCompletionScan() {
  if (!completionMonitoringStarted) return;
  if (completionScanInFlight) {
    completionScanRequested = true;
    return;
  }
  completionScanRequested = false;
  completionScanInFlight = scanKnownCompletions()
    .catch(() => log("Completion synchronization failed; will retry."))
    .finally(() => {
      completionScanInFlight = null;
      if (completionScanRequested) queueMicrotask(scheduleCompletionScan);
    });
}

async function deliverLiveMessage(message) {
  const thread = catalogById.get(message.threadId);
  if (!thread) return { status: "STALE_SELECTION" };
  if (imsgTransport.router.shouldPauseIncoming(thread.id)) return { status: "AWAITING_PROMPT" };
  if (message.role === "user") {
    // A Desktop-started turn appears in the rollout before the slower catalog
    // state refresh. Track it immediately so the current default task exposes
    // native typing within the live-mirror polling window.
    await imsgTransport.setThreadTyping(thread.id, true).catch(() => {});
    if (imsgTransport.router.isThreadMuted(thread.id)) return { status: "INACTIVE" };
    // A focused Codex window is not proof that it owns the app-server
    // connection which started this turn. Fail open to Messages visibility so
    // cross-connection work is never silent in both interfaces.
    let rootGuid = imsgTransport.router.nativeThread(thread.id)?.rootGuid || "";
    if (!rootGuid) {
      const header = await sendOutbound({
        kind: "thread.header",
        deliveryId: `local-user-mirror-root:${thread.id}`,
        thread: threadLabel(thread),
      }, { signal: AbortSignal.timeout(15_000), proactive: true });
      rootGuid = imsgTransport.router.nativeThread(thread.id)?.rootGuid || "";
      if (!rootGuid) return header;
    }
    let local;
    try {
      local = await localUserMirrorSender.sendMirror({
        deliveryId: message.deliveryId,
        threadId: thread.id,
        rootGuid,
        body: message.body,
        phase: message.phase,
      });
    } finally {
      // An authoritative bridge GUID may prove that body-matched rows parked
      // by the receiver were genuine user input. Their actions are already in
      // the durable inbox; enqueue them immediately, while startup replay
      // remains the crash fallback. LocalActionDispatch deduplicates overlap
      // with the live watch without exposing message content here.
      for (const action of imsgTransport.router.drainReleasedUserMirrorActions()) {
        queueLocalAction(action).catch(() => {});
      }
    }
    if (local.sent) return local;
    if (local.classification === "dead-letter") {
      // Do not replay an unverified side effect through another sender. A
      // content-free, task-scoped notice makes the rare failure visible while
      // allowing later live messages to advance in strict rollout order.
      return sendOutbound({
        kind: "service.notice",
        code: "needs-attention",
        deliveryId: `local-user-mirror-unverified:${message.deliveryId}`,
        thread: threadLabel(thread),
        body: "⚠️ **User-message mirror not verified**\n\nThe task still ran in Codex. Use /turn to view the current turn.",
      }, { signal: AbortSignal.timeout(15_000), proactive: true });
    }
    // Ambiguous local sends deliberately hold the durable rollout cursor. A
    // repeat presents the same delivery id to the sender journal, which only
    // reconciles exact GUID/root evidence and never blindly sends again.
    if (local.retryable === true) return local;
    if (local.fallbackSafe !== true) return local;
    // Rich mode is optional to core Codex/iMessage health. If it is unavailable
    // before any local send attempt, retain the prior service-side mirror so a
    // user turn is never silently lost.
  } else if (!imsgTransport.router.nativeThread(thread.id)?.listen) {
    return { status: "INACTIVE" };
  }
  return sendOutbound({
    kind: "thread.live-message",
    messageId: message.deliveryId,
    thread: threadLabel(thread),
    role: message.role,
    phase: message.phase,
    body: message.body,
    at: message.createdAt,
  }, { signal: AbortSignal.timeout(15_000), proactive: true });
}

function liveMirrorBackoffFor(threadIdValue) {
  const threadId = String(threadIdValue || "").trim();
  if (!threadId) throw new TypeError("A task id is required for live-mirror retry state.");
  let backoff = liveMirrorBackoffs.get(threadId);
  if (!backoff) {
    backoff = new LiveMirrorRetryBackoff();
    liveMirrorBackoffs.set(threadId, backoff);
  }
  return backoff;
}

function clearLiveMirrorRetryTimer(threadIdValue) {
  const threadId = String(threadIdValue || "").trim();
  const timer = liveMirrorRetryTimers.get(threadId);
  if (!timer) return;
  clearTimeout(timer);
  liveMirrorRetryTimers.delete(threadId);
}

function resetLiveMirrorRetry(threadIdValue) {
  const threadId = String(threadIdValue || "").trim();
  clearLiveMirrorRetryTimer(threadId);
  liveMirrorBackoffFor(threadId).reset();
}

function scheduleLiveMirrorRetry(threadIdValue) {
  const threadId = String(threadIdValue || "").trim();
  if (stopped || !threadId || !catalogById.has(threadId) || liveMirrorRetryTimers.has(threadId)) return;
  const timer = setTimeout(() => {
    liveMirrorRetryTimers.delete(threadId);
    if (stopped) return;
    if (!catalogById.has(threadId)) {
      liveMirrorBackoffs.delete(threadId);
      return;
    }
    liveMirrorScheduler.scheduleThread(threadId);
  }, Math.max(10, liveMirrorBackoffFor(threadId).remaining()));
  liveMirrorRetryTimers.set(threadId, timer);
  timer.unref?.();
}

function recordLiveMirrorFailure(threadIdValue) {
  const threadId = String(threadIdValue || "").trim();
  const delay = liveMirrorBackoffFor(threadId).recordFailure();
  scheduleLiveMirrorRetry(threadId);
  return delay;
}

function pruneLiveMirrorRetryState(threads) {
  const currentIds = new Set((Array.isArray(threads) ? threads : []).map((thread) => String(thread?.id || "")));
  for (const threadId of liveMirrorRetryTimers.keys()) {
    if (!currentIds.has(threadId)) clearLiveMirrorRetryTimer(threadId);
  }
  for (const threadId of liveMirrorBackoffs.keys()) {
    if (!currentIds.has(threadId)) liveMirrorBackoffs.delete(threadId);
  }
}

async function scanLiveMirrorThread(thread) {
  const threadId = String(thread?.id || "");
  const current = catalogById.get(threadId);
  if (!current) return;
  const backoff = liveMirrorBackoffFor(threadId);
  if (!backoff.ready()) {
    scheduleLiveMirrorRetry(threadId);
    return;
  }
  try {
    const result = await multiLiveMirror.reconcile(current, { deliver: deliverLiveMessage });
    if (result.retryable > 0) recordLiveMirrorFailure(threadId);
    else resetLiveMirrorRetry(threadId);
  } catch (error) {
    recordLiveMirrorFailure(threadId);
    throw error;
  }
}

const liveMirrorScheduler = new RolloutReconcileScheduler({
  maxConcurrent: 4,
  runThread: scanLiveMirrorThread,
  onError: () => log("Live task synchronization failed; will retry."),
});

function scheduleLiveMirrorScan(activity = null) {
  if (stopped) return;
  liveMirrorScheduler.schedule(activity || { source: "full" });
}

const rolloutActivity = new RolloutActivityMonitor({
  root: paths.sessions,
  onActivity: (activity) => {
    scheduleLiveMirrorScan(activity);
    scheduleCompletionScan();
  },
});

async function drainSelectedLiveMirror(thread) {
  if (!thread) return { pending: false };
  const backoff = liveMirrorBackoffFor(thread.id);
  if (imsgTransport.router.shouldPauseIncoming(thread.id)) return { pending: true };
  if (!backoff.ready()) {
    scheduleLiveMirrorRetry(thread.id);
    return { pending: true };
  }
  const result = await multiLiveMirror.drain(thread, { deliver: deliverLiveMessage, maxPasses: 16 });
  if (result.retryable > 0) recordLiveMirrorFailure(thread.id);
  else if (!result.pending) resetLiveMirrorRetry(thread.id);
  return { pending: result.pending === true };
}

async function settleLiveSuppression(event, thread, { forceClear = false } = {}) {
  const token = typeof event?.mirrorSuppressionToken === "string"
    ? event.mirrorSuppressionToken
    : null;
  let drain = { pending: false };
  let cleared = false;
  try {
    drain = await drainSelectedLiveMirror(thread);
  } catch {
    if (thread?.id) recordLiveMirrorFailure(thread.id);
    drain = { pending: true };
  } finally {
    if (token && (forceClear || !drain.pending)) {
      multiLiveMirror.clearSuppression(token);
      if (event) event.mirrorSuppressionToken = null;
      cleared = true;
    }
  }
  return { cleared, pending: drain.pending };
}

function outboundOutcome(result) {
  const status = String(result?.status ?? result?.notification?.status ?? "").toUpperCase();
  return {
    status,
    terminal: result?.sent === true
      || result?.notification?.sent === true
      || ["DUPLICATE", "INACTIVE", "STALE_SELECTION", "NO_BINDING"].includes(status),
  };
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function sendOutbound(event, options = {}) {
  if (event?.thread?.id) {
    try {
      const sidebarRecords = await readSidebarTitleRecords(paths.sessionIndex);
      applyCanonicalThreadTitle(event.thread, sidebarRecords.get(String(event.thread.id)), { source: "index" });
    } catch {
      // Title refresh is presentation-only. A transient index read must not
      // block an otherwise durable local Messages delivery.
    }
  }
  const action = localActionContext.getStore();
  const outboundEvent = action && !event.deliveryId && !event.completionId && !event.messageId
    ? { ...event, deliveryId: `local-action:${action.messageKey}:${action.sequence++}` }
    : event;
  const result = await imsgTransport.outbound(outboundEvent, options);
  if (result?.terminal === false) {
    throw Object.assign(new Error("The local iMessage send remains pending."), {
      code: result.status || "IMSG_DELIVERY_PENDING",
      ...safeImsgFailureDetails(result),
    });
  }
  return result;
}

async function notificationStatus() {
  return imsgTransport.notificationStatus();
}

async function publishImages(thread, files, options = {}) {
  const result = await imsgTransport.publishImages(thread, files, options);
  if (result?.terminal === false) {
    throw Object.assign(new Error("The local iMessage attachment send remains pending."), {
      code: result.status || "IMSG_DELIVERY_PENDING",
      ...safeImsgFailureDetails(result),
    });
  }
  return result;
}

async function updateThreadStatus(thread, status) {
  return { ok: true, threadId: thread?.id || null, status };
}

function threadLabel(thread) {
  const state = effectiveState(thread);
  const reasoning = reasoningPolicy(thread);
  return {
    id: thread.id,
    title: thread.title,
    sidebarTitle: thread.sidebarTitle || null,
    createdAt: thread.createdAt,
    projectKey: thread.projectKey,
    projectLabel: thread.projectLabel,
    projectStartedAt: thread.projectStartedAt,
    status: state.status,
    stateSince: state.stateSince,
    activityAt: thread.lastTurnAt || thread.activityAt || thread.updatedAt,
    pendingCount: state.pendingCount,
    reasoningEffort: reasoning.effort,
    reasoningSource: reasoning.source,
    muted: imsgTransport.router.isThreadMuted(thread.id),
    listening: imsgTransport.router.nativeThread(thread.id)?.listen === true,
  };
}

function applyCanonicalThreadTitle(thread, value, options = {}) {
  if (!thread?.id) return false;
  const id = String(thread.id);
  const title = sidebarTitleArbiter.resolve(id, value, options);
  if (!title) return false;
  thread.title = title;
  thread.sidebarTitle = title;
  const catalogThread = catalogById.get(id);
  if (catalogThread) {
    catalogThread.title = title;
    catalogThread.sidebarTitle = title;
  }
  return true;
}

const serverRequests = new ServerRequestBroker({
  logger: log,
  sendText: async ({ threadId, deliveryId, body }) => {
    const thread = catalogById.get(String(threadId || ""));
    if (!thread) {
      throw Object.assign(new Error("The task for this Codex interaction is no longer available."), {
        code: "CODEX_INTERACTION_THREAD_MISSING",
      });
    }
    return sendOutbound({
      kind: "service.notice",
      deliveryId,
      code: "needs-attention",
      thread: threadLabel(thread),
      body,
    });
  },
  sendChoices: async ({ threadId, deliveryId, question, choices, allowOther, otherToken }) => {
    const thread = catalogById.get(String(threadId || ""));
    if (!thread) {
      throw Object.assign(new Error("The task for this Codex interaction is no longer available."), {
        code: "CODEX_INTERACTION_THREAD_MISSING",
      });
    }
    const result = await imsgTransport.sendActionPicker(
      question,
      choices.map((choice) => ({
        label: choice.label,
        action: {
          kind: "control",
          command: "respond",
          threadId: thread.id,
          argument: choice.token,
        },
      })),
      {
        threadId: thread.id,
        operationScope: deliveryId,
        allowAddedChoiceSearch: allowOther === true,
        ...(allowOther && otherToken ? {
          addedChoiceAction: {
            kind: "control",
            command: "respond",
            threadId: thread.id,
            commandArgument: otherToken,
          },
        } : {}),
      },
    );
    if (result?.terminal === false || result?.sent !== true) {
      throw Object.assign(new Error("The Codex interaction choices could not be delivered in the task reply thread."), {
        code: result?.status || "IMSG_INTERACTION_PENDING",
        ...safeImsgFailureDetails(result),
      });
    }
    return result;
  },
});

function outboundReasoningOptions(options) {
  return options.map((option) => option.value === "default"
    ? { ...option, value: "none", label: "↩️ Use default" }
    : {
      ...option,
      label: `${REASONING_PRESENTATION[option.value]?.emoji || "🧠"} ${REASONING_PRESENTATION[option.value]?.label || option.label}`,
    });
}

function effectiveState(thread) {
  const queued = runs.state(thread.id);
  const receivingCount = ingestPendingCounts.get(thread.id) || 0;
  const receivingAt = ingestLatestAt.get(thread.id) || null;
  const failures = failedRuns.list(thread.id);
  const failure = failures[0] || null;
  const newestFailure = failures.at(-1) || null;
  const latestCandidates = [
    queued && queued.latestRequestAt ? { body: queued.latestRequest, at: queued.latestRequestAt } : null,
    receivingCount ? { body: "Receiving newest iMessage request…", at: receivingAt } : null,
    newestFailure ? { body: newestFailure.body, at: newestFailure.queuedAt } : null,
  ].filter(Boolean).sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
  const observed = failure || thread.state === "aborted"
    ? "error"
    : thread.state === "running"
      ? "working"
      : receivingCount
        ? "pending"
        : "idle";
  return {
    status: queued?.status || observed,
    stateSince: queued?.stateSince || receivingAt || thread.stateSince || thread.activityAt || thread.updatedAt,
    pendingCount: (queued?.pendingCount || 0) + receivingCount,
    request: queued ? queued.request : failure?.body ?? null,
    requestAt: queued?.requestAt || failure?.queuedAt || null,
    latestRequest: latestCandidates[0]?.body ?? null,
    latestRequestAt: latestCandidates[0]?.at ?? null,
  };
}

function reasoningPolicy(thread) {
  try {
    const supported = new Set(listReasoningOptions(thread)
      .map((option) => option.value)
      .filter((value) => value !== "default"));
    const override = getReasoningOverride(thread.id);
    if (override && supported.has(override)) return { effort: override, source: "task-override" };
    const serviceDefault = getDefaultReasoning();
    if (serviceDefault && supported.has(serviceDefault)) return { effort: serviceDefault, source: "service-default" };
    if (thread.reasoningEffort) return { effort: thread.reasoningEffort, source: "codex-task" };
    return { effort: null, source: "codex-default" };
  } catch {
    if (!settingsWarningLogged) {
      settingsWarningLogged = true;
      log("Thread reasoning settings are invalid; using Codex task defaults.");
    }
    return thread.reasoningEffort
      ? { effort: thread.reasoningEffort, source: "codex-task" }
      : { effort: null, source: "codex-default" };
  }
}

function effectiveReasoning(thread) {
  return reasoningPolicy(thread).effort;
}

async function synchronizeNow() {
  const threads = await listThreads(500);
  const sidebarRecords = await readSidebarTitleRecords(paths.sessionIndex);
  for (const thread of threads) {
    applyCanonicalThreadTitle(thread, sidebarRecords.get(thread.id), { source: "index" });
  }
  catalogById = new Map(threads.map((thread) => [thread.id, thread]));
  pruneLiveMirrorRetryState(threads);
  liveMirrorScheduler.replaceCatalog(threads);
  multiLiveMirror.activateCatalog(threads, { resume: true, clearMissing: true });
  await imsgTransport.syncWorkingThreads(
    threads.filter((thread) => effectiveState(thread).status === "working").map((thread) => thread.id),
  );
  scheduleCompletionScan();
  scheduleLiveMirrorScan();
  return threads;
}

function synchronize() {
  syncChain = syncChain.catch(() => []).then(synchronizeNow);
  return syncChain;
}

function scheduleSynchronize(delay = 150) {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    synchronize().catch(() => log("Catalog synchronization failed; will retry."));
  }, delay);
  syncTimer.unref?.();
}

async function publishFailure(thread, error, deliveryId = null) {
  imsgTransport.router.consumeThreadListen(thread.id);
  const body = error?.code === "MISSING_CWD"
    ? "This task’s project folder is no longer available.\n\n/threads"
    : "Codex could not complete this request.\n\n/retry · /turn · /threads";
  await sendOutbound({
    kind: "service.notice",
    ...(deliveryId ? { deliveryId } : {}),
    code: "needs-attention",
    thread: threadLabel(thread),
    body,
  });
}

async function discardReply(event) {
  await settleLiveSuppression(event, catalogById.get(String(event.threadId || "")), { forceClear: true });
  try { markClaimedJobState(event.replyId, "cancelled"); } catch {}
  removeClaimedJob(event.replyId);
  failedRuns.remove(event.threadId, event.replyId);
  pendingNotices.delete(event.replyId);
}

async function deliverCompleted(event, thread) {
  const delivery = event.delivery;
  if (!delivery.textDelivered) {
    const result = await sendOutbound(
      { kind: "thread.output", deliveryId: `run:${event.replyId}:output`, thread: threadLabel(thread), body: delivery.body },
      { replyToGuid: event.imsgGuid },
    );
    if (!outboundOutcome(result).terminal) {
      throw Object.assign(new Error("The completed result has not been accepted by the message transport."), { code: "DELIVERY_PENDING" });
    }
    delivery.textDelivered = true;
    saveClaimedJob(event, "delivering");
  }
  const generatedImages = Array.isArray(delivery.generatedImages) ? delivery.generatedImages : [];
  let imagesDelivered = Math.max(0, Math.min(generatedImages.length, Number(delivery.imagesDelivered) || 0));
  while (imagesDelivered < generatedImages.length) {
    const result = await publishImages(thread, [generatedImages[imagesDelivered]], {
      replyToGuid: event.imsgGuid,
      deliveryId: `run:${event.replyId}:image:${imagesDelivered}`,
    });
    if (!outboundOutcome(result).terminal) {
      throw Object.assign(new Error("A generated image has not been accepted by the message transport."), { code: "DELIVERY_PENDING" });
    }
    imagesDelivered += 1;
    delivery.imagesDelivered = imagesDelivered;
    saveClaimedJob(event, "delivering");
  }
  await updateThreadStatus(thread, "idle");
  imsgTransport.router.consumeThreadListen(thread.id);
  failedRuns.remove(thread.id, event.replyId);
  removeClaimedJob(event.replyId);
}

async function executeReply(event, context) {
  // Restored reply IDs must occupy the run manager before a local watch can
  // replay the same durable Messages event. Keep their actual work paused until
  // transport validation, subscription, and pending-action replay are complete.
  await startupWorkReady;
  if (stopped) return;

  const thread = catalogById.get(String(event.threadId || ""));
  if (!thread) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available, so the message was not run.\n\n/threads" });
    await discardReply(event);
    return;
  }

  if (event.reconcileRunning && !event.delivery) {
    const prompt = String(event.claimed?.reply?.body || "");
    const history = readThreadHistory(thread);
    const candidates = [history.currentTurn, ...(history.completedTurns || [])].filter(Boolean);
    let matchingTurn = event.clientUserMessageId
      ? candidates.find((turn) => turn.clientUserMessageId === event.clientUserMessageId) || null
      : null;
    let recoveryLookupError = null;
    if (!matchingTurn && event.clientUserMessageId) {
      try {
        const recoveryReader = createCodexRunner();
        matchingTurn = await recoveryReader.findTurnByClientUserMessageId(
          thread.id,
          event.clientUserMessageId,
        );
        context.resetDeferBackoff();
        markRemoteControlAvailable();
      } catch (error) {
        recoveryLookupError = error;
        markRemoteControlFailure(error);
        // The rollout may still materialize while the Remote Control RPC connection is
        // recovering. Continue the bounded observation window without ever
        // resubmitting the ambiguous prompt automatically.
        log(`Exact recovery lookup for ${thread.id} is not available (${error?.code || "UNKNOWN"}).`);
      }
    }
    if (!matchingTurn && event.legacyClientUserMessageId) {
      const queuedAtMs = Date.parse(String(event.queuedAt || ""));
      matchingTurn = candidates.find((turn) => {
        if (String(turn.request || "") !== prompt) return false;
        const startedAtMs = Date.parse(String(turn.startedAt || ""));
        return !Number.isFinite(queuedAtMs)
          || (Number.isFinite(startedAtMs) && startedAtMs >= queuedAtMs - 5_000);
      }) || null;
    }
    if (matchingTurn?.state === "running") {
      context.resetDeferBackoff();
      event.recoveredTurnId = String(matchingTurn.id || "");
      event.recoveryMissingSince = null;
      if (!event.recoveredTurnId) {
        throw Object.assign(new Error("The recovered Codex turn has no canonical turn id."), { code: "RECOVERED_TURN_INVALID" });
      }
      context.setCancel(() => {
        try {
          createCodexRunner().cancelRecoveredTurn(thread.id, event.recoveredTurnId)
            .catch(() => log(`Recovered turn ${event.recoveredTurnId} could not be interrupted.`));
        } catch {
          log(`Recovered turn ${event.recoveredTurnId} could not be interrupted.`);
        }
      });
      context.defer(2000);
      saveClaimedJob(event, "running");
      return;
    }
    if (matchingTurn?.finalResponse) {
      context.resetDeferBackoff();
      event.delivery = {
        body: matchingTurn.finalResponse,
        generatedImages: [],
        textDelivered: false,
        imagesDelivered: 0,
      };
      event.reconcileRunning = false;
      event.recoveryMissingSince = null;
      saveClaimedJob(event, "delivering");
    } else if (matchingTurn) {
      context.resetDeferBackoff();
      event.reconcileRunning = false;
      event.recoveryMissingSince = null;
      saveClaimedJob(event, "failed");
      failedRuns.record(thread.id, {
        body: prompt,
        images: event.claimed?.images || [],
        replyId: event.replyId,
        claimed: event.claimed,
        queuedAt: event.queuedAt,
        clientUserMessageId: event.clientUserMessageId,
        reasoningEffort: event.reasoningEffort || null,
      });
      await publishFailure(
        thread,
        Object.assign(new Error("The recovered Codex turn ended without a deliverable response."), { code: "RECOVERED_TURN_INCOMPLETE" }),
        `run:${event.replyId}:failure`,
      );
      return;
    } else {
      const recovery = unconfirmedRecoveryDisposition(event.recoveryMissingSince);
      event.recoveryMissingSince = recovery.missingSince;
      if (recovery.status === "observe") {
        if (recoveryLookupError && shouldDeferCodexRun(recoveryLookupError)) {
          const retry = deferCodexRetry(context, recoveryLookupError);
          log(`Exact recovery lookup for ${thread.id} will retry in ${retry.delayMs}ms (attempt ${retry.attempt}).`);
        } else {
          context.defer(recovery.retryAfterMs);
        }
        saveClaimedJob(event, "running");
        return;
      }
      // A daemon restart cannot prove whether an unobserved turn was accepted.
      // Fail closed into the explicit retry queue instead of submitting the
      // same prompt a second time.
      event.reconcileRunning = false;
      context.resetDeferBackoff();
      saveClaimedJob(event, "failed");
      failedRuns.record(thread.id, {
        body: prompt,
        images: event.claimed?.images || [],
        replyId: event.replyId,
        claimed: event.claimed,
        queuedAt: event.queuedAt,
        clientUserMessageId: event.clientUserMessageId,
        reasoningEffort: event.reasoningEffort || null,
      });
      await publishFailure(
        thread,
        Object.assign(new Error("The restarted service could not confirm whether Codex accepted this turn."), {
          code: "RECOVERED_TURN_UNCONFIRMED",
        }),
        `run:${event.replyId}:failure`,
      );
      return;
    }
  }

  if (event.delivery) {
    const managedSince = event.queuedAt || new Date().toISOString();
    completions.manage(thread.id, managedSince);
    completions.suppressNext(thread.id, String(event.delivery.body || ""), managedSince);
    try {
      const mirror = await settleLiveSuppression(event, thread);
      saveClaimedJob(event, "delivering");
      if (mirror.pending) {
        context.defer(Math.max(1000, liveMirrorBackoffFor(thread.id).remaining()));
        return;
      }
      await deliverCompleted(event, thread);
    } catch {
      context.defer(15000);
      saveClaimedJob(event, "delivering");
      log(`Completed output for ${thread.id} could not be delivered; will retry.`);
    } finally {
      completions.unmanage(thread.id);
    }
    return;
  }

  try {
    assertClaimedThreadUnchanged(thread, event);
  } catch (error) {
    if (error?.code !== "STALE_THREAD_ADVANCED" && error?.code !== "STALE_THREAD_CHECKPOINT") throw error;
    await settleLiveSuppression(event, thread, { forceClear: true });
    failedRuns.record(thread.id, {
      body: String(event.claimed?.reply?.body || ""),
      images: event.claimed?.images || [],
      replyId: event.replyId,
      claimed: event.claimed,
      queuedAt: event.queuedAt,
      clientUserMessageId: event.clientUserMessageId,
      reasoningEffort: event.reasoningEffort || null,
      mirrorSuppressionToken: null,
    });
    saveClaimedJob(event, "failed");
    await sendOutbound({
      kind: "service.notice",
      deliveryId: `run:${event.replyId}:stale`,
      code: "needs-attention",
      thread: threadLabel(thread),
      body: "Not run: this task changed in Codex while the message was waiting. Reply again to run it against the current task state.\n\n/turn · /threads",
    });
    scheduleSynchronize();
    return;
  }

  let claim = event.claimed;
  if (!claim) {
    const error = Object.assign(new Error("The local iMessage request is missing its durable payload."), { code: "MISSING_LOCAL_PAYLOAD" });
    markClaimedJobState(event.replyId, "failed");
    await publishFailure(thread, error, `run:${event.replyId}:failure`);
    return;
  }

  const reply = claim.reply || {};
  const images = (claim.images || []).filter((file) => existsSync(file));
  let runner = null;
  let cancelRequested = false;
  context.setCancel(() => {
    cancelRequested = true;
    runner?.cancel(thread.id);
  });
  let progressTimer = null;
  let pendingPhase = null;
  let lastProgressAt = Date.now();
  let lastPublishedPhase = null;
  let deferred = false;
  let managedCompletion = false;
  let runStartedAt = null;

  try {
    runner = createCodexRunner();
    await updateThreadStatus(thread, "working");
    await imsgTransport.setThreadTyping(thread.id, true);
    scheduleSynchronize();
    if (cancelRequested) {
      removeClaimedJob(event.replyId);
      failedRuns.remove(thread.id, event.replyId);
      await sendOutbound({ kind: "service.notice", code: "cancelled", thread: threadLabel(thread), body: "Stopped at your request." });
      await updateThreadStatus(thread, "idle");
      imsgTransport.router.consumeThreadListen(thread.id);
      return;
    }
    progressTimer = setInterval(async () => {
      if (!pendingPhase || pendingPhase === lastPublishedPhase || Date.now() - lastProgressAt < 30000) return;
      const phase = pendingPhase;
      lastPublishedPhase = phase;
      lastProgressAt = Date.now();
      try {
        await sendOutbound({ kind: "thread.progress", thread: threadLabel(thread), phase });
      } catch {
        log("Could not publish progress.");
      }
    }, 5000);
    progressTimer.unref?.();

    // Re-read the rollout at the last safe point before claiming this turn as
    // service-owned. This prevents a local Codex turn that began after the
    // catalog scan from receiving the same-thread iMessage prompt in parallel.
    // There is still a tiny check-to-submit race; Codex's session lock is the
    // final guard and is handled by the same BUSY deferral path below.
    assertThreadReadyForIMessageRun(thread);
    // Persist the stable app-server user-message id before turn/start can cross
    // the Remote Control stream. This is the recovery key after any process loss.
    saveClaimedJob(event, "running");
    if (shouldSuppressSubmittedUserMirror(claim) && !event.mirrorSuppressionToken) {
      event.mirrorSuppressionToken = multiLiveMirror.suppressUser(thread.id, String(reply.body || ""));
      if (event.mirrorSuppressionToken) saveClaimedJob(event, "running");
    }
    runStartedAt = new Date().toISOString();
    completions.manage(thread.id, runStartedAt);
    managedCompletion = true;
    const result = await runner.run({
      thread,
      prompt: String(reply.body || ""),
      images,
      clientUserMessageId: event.clientUserMessageId,
      reasoningEffort: event.reasoningEffort || effectiveReasoning(thread),
      onPhase: (phase) => { pendingPhase = phase; },
      onThreadNameUpdated: (title) => {
        applyCanonicalThreadTitle(thread, title, { source: "notification" });
      },
      onServerRequest: (descriptor, requestContext) => serverRequests.request(descriptor, requestContext),
    });
    // A completed Remote Control RPC is proof that the capability is back.
    // Reset every prior availability/setup attempt before persisting delivery.
    context.resetDeferBackoff();
    markRemoteControlAvailable();
    if (result.status === "cancelled") {
      await settleLiveSuppression(event, thread, { forceClear: true });
      removeClaimedJob(event.replyId);
      failedRuns.remove(thread.id, event.replyId);
      await sendOutbound({ kind: "service.notice", code: "cancelled", thread: threadLabel(thread), body: "Stopped at your request." });
      await updateThreadStatus(thread, "idle");
      imsgTransport.router.consumeThreadListen(thread.id);
    } else {
      event.delivery = { body: result.body, generatedImages: result.generatedImages || [], textDelivered: false, imagesDelivered: 0 };
      saveClaimedJob(event, "delivering");
      completions.suppressNext(thread.id, result.body, runStartedAt);
      const mirror = await settleLiveSuppression(event, thread);
      saveClaimedJob(event, "delivering");
      if (mirror.pending) {
        deferred = true;
        context.defer(Math.max(1000, liveMirrorBackoffFor(thread.id).remaining()));
        return;
      }
      await deliverCompleted(event, thread);
    }
  } catch (error) {
    if (event.delivery) {
      deferred = true;
      context.defer(15000);
      log(`Completed output for ${thread.id} could not be delivered; will retry.`);
    } else if (error?.turnOutcomeUnknown === true) {
      // turn/start crossed the process boundary, but its result or completion
      // was lost. Never put this back on the normal queue: exact-id recovery
      // must first prove whether Codex accepted and/or completed the turn.
      deferred = true;
      event.reconcileRunning = true;
      event.recoveredTurnId = typeof error.turnId === "string" ? error.turnId : null;
      event.recoveryMissingSince = null;
      markRemoteControlFailure(error);
      saveClaimedJob(event, "running");
      context.defer(1000);
      log(`Codex turn outcome for ${thread.id} is ambiguous; reconciling ${event.clientUserMessageId}.`);
    } else if (shouldDeferCodexRun(error)) {
      deferred = true;
      const pairingRequired = error?.code === "CODEX_REMOTE_PAIRING_REQUIRED";
      const setupRequired = manualCodexRecoveryErrors.has(error?.code);
      const hostOffline = error?.code === "CODEX_HOST_OFFLINE";
      if (error?.code === "BUSY") {
        // BUSY is an application-level response and therefore proves Remote
        // Control itself is online. Only the task-specific retry remains.
        context.resetDeferBackoff();
        markRemoteControlAvailable();
      } else {
        markRemoteControlFailure(error);
      }
      const retry = deferCodexRetry(context, error);
      await settleLiveSuppression(event, thread, { forceClear: true });
      const backendUnavailable = error?.code !== "BUSY";
      if (backendUnavailable) {
        log(`Codex Remote Control for ${thread.id} is unavailable (${error.code}); run remains pending for ${retry.delayMs}ms (attempt ${retry.attempt}).`);
      }
      const noticeKey = backendUnavailable ? "backendNoticeSent" : "busyNoticeSent";
      const shouldNotify = !event[noticeKey];
      if (shouldNotify) {
        event[noticeKey] = true;
      }
      saveClaimedJob(event, "queued");
      await updateThreadStatus(thread, "pending");
      if (shouldNotify) {
        await sendOutbound({
          kind: "service.notice",
          deliveryId: `run:${event.replyId}:${backendUnavailable ? "backend-queued" : "busy-queued"}`,
          code: "queued",
          thread: threadLabel(thread),
          body: pairingRequired
            ? "Remote access needs to be paired with Codex before this message can run. Open Settings → Connections → Control this Mac, then pair the iMessage client. Your message remains pending.\n\n‼️ Emphasize to stop · /thread"
            : setupRequired
            ? "Remote access needs attention on the Mac before this message can run. Your message remains pending.\n\n‼️ Emphasize to stop · /thread"
            : hostOffline
            ? "The Codex host is offline. Your message is pending and will start when it reconnects.\n\n‼️ Emphasize to stop · /thread"
            : backendUnavailable
            ? "Remote Control is reconnecting. Your message remains pending.\n\n‼️ Emphasize to stop · /thread"
            : "This task is already working locally. Your message is pending and will start when it is free.\n\n‼️ Emphasize to stop · /thread",
        });
      }
    } else {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "UNKNOWN";
      log(`Codex run for ${thread.id} failed (${code}).`);
      context.resetDeferBackoff();
      if (code.startsWith("CODEX_")) markRemoteControlFailure(error);
      await settleLiveSuppression(event, thread, { forceClear: true });
      failedRuns.record(thread.id, {
        body: String(reply.body || ""),
        images,
        replyId: event.replyId,
        claimed: event.claimed,
        queuedAt: event.queuedAt,
        clientUserMessageId: event.clientUserMessageId,
        reasoningEffort: event.reasoningEffort || null,
        mirrorSuppressionToken: null,
      });
      saveClaimedJob(event, "failed");
      await publishFailure(thread, error, `run:${event.replyId}:failure`);
      try { await updateThreadStatus(thread, "error"); } catch {}
    }
  } finally {
    try { runner?.close(); } catch { log(`Codex runner for ${thread.id} could not be released.`); }
    await imsgTransport.setThreadTyping(thread.id, false).catch(() => {});
    if (progressTimer) clearInterval(progressTimer);
    if (managedCompletion) completions.unmanage(thread.id);
    if (!deferred) delete event.claimed;
    if (!deferred) pendingNotices.delete(event.replyId);
    scheduleSynchronize();
  }
}

const runs = new RunManager({
  maxConcurrent: 3,
  run: executeReply,
  discard: discardReply,
  onChange: () => scheduleSynchronize(),
  onError: () => log("Queued Codex work failed unexpectedly."),
});

function enqueueReply(event) {
  if (!runs.enqueue(event)) return false;
  setTimeout(async () => {
    const state = runs.state(event.threadId);
    if (state?.status !== "pending" || pendingNotices.has(event.replyId)) return;
    pendingNotices.add(event.replyId);
    const thread = catalogById.get(String(event.threadId || ""));
    if (!thread) return;
    try {
      await sendOutbound({
        kind: "service.notice",
        deliveryId: `run:${event.replyId}:queued`,
        code: "queued",
        thread: threadLabel(thread),
        body: "Queued behind earlier iMessage work. Codex will start this message automatically.\n\n‼️ Emphasize to stop · /thread · /threads",
      });
    } catch {
      log("Could not publish pending state.");
    }
  }, 150).unref?.();
  return true;
}

function scheduleDiscardRetry(event, delay = 5000) {
  const replyId = String(event?.replyId || "");
  if (!replyId || discardRetryTimers.has(replyId) || stopped) return;
  const timer = setTimeout(() => {
    discardRetryTimers.delete(replyId);
    discardReply(event).catch(() => scheduleDiscardRetry(event, Math.min(30000, delay * 2)));
  }, delay);
  timer.unref?.();
  discardRetryTimers.set(replyId, timer);
}

async function ingestReply(event) {
  const replyId = String(event?.replyId || "");
  const threadId = String(event?.threadId || "");
  if (!replyId || !threadId || runs.has(replyId) || claimingReplyIds.has(replyId)) return;
  event.receivedAtMs ||= Date.now();
  event.queuedAt ||= event.createdAt || new Date().toISOString();
  if (!event.claimed) {
    throw Object.assign(new Error("The local iMessage request is missing its durable payload."), { code: "MISSING_LOCAL_PAYLOAD" });
  }
  event.threadCheckpoint ||= captureThreadRunCheckpoint(catalogById.get(threadId), event.queuedAt);
  claimingReplyIds.set(replyId, threadId);
  try {
    return await admitClaimedJob({
      persist: () => saveClaimedJob(event, "queued"),
      cancelled: () => (cancelledThrough.get(threadId) || 0) >= event.receivedAtMs,
      discard: () => discardReply(event),
      threadExists: () => catalogById.has(threadId),
      missingThread: () => sendOutbound({
        kind: "service.notice",
        code: "needs-attention",
        body: "That task is no longer available, so the message was not run.\n\n/threads",
      }),
      enqueue: () => enqueueReply(event),
    });
  } catch (error) {
    if (error?.status === 409) return "duplicate";
    throw error;
  } finally {
    claimingReplyIds.delete(replyId);
  }
}

function queueIngest(event) {
  const threadId = String(event?.threadId || "");
  if (!threadId) return;
  event.receivedAtMs ||= Date.now();
  event.queuedAt ||= event.createdAt || new Date().toISOString();
  ingestPendingCounts.set(threadId, (ingestPendingCounts.get(threadId) || 0) + 1);
  if (!ingestLatestAt.get(threadId) || String(event.queuedAt).localeCompare(String(ingestLatestAt.get(threadId))) > 0) {
    ingestLatestAt.set(threadId, event.queuedAt);
  }
  const previous = ingestChains.get(threadId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => ingestReply(event));
  ingestChains.set(threadId, current);
  current.finally(() => {
    const remaining = (ingestPendingCounts.get(threadId) || 1) - 1;
    if (remaining > 0) ingestPendingCounts.set(threadId, remaining);
    else {
      ingestPendingCounts.delete(threadId);
      ingestLatestAt.delete(threadId);
    }
    if (ingestChains.get(threadId) === current) ingestChains.delete(threadId);
  }).catch(() => {});
}

async function restoreClaimedState(jobs) {
  for (const job of jobs) {
    if (job.imsgGuid) imsgTransport.rememberInbound(job.threadId, job.imsgGuid);
    if (job.state === "queued" || job.state === "delivering") {
      enqueueReply(job);
      continue;
    }
    if (job.state === "running") {
      job.reconcileRunning = true;
      saveClaimedJob(job, "running");
      enqueueReply(job);
      continue;
    }
    if (job.state === "cancelled") {
      try { await discardReply(job); } catch { scheduleDiscardRetry(job); }
      continue;
    }
    await settleLiveSuppression(job, catalogById.get(String(job.threadId || "")), { forceClear: true });
    saveClaimedJob(job, "failed");
    failedRuns.record(job.threadId, {
      body: String(job.claimed?.reply?.body || ""),
      images: job.claimed?.images || [],
      replyId: job.replyId,
      claimed: job.claimed,
      queuedAt: job.queuedAt,
      clientUserMessageId: job.clientUserMessageId,
      reasoningEffort: job.reasoningEffort || null,
      mirrorSuppressionToken: null,
    });
  }
}

async function buildThreadDetailEvent(thread, options = {}) {
  const state = effectiveState(thread);
  const detail = await getThreadDetail(thread, {
    stateOverride: state.status,
    reasoningEffort: effectiveReasoning(thread),
    userPreviewLimit: 360,
    endOffset: options.endOffset,
  });
  const turn = detail.turn;
  const hasQueuedRequest = state.request !== null;
  const queuedRequest = state.request ?? "";
  const requestPreview = hasQueuedRequest
    ? queuedRequest.slice(0, 360) || "Image attachment"
    : detail.requestPreview || "No user request was found in the available history.";
  const queuedTurnVisible = !hasQueuedRequest || (turn?.state === "running" && detail.fullRequest === queuedRequest);
  const messages = state.status === "working" && queuedTurnVisible
    ? (detail.assistantMessages || []).map((message) => ({ body: message.text, at: message.timestamp, phase: message.phase }))
    : state.status === "idle" && detail.finalResponse
      ? [{ body: detail.finalResponse, at: turn?.completedAt || detail.activityAt, phase: "final_answer" }]
      : [];
  return {
    kind: "thread.detail",
    ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
    thread: threadLabel(thread),
    state: state.status,
    activityAt: detail.activityAt || thread.activityAt,
    stateSince: state.stateSince,
    pendingCount: state.pendingCount,
    turnCount: detail.turnCount,
    turnCountLowerBound: detail.turnCountLowerBound,
    reasoningEffort: effectiveReasoning(thread),
    requestPreview: {
      body: requestPreview,
      at: state.requestAt || turn?.startedAt || null,
      truncated: hasQueuedRequest ? queuedRequest.length > requestPreview.length : Boolean(detail.fullRequest && detail.fullRequest !== detail.requestPreview),
    },
    assistantMessages: messages,
    historyTruncated: detail.truncated,
  };
}

function headerThreadFromDetail(detail) {
  return {
    ...detail.thread,
    status: detail.state,
    activityAt: detail.activityAt,
    stateSince: detail.stateSince,
    pendingCount: detail.pendingCount,
    turnCount: detail.turnCount,
    turnCountLowerBound: detail.turnCountLowerBound,
    reasoningEffort: detail.reasoningEffort,
  };
}

async function publishThreadHeader(thread, detail = null) {
  const resolved = detail || await buildThreadDetailEvent(thread);
  await sendOutbound({ kind: "thread.header", thread: headerThreadFromDetail(resolved) });
  return resolved;
}

function outboundTurn(turn) {
  if (!turn) return null;
  return {
    id: turn.id,
    state: turn.state,
    request: turn.request || "",
    requestAt: turn.startedAt || null,
    assistantMessages: (turn.assistantMessages || []).map((message) => ({
      body: message.text,
      at: message.timestamp,
      phase: message.phase,
    })),
    finalResponse: turn.finalResponse || null,
    completedAt: turn.completedAt || null,
  };
}

async function currentThreadTurn(thread) {
  const state = effectiveState(thread);
  const turn = await getTurn(thread);
  const serviceTurnVisible = state.request !== null
    && state.status === "working"
    && turn?.state === "running"
    && turn.request === state.request;
  return state.request !== null && !serviceTurnVisible
    ? { state: state.status, request: state.request, requestAt: state.requestAt, assistantMessages: [], finalResponse: null, completedAt: null }
    : outboundTurn(turn);
}

async function publishThreadDirectory(activeThreadId) {
  const currentIngests = [...ingestChains.values()];
  if (currentIngests.length) {
    await Promise.race([
      Promise.allSettled(currentIngests),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  const threads = await synchronize();
  const planned = await buildThreadDirectory(threads, {
    activeThreadId,
    stateFor: effectiveState,
    historyFor: (thread) => readThreadHistory(thread),
  });
  await sendOutbound({ kind: "service.directory", directory: planned.directory });
  imsgTransport.setMenu(planned.references);
  return planned;
}

function reasoningReaction(level) {
  return REASONING_PRESENTATION[level]?.emoji || REASONING_PRESENTATION.inherit.emoji;
}

async function handleDefaultReasoning(action) {
  const requestedInput = String(action.argument || "").trim().toLowerCase();
  const requested = ["none", "inherit"].includes(requestedInput) ? "default" : requestedInput;
  const options = listDefaultReasoningOptions();
  if (!requested) {
    const result = await imsgTransport.sendActionPicker(
      "Default reasoning",
      options.map((option) => ({
        label: `${option.label}${option.selected ? " · selected" : ""}`,
        action: { kind: "default-reasoning", argument: option.value === "default" ? "none" : option.value },
      })),
      {
        allowAddedChoiceSearch: false,
        operationScope: `local-action:${action.messageKey}:default-reasoning`,
      },
    );
    if (result?.terminal === false) {
      throw Object.assign(new Error("The default-reasoning poll remains pending."), {
        code: result.status || "IMSG_PICKER_PENDING",
      });
    }
    return null;
  }
  const valid = new Set(options.map((option) => option.value));
  if (!valid.has(requested)) {
    await sendOutbound({
      kind: "service.notice",
      code: "needs-attention",
      body: `“${requestedInput}” isn’t a reasoning level.\n\n/defaultreasoning (level/none)`,
    });
    return { reaction: "❌" };
  }
  const selected = setDefaultReasoning(requested);
  scheduleSynchronize();
  const display = REASONING_PRESENTATION[selected || "inherit"];
  await sendOutbound({
    kind: "service.notice",
    code: "updated",
    body: selected
      ? `${display.emoji} Default reasoning set to **${display.label}**.`
      : "↩️ Default reasoning now follows each Codex task.",
  });
  return { reaction: display.emoji };
}

function compactPickerText(value, limit = 48) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((entry) => entry.segment)
    : [...text];
  return segments.length <= limit
    ? text
    : `${segments.slice(0, Math.max(1, limit - 1)).join("").trimEnd()}…`;
}

function projectGroupsForNewTask(queryValue = "") {
  const query = String(queryValue || "").trim().toLowerCase();
  const groups = new Map();
  for (const thread of catalogById.values()) {
    if (projectKeyFor(thread) === "other-tasks") continue;
    const key = projectKeyFor(thread);
    const group = groups.get(key) || {
      projectKey: key,
      projectLabel: projectLabelFor(thread),
      startedAt: thread.projectStartedAt || thread.createdAt || null,
      activityAt: null,
      status: "idle",
      representative: thread,
    };
    if (threadActivityMs(thread) > threadActivityMs(group.representative)) group.representative = thread;
    const state = effectiveState(thread);
    const activityAt = thread.lastTurnAt || thread.activityAt || thread.updatedAt;
    if (!group.activityAt || Date.parse(activityAt || "") > Date.parse(group.activityAt || "")) group.activityAt = activityAt;
    if (state.status === "working") group.status = "working";
    else if (group.status !== "working" && (state.status === "pending" || state.pendingCount > 0)) group.status = "pending";
    else if (group.status === "idle" && state.status === "error") group.status = "error";
    groups.set(key, group);
  }
  const recencyCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return [...groups.values()]
    .filter((group) => {
      if (query) {
        return `${group.projectLabel} ${group.representative?.workspaceRoot || group.representative?.cwd || ""}`
          .toLowerCase().includes(query);
      }
      return ["working", "pending"].includes(group.status)
        || Date.parse(group.activityAt || "") >= recencyCutoff;
    })
    .sort((left, right) => {
      const priority = (group) => group.status === "working" ? 3 : group.status === "pending" ? 2 : group.status === "error" ? 1 : 0;
      return priority(right) - priority(left)
        || (Date.parse(right.activityAt || "") || 0) - (Date.parse(left.activityAt || "") || 0)
        || left.projectLabel.localeCompare(right.projectLabel);
    });
}

async function publishNewProjectPicker(flow, query = "") {
  await synchronize();
  const projects = projectGroupsForNewTask(query);
  const choices = projects.map((project) => ({
    label: `${statusGlyph(project.status)} ${projectIdentityEmoji(project)} ${compactPickerText(project.projectLabel, 58)}`,
    action: { kind: "new-project", flowId: flow.id, projectKey: project.projectKey },
  }));
  if (!query || "other tasks".includes(String(query).toLowerCase())) {
    choices.push({
      label: `○ ${projectIdentityEmoji({ projectLabel: "Other task", startedAt: flow.createdAt })} Other task`,
      action: { kind: "new-project", flowId: flow.id, projectKey: "other-tasks" },
    });
  }
  if (!choices.length) {
    await sendOutbound({
      kind: "service.notice",
      code: "needs-attention",
      body: `No recent project matched “${compactPickerText(query, 80)}”.`,
    });
    return publishNewProjectPicker(flow, "");
  }
  if (choices.length === 1) {
    await selectNewProject(flow, choices[0].action.projectKey);
    return;
  }
  const result = await imsgTransport.sendActionPicker("New task · project", choices, {
    allowAddedChoiceSearch: true,
    addedChoiceAction: { kind: "new-project-search", flowId: flow.id },
    refreshAction: { kind: "new-project-search", flowId: flow.id },
    operationScope: `new-thread:${flow.id}:project:${String(query).toLowerCase()}`,
  });
  if (result?.terminal === false) {
    throw Object.assign(new Error("The new-task project poll remains pending."), {
      code: result.status || "IMSG_PICKER_PENDING",
    });
  }
}

async function selectNewProject(flow, projectKey) {
  const result = await resumeNewProjectSelection({
    flow,
    projectKey,
    store: newThreadFlows,
    resolveProject: async (requestedKey) => {
      await synchronize();
      const otherTask = requestedKey === "other-tasks";
      const project = otherTask ? null : projectGroupsForNewTask("").find((item) => item.projectKey === requestedKey)
        || [...catalogById.values()].map((thread) => ({
          projectKey: projectKeyFor(thread),
          projectLabel: projectLabelFor(thread),
          startedAt: thread.projectStartedAt || thread.createdAt || null,
          representative: thread,
        })).find((item) => item.projectKey === requestedKey);
      if (!otherTask && !project) return null;
      const representative = project?.representative || null;
      return {
        projectKey: otherTask ? "other-tasks" : project.projectKey,
        projectLabel: otherTask ? "Other tasks" : project.projectLabel,
        projectStartedAt: otherTask ? null : project.startedAt || null,
        cwd: otherTask ? os.homedir() : representative.workspaceRoot || representative.cwd,
        otherTask,
        threadSource: `imessage-handoff:new:${flow.id}:${otherTask ? "other" : "project"}`,
      };
    },
    publishReasoning: publishNewReasoningPicker,
  });
  if (result.status === "missing") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That project is no longer available. Choose another project." });
    await publishNewProjectPicker(flow);
    return null;
  }
  if (result.status === "stale") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That project poll is no longer current. Continue with the latest new-task step or use /cancel." });
    return null;
  }
  return result.flow;
}

async function publishNewReasoningPicker(flow) {
  // thread/start determines the authoritative model only after creation, so
  // the setup poll exposes the conservative cross-model reasoning levels.
  const taskOptions = listReasoningOptions({ id: `new-${flow.id}`, model: null });
  const serviceDefault = getDefaultReasoning();
  const choices = taskOptions.map((option) => {
    if (option.value === "default") {
      const display = REASONING_PRESENTATION[serviceDefault || "inherit"];
      return {
        label: serviceDefault
          ? `↩️ iMessage default · ${display.emoji} ${display.label} when supported`
          : "↩️ Codex default",
        action: { kind: "new-reasoning", flowId: flow.id, argument: "default" },
      };
    }
    const display = REASONING_PRESENTATION[option.value];
    return {
      label: `${display.emoji} ${display.label}`,
      action: { kind: "new-reasoning", flowId: flow.id, argument: option.value },
    };
  });
  const result = await imsgTransport.sendActionPicker("New task · reasoning", choices, {
    allowAddedChoiceSearch: false,
    refreshAction: { kind: "new-reasoning-refresh", flowId: flow.id },
    operationScope: `new-thread:${flow.id}:reasoning`,
  });
  if (result?.terminal === false) {
    throw Object.assign(new Error("The new-task reasoning poll remains pending."), {
      code: result.status || "IMSG_PICKER_PENDING",
    });
  }
}

async function finishNewThreadFlow(flow, action, promptValue = flow.prompt, attachments = []) {
  const prompt = String(promptValue || "").trim();
  if (!prompt && !(attachments || []).length) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "Send text or an image to create the task." });
    return { reaction: "❌" };
  }
  const result = await resumeNewThreadCreation({
    flow,
    action,
    promptValue: prompt,
    attachments,
    store: newThreadFlows,
    findThread: (current) => findThreadBySource(current.threadSource),
    createThread: (current) => createCodexRunner().createThread({
      cwd: current.cwd,
      threadSource: current.threadSource,
    }),
    normalizeThread: normalizeCreatedThread,
    prepareThread: async (thread, current) => {
      catalogById.set(thread.id, thread);
      multiLiveMirror.activate(thread, { resume: true });
      liveMirrorScheduler.replaceCatalog([...catalogById.values()]);
      if (current.reasoning && current.reasoning !== "default") setReasoningOverride(thread.id, current.reasoning);
      else setReasoningOverride(thread.id, "default");
      imsgTransport.router.setThreadListen(thread.id, true);
    },
    queuePrompt: async ({ thread, prompt: queuedPrompt, attachments: queuedAttachments }) => {
      const queued = await queueLocalPrompt(
        { ...action, body: queuedPrompt },
        thread.id,
        queuedPrompt,
        queuedAttachments,
      );
      return queued;
    },
  });
  if (result.status === "stale") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That new-task submission is no longer current. Continue with the latest setup step or use /cancel." });
    return { reaction: "❌" };
  }
  if (result.status === "needs-prompt") {
    imsgTransport.router.setAwaitingNewPrompt(result.flow.id, action.createdAt);
    return { reaction: "❌" };
  }
  const threadId = String(result.flow.threadId || "").trim();
  if (!threadId || !imsgTransport.router.setDefaultThread(threadId, action.createdAt)) {
    throw Object.assign(new Error("The created task could not become the default iMessage context."), {
      code: "NEW_THREAD_DEFAULT_CONTEXT_FAILED",
    });
  }
  const createdThread = result.thread || catalogById.get(threadId) || null;
  const fallbackReasoning = createdThread
    ? effectiveReasoning(createdThread)
    : result.flow.reasoning && result.flow.reasoning !== "default"
      ? result.flow.reasoning
      : null;
  const awarenessReaction = result.admission?.reaction
    || reasoningAwarenessReaction(fallbackReasoning);
  // Keep the queued flow as a replayable tombstone until acceptInbound has
  // durably moved this exact user action from pending to seen.
  return {
    reaction: awarenessReaction || "✨",
    newThreadCompletion: {
      flowId: result.flow.id,
      threadId,
      updatedAt: action.createdAt,
    },
  };
}

async function handleNewThreadAction(action) {
  if (action.kind === "new") {
    const flow = newThreadFlows.begin(action);
    const previousFlowId = imsgTransport.router.activeNewFlowId;
    if (previousFlowId && previousFlowId !== flow.id) newThreadFlows.remove(previousFlowId);
    imsgTransport.router.clearAwaitingNewPrompt();
    imsgTransport.router.setActiveNewFlow(flow.id);
    await publishNewProjectPicker(flow);
    return null;
  }
  const flow = newThreadFlows.get(action.flowId);
  if (!flow) {
    imsgTransport.router.clearAwaitingNewPrompt(action.flowId);
    imsgTransport.router.clearActiveNewFlow(action.flowId);
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That new-task setup expired. Start again with /new." });
    return { reaction: "❌" };
  }
  if (action.kind === "new-project-search" && flow.stage !== "project") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That project poll is no longer current. Continue with the latest new-task step or use /cancel." });
    return { reaction: "❌" };
  }
  if (action.kind === "new-reasoning-refresh" && flow.stage !== "reasoning") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That reasoning poll is no longer current. Continue with the latest new-task step or use /cancel." });
    return { reaction: "❌" };
  }
  if (action.kind === "new-prompt" && !["prompt", "creating", "queued"].includes(flow.stage)) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That new-task setup is not waiting for a message yet." });
    return { reaction: "❌" };
  }
  if (action.kind === "new-project-search") {
    await publishNewProjectPicker(flow, action.argument);
    return null;
  }
  if (action.kind === "new-project") return selectNewProject(flow, action.projectKey);
  if (action.kind === "new-reasoning-refresh") {
    await publishNewReasoningPicker(flow);
    return null;
  }
  if (action.kind === "new-reasoning") {
    if (["creating", "queued"].includes(flow.stage)) {
      return finishNewThreadFlow(flow, action, flow.prompt, flow.attachments);
    }
    if (!["reasoning", "prompt"].includes(flow.stage)) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That reasoning poll is no longer current. Continue with the latest new-task step or use /cancel." });
      return { reaction: "❌" };
    }
    const available = new Set(["default", ...Object.keys(REASONING_PRESENTATION).filter((value) => value !== "inherit")]);
    if (!available.has(action.argument)) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That reasoning choice is no longer available. Choose again." });
      await publishNewReasoningPicker(flow);
      return { reaction: "❌" };
    }
    if (flow.stage === "prompt") {
      const resumed = await resumeNewPromptCollection({
        flow,
        action,
        reasoning: action.argument,
        store: newThreadFlows,
        activatePrompt: (waiting) => imsgTransport.router.setAwaitingNewPrompt(waiting.id, action.createdAt),
        publishPrompt: () => sendOutbound({
          kind: "service.notice",
          code: "updated",
          body: "Send the first message for this task. /cancel leaves setup.",
        }),
      });
      if (resumed.status === "stale") {
        await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That reasoning poll is no longer current. Continue with the latest new-task step or use /cancel." });
        return { reaction: "❌" };
      }
      return { reaction: reasoningReaction(action.argument === "default" ? getDefaultReasoning() : action.argument) };
    }
    const updated = newThreadFlows.update(flow.id, { reasoning: action.argument });
    if (updated.prompt || updated.attachments.length) {
      return finishNewThreadFlow(updated, action, updated.prompt, updated.attachments);
    }
    await resumeNewPromptCollection({
      flow: updated,
      action,
      reasoning: action.argument,
      store: newThreadFlows,
      activatePrompt: (waiting) => imsgTransport.router.setAwaitingNewPrompt(waiting.id, action.createdAt),
      publishPrompt: () => sendOutbound({
        kind: "service.notice",
        code: "updated",
        body: "Send the first message for this task. /cancel leaves setup.",
      }),
    });
    return { reaction: reasoningReaction(action.argument === "default" ? getDefaultReasoning() : action.argument) };
  }
  if (action.kind === "new-prompt") return finishNewThreadFlow(flow, action, action.body, action.attachments);
  if (action.kind === "new-cancel") {
    imsgTransport.router.clearAwaitingNewPrompt(flow.id);
    imsgTransport.router.clearActiveNewFlow(flow.id);
    newThreadFlows.remove(flow.id);
    return { reaction: "🛑" };
  }
  return null;
}

async function stopTask(threadIdValue) {
  const threadId = String(threadIdValue || "");
  const thread = threadId ? catalogById.get(threadId) : null;
  if (threadId) imsgTransport.router.consumeThreadListen(threadId);
  const selectionCleared = imsgTransport.router.clearAwaitingPrompt(threadId || null);
  if (selectionCleared) {
    scheduleLiveMirrorScan();
    scheduleCompletionScan();
  }
  cancelledThrough.set(threadId, Date.now());
  const claiming = ingestPendingCounts.get(threadId)
    || [...claimingReplyIds.values()].filter((id) => id === threadId).length;
  const cancelled = await runs.cancel(threadId);
  const notice = manualSelectionCancellationNotice({
    selectionCleared,
    active: cancelled.active,
    pending: cancelled.pending,
    claiming,
  });
  if (notice) {
    await sendOutbound({
      kind: "service.notice",
      ...notice,
      thread: thread ? threadLabel(thread) : undefined,
    });
  }
  return notice;
}

async function handleControl(event) {
  const command = String(event.command || "").toLowerCase();
  const thread = event.threadId ? catalogById.get(String(event.threadId)) : null;
  if (command === "threads" || command === "recent" || command === "refresh") {
    await publishThreadDirectory(event.threadId);
    return null;
  }
  if (!thread) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available.\n\n/threads" });
    return { reaction: "❌" };
  }
  if (command === "listen") {
    imsgTransport.router.setThreadListen(thread.id, true);
    await sendOutbound({
      kind: "service.notice",
      code: "updated",
      thread: threadLabel(thread),
      body: "Listening for the next turn’s live updates.",
    });
    return { reaction: "👂" };
  }
  if (command === "mute" || command === "unmute") {
    const muted = command === "mute";
    imsgTransport.router.setThreadMuted(thread.id, muted);
    await sendOutbound({
      kind: "service.notice",
      code: "updated",
      thread: threadLabel(thread),
      body: muted ? "Automatic updates muted.\n\n/unmute" : "Automatic updates resumed.\n\n/mute",
    });
    if (!muted) {
      scheduleLiveMirrorScan();
      scheduleCompletionScan();
    }
    return { reaction: muted ? "🔕" : "🔔" };
  }
  if (command === "open" || command === "thread" || command === "status") {
    const detail = await buildThreadDetailEvent(thread);
    await publishThreadHeader(thread, detail);
    await sendOutbound(detail);
    return null;
  }
  if (command === "request" || command === "message") {
    const state = effectiveState(thread);
    const turn = state.request === null ? await getTurn(thread) : null;
    await sendOutbound({
      kind: "thread.request",
      thread: threadLabel(thread),
      body: state.request ?? await getLatestRequest(thread),
      at: state.requestAt || turn?.startedAt || null,
    });
    return null;
  }
  if (command === "turn") {
    await sendOutbound({
      kind: "thread.turn",
      thread: threadLabel(thread),
      turn: await currentThreadTurn(thread),
      reasoningEffort: effectiveReasoning(thread),
    });
    return null;
  }
  if (command === "history") {
    const requested = Number.parseInt(String(event.argument || "3"), 10);
    const limit = Math.max(1, Math.min(5, Number.isFinite(requested) ? requested : 3));
    const history = await getHistory(thread, limit + 1);
    await sendOutbound({
      kind: "thread.history",
      thread: threadLabel(thread),
      turns: history.slice(0, limit).map(outboundTurn),
      hasMore: history.length > limit,
    });
    return null;
  }
  if (command === "reasoning") {
    let options = listReasoningOptions(thread);
    const requestedInput = String(event.argument || "").trim().toLowerCase();
    const requested = requestedInput === "none" ? "default" : requestedInput;
    let current = effectiveReasoning(thread);
    let changed = false;
    if (requested) {
      if (!options.some((option) => option.value === requested)) {
        await sendOutbound({ kind: "service.reasoning", thread: threadLabel(thread), current, options: outboundReasoningOptions(options), invalid: requestedInput });
        return { reaction: "❌" };
      }
      setReasoningOverride(thread.id, requested);
      current = effectiveReasoning(thread);
      changed = true;
      options = listReasoningOptions(thread);
      scheduleSynchronize();
    }
    const running = effectiveState(thread).status === "working";
    await sendOutbound({
      kind: "service.reasoning",
      thread: threadLabel(thread),
      current,
      options: outboundReasoningOptions(options),
      changed,
      note: running ? "Applies to the next turn; the current turn is unchanged." : "Applies to the next iMessage-started turn.",
    });
    return changed ? { reaction: reasoningReaction(current) } : null;
  }
  if (command === "retry") {
    const failures = failedRuns.list(thread.id);
    const failed = failedRuns.next(thread.id);
    if (!failed) {
      const body = failures.length
        ? "The failed message is already pending or running.\n\n‼️ Emphasize to stop · /thread"
        : "There is no failed iMessage request to retry.\n\n/turn · /threads";
      await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body });
      return { reaction: "❌" };
    }
    const retryAt = new Date().toISOString();
    const retry = {
      threadId: thread.id,
      replyId: failed.replyId || `retry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      claimed: failed.claimed || { reply: { body: failed.body }, images: failed.images },
      queuedAt: retryAt,
      receivedAtMs: Date.now(),
      threadCheckpoint: captureThreadRunCheckpoint(thread, retryAt),
      clientUserMessageId: failed.clientUserMessageId || null,
      reasoningEffort: failed.reasoningEffort || null,
      retryOf: failed.replyId,
    };
    saveClaimedJob(retry, "queued");
    if (enqueueReply(retry)) failedRuns.markRetrying(thread.id, failed.replyId);
    else markClaimedJobState(retry.replyId, "failed");
    return { reaction: "🔄" };
  }
  if (command === "dismiss") {
    const failed = failedRuns.list(thread.id)[0] || null;
    if (!failed) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "There is no failed iMessage request to dismiss.\n\n/thread · /threads" });
      return { reaction: "❌" };
    }
    if (failed.retrying) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "That failed request is already pending or running. Emphasize a message in this task to stop it before dismissing." });
      return { reaction: "❌" };
    }
    await settleLiveSuppression(failed, thread, { forceClear: true });
    failedRuns.remove(thread.id, failed.replyId);
    removeClaimedJob(failed.replyId);
    const remaining = failedRuns.list(thread.id).length;
    try { await updateThreadStatus(thread, remaining ? "error" : "idle"); } catch {}
    scheduleSynchronize();
    await sendOutbound({
      kind: "service.notice",
      code: "updated",
      thread: threadLabel(thread),
      body: remaining
        ? `Dismissed one failed request. ${remaining} still need${remaining === 1 ? "s" : ""} attention.\n\n/retry · /dismiss`
        : "Dismissed the failed request. This task is clear.",
    });
    return { reaction: "🗑️" };
  }
  return null;
}

function threadActivityMs(thread) {
  return Math.max(
    Date.parse(thread?.lastTurnAt || "") || 0,
    Date.parse(thread?.activityAt || "") || 0,
    Date.parse(thread?.updatedAt || "") || 0,
  );
}

function projectKeyFor(thread) {
  return thread?.groupKind === "other" || !thread?.projectKey || !thread?.projectLabel
    ? "other-tasks"
    : String(thread.projectKey);
}

function projectLabelFor(thread) {
  return projectKeyFor(thread) === "other-tasks" ? "Other tasks" : String(thread.projectLabel);
}

async function latestRequestText(thread) {
  try {
    return await getLatestRequest(thread);
  } catch {
    return "";
  }
}

async function threadMenuItem(thread, index) {
  const state = effectiveState(thread);
  const request = state.latestRequest ?? await latestRequestText(thread);
  const requestPreview = String(request || "").replace(/\s+/g, " ").trim();
  return {
    ...threadLabel(thread),
    index,
    current: thread.id === imsgTransport.router.lastUserThreadId,
    status: state.status,
    stateSince: state.stateSince,
    activityAt: thread.lastTurnAt || thread.activityAt || thread.updatedAt,
    pendingCount: state.pendingCount,
    reasoningEffort: effectiveReasoning(thread),
    requestPreview: requestPreview ? `${requestPreview.slice(0, 139)}${requestPreview.length > 139 ? "…" : ""}` : null,
  };
}

function sortedThreads(threads) {
  return [...threads].sort((left, right) => {
    const leftState = effectiveState(left);
    const rightState = effectiveState(right);
    const leftPending = leftState.status === "pending" || leftState.pendingCount > 0;
    const rightPending = rightState.status === "pending" || rightState.pendingCount > 0;
    return Number(rightPending) - Number(leftPending)
      || threadActivityMs(right) - threadActivityMs(left)
      || String(left.id).localeCompare(String(right.id));
  });
}

async function publishProjects() {
  await synchronize();
  const groups = new Map();
  for (const thread of catalogById.values()) {
    const key = projectKeyFor(thread);
    const group = groups.get(key) || { key, label: projectLabelFor(thread), threads: [] };
    group.threads.push(thread);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((left, right) => {
    const leftPending = left.threads.some((thread) => ["working", "pending"].includes(effectiveState(thread).status));
    const rightPending = right.threads.some((thread) => ["working", "pending"].includes(effectiveState(thread).status));
    const leftActivity = Math.max(0, ...left.threads.map(threadActivityMs));
    const rightActivity = Math.max(0, ...right.threads.map(threadActivityMs));
    return Number(rightPending) - Number(leftPending) || rightActivity - leftActivity || left.label.localeCompare(right.label);
  });
  const items = ordered.map((group, index) => {
    const states = group.threads.map(effectiveState);
    const status = states.some((state) => state.status === "working")
      ? "working"
      : states.some((state) => state.status === "pending" || state.pendingCount > 0)
        ? "pending"
        : states.some((state) => state.status === "error") ? "error" : "idle";
    return {
      index: index + 1,
      title: group.label,
      projectKey: group.key,
      createdAt: group.threads.map((thread) => thread.projectStartedAt || thread.createdAt).filter(Boolean).sort()[0] || null,
      status,
      activityAt: group.threads.map((thread) => thread.lastTurnAt || thread.activityAt || thread.updatedAt).filter(Boolean).sort().at(-1) || null,
      threadCount: group.threads.length,
    };
  });
  await sendOutbound({
    kind: "service.menu",
    label: "PROJECTS",
    items,
    note: "Reply with a number to show that project.\n“/threads” - See recent threads\n“/search” - Show threads with specific text",
  });
  imsgTransport.setMenu(ordered.map((group) => `project:${group.key}`));
}

async function publishThreadMenu(threads, note) {
  const ordered = sortedThreads(threads);
  const items = await Promise.all(ordered.map((thread, index) => threadMenuItem(thread, index + 1)));
  await sendOutbound({ kind: "service.menu", label: "THREADS", items, note });
  imsgTransport.setMenu(ordered.map((thread) => `thread:${thread.id}`));
  return ordered;
}

async function publishCommandThreadPicker(command, action = {}) {
  const threads = await synchronize();
  let items;
  if (command === "mute" || command === "unmute") {
    const shouldBeMuted = command === "unmute";
    const relevant = sortedThreads(threads).filter((thread) => imsgTransport.router.isThreadMuted(thread.id) === shouldBeMuted);
    items = await Promise.all(relevant.map((thread, index) => threadMenuItem(thread, index + 1)));
  } else {
    const planned = await buildThreadDirectory(threads, {
      activeThreadId: imsgTransport.router.lastUserThreadId,
      stateFor: effectiveState,
      historyFor: (thread) => readThreadHistory(thread),
    });
    items = (planned.directory.groups || [])
      .flatMap((group) => group.threads || [])
      .map((item) => ({ ...item, projectLabel: item.projectLabel || item.projectName || "Codex" }));
  }
  if (!items.length) {
    const body = command === "unmute"
      ? "No tasks are muted."
      : command === "mute"
        ? "All available tasks are already muted."
        : "No recent tasks are available.";
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body });
    return;
  }
  const result = await imsgTransport.sendThreadPicker(command, items, {
    argument: action.argument,
    operationScope: action.messageKey ? `local-action:${action.messageKey}:picker:${command}` : `picker:${command}`,
  });
  if (result?.terminal === false) {
    throw Object.assign(new Error("The native task picker remains pending."), { code: result.status || "IMSG_PICKER_PENDING" });
  }
}

async function publishProject(projectKey) {
  await synchronize();
  const threads = [...catalogById.values()].filter((thread) => projectKeyFor(thread) === projectKey);
  if (!threads.length) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That project is no longer available.\n\n/threads" });
    return;
  }
  await publishThreadMenu(threads, "Reply with a number to open that thread. Add “1 (message)” to directly message the thread.\n“/projects” - See all projects");
}

async function publishSearch(queryValue, options = {}) {
  await synchronize();
  const query = String(queryValue || "").trim().toLowerCase();
  const queryLabel = String(queryValue || "").trim().replace(/\s+/g, " ").slice(0, 96);
  const pickerCommand = String(options.command || "search").trim().toLowerCase();
  const candidates = sortedThreads([...catalogById.values()]).filter((thread) => {
    if (pickerCommand === "mute") return !imsgTransport.router.isThreadMuted(thread.id);
    if (pickerCommand === "unmute") return imsgTransport.router.isThreadMuted(thread.id);
    return true;
  });
  const matches = [];
  for (const thread of candidates) {
    if (matches.length >= 25) break;
    const labelText = `${thread.title || ""} ${thread.projectLabel || ""}`.toLowerCase();
    const requestText = query && !labelText.includes(query)
      ? String(await latestRequestText(thread) || "").toLowerCase()
      : "";
    if (!query || labelText.includes(query) || requestText.includes(query)) matches.push(thread);
  }
  if (pickerCommand !== "search") {
    if (!matches.length) {
      await sendOutbound({
        kind: "service.notice",
        code: "needs-attention",
        body: queryLabel ? `No tasks matched “${queryLabel}”.` : "No matching tasks are available.",
      });
      return;
    }
    const items = await Promise.all(matches.map((thread, index) => threadMenuItem(thread, index + 1)));
    const result = await imsgTransport.sendThreadPicker(pickerCommand, items, {
      argument: options.commandArgument,
      question: `/${pickerCommand} · ${queryLabel}`,
      operationScope: options.messageKey
        ? `local-action:${options.messageKey}:search:${pickerCommand}`
        : `search:${pickerCommand}:${query}`,
    });
    if (result?.terminal === false) {
      throw Object.assign(new Error("The native task search picker remains pending."), {
        code: result.status || "IMSG_PICKER_PENDING",
      });
    }
    return;
  }
  await publishThreadMenu(
    matches,
    query
      ? `Showing matches for “${queryLabel}”.\n“/threads” - See recent threads`
      : "Add a query after /search, or reply with a number to open a task.",
  );
}

async function queueLocalPrompt(action, threadId, bodyValue = action.body, attachments = action.attachments) {
  const thread = catalogById.get(String(threadId || ""));
  if (!thread) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available.\n\n/threads" });
    return { accepted: false, reaction: null };
  }
  const replyId = `imsg:${action.messageKey}`;
  // A crash can leave the durable run admitted while the separate new-task
  // flow still says `creating`. Treat the exact claimed reply as success and
  // never restage attachments or enqueue the turn a second time.
  if (runs.has(replyId)) {
    return { accepted: true, reaction: reasoningAwarenessReaction(effectiveReasoning(thread)) };
  }
  const images = await imsgTransport.importInboundAttachments(attachments, {
    destinationRoot: `${paths.attachments}/imsg`,
    messageKey: action.messageKey,
  });
  const body = String(bodyValue || "").trim() || (images.length ? "Please review the attached image." : "");
  if (!body) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "That message did not contain text or a supported image." });
    return { accepted: false, reaction: null };
  }
  const reasoningEffort = effectiveReasoning(thread);
  imsgTransport.rememberInbound(thread.id, action.guid);
  const admission = await ingestReply({
    threadId: thread.id,
    replyId,
    createdAt: action.createdAt || new Date().toISOString(),
    queuedAt: action.createdAt || new Date().toISOString(),
    imsgGuid: action.guid || null,
    reasoningEffort,
    claimed: {
      reply: { id: `imsg:${action.messageKey}`, body, media: [] },
      images,
      userMirrorMode: submittedUserMirrorMode(action),
    },
  });
  if (!["queued", "duplicate"].includes(admission) && !runs.has(replyId)) {
    return { accepted: false, reaction: null };
  }
  const reaction = reasoningAwarenessReaction(reasoningEffort);
  scheduleLiveMirrorScan();
  scheduleCompletionScan();
  return { accepted: true, reaction };
}

async function handleLocalAction(action) {
  const serverRequestOutcome = await serverRequests.handleAction(action);
  if (serverRequestOutcome.handled) {
    if (serverRequestOutcome.stale) {
      const thread = action.threadId ? catalogById.get(String(action.threadId)) : null;
      await sendOutbound({
        kind: "service.notice",
        code: "needs-attention",
        ...(thread ? { thread: threadLabel(thread) } : {}),
        body: "That Codex request has expired or was already answered.",
      });
      return { reaction: "❌" };
    }
    return { reaction: serverRequestOutcome.deliveryFailed
      ? "❌"
      : serverRequestOutcome.accepted
        ? "✅"
        : "❓" };
  }
  if (["new", "new-project", "new-project-search", "new-reasoning", "new-reasoning-refresh", "new-prompt", "new-cancel"].includes(action.kind)) {
    return handleNewThreadAction(action);
  }
  if (action.kind === "defaultreasoning" || action.kind === "default-reasoning") {
    return handleDefaultReasoning(action);
  }
  if (action.kind === "reaction-control") {
    const thread = catalogById.get(String(action.threadId || ""));
    if (!thread) return null;
    if (action.command === "listen") {
      imsgTransport.router.setThreadListen(thread.id, action.enabled === true);
      return null;
    }
    if (action.command === "mute" || action.command === "unmute") {
      const muted = action.command === "mute";
      imsgTransport.router.setThreadMuted(thread.id, muted);
      if (!muted) {
        scheduleLiveMirrorScan();
        scheduleCompletionScan();
      }
      return null;
    }
    if (action.command === "inspect") {
      const detail = await buildThreadDetailEvent(thread);
      await publishThreadHeader(thread, detail);
      await sendOutbound(detail);
      const history = await getHistory(thread, 4);
      await sendOutbound({
        kind: "thread.history",
        thread: threadLabel(thread),
        turns: history.slice(0, 3).map(outboundTurn),
        hasMore: history.length > 3,
      });
      return null;
    }
    if (action.command === "stop") {
      await stopTask(thread.id);
      return null;
    }
  }
  if (action.kind === "threads" || action.kind === "refresh") {
    await publishThreadDirectory(imsgTransport.router.lastUserThreadId);
    return null;
  }
  if (action.kind === "help") {
    await sendOutbound({ kind: "service.menu", label: "COMMANDS" }, { replyToGuid: action.guid });
    return null;
  }
  if (action.kind === "projects") {
    await publishProjects();
    return null;
  }
  if (action.kind === "search") {
    await publishSearch(action.argument, action);
    return null;
  }
  if (action.kind === "project") {
    await publishProject(action.projectKey);
    return null;
  }
  if (action.kind === "stale-menu" || action.kind === "stale-poll") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That selection expired. Here is a fresh directory; choose a new option." });
    await publishThreadDirectory(imsgTransport.router.lastUserThreadId);
    return { reaction: "❌" };
  }
  if (action.kind === "stale-reply-context" || action.kind === "ambiguous-reply-context") {
    await sendOutbound({
      kind: "service.notice",
      code: "needs-attention",
      body: action.kind === "stale-reply-context"
        ? "That reply thread is no longer mapped to a Codex task. Choose the task again with /threads."
        : "That reply thread maps to more than one Codex task, so nothing was run. Choose the task again with /threads.",
    });
    return { reaction: "❌" };
  }
  if (action.kind === "no-thread") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "No thread is selected.\nText /threads to choose one." });
    return { reaction: "❌" };
  }
  if (action.kind === "unknown-command") {
    const thread = action.threadId ? catalogById.get(String(action.threadId)) : null;
    await sendOutbound({
      kind: "service.notice",
      code: "needs-attention",
      ...(thread ? { thread: threadLabel(thread) } : {}),
      body: "That command is not available.\n\n/help · /thread · /turn · /history · /reasoning",
    });
    return { reaction: "❌" };
  }
  if (action.kind === "thread-picker") {
    await publishCommandThreadPicker(action.command, action);
    return null;
  }
  if (action.kind === "switch") {
    const thread = catalogById.get(String(action.threadId || ""));
    if (!thread) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That menu has changed.\nText /threads for a fresh list." });
      return { reaction: "❌" };
    }
    imsgTransport.router.touchThread(thread.id, action.createdAt);
    if (action.prompt) {
      const queued = await queueLocalPrompt(action, thread.id, action.prompt, []);
      return queued.reaction ? { reaction: queued.reaction } : null;
    } else {
      // Router ingestion established this atomically before the menu action was
      // queued. If a later user message already consumed it, a retried menu
      // action must not reopen the pause or send a stale prompt.
      const lease = manualSelectionLease(action, imsgTransport.router.awaitingPrompt);
      if (!lease) return null;
      await presentManualSelection({
        lease,
        currentLease: () => imsgTransport.router.awaitingPrompt,
        buildDetail: () => buildThreadDetailEvent(thread),
        sendHeader: (detail) => publishThreadHeader(thread, detail),
        buildTurn: () => currentThreadTurn(thread),
        sendTurn: (detail, turn) => sendOutbound({
          kind: "thread.turn",
          thread: detail.thread,
          turn,
          reasoningEffort: detail.reasoningEffort,
        }),
        sendPrompt: () => sendOutbound({
          kind: "service.notice",
          code: "updated",
          thread: threadLabel(thread),
          body: "Send the message you want to run in this task. This selection expires in about 2 minutes if unused.",
        }),
      });
    }
    return null;
  }
  if (action.kind === "prompt") {
    const queued = await queueLocalPrompt(action, action.threadId);
    return queued.reaction ? { reaction: queued.reaction } : null;
  }
  if (action.kind === "control") {
    return handleControl(action);
  }
  throw new Error(`Unsupported local action: ${action.kind}`);
}

const localActionsInFlight = new Set();
const localActionRetryTimers = new Map();
const localActionRetryAttempts = new Map();
const MAX_LOCAL_ACTION_FAILURES = 5;

function scheduleLocalActionRetry(action) {
  const key = String(action?.messageKey || "");
  if (!key || stopped || localActionRetryTimers.has(key)) return false;
  const attempts = (localActionRetryAttempts.get(key) || 0) + 1;
  localActionRetryAttempts.set(key, attempts);
  if (attempts >= MAX_LOCAL_ACTION_FAILURES) return false;
  const delay = Math.min(5 * 60 * 1000, 5_000 * (2 ** Math.min(6, attempts - 1)));
  const timer = setTimeout(() => {
    localActionRetryTimers.delete(key);
    queueLocalAction(action);
  }, delay);
  timer.unref?.();
  localActionRetryTimers.set(key, timer);
  return true;
}

async function settleFailedLocalAction(action, code, detail = "") {
  const key = String(action?.messageKey || "");
  if (!key) return;
  const preservePending = code === "CLAIMED_STORE_UNAVAILABLE";
  if (!preservePending) await imsgTransport.quarantineInbound(action, { reaction: "❌" });
  localActionRetryAttempts.delete(key);
  const timer = localActionRetryTimers.get(key);
  if (timer) clearTimeout(timer);
  localActionRetryTimers.delete(key);
  log(preservePending
    ? `Local iMessage prompt remains in the durable inbox after bounded persistence failures (${detail ? `${code}; ${detail}` : code}); later messages will continue normally.`
    : `Local iMessage action was quarantined after ${detail ? `${code}; ${detail}` : code}; later messages will continue normally.`);
}

function safeLocalFailureDiagnostic(error) {
  const detail = safeImsgFailureDetails(error);
  return [
    detail.failureSource ? `source=${detail.failureSource}` : "",
    detail.remoteCode !== undefined ? `remote=${detail.remoteCode}` : "",
    detail.remoteCategory ? `category=${detail.remoteCategory}` : "",
    detail.remoteMessage || "",
  ].filter(Boolean).join("; ");
}

async function processLocalAction(action) {
  const key = String(action?.messageKey || "");
  if (!key || localActionsInFlight.has(key)) return;
  localActionsInFlight.add(key);
  try {
    const outcome = await localActionContext.run(
      { messageKey: key, sequence: 0 },
      () => handleLocalAction(action),
    );
    await settleLocalActionOutcome(action, outcome, {
      acceptInbound: (pendingAction, options) => imsgTransport.acceptInbound(pendingAction, options),
      newThreadFlows,
      router: imsgTransport.router,
      scheduleSynchronize,
    });
    localActionRetryAttempts.delete(key);
    const retryTimer = localActionRetryTimers.get(key);
    if (retryTimer) clearTimeout(retryTimer);
    localActionRetryTimers.delete(key);
  } catch (error) {
    const code = error?.code || "UNKNOWN";
    const detail = safeLocalFailureDiagnostic(error);
    const diagnostic = detail ? `${code}; ${detail}` : code;
    if (stopped) {
      log(`Local iMessage action stopped during shutdown (${diagnostic}); it remains durable.`);
    } else if (isTerminalLocalActionFailure(code) || !scheduleLocalActionRetry(action)) {
      await settleFailedLocalAction(action, code, detail);
    } else {
      log(`Local iMessage action could not be completed (${diagnostic}); it will retry with a bounded backoff.`);
    }
  } finally {
    localActionsInFlight.delete(key);
  }
}

const localActionDispatch = new LocalActionDispatch(processLocalAction);

function queueLocalAction(action) {
  return localActionDispatch.enqueue(action, {
    immediate: isImmediateLocalAction(action),
  });
}

async function main() {
  const restoredJobs = loadClaimedJobs();
  for (const job of restoredJobs) {
    if (job.delivery?.body) completions.suppressNext(job.threadId, job.delivery.body, job.queuedAt);
  }
  const threads = await synchronize();
  const helper = await imsgTransport.helperStatus();
  const profile = config.imsg;
  if (Number(helper.profile?.chatId) !== profile.chatId
    || helper.profile?.chatGuid !== profile.chatGuid
    || helper.profile?.expectedSender !== profile.expectedSender
    || helper.settings?.featureMode !== "bridge"
    || helper.settings?.presentation !== "rich"
    || helper.settings?.polls !== true
    || helper.settings?.reactions !== true) {
    throw Object.assign(
      new Error("The authenticated Messages helper no longer matches the local rich-mode configuration."),
      { code: "IMSG_HELPER_MISMATCH" },
    );
  }
  localUserMirrorSender.initialize({
    expectedLocalSender: profile.expectedSender,
    knownRootGuids: threads.map((thread) => imsgTransport.router.nativeThread(thread.id)?.rootGuid).filter(Boolean),
    knownThreads: threads.map((thread) => ({
      threadId: thread.id,
      rootGuid: imsgTransport.router.nativeThread(thread.id)?.rootGuid,
    })).filter((thread) => thread.rootGuid),
  }).then(() => serviceReadiness.refreshCapabilities()).catch(() => {
    serviceReadiness.refreshCapabilities();
    log("Normal-profile user mirroring is unavailable; core local Messages transport remains active.");
  });
  await restoreClaimedState(restoredJobs);
  await imsgTransport.start({
    onAction: (action) => queueLocalAction(action),
    onError: () => log("Local iMessage watch reported an error; imsg will retry recoverable subscriptions."),
  });
  await imsgTransport.syncWorkingThreads(
    threads.filter((thread) => effectiveState(thread).status === "working").map((thread) => thread.id),
  );
  for (const action of imsgTransport.pendingActions()) await queueLocalAction(action);
  await completions.reconcile(threads, { deliver: deliverLocalCompletion, deliverPending: false });
  allowStartupWork();
  log(`Ready on ${os.hostname()} with ${threads.length} top-level tasks via the authenticated local imsg helper.`);
  completionMonitoringStarted = true;
  scheduleCompletionScan();
  scheduleLiveMirrorScan();
  rolloutActivity.start();
  setInterval(() => synchronize().catch(() => log("Background synchronization failed; will retry.")), 30 * 1000).unref();
  serviceReadiness.markReady();
}

async function stop() {
  if (stopped) return;
  stopped = true;
  if (presenceOfflineTimer) clearTimeout(presenceOfflineTimer);
  presenceOfflineTimer = null;
  for (const threadId of [...liveMirrorRetryTimers.keys()]) clearLiveMirrorRetryTimer(threadId);
  runs.shutdown();
  rolloutActivity.stop();
  liveMirrorScheduler.stop();
  serverRequests.stop();
  codexRuntime.close();
  await Promise.race([
    liveMirrorScheduler.whenIdle(),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await localUserMirrorSender.stop().catch(() => {});
  await imsgTransport.stop().catch(() => {});
  clearServiceReadiness();
  process.exit(0);
}

process.on("SIGTERM", () => { stop(); });
process.on("SIGINT", () => { stop(); });
process.on("exit", clearServiceReadiness);

main().catch((error) => {
  clearServiceReadiness();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
