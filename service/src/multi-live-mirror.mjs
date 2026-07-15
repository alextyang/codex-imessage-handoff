import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LiveMirror } from "./live-mirror.mjs";

const TOKEN_VERSION = "mlm1";
const MAX_THREAD_ID_LENGTH = 200;
const DEFAULT_MAX_DRAIN_PASSES = 16;
const COUNTERS = Object.freeze([
  "baselined",
  "processed",
  "delivered",
  "suppressed",
  "discarded",
  "ignored",
  "retryable",
]);

function threadId(value) {
  const id = String(value?.id ?? value?.threadId ?? value ?? "").trim();
  if (!id || id.length > MAX_THREAD_ID_LENGTH || /[\u0000-\u001f]/.test(id)) {
    throw new TypeError("A valid Codex thread id is required.");
  }
  return id;
}

function threadDetails(thread) {
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    throw new TypeError("A Codex thread with a rollout path is required.");
  }
  const id = threadId(thread);
  const rolloutPath = String(thread.rolloutPath ?? thread.rollout_path ?? "").trim();
  if (!rolloutPath) throw new TypeError("A Codex thread with a rollout path is required.");
  return { id, thread };
}

function threadDigest(id) {
  return createHash("sha256").update(`multi-live-mirror\0${threadId(id)}`, "utf8").digest("hex");
}

function stateFileForDigest(directory, digest) {
  return path.join(directory, `thread-${digest}.json`);
}

function encodeSuppressionToken(id, token) {
  const inner = typeof token === "string" ? token.trim() : "";
  if (!/^[a-f0-9]{32}$/.test(inner)) return null;
  return `${TOKEN_VERSION}.${threadDigest(id)}.${inner}`;
}

function decodeSuppressionToken(value) {
  const match = typeof value === "string"
    ? value.trim().match(/^mlm1\.([a-f0-9]{64})\.([a-f0-9]{32})$/)
    : null;
  return match ? { digest: match[1], token: match[2] } : null;
}

function emptyAggregate() {
  return {
    baselined: 0,
    processed: 0,
    delivered: 0,
    suppressed: 0,
    discarded: 0,
    ignored: 0,
    retryable: 0,
    partial: false,
    more: false,
  };
}

function addResult(aggregate, result) {
  for (const key of COUNTERS) aggregate[key] += Math.max(0, Number(result?.[key]) || 0);
  aggregate.partial ||= result?.partial === true;
  aggregate.more ||= result?.more === true;
  return aggregate;
}

/**
 * Own one durable LiveMirror cursor per Codex task. This class deliberately
 * contains no polling or timers; callers decide when catalog activation and
 * reconciliation happen. One operation chain per task preserves that task's
 * delivery order without allowing a slow send to stall unrelated tasks.
 */
export class MultiLiveMirror {
  constructor(options) {
    const normalized = typeof options === "string" ? { stateDirectory: options } : options;
    const stateDirectory = String(normalized?.stateDirectory ?? normalized?.stateDir ?? "").trim();
    if (!stateDirectory) throw new TypeError("MultiLiveMirror requires a stateDirectory.");
    this.stateDirectory = path.resolve(stateDirectory);
    this.maxReadBytes = normalized?.maxReadBytes;
    this.mirrors = new Map();
    this.mirrorsByDigest = new Map();
    this.catalog = new Map();
    this.reconcileChains = new Map();
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.stateDirectory, 0o700);
  }

  get activeThreadIds() {
    return [...this.mirrors.entries()]
      .filter(([, mirror]) => mirror.activeThreadId)
      .map(([id]) => id)
      .sort();
  }

  stateFile(threadIdValue) {
    return stateFileForDigest(this.stateDirectory, threadDigest(threadIdValue));
  }

  activate(thread, options = {}) {
    const details = threadDetails(thread);
    this.catalog.set(details.id, thread);
    return this.#mirror(details.id).activate(thread, options);
  }

  activateCatalog(threads, options = {}) {
    const unique = new Map();
    for (const thread of Array.isArray(threads) ? threads : []) {
      const details = threadDetails(thread);
      unique.set(details.id, thread);
    }

    const activations = [];
    for (const [id, thread] of [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      this.catalog.set(id, thread);
      activations.push({ threadId: id, ...this.#mirror(id).activate(thread, { resume: options.resume !== false }) });
    }

    if (options.clearMissing === true) {
      for (const id of [...this.catalog.keys()]) {
        if (!unique.has(id)) this.clearThread(id);
      }
    }
    return activations;
  }

  suppressUser(threadIdValue, body) {
    const id = threadId(threadIdValue);
    const token = this.#mirror(id).suppressUser(id, body);
    return token ? encodeSuppressionToken(id, token) : null;
  }

  clearSuppression(value) {
    const decoded = decodeSuppressionToken(value);
    if (!decoded) return false;
    const mirror = this.#mirrorByDigest(decoded.digest);
    const activeId = mirror.activeThreadId;
    if (!activeId || threadDigest(activeId) !== decoded.digest) return false;
    return mirror.clearSuppression(decoded.token);
  }

  clearThread(threadIdValue) {
    const id = threadId(threadIdValue);
    this.catalog.delete(id);
    const mirror = this.#mirror(id);
    return mirror.deactivate();
  }

  clear(threadIdValue) {
    return this.clearThread(threadIdValue);
  }

  reconcile(thread, options = {}) {
    const details = threadDetails(thread);
    return this.#enqueueThread(details.id, () => this.#reconcile(thread, options));
  }

  reconcileAll(threads, options = {}) {
    const unique = new Map();
    for (const thread of Array.isArray(threads) ? threads : []) {
      const details = threadDetails(thread);
      unique.set(details.id, thread);
    }
    const ordered = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right));
    return Promise.all(ordered.map(([id, thread]) => (
      this.#enqueueThread(id, () => this.#reconcile(thread, options))
    ))).then((resolved) => {
      const aggregate = emptyAggregate();
      const results = resolved.map((result, index) => {
        addResult(aggregate, result);
        return { threadId: ordered[index][0], ...result };
      });
      return { ...aggregate, threads: results };
    });
  }

  drain(thread, options = {}) {
    const id = threadDetails(thread).id;
    return this.#enqueueThread(id, async () => {
      const aggregate = emptyAggregate();
      const maxPasses = Math.max(1, Math.min(256, Number(options.maxPasses) || DEFAULT_MAX_DRAIN_PASSES));
      let last = null;
      let passes = 0;
      for (; passes < maxPasses; passes += 1) {
        last = await this.#reconcile(thread, options);
        addResult(aggregate, last);
        if (last.retryable > 0) {
          return { ...aggregate, partial: last.partial === true, more: last.more === true, threadId: threadId(thread), passes: passes + 1, pending: true, reason: "RETRYABLE", last };
        }
        if (!last.more) {
          return {
            ...aggregate,
            partial: last.partial === true,
            more: false,
            threadId: threadId(thread),
            passes: passes + 1,
            pending: last.partial === true,
            reason: last.partial === true ? "PARTIAL_RECORD" : null,
            last,
          };
        }
      }
      return { ...aggregate, partial: last?.partial === true, more: last?.more === true, threadId: threadId(thread), passes, pending: true, reason: "MAX_PASSES", last };
    });
  }

  #enqueueThread(id, operation) {
    const previous = this.reconcileChains.get(id) || Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.reconcileChains.set(id, settled);
    settled.finally(() => {
      if (this.reconcileChains.get(id) === settled) this.reconcileChains.delete(id);
    });
    return result;
  }

  #mirror(id) {
    const normalized = threadId(id);
    const existing = this.mirrors.get(normalized);
    if (existing) return existing;
    const digest = threadDigest(normalized);
    const mirror = this.#newMirror(stateFileForDigest(this.stateDirectory, digest));
    this.mirrors.set(normalized, mirror);
    this.mirrorsByDigest.set(digest, mirror);
    return mirror;
  }

  #mirrorByDigest(digest) {
    const existing = this.mirrorsByDigest.get(digest);
    if (existing) return existing;
    const stateFile = stateFileForDigest(this.stateDirectory, digest);
    const mirror = this.#newMirror(stateFile);
    this.mirrorsByDigest.set(digest, mirror);
    if (mirror.activeThreadId && threadDigest(mirror.activeThreadId) === digest) {
      this.mirrors.set(mirror.activeThreadId, mirror);
    }
    return mirror;
  }

  #newMirror(stateFile) {
    const options = this.maxReadBytes === undefined
      ? { stateFile }
      : { stateFile, maxReadBytes: this.maxReadBytes };
    return new LiveMirror(options);
  }

  async #reconcile(thread, options) {
    const details = threadDetails(thread);
    this.catalog.set(details.id, thread);
    const mirror = this.#mirror(details.id);
    if (mirror.activeThreadId !== details.id) mirror.activate(thread, { resume: true });
    const deliver = options?.deliver;
    if (typeof deliver !== "function") throw new TypeError("MultiLiveMirror reconciliation requires deliver.");
    return mirror.reconcile(thread, {
      deliver: (event) => deliver(event, thread),
    });
  }
}

export const multiLiveMirrorInternals = Object.freeze({
  decodeSuppressionToken,
  encodeSuppressionToken,
  threadDigest,
});
