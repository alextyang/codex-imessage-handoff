#!/usr/bin/env node
import os from "node:os";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { readConfig } from "./config.mjs";
import { listThreads } from "./thread-store.mjs";
import { assertThreadReadyForIMessageRun, getThreadDetail, getLatestRequest, getTurn, getHistory, readThreadHistory } from "./thread-history.mjs";
import { buildThreadDirectory } from "./thread-directory.mjs";
import { getReasoningOverride, setReasoningOverride, listReasoningOptions } from "./thread-settings.mjs";
import { ImsgTransport } from "./imsg-transport.mjs";
import { safeImsgFailureDetails } from "./imsg-rpc-diagnostics.mjs";
import { AppServerCodexRunner } from "./app-server-runner.mjs";
import { RunManager } from "./run-manager.mjs";
import { FailureQueue } from "./failure-queue.mjs";
import { isTerminalLocalActionFailure, LocalActionDispatch } from "./local-action-dispatch.mjs";
import { loadClaimedJobs, markClaimedJobState, removeClaimedJob, saveClaimedJob } from "./claimed-store.mjs";
import { admitClaimedJob } from "./claimed-job-admission.mjs";
import { unconfirmedRecoveryDisposition } from "./recovered-run-policy.mjs";
import { CompletionMonitor } from "./completion-monitor.mjs";
import { MultiLiveMirror } from "./multi-live-mirror.mjs";
import { CodexFocusDetector } from "./codex-focus.mjs";
import { LiveMirrorRetryBackoff } from "./live-mirror-backoff.mjs";
import { servicePaths } from "./paths.mjs";
import { SharedBackendTurnLease } from "./shared-backend-lease.mjs";
import { inspectDesktopSharedConnection } from "./desktop-connection.mjs";
import { ServiceReadiness } from "./service-readiness.mjs";
import { PresenceTracker } from "./presence-tracker.mjs";
import { shouldSuppressSubmittedUserMirror, submittedUserMirrorMode } from "./submitted-user-mirror-policy.mjs";
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
serviceReadiness.setHealthCheck(() => imsgTransport.healthStatus());
const presenceTracker = new PresenceTracker(paths.presenceState);
const PRESENCE_OFFLINE_DEBOUNCE_MS = 30_000;
let presenceOfflineTimer = null;
function observePresence(state) {
  presenceTracker.observe(state, {
    active: imsgTransport.notificationStatus().active,
    deliver: (event) => sendOutbound(event),
  }).catch(() => log("A Codex presence transition remains pending."));
}
imsgTransport.setHealthCallback((health) => {
  if (health?.healthy === true) {
    if (presenceOfflineTimer) clearTimeout(presenceOfflineTimer);
    presenceOfflineTimer = null;
    observePresence("online");
    return;
  }
  if (presenceOfflineTimer) return;
  presenceOfflineTimer = setTimeout(() => {
    presenceOfflineTimer = null;
    if (imsgTransport.healthStatus().healthy !== true) observePresence("offline");
  }, PRESENCE_OFFLINE_DEBOUNCE_MS);
  presenceOfflineTimer.unref?.();
});
const completions = new CompletionMonitor(paths.completionState);
const multiLiveMirror = new MultiLiveMirror({ stateDirectory: paths.multiLiveMirrorState });
const codexFocus = new CodexFocusDetector();
const liveMirrorBackoff = new LiveMirrorRetryBackoff();
const failedRuns = new FailureQueue();
const localActionContext = new AsyncLocalStorage();
const codexBackend = String(process.env.IMESSAGE_HANDOFF_CODEX_BACKEND || "app-server").trim().toLowerCase();
const sharedBackendTurnLease = new SharedBackendTurnLease(paths.sharedBackendTurnLease);
const retryableSharedBackendErrors = new Set([
  "CODEX_DISCONNECTED",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_TIMEOUT",
  "CODEX_UNAVAILABLE",
]);

function clearServiceReadiness() {
  try { serviceReadiness.markStopped(); } catch {}
}

if (codexBackend !== "app-server" && codexBackend !== "shared") {
  throw new Error("The local iMessage service requires the supervised shared Codex app-server.");
}

function createCodexRunner() {
  return new AppServerCodexRunner();
}

function shouldDeferCodexRun(error) {
  return error?.code === "BUSY" || retryableSharedBackendErrors.has(error?.code);
}

async function shouldSuppressFocusedResult(threadId) {
  if (!codexFocus || !threadId) return false;
  const status = await codexFocus.getStatus({ force: true });
  return status.focusKnown === true
    && status.appFocused === true
    && status.routeKnown === true
    && status.openThreadId === String(threadId);
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
let completionMonitoringStarted = false;
let completionScanInFlight = null;
let liveMirrorScanInFlight = null;
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
  if (thread && !listening && await shouldSuppressFocusedResult(thread.id)) {
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
  if (!completionMonitoringStarted || completionScanInFlight) return;
  completionScanInFlight = scanKnownCompletions()
    .catch(() => log("Completion synchronization failed; will retry."))
    .finally(() => { completionScanInFlight = null; });
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
    if (await codexFocus.shouldSuppressUserMirror()) return { status: "INACTIVE" };
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

async function scanLiveMirror() {
  if (!liveMirrorBackoff.ready()) return;
  const result = await multiLiveMirror.reconcileAll([...catalogById.values()], { deliver: deliverLiveMessage });
  if (result.retryable > 0) liveMirrorBackoff.recordFailure();
  else liveMirrorBackoff.reset();
}

function scheduleLiveMirrorScan() {
  if (stopped || liveMirrorScanInFlight || !liveMirrorBackoff.ready()) return;
  liveMirrorScanInFlight = scanLiveMirror()
    .catch(() => {
      liveMirrorBackoff.recordFailure();
      log("Live task synchronization failed; will retry.");
    })
    .finally(() => { liveMirrorScanInFlight = null; });
}

async function drainSelectedLiveMirror(thread) {
  if (!thread) return { pending: false };
  if (imsgTransport.router.shouldPauseIncoming(thread.id) || !liveMirrorBackoff.ready()) return { pending: true };
  const result = await multiLiveMirror.drain(thread, { deliver: deliverLiveMessage, maxPasses: 16 });
  if (result.retryable > 0) liveMirrorBackoff.recordFailure();
  else if (!result.pending) liveMirrorBackoff.reset();
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
    liveMirrorBackoff.recordFailure();
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
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    projectKey: thread.projectKey,
    projectLabel: thread.projectLabel,
    status: state.status,
    stateSince: state.stateSince,
    activityAt: thread.lastTurnAt || thread.activityAt || thread.updatedAt,
    pendingCount: state.pendingCount,
    reasoningEffort: effectiveReasoning(thread),
    muted: imsgTransport.router.isThreadMuted(thread.id),
    listening: imsgTransport.router.nativeThread(thread.id)?.listen === true,
  };
}

function outboundReasoningOptions(options) {
  return options.map((option) => option.value === "default"
    ? { ...option, value: "none", label: "None (use task default)" }
    : option);
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

function effectiveReasoning(thread) {
  try {
    return getReasoningOverride(thread.id) || thread.reasoningEffort || null;
  } catch {
    if (!settingsWarningLogged) {
      settingsWarningLogged = true;
      log("Thread reasoning settings are invalid; using Codex task defaults.");
    }
    return thread.reasoningEffort || null;
  }
}

async function synchronizeNow() {
  const threads = await listThreads(500);
  catalogById = new Map(threads.map((thread) => [thread.id, thread]));
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
  const listening = imsgTransport.router.nativeThread(thread.id)?.listen === true;
  if (!listening && await shouldSuppressFocusedResult(thread.id)) {
    delivery.textDelivered = true;
    await updateThreadStatus(thread, "idle");
    imsgTransport.router.consumeThreadListen(thread.id);
    failedRuns.remove(thread.id, event.replyId);
    removeClaimedJob(event.replyId);
    return;
  }
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
    const queuedAtMs = Date.parse(String(event.queuedAt || ""));
    const matchingTurn = candidates.find((turn) => {
      if (String(turn.request || "") !== prompt) return false;
      const startedAtMs = Date.parse(String(turn.startedAt || ""));
      return !Number.isFinite(queuedAtMs)
        || (Number.isFinite(startedAtMs) && startedAtMs >= queuedAtMs - 5_000);
    }) || null;
    if (matchingTurn?.state === "running") {
      event.recoveredTurnId = String(matchingTurn.id || "");
      event.recoveryMissingSince = null;
      if (!event.recoveredTurnId) {
        throw Object.assign(new Error("The recovered Codex turn has no canonical turn id."), { code: "RECOVERED_TURN_INVALID" });
      }
      const recoveryRunner = createCodexRunner();
      context.setCancel(() => {
        recoveryRunner.cancelRecoveredTurn(thread.id, event.recoveredTurnId)
          .catch(() => log(`Recovered turn ${event.recoveredTurnId} could not be interrupted.`));
      });
      context.defer(2000);
      saveClaimedJob(event, "running");
      return;
    }
    if (matchingTurn?.finalResponse) {
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
      event.reconcileRunning = false;
      event.recoveryMissingSince = null;
      saveClaimedJob(event, "failed");
      failedRuns.record(thread.id, {
        body: prompt,
        images: event.claimed?.images || [],
        replyId: event.replyId,
        claimed: event.claimed,
        queuedAt: event.queuedAt,
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
        saveClaimedJob(event, "running");
        context.defer(recovery.retryAfterMs);
        return;
      }
      // A daemon restart cannot prove whether an unobserved turn was accepted.
      // Fail closed into the explicit retry queue instead of submitting the
      // same prompt a second time.
      event.reconcileRunning = false;
      saveClaimedJob(event, "failed");
      failedRuns.record(thread.id, {
        body: prompt,
        images: event.claimed?.images || [],
        replyId: event.replyId,
        claimed: event.claimed,
        queuedAt: event.queuedAt,
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
        context.defer(Math.max(1000, liveMirrorBackoff.remaining()));
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

  let claim = event.claimed;
  if (!claim) {
    const error = Object.assign(new Error("The local iMessage request is missing its durable payload."), { code: "MISSING_LOCAL_PAYLOAD" });
    markClaimedJobState(event.replyId, "failed");
    await publishFailure(thread, error, `run:${event.replyId}:failure`);
    return;
  }

  const reply = claim.reply || {};
  const images = (claim.images || []).filter((file) => existsSync(file));
  const runner = createCodexRunner();
  let cancelRequested = false;
  context.setCancel(() => {
    cancelRequested = true;
    runner.cancel(thread.id);
  });
  let progressTimer = null;
  let pendingPhase = null;
  let lastProgressAt = Date.now();
  let lastPublishedPhase = null;
  let deferred = false;
  let managedCompletion = false;
  let runStartedAt = null;
  let sharedLeaseHeld = false;

  try {
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
    // There is still a tiny check-to-spawn race; Codex's session lock is the
    // final guard and is handled by the same BUSY deferral path below.
    assertThreadReadyForIMessageRun(thread);
    const desktop = inspectDesktopSharedConnection();
    if (desktop.desktopRunning && desktop.privateAppServerChild) {
      throw Object.assign(new Error("Codex Desktop is currently using its private app server; shared iMessage work is paused until the next shared Desktop session."), { code: "CODEX_UNAVAILABLE" });
    }
    markClaimedJobState(event.replyId, "running");
    if (shouldSuppressSubmittedUserMirror(claim) && !event.mirrorSuppressionToken) {
      event.mirrorSuppressionToken = multiLiveMirror.suppressUser(thread.id, String(reply.body || ""));
      if (event.mirrorSuppressionToken) saveClaimedJob(event, "running");
    }
    runStartedAt = new Date().toISOString();
    completions.manage(thread.id, runStartedAt);
    managedCompletion = true;
    sharedBackendTurnLease.acquire(thread.id);
    sharedLeaseHeld = true;
    const result = await runner.run({
      thread,
      prompt: String(reply.body || ""),
      images,
      reasoningEffort: effectiveReasoning(thread),
      onPhase: (phase) => { pendingPhase = phase; },
    });
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
        context.defer(Math.max(1000, liveMirrorBackoff.remaining()));
        return;
      }
      await deliverCompleted(event, thread);
    }
  } catch (error) {
    if (event.delivery) {
      deferred = true;
      context.defer(15000);
      log(`Completed output for ${thread.id} could not be delivered; will retry.`);
    } else if (shouldDeferCodexRun(error)) {
      deferred = true;
      context.defer(15000);
      await settleLiveSuppression(event, thread, { forceClear: true });
      const backendUnavailable = error?.code !== "BUSY";
      if (backendUnavailable) {
        log(`Shared Codex connection for ${thread.id} is unavailable (${error.code}); run remains pending.`);
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
          body: backendUnavailable
            ? "Codex is reconnecting. Your message remains pending and will start when the shared service is available.\n\n/cancel · /thread"
            : "This task is already working locally. Your message is pending and will start when it is free.\n\n/cancel · /thread",
        });
      }
    } else {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "UNKNOWN";
      log(`Codex run for ${thread.id} failed (${code}).`);
      await settleLiveSuppression(event, thread, { forceClear: true });
      failedRuns.record(thread.id, { body: String(reply.body || ""), images, replyId: event.replyId, claimed: event.claimed, queuedAt: event.queuedAt, mirrorSuppressionToken: null });
      saveClaimedJob(event, "failed");
      await publishFailure(thread, error, `run:${event.replyId}:failure`);
      try { await updateThreadStatus(thread, "error"); } catch {}
    }
  } finally {
    await imsgTransport.setThreadTyping(thread.id, false).catch(() => {});
    if (sharedLeaseHeld) sharedBackendTurnLease.release();
    if (progressTimer) clearInterval(progressTimer);
    if (managedCompletion) completions.unmanage(thread.id);
    if (!deferred) delete event.claimed;
    if (!deferred) pendingNotices.delete(event.replyId);
    scheduleSynchronize();
  }
}

const runs = new RunManager({
  maxConcurrent: 1,
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
        body: "Pending. Codex will start this message when a run slot is free.\n\n/cancel · /thread · /threads",
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

async function handleControl(event) {
  const command = String(event.command || "").toLowerCase();
  const thread = event.threadId ? catalogById.get(String(event.threadId)) : null;
  if (command === "threads" || command === "recent" || command === "refresh") {
    await publishThreadDirectory(event.threadId);
    return;
  }
  if (command === "cancel") {
    const threadId = event.threadId ? String(event.threadId) : "";
    if (threadId) imsgTransport.router.consumeThreadListen(threadId);
    // Top-level /cancel consumes the awaiting-prompt lease atomically during
    // routing, while a native Reply /cancel is cleared here. Preserve either
    // path so selection-only cancellation never reports that no work existed.
    const selectionCleared = imsgTransport.router.clearAwaitingPrompt(threadId || null)
      || event.fromAwaitingPrompt === true;
    if (selectionCleared) {
      scheduleLiveMirrorScan();
      scheduleCompletionScan();
    }
    cancelledThrough.set(threadId, Date.now());
    const claiming = ingestPendingCounts.get(threadId) || [...claimingReplyIds.values()].filter((id) => id === threadId).length;
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
    return;
  }
  if (!thread) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available.\n\n/threads" });
    return;
  }
  if (command === "listen") {
    imsgTransport.router.setThreadListen(thread.id, true);
    await sendOutbound({
      kind: "service.notice",
      code: "updated",
      thread: threadLabel(thread),
      body: "Listening for the next turn’s live updates.",
    });
    return;
  }
  if (command === "link") {
    await sendOutbound({
      kind: "service.notice",
      code: "updated",
      thread: threadLabel(thread),
      body: `codex://threads/${encodeURIComponent(thread.id)}`,
    });
    return;
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
    return;
  }
  if (command === "open" || command === "thread" || command === "status") {
    const detail = await buildThreadDetailEvent(thread);
    await publishThreadHeader(thread, detail);
    await sendOutbound(detail);
    return;
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
    return;
  }
  if (command === "turn") {
    await sendOutbound({
      kind: "thread.turn",
      thread: threadLabel(thread),
      turn: await currentThreadTurn(thread),
      reasoningEffort: effectiveReasoning(thread),
    });
    return;
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
    return;
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
        return;
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
    return;
  }
  if (command === "retry") {
    const failures = failedRuns.list(thread.id);
    const failed = failedRuns.next(thread.id);
    if (!failed) {
      const body = failures.length
        ? "The failed message is already pending or running.\n\n/thread · /cancel"
        : "There is no failed iMessage request to retry.\n\n/turn · /threads";
      await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body });
      return;
    }
    const retry = {
      threadId: thread.id,
      replyId: failed.replyId || `retry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      claimed: failed.claimed || { reply: { body: failed.body }, images: failed.images },
      queuedAt: failed.queuedAt || new Date().toISOString(),
      retryOf: failed.replyId,
    };
    saveClaimedJob(retry, "queued");
    if (enqueueReply(retry)) failedRuns.markRetrying(thread.id, failed.replyId);
    else markClaimedJobState(retry.replyId, "failed");
    return;
  }
  if (command === "dismiss") {
    const failed = failedRuns.list(thread.id)[0] || null;
    if (!failed) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "There is no failed iMessage request to dismiss.\n\n/thread · /threads" });
      return;
    }
    if (failed.retrying) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "That failed request is already pending or running. Use /cancel before dismissing it." });
      return;
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
  }
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
    return;
  }
  const images = await imsgTransport.importInboundAttachments(attachments, {
    destinationRoot: `${paths.attachments}/imsg`,
    messageKey: action.messageKey,
  });
  const body = String(bodyValue || "").trim() || (images.length ? "Please review the attached image." : "");
  if (!body) {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "That message did not contain text or a supported image." });
    return;
  }
  imsgTransport.rememberInbound(thread.id, action.guid);
  await ingestReply({
    threadId: thread.id,
    replyId: `imsg:${action.messageKey}`,
    createdAt: action.createdAt || new Date().toISOString(),
    queuedAt: action.createdAt || new Date().toISOString(),
    imsgGuid: action.guid || null,
    claimed: {
      reply: { id: `imsg:${action.messageKey}`, body, media: [] },
      images,
      userMirrorMode: submittedUserMirrorMode(action),
    },
  });
  scheduleLiveMirrorScan();
  scheduleCompletionScan();
}

async function handleLocalAction(action) {
  if (action.kind === "threads" || action.kind === "refresh") {
    await publishThreadDirectory(imsgTransport.router.lastUserThreadId);
    return;
  }
  if (action.kind === "help") {
    await sendOutbound({ kind: "service.menu", label: "COMMANDS" }, { replyToGuid: action.guid });
    return;
  }
  if (action.kind === "projects") {
    await publishProjects();
    return;
  }
  if (action.kind === "search") {
    await publishSearch(action.argument, action);
    return;
  }
  if (action.kind === "project") {
    await publishProject(action.projectKey);
    return;
  }
  if (action.kind === "stale-menu" || action.kind === "stale-poll") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That selection expired. Here is a fresh directory; choose a new option." });
    await publishThreadDirectory(imsgTransport.router.lastUserThreadId);
    return;
  }
  if (action.kind === "stale-reply-context" || action.kind === "ambiguous-reply-context") {
    await sendOutbound({
      kind: "service.notice",
      code: "needs-attention",
      body: action.kind === "stale-reply-context"
        ? "That reply thread is no longer mapped to a Codex task. Choose the task again with /threads."
        : "That reply thread maps to more than one Codex task, so nothing was run. Choose the task again with /threads.",
    });
    return;
  }
  if (action.kind === "no-thread") {
    await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "No thread is selected.\nText /threads to choose one." });
    return;
  }
  if (action.kind === "unknown-command") {
    const thread = action.threadId ? catalogById.get(String(action.threadId)) : null;
    await sendOutbound({
      kind: "service.notice",
      code: "needs-attention",
      ...(thread ? { thread: threadLabel(thread) } : {}),
      body: "That command is not available.\n\n/help · /thread · /turn · /history · /reasoning",
    });
    return;
  }
  if (action.kind === "thread-picker") {
    await publishCommandThreadPicker(action.command, action);
    return;
  }
  if (action.kind === "switch") {
    const thread = catalogById.get(String(action.threadId || ""));
    if (!thread) {
      await sendOutbound({ kind: "service.notice", code: "needs-attention", body: "That menu has changed.\nText /threads for a fresh list." });
      return;
    }
    imsgTransport.router.touchThread(thread.id, action.createdAt);
    if (action.prompt) {
      await queueLocalPrompt(action, thread.id, action.prompt, []);
    } else {
      // Router ingestion established this atomically before the menu action was
      // queued. If a later user message already consumed it, a retried menu
      // action must not reopen the pause or send a stale prompt.
      const lease = manualSelectionLease(action, imsgTransport.router.awaitingPrompt);
      if (!lease) return;
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
          body: "Send the message you want to run in this task. Reply /cancel to leave this selection.",
        }),
      });
    }
    return;
  }
  if (action.kind === "prompt") {
    await queueLocalPrompt(action, action.threadId);
    return;
  }
  if (action.kind === "control") {
    await handleControl(action);
    return;
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

function settleFailedLocalAction(action, code, detail = "") {
  const key = String(action?.messageKey || "");
  if (!key) return;
  const preservePending = code === "CLAIMED_STORE_UNAVAILABLE";
  if (!preservePending) imsgTransport.acknowledge(key);
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
    await localActionContext.run(
      { messageKey: key, sequence: 0 },
      () => handleLocalAction(action),
    );
    await imsgTransport.acceptInbound(action);
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
      settleFailedLocalAction(action, code, detail);
    } else {
      log(`Local iMessage action could not be completed (${diagnostic}); it will retry with a bounded backoff.`);
    }
  } finally {
    localActionsInFlight.delete(key);
  }
}

const localActionDispatch = new LocalActionDispatch(processLocalAction);

function queueLocalAction(action) {
  imsgTransport.observeInbound(action).catch(() => {});
  return localActionDispatch.enqueue(action, {
    immediate: action?.kind === "control" && action.command === "cancel",
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
  setInterval(scheduleLiveMirrorScan, 2000).unref();
  setInterval(scheduleCompletionScan, 10 * 1000).unref();
  setInterval(() => synchronize().catch(() => log("Background synchronization failed; will retry.")), 30 * 1000).unref();
  serviceReadiness.markReady();
}

async function stop() {
  if (stopped) return;
  stopped = true;
  if (presenceOfflineTimer) clearTimeout(presenceOfflineTimer);
  presenceOfflineTimer = null;
  runs.shutdown();
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
