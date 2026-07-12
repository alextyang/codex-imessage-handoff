import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { writePrivateJson } from "./config.mjs";
import { servicePaths } from "./paths.mjs";

function emptyStore() {
  return { version: 1, jobs: Object.create(null) };
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
  if (!value || value.version !== 1 || !value.jobs || typeof value.jobs !== "object" || Array.isArray(value.jobs)) {
    throw Object.assign(new Error("Claimed-run state has an unsupported format."), { code: "INVALID_RUN_STATE" });
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

export function saveClaimedJob(event, state = "queued") {
  const id = replyId(event?.replyId);
  if (!event?.claimed?.reply || !event?.threadId) throw new TypeError("A claimed reply is required.");
  if (!["queued", "running", "failed", "delivering", "cancelled"].includes(state)) throw new TypeError("Invalid claimed-run state.");
  const store = readStore();
  store.jobs[id] = {
    threadId: String(event.threadId),
    replyId: id,
    queuedAt: event.queuedAt || new Date().toISOString(),
    receivedAtMs: Number(event.receivedAtMs) || Date.now(),
    claimed: event.claimed,
    delivery: event.delivery || null,
    busyNoticeSent: Boolean(event.busyNoticeSent),
    retryOf: event.retryOf || null,
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

export function loadClaimedJobs() {
  return Object.values(readStore().jobs)
    .filter((job) => job && typeof job === "object" && job.threadId && job.replyId && job.claimed?.reply)
    .sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt)));
}
