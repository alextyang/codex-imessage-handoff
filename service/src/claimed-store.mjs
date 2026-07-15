import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { writePrivateJson } from "./config.mjs";
import { servicePaths } from "./paths.mjs";

function emptyStore() {
  return { version: 3, nextAdmissionOrder: 1, jobs: Object.create(null) };
}

function validAdmissionOrder(value) {
  const order = Number(value);
  return Number.isSafeInteger(order) && order > 0 ? order : null;
}

function upgradeLegacyStore(value) {
  let admissionOrder = 1;
  const jobs = Object.create(null);
  // Object property order is the durable insertion order used by the v1/v2
  // store. Materialize it once so equal Messages timestamps remain ordered
  // after every subsequent restart.
  for (const [id, job] of Object.entries(value.jobs)) {
    jobs[id] = job && typeof job === "object"
      ? { ...job, admissionOrder: admissionOrder++ }
      : job;
  }
  return { version: 3, nextAdmissionOrder: admissionOrder, jobs };
}

function readStore() {
  const file = servicePaths().runState;
  if (!existsSync(file)) return emptyStore();
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error("Claimed-run state could not be read safely.", { cause: error }), { code: "INVALID_RUN_STATE" });
  }
  if (
    !value
    || ![1, 2, 3].includes(value.version)
    || !value.jobs
    || typeof value.jobs !== "object"
    || Array.isArray(value.jobs)
  ) {
    throw Object.assign(new Error("Claimed-run state has an unsupported format."), { code: "INVALID_RUN_STATE" });
  }
  // Older versions relied on timestamps (and, accidentally, object order) for
  // FIFO decisions. Normalize that insertion order in memory so read-only
  // commands remain side-effect free; the next intentional update persists it.
  if (value.version < 3) return upgradeLegacyStore(value);
  const orders = Object.values(value.jobs).map((job) => validAdmissionOrder(job?.admissionOrder));
  const uniqueOrders = new Set(orders.filter(Boolean));
  const nextAdmissionOrder = validAdmissionOrder(value.nextAdmissionOrder);
  const maximumOrder = orders.length ? Math.max(0, ...orders.filter(Boolean)) : 0;
  if (
    orders.some((order) => order === null)
    || uniqueOrders.size !== orders.length
    || !nextAdmissionOrder
    || nextAdmissionOrder <= maximumOrder
  ) {
    throw Object.assign(new Error("Claimed-run state has an invalid admission order."), { code: "INVALID_RUN_STATE" });
  }
  return value;
}

function writeStore(store) {
  const file = servicePaths().runState;
  if (Object.keys(store.jobs).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writePrivateJson(file, store);
  try { chmodSync(file, 0o600); } catch {}
}

function replyId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 240 || /[\u0000-\u001f]/.test(id)) throw new TypeError("A valid reply id is required.");
  return id;
}

function validClientUserMessageId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 256 && !/[\u0000-\u001f]/.test(id) ? id : null;
}

function validIso(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 64 && Number.isFinite(Date.parse(text)) ? text : null;
}

function normalizedThreadCheckpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const turnId = typeof value.turnId === "string" && value.turnId.length <= 256 ? value.turnId : null;
  const activityAt = validIso(value.activityAt);
  const capturedAt = validIso(value.capturedAt);
  return capturedAt ? { turnId, activityAt, capturedAt } : null;
}

function validPredecessorIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(validClientUserMessageId).filter(Boolean))].slice(-32)
    : [];
}

// The app-server persists this value on the resulting userMessage item. A
// deterministic UUID keeps a claimed Messages event identifiable even if the
// daemon crashes between accepting the event and reloading its durable state.
export function claimedClientUserMessageId(threadIdValue, replyIdValue) {
  const threadId = String(threadIdValue || "").trim();
  const id = replyId(replyIdValue);
  if (!threadId) throw new TypeError("A claimed reply thread is required.");
  const digest = createHash("sha256")
    .update("imessage-handoff\0", "utf8")
    .update(threadId, "utf8")
    .update("\0", "utf8")
    .update(id, "utf8")
    .digest();
  // RFC 9562 UUIDv8 layout for an application-defined SHA-256 name. This keeps
  // the native Messages identifier off the Codex protocol boundary.
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function saveClaimedJob(event, state = "queued") {
  const id = replyId(event?.replyId);
  if (!event?.claimed?.reply || !event?.threadId) throw new TypeError("A claimed reply is required.");
  if (!["queued", "running", "failed", "delivering", "cancelled"].includes(state)) throw new TypeError("Invalid claimed-run state.");
  const store = readStore();
  const existing = store.jobs[id] || null;
  const existingClientUserMessageId = validClientUserMessageId(existing?.clientUserMessageId);
  const suppliedClientUserMessageId = validClientUserMessageId(event.clientUserMessageId);
  const clientUserMessageId = existingClientUserMessageId
    || suppliedClientUserMessageId
    || claimedClientUserMessageId(event.threadId, id);
  // Only pre-upgrade jobs can already exist without a client message id. Keep
  // that fact so their in-flight pre-upgrade turn remains recoverable by the
  // old prompt/time fallback; all new jobs reconcile only by the protocol id.
  const legacyClientUserMessageId = Boolean(
    event.legacyClientUserMessageId
    || existing?.legacyClientUserMessageId
    || (existing && !existingClientUserMessageId),
  );
  const queuedAt = event.queuedAt || existing?.queuedAt || new Date().toISOString();
  const receivedAtMs = Number(event.receivedAtMs) || Number(existing?.receivedAtMs) || Date.now();
  const admissionOrder = validAdmissionOrder(existing?.admissionOrder) || store.nextAdmissionOrder++;
  const predecessorClientUserMessageIds = [...new Set([
    ...validPredecessorIds(existing?.predecessorClientUserMessageIds),
    ...validPredecessorIds(event.predecessorClientUserMessageIds),
    ...Object.entries(store.jobs).flatMap(([otherId, other]) => {
      if (otherId === id || String(other?.threadId || "") !== String(event.threadId)
        || !["queued", "running", "delivering"].includes(other?.state)
        || !validClientUserMessageId(other?.clientUserMessageId)) return [];
      return validAdmissionOrder(other.admissionOrder) < admissionOrder ? [other.clientUserMessageId] : [];
    }),
  ])].filter((value) => value !== clientUserMessageId).slice(-32);
  const threadCheckpoint = normalizedThreadCheckpoint(event.threadCheckpoint)
    || normalizedThreadCheckpoint(existing?.threadCheckpoint);
  event.clientUserMessageId = clientUserMessageId;
  event.legacyClientUserMessageId = legacyClientUserMessageId;
  event.admissionOrder = admissionOrder;
  event.predecessorClientUserMessageIds = predecessorClientUserMessageIds;
  if (threadCheckpoint) event.threadCheckpoint = threadCheckpoint;
  store.jobs[id] = {
    threadId: String(event.threadId),
    replyId: id,
    clientUserMessageId,
    legacyClientUserMessageId,
    predecessorClientUserMessageIds,
    admissionOrder,
    threadCheckpoint,
    queuedAt,
    receivedAtMs,
    reasoningEffort: typeof event.reasoningEffort === "string"
      && /^[a-z][a-z0-9_-]{0,31}$/i.test(event.reasoningEffort)
      ? event.reasoningEffort
      : null,
    claimed: event.claimed,
    delivery: event.delivery || null,
    busyNoticeSent: Boolean(event.busyNoticeSent),
    backendNoticeSent: Boolean(event.backendNoticeSent),
    imsgGuid: typeof event.imsgGuid === "string" && event.imsgGuid.length <= 256
      ? event.imsgGuid
      : null,
    mirrorSuppressionToken: typeof event.mirrorSuppressionToken === "string"
      ? event.mirrorSuppressionToken
      : null,
    retryOf: event.retryOf || null,
    reconcileRunning: Boolean(event.reconcileRunning),
    recoveredTurnId: typeof event.recoveredTurnId === "string" && event.recoveredTurnId.length <= 256
      ? event.recoveredTurnId
      : null,
    recoveryMissingSince: typeof event.recoveryMissingSince === "string"
      && event.recoveryMissingSince.length <= 64
      && Number.isFinite(Date.parse(event.recoveryMissingSince))
      ? event.recoveryMissingSince
      : null,
    state,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return store.jobs[id];
}

export function markClaimedJobState(id, state) {
  const store = readStore();
  const key = replyId(id);
  if (!store.jobs[key]) return null;
  store.jobs[key].state = state;
  store.jobs[key].updatedAt = new Date().toISOString();
  writeStore(store);
  return store.jobs[key];
}

export function removeClaimedJob(id) {
  const store = readStore();
  const key = replyId(id);
  const existed = Boolean(store.jobs[key]);
  delete store.jobs[key];
  writeStore(store);
  return existed;
}

export function removeClaimedJobs(ids) {
  if (!Array.isArray(ids)) throw new TypeError("Claimed-run ids must be an array.");
  const keys = [...new Set(ids.map(replyId))];
  const store = readStore();
  let removed = 0;
  for (const key of keys) {
    if (!store.jobs[key]) continue;
    delete store.jobs[key];
    removed += 1;
  }
  if (removed) writeStore(store);
  return removed;
}

export function loadClaimedJobs() {
  return Object.values(readStore().jobs)
    .filter((job) => job && typeof job === "object" && job.threadId && job.replyId && job.claimed?.reply)
    .sort((left, right) => left.admissionOrder - right.admissionOrder);
}
