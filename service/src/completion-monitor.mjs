import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;
const SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HANDLED = 4_096;
const MAX_MANAGED_OBSERVED_PER_THREAD = 16;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;
const TERMINAL_STATUSES = new Set(["INACTIVE", "NO_BINDING", "SUPPRESSED_INACTIVE"]);

function nowIso(now) {
  const value = typeof now === "function" ? now() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function dateMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function completionTime(record, fallback) {
  const value = record?.payload?.completed_at ?? record?.timestamp;
  const milliseconds = dateMs(value) ?? dateMs(fallback);
  return milliseconds === null ? fallback : new Date(milliseconds).toISOString();
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function bodyDigest(value) {
  return digest(String(value).trim());
}

function completionKey(threadId, turnId) {
  return digest(`${threadId}\0${turnId}`);
}

function emptyState() {
  return {
    version: STATE_VERSION,
    initializedAt: null,
    updatedAt: null,
    threads: Object.create(null),
    pending: Object.create(null),
    handled: Object.create(null),
    suppressions: Object.create(null),
    managedObserved: Object.create(null),
  };
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : Object.create(null);
}

function readState(stateFile) {
  if (!existsSync(stateFile)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    try {
      const quarantined = `${stateFile}.invalid-${Date.now()}`;
      renameSync(stateFile, quarantined);
      chmodSync(quarantined, 0o600);
    } catch {}
    return emptyState();
  }
  if (!parsed || parsed.version !== STATE_VERSION) {
    try {
      const quarantined = `${stateFile}.invalid-${Date.now()}`;
      renameSync(stateFile, quarantined);
      chmodSync(quarantined, 0o600);
    } catch {}
    return emptyState();
  }
  try { chmodSync(stateFile, 0o600); } catch {}
  return {
    ...emptyState(),
    ...parsed,
    threads: normalizeObject(parsed.threads),
    pending: normalizeObject(parsed.pending),
    handled: normalizeObject(parsed.handled),
    suppressions: normalizeObject(parsed.suppressions),
    managedObserved: normalizeObject(parsed.managedObserved),
  };
}

function writePrivateState(stateFile, state) {
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, stateFile);
  chmodSync(stateFile, 0o600);
}

function identity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

function sameFile(tracked, filePath, stat) {
  const current = identity(stat);
  return tracked?.path === filePath
    && tracked?.device === current.device
    && tracked?.inode === current.inode
    && Number.isFinite(Number(tracked.offset))
    && Number(tracked.offset) <= stat.size;
}

function trackedFile(filePath, stat, offset, observedAt) {
  return {
    path: filePath,
    ...identity(stat),
    offset,
    observedAt,
  };
}

function threadDetails(thread) {
  if (!thread || typeof thread !== "object") return null;
  const threadId = String(thread.id ?? thread.threadId ?? "").trim();
  const filePath = String(thread.rolloutPath ?? thread.rollout_path ?? "").trim();
  if (!threadId || !filePath) return null;
  return { threadId, filePath, createdAt: thread.createdAt ?? thread.created_at ?? null };
}

function readAppendedRecords(filePath, offset, size) {
  if (size <= offset) return { records: [], offset };
  const length = size - offset;
  const descriptor = openSync(filePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = readSync(descriptor, bytes, read, length - read, offset + read);
      if (count <= 0) break;
      read += count;
    }
    const available = bytes.subarray(0, read);
    const finalNewline = available.lastIndexOf(0x0a);
    if (finalNewline < 0) return { records: [], offset };

    const records = [];
    const complete = available.subarray(0, finalNewline).toString("utf8");
    for (const line of complete.split("\n")) {
      if (!line.includes('"task_complete"')) continue;
      try {
        const record = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
        if (record && typeof record === "object") records.push(record);
      } catch {
        // Complete malformed records are skipped. Their content is intentionally
        // never surfaced in errors or logs.
      }
    }
    return { records, offset: offset + finalNewline + 1 };
  } finally {
    closeSync(descriptor);
  }
}

function completeFileOffset(filePath, size) {
  if (size <= 0) return 0;
  const descriptor = openSync(filePath, "r");
  try {
    let end = size;
    while (end > 0) {
      const length = Math.min(64 * 1024, end);
      const start = end - length;
      const bytes = Buffer.allocUnsafe(length);
      const read = readSync(descriptor, bytes, 0, length, start);
      const newline = bytes.subarray(0, read).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    closeSync(descriptor);
  }
}

function completionFrom(record, threadId, observedAt) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "task_complete") return null;
  const turnId = typeof record.payload.turn_id === "string" ? record.payload.turn_id.trim() : "";
  const body = record.payload.last_agent_message;
  if (!turnId || typeof body !== "string" || !body.trim()) return null;
  const bodyHash = bodyDigest(body);
  return {
    key: completionKey(threadId, turnId),
    threadId,
    turnId,
    body,
    bodyHash,
    completedAt: completionTime(record, observedAt),
    observedAt,
  };
}

function terminalDelivery(result) {
  if (result?.sent === true || result?.notification?.sent === true) return { terminal: true, outcome: "SENT" };
  const rawStatus = result?.status ?? result?.notification?.status ?? result?.code;
  const status = typeof rawStatus === "string" ? rawStatus.toUpperCase() : "";
  return TERMINAL_STATUSES.has(status)
    ? { terminal: true, outcome: status }
    : { terminal: false, outcome: null };
}

function completionIsAfter(completedAt, startedAt) {
  const completedMs = dateMs(completedAt);
  const startedMs = dateMs(startedAt);
  return startedMs === null || completedMs === null || completedMs >= startedMs;
}

function pruneState(state, currentTime) {
  const currentMs = dateMs(currentTime) ?? Date.now();
  for (const [threadId, entries] of Object.entries(state.suppressions)) {
    const active = Array.isArray(entries)
      ? entries.filter((entry) => (dateMs(entry?.expiresAt) ?? 0) > currentMs)
      : [];
    if (active.length) state.suppressions[threadId] = active.slice(-MAX_MANAGED_OBSERVED_PER_THREAD);
    else delete state.suppressions[threadId];
  }
  for (const [threadId, entries] of Object.entries(state.managedObserved)) {
    const recent = Array.isArray(entries)
      ? entries.filter((entry) => currentMs - (dateMs(entry?.observedAt) ?? 0) <= SUPPRESSION_TTL_MS)
      : [];
    if (recent.length) state.managedObserved[threadId] = recent.slice(-MAX_MANAGED_OBSERVED_PER_THREAD);
    else delete state.managedObserved[threadId];
  }
  const handledEntries = Object.entries(state.handled);
  if (handledEntries.length > MAX_HANDLED) {
    handledEntries
      .sort((left, right) => String(left[1]?.handledAt || "").localeCompare(String(right[1]?.handledAt || "")))
      .slice(0, handledEntries.length - MAX_HANDLED)
      .forEach(([key]) => delete state.handled[key]);
  }
}

export class CompletionMonitor {
  constructor(options) {
    const normalized = typeof options === "string" ? { stateFile: options } : options;
    const stateFile = String(normalized?.stateFile || "").trim();
    if (!stateFile) throw new TypeError("CompletionMonitor requires a stateFile.");
    this.stateFile = path.resolve(stateFile);
    this.now = typeof normalized?.now === "function" ? normalized.now : Date.now;
    this.state = readState(this.stateFile);
    this.processStartedAt = nowIso(this.now);
    this.managed = new Map();
    this.reconcileChain = Promise.resolve();
  }

  manage(threadId, startedAt = nowIso(this.now)) {
    const id = String(threadId || "").trim();
    if (!id) throw new TypeError("A thread id is required.");
    this.managed.set(id, startedAt);
    return this;
  }

  unmanage(threadId) {
    this.managed.delete(String(threadId || "").trim());
    return this;
  }

  suppressNext(threadId, finalBody, startedAt = nowIso(this.now)) {
    const id = String(threadId || "").trim();
    if (!id) throw new TypeError("A thread id is required.");
    if (typeof finalBody !== "string" || !finalBody.trim()) return false;
    const currentTime = nowIso(this.now);
    const bodyHash = bodyDigest(finalBody);
    const observed = Array.isArray(this.state.managedObserved[id]) ? this.state.managedObserved[id] : [];
    const handledIndex = observed.findIndex((entry) => entry?.bodyHash === bodyHash
      && completionIsAfter(entry.completedAt, startedAt));
    if (handledIndex >= 0) {
      observed.splice(handledIndex, 1);
      if (observed.length) this.state.managedObserved[id] = observed;
      else delete this.state.managedObserved[id];
      this.#save(currentTime);
      return false;
    }
    const alreadyHandled = Object.values(this.state.handled).some((entry) => entry?.threadId === id
      && entry?.bodyHash === bodyHash
      && (entry?.outcome === "MANAGED" || entry?.outcome === "SUPPRESS_NEXT")
      && completionIsAfter(entry.completedAt, startedAt));
    if (alreadyHandled) return false;

    const startedMs = dateMs(startedAt);
    const createdMs = dateMs(currentTime) ?? Date.now();
    const entries = Array.isArray(this.state.suppressions[id]) ? this.state.suppressions[id] : [];
    entries.push({
      bodyHash,
      startedAt: startedMs === null ? currentTime : new Date(startedMs).toISOString(),
      createdAt: currentTime,
      expiresAt: new Date(Math.max(createdMs, startedMs ?? createdMs) + SUPPRESSION_TTL_MS).toISOString(),
    });
    this.state.suppressions[id] = entries.slice(-MAX_MANAGED_OBSERVED_PER_THREAD);
    this.#save(currentTime);
    return true;
  }

  reconcile(threads, options = {}) {
    const task = () => this.#reconcile(Array.isArray(threads) ? threads : [], options);
    const result = this.reconcileChain.then(task, task);
    this.reconcileChain = result.then(() => undefined, () => undefined);
    return result;
  }

  #save(currentTime = nowIso(this.now)) {
    pruneState(this.state, currentTime);
    this.state.updatedAt = currentTime;
    writePrivateState(this.stateFile, this.state);
  }

  #consumeSuppression(completion, currentTime) {
    const entries = Array.isArray(this.state.suppressions[completion.threadId])
      ? this.state.suppressions[completion.threadId]
      : [];
    const currentMs = dateMs(currentTime) ?? Date.now();
    const index = entries.findIndex((entry) => entry?.bodyHash === completion.bodyHash
      && (dateMs(entry.expiresAt) ?? 0) > currentMs
      && completionIsAfter(completion.completedAt, entry.startedAt));
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entries.length) this.state.suppressions[completion.threadId] = entries;
    else delete this.state.suppressions[completion.threadId];
    return true;
  }

  #markHandled(completion, outcome, currentTime) {
    this.state.handled[completion.key] = {
      threadId: completion.threadId,
      turnId: completion.turnId,
      bodyHash: completion.bodyHash,
      completedAt: completion.completedAt,
      handledAt: currentTime,
      outcome,
    };
    delete this.state.pending[completion.key];
  }

  #observe(completion, currentTime, summary) {
    if (this.state.handled[completion.key] || this.state.pending[completion.key]) return;
    summary.observed += 1;

    if (this.#consumeSuppression(completion, currentTime)) {
      this.#markHandled(completion, "SUPPRESS_NEXT", currentTime);
      summary.suppressed += 1;
      return;
    }

    const managedSince = this.managed.get(completion.threadId);
    if (managedSince !== undefined && completionIsAfter(completion.completedAt, managedSince)) {
      const entries = Array.isArray(this.state.managedObserved[completion.threadId])
        ? this.state.managedObserved[completion.threadId]
        : [];
      entries.push({
        bodyHash: completion.bodyHash,
        completedAt: completion.completedAt,
        observedAt: currentTime,
      });
      this.state.managedObserved[completion.threadId] = entries.slice(-MAX_MANAGED_OBSERVED_PER_THREAD);
      this.#markHandled(completion, "MANAGED", currentTime);
      summary.suppressed += 1;
      return;
    }

    this.state.pending[completion.key] = completion;
  }

  async #reconcile(threads, { deliver, deliverPending = true } = {}) {
    if (typeof deliver !== "function") throw new TypeError("CompletionMonitor.reconcile requires deliver.");
    const currentTime = nowIso(this.now);
    const processStartedMs = dateMs(this.processStartedAt) ?? Date.now();
    const summary = {
      baselined: 0,
      observed: 0,
      delivered: 0,
      suppressed: 0,
      retryable: 0,
      pending: 0,
    };
    const uniqueThreads = new Map();
    for (const thread of threads) {
      const details = threadDetails(thread);
      if (details && !uniqueThreads.has(details.threadId)) uniqueThreads.set(details.threadId, details);
    }

    const firstUse = !this.state.initializedAt;
    let dirty = false;
    for (const { threadId, filePath, createdAt } of uniqueThreads.values()) {
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const tracked = this.state.threads[threadId];
      if (firstUse) {
        this.state.threads[threadId] = trackedFile(filePath, stat, completeFileOffset(filePath, stat.size), currentTime);
        summary.baselined += 1;
        dirty = true;
        continue;
      }

      if (!sameFile(tracked, filePath, stat)) {
        const appended = readAppendedRecords(filePath, 0, stat.size);
        const createdAfterInitialization = (dateMs(createdAt) ?? 0) > (dateMs(this.state.initializedAt) ?? Number.POSITIVE_INFINITY);
        for (const record of appended.records) {
          const completion = completionFrom(record, threadId, currentTime);
          if (!completion) continue;
          if (createdAfterInitialization || (dateMs(completion.completedAt) ?? 0) >= processStartedMs) {
            this.#observe(completion, currentTime, summary);
          }
        }
        this.state.threads[threadId] = trackedFile(filePath, stat, appended.offset, currentTime);
        summary.baselined += 1;
        dirty = true;
        continue;
      }

      if (Number(tracked.offset) === stat.size) continue;
      const appended = readAppendedRecords(filePath, Number(tracked.offset), stat.size);
      for (const record of appended.records) {
        const completion = completionFrom(record, threadId, currentTime);
        if (completion) this.#observe(completion, currentTime, summary);
      }
      if (appended.offset !== Number(tracked.offset)) {
        this.state.threads[threadId] = trackedFile(filePath, stat, appended.offset, currentTime);
        dirty = true;
      }
    }

    if (firstUse) {
      this.state.initializedAt = currentTime;
      dirty = true;
    }
    for (const threadId of Object.keys(this.state.threads)) {
      if (!uniqueThreads.has(threadId)) {
        delete this.state.threads[threadId];
        dirty = true;
      }
    }
    // Persist both file offsets and newly queued bodies before attempting any
    // provider call, so a crash can only cause a retry rather than data loss.
    if (dirty) this.#save(currentTime);
    if (!deliverPending) {
      summary.pending = Object.keys(this.state.pending).length;
      return summary;
    }

    const pending = Object.values(this.state.pending)
      .filter((entry) => entry && typeof entry === "object")
      .sort((left, right) => String(left.observedAt || "").localeCompare(String(right.observedAt || "")));
    for (const completion of pending) {
      const attemptTime = nowIso(this.now);
      if ((dateMs(completion.nextAttemptAt) ?? 0) > (dateMs(attemptTime) ?? Date.now())) continue;
      let outcome = { terminal: false, outcome: null };
      try {
        outcome = terminalDelivery(await deliver({
          completionId: completion.key,
          threadId: completion.threadId,
          turnId: completion.turnId,
          body: completion.body,
          completedAt: completion.completedAt,
        }));
      } catch {
        // Delivery errors are deliberately reduced to a retry count. Neither
        // completion content nor provider error text is ever logged here.
      }
      if (outcome.terminal) {
        this.#markHandled(completion, outcome.outcome, nowIso(this.now));
        summary.delivered += outcome.outcome === "SENT" ? 1 : 0;
        summary.suppressed += outcome.outcome === "SENT" ? 0 : 1;
        this.#save(nowIso(this.now));
      } else {
        completion.attempts = Math.max(0, Number(completion.attempts) || 0) + 1;
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(10, completion.attempts - 1)));
        completion.nextAttemptAt = new Date((dateMs(attemptTime) ?? Date.now()) + backoff).toISOString();
        this.state.pending[completion.key] = completion;
        summary.retryable += 1;
        this.#save(nowIso(this.now));
      }
    }
    summary.pending = Object.keys(this.state.pending).length;
    return summary;
  }
}
