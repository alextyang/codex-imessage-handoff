#!/usr/bin/env node
import WebSocket from "ws";
import os from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readConfig } from "./config.mjs";
import { listThreads } from "./thread-store.mjs";
import { getThreadDetail, getLatestRequest, getTurn, getHistory } from "./thread-history.mjs";
import { buildThreadDirectory } from "./thread-directory.mjs";
import { getReasoningOverride, setReasoningOverride, listReasoningOptions } from "./thread-settings.mjs";
import { RelayClient } from "./relay-client.mjs";
import { CodexRunner } from "./codex-runner.mjs";
import { RunManager } from "./run-manager.mjs";
import { FailureQueue } from "./failure-queue.mjs";
import { loadClaimedJobs, markClaimedJobState, removeClaimedJob, saveClaimedJob } from "./claimed-store.mjs";
import { CompletionMonitor } from "./completion-monitor.mjs";
import { LiveMirror } from "./live-mirror.mjs";
import { activeDescendant } from "./active-thread.mjs";
import { ActiveSelection } from "./active-selection.mjs";
import { LiveMirrorRetryBackoff } from "./live-mirror-backoff.mjs";
import { PendingFollowStore } from "./pending-follow-store.mjs";
import { servicePaths } from "./paths.mjs";

const config = readConfig();
const relay = new RelayClient(config);
const paths = servicePaths();
const completions = new CompletionMonitor(paths.completionState);
const liveMirror = new LiveMirror({ stateFile: paths.liveMirrorState });
const activeSelection = new ActiveSelection();
const liveMirrorBackoff = new LiveMirrorRetryBackoff();
const pendingFollow = new PendingFollowStore(paths.pendingFollowState);
const pendingFollowBackoff = new LiveMirrorRetryBackoff();
const failedRuns = new FailureQueue();
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
let lastCatalogSignature = null;
let catalogById = new Map();
let controlChain = Promise.resolve();
let completionMonitoringStarted = false;
let completionScanInFlight = null;
let liveMirrorScanInFlight = null;
let activeFollowInFlight = null;
let liveMirrorPaused = Boolean(pendingFollow.get());
let pendingFollowDeliveryInFlight = null;

function clearPendingFollow(deliveryId = null) {
  const cleared = pendingFollow.clear(deliveryId);
  if (cleared) {
    pendingFollowBackoff.reset();
    liveMirrorPaused = false;
    scheduleLiveMirrorScan();
  }
  return cleared;
}

function selectActiveThread(threadId, selectedAt, { resume = true } = {}) {
  const { id: nextId, changed } = activeSelection.update(threadId, selectedAt);
  if (!nextId) {
    liveMirror.deactivate();
    liveMirrorBackoff.reset();
    clearPendingFollow();
    return { changed, active: false };
  }
  const thread = catalogById.get(nextId);
  if (!thread) return { changed, active: false };
  let activation = null;
  if (changed || liveMirror.activeThreadId !== nextId) {
    activation = liveMirror.activate(thread, { resume: changed ? resume : true });
    liveMirrorBackoff.reset();
  }
  scheduleLiveMirrorScan();
  return { changed, active: true, thread, activation };
}

function applyRegistration(registration, { resume = true } = {}) {
  if (!registration || !Object.prototype.hasOwnProperty.call(registration, "activeThreadId")) return;
  const remoteId = String(registration.activeThreadId || "").trim() || null;
  const pending = pendingFollow.get();
  if (pending && pending.threadId !== remoteId && !activeFollowInFlight) {
    clearPendingFollow(pending.deliveryId);
  }
  selectActiveThread(registration.activeThreadId, registration.activeThreadUpdatedAt, { resume });
}

function cancelPendingFollowForSelection(threadId) {
  const pending = pendingFollow.get();
  const selectedId = String(threadId || "").trim();
  if (!pending || !selectedId || pending.threadId === selectedId) return;
  clearPendingFollow(pending.deliveryId);
}

async function deliverLocalCompletion(completion) {
  const activity = await relay.notificationStatus({ signal: AbortSignal.timeout(10_000) });
  if (activity?.active !== true) return { status: activity?.status || "INACTIVE" };
  const thread = catalogById.get(String(completion.threadId || ""));
  if (thread && activeSelection.id === thread.id) {
    const mirror = await drainSelectedLiveMirror(thread);
    if (mirror.pending) return { status: "IN_PROGRESS" };
  }
  const label = thread
    ? threadLabel(thread)
    : { id: completion.threadId, title: "Codex task", projectLabel: "Codex" };
  return relay.outbound({
    kind: "thread.completed",
    completionId: completion.completionId,
    thread: label,
    body: completion.body,
    completedAt: completion.completedAt,
  }, { signal: AbortSignal.timeout(15_000) });
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
  if (!activeSelection.id || message.threadId !== activeSelection.id) return { status: "STALE_SELECTION" };
  const thread = catalogById.get(message.threadId);
  if (!thread) return { status: "STALE_SELECTION" };
  return relay.outbound({
    kind: "thread.live-message",
    messageId: message.deliveryId,
    thread: threadLabel(thread),
    role: message.role,
    phase: message.phase,
    body: message.body,
    at: message.createdAt,
  }, { signal: AbortSignal.timeout(15_000) });
}

async function scanLiveMirror() {
  const selectedId = activeSelection.id;
  if (!selectedId || liveMirrorPaused || !liveMirrorBackoff.ready()) return;
  const thread = catalogById.get(selectedId);
  if (!thread) return;
  if (liveMirror.activeThreadId !== selectedId) liveMirror.activate(thread, { resume: true });
  let retryable = false;
  for (let pass = 0; pass < 16 && selectedId === activeSelection.id && !liveMirrorPaused; pass += 1) {
    const result = await liveMirror.reconcile(thread, { deliver: deliverLiveMessage });
    if (result.retryable > 0) {
      liveMirrorBackoff.recordFailure();
      retryable = true;
      break;
    }
    if (!result.more) break;
  }
  if (!retryable) liveMirrorBackoff.reset();
}

function scheduleLiveMirrorScan() {
  if (stopped || liveMirrorPaused || liveMirrorScanInFlight || !activeSelection.id || !liveMirrorBackoff.ready()) return;
  liveMirrorScanInFlight = scanLiveMirror()
    .catch(() => {
      liveMirrorBackoff.recordFailure();
      log("Live task synchronization failed; will retry.");
    })
    .finally(() => { liveMirrorScanInFlight = null; });
}

async function drainSelectedLiveMirror(thread) {
  if (liveMirrorPaused || !liveMirrorBackoff.ready()) return { pending: true };
  if (!thread || liveMirror.activeThreadId !== thread.id || activeSelection.id !== thread.id) {
    return { pending: false };
  }
  for (let pass = 0; pass < 16; pass += 1) {
    const result = await liveMirror.reconcile(thread, { deliver: deliverLiveMessage });
    if (result.retryable > 0) {
      liveMirrorBackoff.recordFailure();
      return { pending: true };
    }
    if (!result.more) {
      if (!result.partial) liveMirrorBackoff.reset();
      return { pending: result.partial === true };
    }
  }
  return { pending: true };
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
      liveMirror.clearSuppression(token);
      if (event) event.mirrorSuppressionToken = null;
      cleared = true;
    }
  }
  return { cleared, pending: drain.pending };
}

function followDeliveryId(parentThreadId, threadId, selectedAt, activityAt) {
  return createHash("sha256")
    .update(`follow-context-v1\0${parentThreadId}\0${threadId}\0${selectedAt || ""}\0${activityAt || ""}`)
    .digest("hex");
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

async function preparePendingFollow() {
  const pending = pendingFollow.get();
  if (!pending || pending.event || pending.threadId !== activeSelection.id) return pending;
  const thread = catalogById.get(pending.threadId);
  if (!thread) {
    clearPendingFollow(pending.deliveryId);
    return null;
  }
  const activation = liveMirror.activate(thread, { resume: true });
  const event = await buildThreadDetailEvent(thread, {
    deliveryId: pending.deliveryId,
    reason: "fork",
    endOffset: activation.offset,
  });
  return pendingFollow.save({ ...pending, event });
}

async function deliverPendingFollowNow() {
  let pending = pendingFollow.get();
  if (!pending) return;
  if (pending.threadId !== activeSelection.id) return;
  pending = await preparePendingFollow();
  if (!pending) return;
  if (!pending.event) throw new Error("Pending fork context is not ready.");
  const result = await relay.outbound(pending.event, { signal: AbortSignal.timeout(15_000) });
  const outcome = outboundOutcome(result);
  if (outcome.status === "STALE_SELECTION") {
    const status = await relay.serviceStatus({ signal: AbortSignal.timeout(10_000) });
    const remoteId = String(status?.activeThread?.id || "").trim() || null;
    selectActiveThread(remoteId, status?.activeThreadUpdatedAt, { resume: false });
  } else if (outcome.status === "NO_BINDING") {
    selectActiveThread(null, null, { resume: false });
  }
  if (outcome.terminal) {
    clearPendingFollow(pending.deliveryId);
  } else {
    pendingFollowBackoff.recordFailure();
  }
}

function schedulePendingFollowDelivery() {
  const pending = pendingFollow.get();
  if (stopped
    || pendingFollowDeliveryInFlight
    || !pendingFollowBackoff.ready()
    || !pending
    || pending.threadId !== activeSelection.id) {
    return pendingFollowDeliveryInFlight;
  }
  pendingFollowDeliveryInFlight = deliverPendingFollowNow()
    .catch(() => {
      pendingFollowBackoff.recordFailure();
      log("Fork context delivery failed; will retry.");
    })
    .finally(() => { pendingFollowDeliveryInFlight = null; });
  return pendingFollowDeliveryInFlight;
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function threadLabel(thread) {
  return {
    id: thread.id,
    title: thread.title,
    projectKey: thread.projectKey,
    projectLabel: thread.projectLabel,
  };
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
  const catalog = threads.map((thread) => {
    const state = effectiveState(thread);
    return {
      id: thread.id,
      title: thread.title,
      cwd: thread.projectLabel || "Codex",
      projectKey: thread.projectKey,
      projectLabel: thread.projectLabel,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      activityAt: state.status === "working" || state.status === "pending"
        ? state.stateSince
        : thread.activityAt || thread.updatedAt,
      stateSince: state.stateSince,
      status: state.status,
      pendingCount: state.pendingCount,
      reasoningEffort: effectiveReasoning(thread),
      archived: thread.archived,
      visible: thread.visible,
    };
  });
  const signature = JSON.stringify(catalog);
  if (signature !== lastCatalogSignature) {
    await relay.syncCatalog(catalog);
    lastCatalogSignature = signature;
  }
  if (activeSelection.id && liveMirror.activeThreadId !== activeSelection.id) {
    const selected = catalogById.get(activeSelection.id);
    if (selected) liveMirror.activate(selected, { resume: true });
  }
  scheduleCompletionScan();
  scheduleLiveMirrorScan();
  scheduleActiveForkFollow(threads);
  return threads;
}

function scheduleActiveForkFollow(threads) {
  if (stopped || activeFollowInFlight || !activeSelection.id || !activeSelection.selectedAt) return;
  const existing = pendingFollow.get();
  if (existing) {
    if (existing.threadId === activeSelection.id) {
      schedulePendingFollowDelivery();
      return;
    }
    activeFollowInFlight = relay.serviceStatus({ signal: AbortSignal.timeout(10_000) })
      .then((status) => {
        const remoteId = String(status?.activeThread?.id || "").trim() || null;
        if (remoteId === existing.threadId) {
          selectActiveThread(remoteId, status?.activeThreadUpdatedAt, { resume: false });
          schedulePendingFollowDelivery();
        } else {
          clearPendingFollow(existing.deliveryId);
          if (remoteId !== activeSelection.id) {
            selectActiveThread(remoteId, status?.activeThreadUpdatedAt, { resume: false });
          }
        }
      })
      .catch(() => log("Pending fork selection could not be reconciled; will retry."))
      .finally(() => { activeFollowInFlight = null; });
    return;
  }
  const expectedThreadId = activeSelection.id;
  const selectionSnapshot = activeSelection.capture();
  const descendant = activeDescendant(threads, expectedThreadId, activeSelection.selectedAt);
  if (!descendant) return;
  const deliveryId = followDeliveryId(
    expectedThreadId,
    descendant.id,
    activeSelection.selectedAt,
    descendant.activityAt || descendant.updatedAt,
  );
  pendingFollow.save({ deliveryId, threadId: descendant.id, parentThreadId: expectedThreadId, event: null });
  liveMirrorPaused = true;
  activeFollowInFlight = (async () => {
    const result = await relay.followThread(descendant.id, expectedThreadId, { signal: AbortSignal.timeout(10_000) });
    if (!activeSelection.isCurrent(selectionSnapshot)) {
      clearPendingFollow(deliveryId);
      const status = await relay.serviceStatus({ signal: AbortSignal.timeout(10_000) });
      const currentId = String(status?.activeThread?.id || "").trim() || null;
      selectActiveThread(currentId, status?.activeThreadUpdatedAt, { resume: false });
      return;
    }
    const remoteId = String(result?.currentThreadId || "").trim() || null;
    if (remoteId === descendant.id) {
      liveMirrorPaused = true;
      try {
        selectActiveThread(descendant.id, result.activeThreadUpdatedAt, { resume: false });
        await preparePendingFollow();
        await schedulePendingFollowDelivery();
      } finally {
        if (!pendingFollow.get()) {
          liveMirrorPaused = false;
          scheduleLiveMirrorScan();
        }
      }
      return;
    }
    // A manual selection won the compare-and-swap. Mirror that choice and do
    // not emit a second switch notice over the user's own navigation.
    clearPendingFollow(deliveryId);
    if (remoteId !== activeSelection.id) {
      selectActiveThread(remoteId, result?.activeThreadUpdatedAt, { resume: false });
    } else if (remoteId) {
      selectActiveThread(remoteId, result?.activeThreadUpdatedAt, { resume: true });
    }
  })()
    .catch(() => {
      log("Active fork synchronization failed; selection will be reconciled.");
      scheduleSynchronize(1000);
    })
    .finally(() => { activeFollowInFlight = null; });
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

async function publishFailure(thread, error) {
  const body = error?.code === "MISSING_CWD"
    ? "This task’s project folder is no longer available.\n\n/threads"
    : "Codex could not complete this request.\n\n/retry · /turn · /threads";
  await relay.outbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body });
}

async function discardReply(event) {
  await settleLiveSuppression(event, catalogById.get(String(event.threadId || "")), { forceClear: true });
  try { markClaimedJobState(event.replyId, "cancelled"); } catch {}
  try {
    if (!event.claimed) await relay.claim(String(event.threadId), String(event.replyId));
  } catch (error) {
    if (error?.status !== 409) throw error;
  }
  removeClaimedJob(event.replyId);
  failedRuns.remove(event.threadId, event.replyId);
  pendingNotices.delete(event.replyId);
}

async function deliverCompleted(event, thread) {
  const delivery = event.delivery;
  if (!delivery.textDelivered) {
    await relay.outbound({ kind: "thread.output", thread: threadLabel(thread), body: delivery.body });
    delivery.textDelivered = true;
    saveClaimedJob(event, "delivering");
  }
  if (Array.isArray(delivery.generatedImages) && delivery.generatedImages.length > 0) {
    await relay.publishImages(thread, delivery.generatedImages);
  } else {
    await relay.updateThreadStatus(thread, "idle");
  }
  failedRuns.remove(thread.id, event.replyId);
  removeClaimedJob(event.replyId);
}

async function executeReply(event, context) {
  const thread = catalogById.get(String(event.threadId || ""));
  if (!thread) {
    await relay.outbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available, so the message was not run.\n\n/threads" });
    await discardReply(event);
    return;
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
    try {
      claim = await relay.claim(thread.id, String(event.replyId || ""));
      const reply = claim.reply || {};
      event.claimed = { ...claim, images: [] };
      saveClaimedJob(event, "queued");
      claim.images = await relay.downloadImages(thread.id, reply);
      event.claimed = claim;
      saveClaimedJob(event, "queued");
    } catch (error) {
      if (error?.status === 409) return;
      if (!claim) {
        context.defer(5000);
        log(`Could not claim reply for ${thread.id}; will retry.`);
        return;
      }
      failedRuns.record(thread.id, { body: String(claim?.reply?.body || ""), images: [], replyId: event.replyId, claimed: event.claimed, queuedAt: event.queuedAt });
      if (event.claimed) markClaimedJobState(event.replyId, "failed");
      await publishFailure(thread, error);
      try { await relay.updateThreadStatus(thread, "error"); } catch {}
      return;
    }
  }

  const reply = claim.reply || {};
  const hasRemoteMedia = Array.isArray(reply.media) && reply.media.length > 0;
  const localMediaMissing = !Array.isArray(claim.images) || claim.images.length === 0 || claim.images.some((file) => !existsSync(file));
  if (hasRemoteMedia && localMediaMissing) {
    try {
      claim.images = await relay.downloadImages(thread.id, reply);
      event.claimed = claim;
      saveClaimedJob(event, "queued");
    } catch (error) {
      failedRuns.record(thread.id, { body: String(reply.body || ""), images: [], replyId: event.replyId, claimed: event.claimed, queuedAt: event.queuedAt });
      markClaimedJobState(event.replyId, "failed");
      await publishFailure(thread, error);
      return;
    }
  }
  const images = claim.images || [];
  const runner = new CodexRunner();
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

  try {
    await relay.updateThreadStatus(thread, "working");
    scheduleSynchronize();
    if (cancelRequested) {
      removeClaimedJob(event.replyId);
      failedRuns.remove(thread.id, event.replyId);
      await relay.outbound({ kind: "service.notice", code: "cancelled", thread: threadLabel(thread), body: "Stopped at your request." });
      await relay.updateThreadStatus(thread, "idle");
      return;
    }
    progressTimer = setInterval(async () => {
      if (!pendingPhase || pendingPhase === lastPublishedPhase || Date.now() - lastProgressAt < 30000) return;
      const phase = pendingPhase;
      lastPublishedPhase = phase;
      lastProgressAt = Date.now();
      try {
        await relay.outbound({ kind: "thread.progress", thread: threadLabel(thread), phase });
      } catch {
        log("Could not publish progress.");
      }
    }, 5000);
    progressTimer.unref?.();

    markClaimedJobState(event.replyId, "running");
    if (!event.mirrorSuppressionToken) {
      event.mirrorSuppressionToken = liveMirror.suppressUser(thread.id, String(reply.body || ""));
      if (event.mirrorSuppressionToken) saveClaimedJob(event, "running");
    }
    runStartedAt = new Date().toISOString();
    completions.manage(thread.id, runStartedAt);
    managedCompletion = true;
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
      await relay.outbound({ kind: "service.notice", code: "cancelled", thread: threadLabel(thread), body: "Stopped at your request." });
      await relay.updateThreadStatus(thread, "idle");
    } else {
      event.delivery = { body: result.body, generatedImages: result.generatedImages || [], textDelivered: false };
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
    } else if (error?.code === "BUSY") {
      deferred = true;
      context.defer(15000);
      await settleLiveSuppression(event, thread, { forceClear: true });
      saveClaimedJob(event, "queued");
      await relay.updateThreadStatus(thread, "pending");
      if (!event.busyNoticeSent) {
        event.busyNoticeSent = true;
        await relay.outbound({
          kind: "service.notice",
          code: "queued",
          thread: threadLabel(thread),
          body: "This task is already working locally. Your message is pending and will start when it is free.\n\n/cancel · /thread",
        });
      }
    } else {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "UNKNOWN";
      log(`Codex run for ${thread.id} failed (${code}).`);
      await settleLiveSuppression(event, thread, { forceClear: true });
      failedRuns.record(thread.id, { body: String(reply.body || ""), images, replyId: event.replyId, claimed: event.claimed, queuedAt: event.queuedAt, mirrorSuppressionToken: null });
      saveClaimedJob(event, "failed");
      await publishFailure(thread, error);
      try { await relay.updateThreadStatus(thread, "error"); } catch {}
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (managedCompletion) completions.unmanage(thread.id);
    if (!deferred) delete event.claimed;
    if (!deferred) pendingNotices.delete(event.replyId);
    scheduleSynchronize();
  }
}

const runs = new RunManager({
  maxConcurrent: Number(process.env.IMESSAGE_HANDOFF_CONCURRENCY) || 3,
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
      await relay.outbound({
        kind: "service.notice",
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
  let delay = 1000;
  while (!stopped && !runs.has(replyId)) {
    claimingReplyIds.set(replyId, threadId);
    try {
      if (!event.claimed) {
        const claim = await relay.claim(threadId, replyId);
        event.claimed = { ...claim, images: [] };
      }
      saveClaimedJob(event, "queued");
      if ((cancelledThrough.get(threadId) || 0) >= event.receivedAtMs) {
        await discardReply(event);
        return;
      }
      if (!catalogById.has(threadId)) {
        await relay.outbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available, so the message was not run.\n\n/threads" });
        await discardReply(event);
        return;
      }
      enqueueReply(event);
      return;
    } catch (error) {
      if (error?.status === 409) return;
      log(`Could not save pending reply ${replyId}; will retry.`);
    } finally {
      claimingReplyIds.delete(replyId);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(30000, delay * 2);
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
    if (job.state === "queued" || job.state === "delivering") {
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
    ...(options.reason ? { reason: options.reason } : {}),
    thread: threadLabel(thread),
    state: state.status,
    activityAt: detail.activityAt || thread.activityAt,
    stateSince: state.stateSince,
    pendingCount: state.pendingCount,
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

async function publishThreadDetail(thread) {
  await relay.outbound(await buildThreadDetailEvent(thread));
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
    latestRequest: (thread) => {
      const turn = getTurn(thread);
      return { body: turn?.request || "", at: turn?.startedAt || thread.lastTurnAt };
    },
  });
  await relay.outbound({ kind: "service.directory", directory: planned.directory });
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
    cancelledThrough.set(threadId, Date.now());
    const claiming = ingestPendingCounts.get(threadId) || [...claimingReplyIds.values()].filter((id) => id === threadId).length;
    const cancelled = await runs.cancel(threadId);
    if (!cancelled.active && cancelled.pending === 0 && claiming === 0) {
      await relay.outbound({ kind: "service.notice", code: "needs-attention", thread: thread ? threadLabel(thread) : undefined, body: "There is no iMessage-started work to cancel." });
    } else if (!cancelled.active) {
      const count = cancelled.pending + claiming;
      await relay.outbound({ kind: "service.notice", code: "cancelled", thread: thread ? threadLabel(thread) : undefined, body: `Removed ${count} pending message${count === 1 ? "" : "s"}.` });
    }
    return;
  }
  if (!thread) {
    await relay.outbound({ kind: "service.notice", code: "needs-attention", body: "That task is no longer available.\n\n/threads" });
    return;
  }
  if (command === "open" || command === "thread" || command === "status") {
    await publishThreadDetail(thread);
    return;
  }
  if (command === "request" || command === "message") {
    const state = effectiveState(thread);
    const turn = state.request === null ? await getTurn(thread) : null;
    await relay.outbound({
      kind: "thread.request",
      thread: threadLabel(thread),
      body: state.request ?? await getLatestRequest(thread),
      at: state.requestAt || turn?.startedAt || null,
    });
    return;
  }
  if (command === "turn") {
    const state = effectiveState(thread);
    const turn = await getTurn(thread);
    const serviceTurnVisible = state.request !== null
      && state.status === "working"
      && turn?.state === "running"
      && turn.request === state.request;
    const current = state.request !== null && !serviceTurnVisible
      ? { state: state.status, request: state.request, requestAt: state.requestAt, assistantMessages: [], finalResponse: null, completedAt: null }
      : outboundTurn(turn);
    await relay.outbound({ kind: "thread.turn", thread: threadLabel(thread), turn: current, reasoningEffort: effectiveReasoning(thread) });
    return;
  }
  if (command === "history") {
    const requested = Number.parseInt(String(event.argument || "3"), 10);
    const limit = Math.max(1, Math.min(5, Number.isFinite(requested) ? requested : 3));
    await relay.outbound({ kind: "thread.history", thread: threadLabel(thread), turns: (await getHistory(thread, limit)).map(outboundTurn) });
    return;
  }
  if (command === "reasoning") {
    let options = listReasoningOptions(thread);
    const requested = String(event.argument || "").trim().toLowerCase();
    let current = effectiveReasoning(thread);
    let changed = false;
    if (requested) {
      if (!options.some((option) => option.value === requested)) {
        await relay.outbound({ kind: "service.reasoning", thread: threadLabel(thread), current, options, invalid: requested });
        return;
      }
      setReasoningOverride(thread.id, requested);
      current = effectiveReasoning(thread);
      changed = true;
      options = listReasoningOptions(thread);
      scheduleSynchronize();
    }
    const running = effectiveState(thread).status === "working";
    await relay.outbound({
      kind: "service.reasoning",
      thread: threadLabel(thread),
      current,
      options,
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
      await relay.outbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body });
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
      await relay.outbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "There is no failed iMessage request to dismiss.\n\n/thread · /threads" });
      return;
    }
    if (failed.retrying) {
      await relay.outbound({ kind: "service.notice", code: "needs-attention", thread: threadLabel(thread), body: "That failed request is already pending or running. Use /cancel before dismissing it." });
      return;
    }
    await settleLiveSuppression(failed, thread, { forceClear: true });
    failedRuns.remove(thread.id, failed.replyId);
    removeClaimedJob(failed.replyId);
    const remaining = failedRuns.list(thread.id).length;
    try { await relay.updateThreadStatus(thread, remaining ? "error" : "idle"); } catch {}
    scheduleSynchronize();
    await relay.outbound({
      kind: "service.notice",
      code: "updated",
      thread: threadLabel(thread),
      body: remaining
        ? `Dismissed one failed request. ${remaining} still need${remaining === 1 ? "s" : ""} attention.\n\n/retry · /dismiss`
        : "Dismissed the failed request. This task is clear.",
    });
  }
}

async function runControl(event) {
  try {
    if (event.threadId) {
      const threadId = String(event.threadId);
      cancelPendingFollowForSelection(threadId);
      selectActiveThread(threadId, event.createdAt, { resume: threadId === activeSelection.id });
    }
    await handleControl(event);
  } catch {
    log("Control command failed.");
    try {
      await relay.outbound({ kind: "service.notice", code: "needs-attention", body: "That control could not be completed. Try again or use /threads." });
    } catch {}
  }
}

function connect() {
  if (stopped) return;
  const socket = new WebSocket(relay.eventsUrl());
  let heartbeatTimer = null;
  socket.on("open", () => {
    log("Connected to relay.");
    socket.send(JSON.stringify({ type: "service-connected", clientId: config.clientId }));
    socket.send(JSON.stringify({ type: "service-heartbeat", clientId: config.clientId }));
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "service-heartbeat", clientId: config.clientId }));
      }
    }, 20 * 1000);
    heartbeatTimer.unref?.();
  });
  socket.on("message", (data) => {
    try {
      const event = JSON.parse(String(data));
      if (event.type === "reply-pending") {
        const threadId = String(event.threadId || "");
        if (threadId) {
          cancelPendingFollowForSelection(threadId);
          selectActiveThread(threadId, event.createdAt, { resume: threadId === activeSelection.id });
        }
        queueIngest(event);
      }
      if (event.type === "control") {
        // Cancellation stays immediate even if a large directory/history view
        // is still scanning or delivering. Presentation controls remain
        // ordered so their messages and menu snapshots cannot cross.
        if (String(event.command || "").toLowerCase() === "cancel") runControl(event);
        else controlChain = controlChain.catch(() => {}).then(() => runControl(event));
      }
    } catch {
      log("Ignored malformed relay event.");
    }
  });
  socket.on("close", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (!stopped) setTimeout(connect, 2000 + Math.floor(Math.random() * 2000)).unref();
  });
  socket.on("error", () => socket.close());
}

async function main() {
  const restoredJobs = loadClaimedJobs();
  for (const job of restoredJobs) {
    if (job.delivery?.body) completions.suppressNext(job.threadId, job.delivery.body, job.queuedAt);
  }
  const threads = await synchronize();
  await completions.reconcile(threads, { deliver: deliverLocalCompletion, deliverPending: false });
  const registration = await relay.register();
  applyRegistration(registration, { resume: true });
  await restoreClaimedState(restoredJobs);
  if (registration.pairingRequired) {
    log(`Pairing required: text ${registration.pairingCode} to ${registration.sendblueNumber} within 15 minutes.`);
  } else {
    log(`Ready on ${os.hostname()} with ${threads.length} top-level tasks.`);
  }
  connect();
  completionMonitoringStarted = true;
  scheduleCompletionScan();
  scheduleLiveMirrorScan();
  scheduleActiveForkFollow(threads);
  setInterval(() => {
    scheduleLiveMirrorScan();
    schedulePendingFollowDelivery();
  }, 750).unref();
  setInterval(scheduleCompletionScan, 10 * 1000).unref();
  setInterval(() => synchronize().catch(() => log("Background synchronization failed; will retry.")), 30 * 1000).unref();
  setInterval(() => relay.register()
    .then((refreshed) => {
      applyRegistration(refreshed, { resume: true });
      scheduleActiveForkFollow([...catalogById.values()]);
    })
    .catch(() => log("Service registration refresh failed; will retry.")), 5 * 60 * 1000).unref();
}

process.on("SIGTERM", () => { stopped = true; runs.cancelAll(); process.exit(0); });
process.on("SIGINT", () => { stopped = true; runs.cancelAll(); process.exit(0); });

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
