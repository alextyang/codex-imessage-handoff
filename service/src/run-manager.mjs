export class RunManager {
  constructor({ maxConcurrent = 3, run, discard = async () => {}, onChange = () => {}, onError = () => {} } = {}) {
    if (typeof run !== "function") throw new TypeError("run is required");
    this.maxConcurrent = Math.max(1, Math.min(8, Number(maxConcurrent) || 3));
    this.run = run;
    this.discard = discard;
    this.onChange = onChange;
    this.onError = onError;
    this.queues = new Map();
    this.active = new Map();
    this.blockedUntil = new Map();
    this.knownReplyIds = new Set();
    this.deferTimers = new Set();
    this.closed = false;
    this.sequence = 0;
  }

  enqueue(event) {
    const threadId = String(event?.threadId || "");
    const replyId = String(event?.replyId || "");
    if (this.closed || !threadId || !replyId || this.knownReplyIds.has(replyId)) return false;
    this.knownReplyIds.add(replyId);
    const entry = { ...event, threadId, replyId, queuedAt: event.queuedAt || new Date().toISOString(), sequence: this.sequence++ };
    const queue = this.queues.get(threadId) || [];
    queue.push(entry);
    this.queues.set(threadId, queue);
    this.#changed();
    this.#drain();
    return true;
  }

  has(replyId) {
    return this.knownReplyIds.has(String(replyId || ""));
  }

  state(threadId) {
    const id = String(threadId || "");
    const active = this.active.get(id);
    const queued = this.queues.get(id) || [];
    const newest = queued.at(-1);
    if (active) {
      return {
        status: "working",
        stateSince: active.startedAt,
        pendingCount: queued.length,
        request: String(active.entry?.claimed?.reply?.body || ""),
        requestAt: active.entry?.queuedAt || active.startedAt,
        latestRequest: String((newest || active.entry)?.claimed?.reply?.body || ""),
        latestRequestAt: newest?.queuedAt || active.entry?.queuedAt || active.startedAt,
      };
    }
    if (queued.length) {
      return {
        status: "pending",
        stateSince: queued[0].queuedAt,
        pendingCount: queued.length,
        request: String(queued[0]?.claimed?.reply?.body || ""),
        requestAt: queued[0]?.queuedAt || null,
        latestRequest: String(newest?.claimed?.reply?.body || ""),
        latestRequestAt: newest?.queuedAt || null,
      };
    }
    return null;
  }

  states() {
    const ids = new Set([...this.queues.keys(), ...this.active.keys()]);
    return new Map([...ids].map((id) => [id, this.state(id)]).filter(([, state]) => state));
  }

  async cancel(threadId) {
    const id = String(threadId || "");
    const active = this.active.get(id);
    const queued = this.queues.get(id) || [];
    if (active) {
      active.cancelRequested = true;
      active.cancel?.();
    }
    if (queued.length) {
      this.queues.delete(id);
      await Promise.allSettled(queued.map(async (entry) => {
        try {
          await this.discard(entry);
        } finally {
          this.knownReplyIds.delete(entry.replyId);
        }
      }));
    }
    if (active || queued.length) this.#changed();
    return { active: Boolean(active), pending: queued.length };
  }

  cancelAll() {
    for (const active of this.active.values()) active.cancel?.();
  }

  // Service shutdown is a transport detach, not a user cancellation. Keep the
  // durable queue untouched and, by default, do not interrupt canonical Codex
  // turns that can be reconciled by the next daemon process.
  shutdown({ interrupt = false } = {}) {
    if (this.closed) return { active: this.active.size, pending: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0) };
    this.closed = true;
    for (const timer of this.deferTimers) clearTimeout(timer);
    this.deferTimers.clear();
    this.blockedUntil.clear();
    if (interrupt) this.cancelAll();
    return {
      active: this.active.size,
      pending: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    };
  }

  #next() {
    return [...this.queues.entries()]
      .filter(([threadId, queue]) => queue.length && !this.active.has(threadId))
      .filter(([threadId]) => (this.blockedUntil.get(threadId) || 0) <= Date.now())
      .map(([threadId, queue]) => ({ threadId, entry: queue[0] }))
      .sort((a, b) => a.entry.sequence - b.entry.sequence)[0] || null;
  }

  #drain() {
    if (this.closed) return;
    while (this.active.size < this.maxConcurrent) {
      const next = this.#next();
      if (!next) return;
      const queue = this.queues.get(next.threadId) || [];
      const entry = queue.shift();
      if (queue.length) this.queues.set(next.threadId, queue);
      else this.queues.delete(next.threadId);
      const slot = {
        entry,
        startedAt: new Date().toISOString(),
        cancel: null,
        cancelRequested: false,
        deferMs: 0,
      };
      this.active.set(next.threadId, slot);
      this.#changed();
      const context = {
        setCancel: (cancel) => {
          if (typeof cancel !== "function") return;
          slot.cancel = cancel;
          if (slot.cancelRequested) cancel();
        },
        defer: (milliseconds = 15000) => { slot.deferMs = Math.max(1000, Number(milliseconds) || 15000); },
      };
      Promise.resolve()
        .then(() => this.run(entry, context))
        .catch((error) => {
          try { this.onError(error, entry); } catch {}
        })
        .finally(() => {
          this.active.delete(next.threadId);
          if (this.closed) {
            this.#changed();
            return;
          }
          if (slot.cancelRequested) {
            this.blockedUntil.delete(next.threadId);
            this.knownReplyIds.delete(entry.replyId);
            Promise.resolve(this.discard(entry)).catch((error) => {
              try { this.onError(error, entry); } catch {}
            });
          } else if (slot.deferMs > 0) {
            const deferred = this.queues.get(next.threadId) || [];
            deferred.unshift(entry);
            this.queues.set(next.threadId, deferred);
            this.blockedUntil.set(next.threadId, Date.now() + slot.deferMs);
            const timer = setTimeout(() => {
              this.deferTimers.delete(timer);
              this.blockedUntil.delete(next.threadId);
              this.#drain();
            }, slot.deferMs);
            this.deferTimers.add(timer);
            timer.unref?.();
          } else {
            this.knownReplyIds.delete(entry.replyId);
          }
          this.#changed();
          this.#drain();
        });
    }
  }

  #changed() {
    try { this.onChange(this.states()); } catch {}
  }
}
