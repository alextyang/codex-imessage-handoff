import path from "node:path";

const BACKGROUND_PRIORITY = 1;
const FILESYSTEM_PRIORITY = 2;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_FOREGROUND_BURST = 8;

function threadDetails(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  const id = String(thread.id ?? thread.threadId ?? "").trim();
  const rolloutPath = String(thread.rolloutPath ?? thread.rollout_path ?? "").trim();
  if (!id || !rolloutPath) return null;
  return { id, rolloutPath: path.resolve(rolloutPath), thread };
}

function normalizedActivityPath(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate ? path.resolve(candidate) : null;
}

/**
 * Route rollout activity to bounded, task-local reconciliation work.
 *
 * Filesystem events receive foreground priority and only wake tasks whose
 * rollout paths changed. Unknown paths and periodic fallback ticks enqueue a
 * full catalog pass at background priority. At most one operation runs for a
 * task at once; activity arriving during that operation is coalesced into one
 * subsequent pass, while unrelated tasks may reconcile concurrently. A bounded
 * foreground burst keeps old fallback work moving under sustained activity.
 */
export class RolloutReconcileScheduler {
  constructor(options = {}) {
    if (typeof options.runThread !== "function") {
      throw new TypeError("RolloutReconcileScheduler requires a runThread callback.");
    }
    this.runThread = options.runThread;
    this.onError = typeof options.onError === "function" ? options.onError : () => {};
    this.maxConcurrent = Math.max(1, Math.min(64, Number(options.maxConcurrent) || DEFAULT_MAX_CONCURRENT));
    this.maxForegroundBurst = Math.max(1, Math.min(
      1024,
      Math.floor(Number(options.maxForegroundBurst) || DEFAULT_MAX_FOREGROUND_BURST),
    ));
    this.threads = new Map();
    this.threadIdsByPath = new Map();
    this.pending = new Map();
    this.running = new Map();
    this.sequence = 0;
    this.pumpQueued = false;
    this.foregroundBurst = 0;
    this.started = true;
    this.idleWaiters = new Set();
  }

  replaceCatalog(threads) {
    const nextThreads = new Map();
    const nextByPath = new Map();
    for (const thread of Array.isArray(threads) ? threads : []) {
      const details = threadDetails(thread);
      if (!details) continue;
      nextThreads.set(details.id, details.thread);
      const ids = nextByPath.get(details.rolloutPath) || new Set();
      ids.add(details.id);
      nextByPath.set(details.rolloutPath, ids);
    }
    this.threads = nextThreads;
    this.threadIdsByPath = nextByPath;
    for (const id of [...this.pending.keys()]) {
      if (!nextThreads.has(id)) this.pending.delete(id);
    }
    this.#queuePump();
    this.#resolveIdle();
    return this;
  }

  schedule(activity = {}) {
    if (!this.started) return { scheduled: 0, full: false, unknownPaths: 0 };
    const filesystem = activity?.source === "filesystem";
    const paths = Array.isArray(activity?.paths)
      ? [...new Set(activity.paths.map(normalizedActivityPath).filter(Boolean))]
      : [];
    let full = !filesystem || activity?.unknownPath === true || paths.length === 0;
    let unknownPaths = 0;
    const foregroundIds = new Set();

    if (filesystem) {
      for (const rolloutPath of paths) {
        const ids = this.threadIdsByPath.get(rolloutPath);
        if (!ids?.size) {
          full = true;
          unknownPaths += 1;
          continue;
        }
        for (const id of ids) foregroundIds.add(id);
      }
    }

    if (full) {
      for (const id of this.threads.keys()) this.#markPending(id, BACKGROUND_PRIORITY);
    }
    for (const id of foregroundIds) this.#markPending(id, FILESYSTEM_PRIORITY);
    this.#queuePump();
    return { scheduled: full ? this.threads.size : foregroundIds.size, full, unknownPaths };
  }

  scheduleThread(threadId, { foreground = false } = {}) {
    if (!this.started) return false;
    const id = String(threadId ?? "").trim();
    if (!id || !this.threads.has(id)) return false;
    this.#markPending(id, foreground ? FILESYSTEM_PRIORITY : BACKGROUND_PRIORITY);
    this.#queuePump();
    return true;
  }

  stop() {
    this.started = false;
    this.pending.clear();
    this.foregroundBurst = 0;
    this.#resolveIdle();
  }

  start() {
    if (this.started) return this;
    this.started = true;
    // A full pass recovers any activity which occurred while monitoring was
    // stopped without replaying work already committed by the durable cursor.
    this.schedule({ source: "restart" });
    return this;
  }

  whenIdle() {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  #markPending(id, priority) {
    if (!this.threads.has(id)) return;
    const existing = this.pending.get(id);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      return;
    }
    this.pending.set(id, { priority, sequence: this.sequence++ });
  }

  #queuePump() {
    if (!this.started || this.pumpQueued || this.pending.size === 0) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.#pump();
    });
  }

  #pump() {
    if (!this.started) {
      this.#resolveIdle();
      return;
    }
    while (this.running.size < this.maxConcurrent) {
      const available = [...this.pending.entries()]
        .filter(([id]) => !this.running.has(id) && this.threads.has(id));
      const foreground = available
        .filter(([, details]) => details.priority === FILESYSTEM_PRIORITY)
        .sort(([, left], [, right]) => left.sequence - right.sequence);
      const background = available
        .filter(([, details]) => details.priority !== FILESYSTEM_PRIORITY)
        .sort(([, left], [, right]) => left.sequence - right.sequence);
      let candidate;
      if (foreground.length > 0 && background.length > 0) {
        if (this.foregroundBurst >= this.maxForegroundBurst) {
          candidate = background[0];
          this.foregroundBurst = 0;
        } else {
          candidate = foreground[0];
          this.foregroundBurst += 1;
        }
      } else if (foreground.length > 0) {
        candidate = foreground[0];
        this.foregroundBurst = 0;
      } else {
        candidate = background[0];
        this.foregroundBurst = 0;
      }
      if (!candidate) break;
      const [id] = candidate;
      const thread = this.threads.get(id);
      this.pending.delete(id);
      const operation = Promise.resolve().then(() => this.runThread(thread));
      this.running.set(id, operation);
      operation.catch((error) => {
        try { this.onError(error, thread); } catch {}
      }).finally(() => {
        if (this.running.get(id) === operation) this.running.delete(id);
        this.#queuePump();
        this.#resolveIdle();
      });
    }
    this.#resolveIdle();
  }

  #isIdle() {
    return this.pending.size === 0 && this.running.size === 0 && !this.pumpQueued;
  }

  #resolveIdle() {
    if (!this.#isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
