import { existsSync, watch as nodeWatch } from "node:fs";
import path from "node:path";

/**
 * Coalesce Codex rollout filesystem activity into one lightweight wake-up.
 * A periodic fallback preserves correctness when FSEvents is unavailable or
 * drops an event; the monitor never reads rollout content itself.
 */
export class RolloutActivityMonitor {
  constructor(options = {}) {
    this.root = path.resolve(String(options.root || ""));
    if (!options.root || typeof options.onActivity !== "function") {
      throw new TypeError("RolloutActivityMonitor requires a root and onActivity callback.");
    }
    this.onActivity = options.onActivity;
    this.watchImpl = options.watchImpl || nodeWatch;
    this.existsImpl = options.existsImpl || existsSync;
    this.debounceMs = Math.max(10, Number(options.debounceMs) || 100);
    this.fallbackMs = Math.max(10, Number(options.fallbackMs) || 10_000);
    this.watcher = null;
    this.debounceTimer = null;
    this.fallbackTimer = null;
    this.pendingPaths = new Set();
    this.pendingUnknownPath = false;
    this.started = false;
  }

  get watching() {
    return Boolean(this.watcher);
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.fallbackTimer = setInterval(() => {
      this.#ensureWatcher();
      this.#notify("fallback", { paths: [], unknownPath: true });
    }, this.fallbackMs);
    this.fallbackTimer.unref?.();
    this.#ensureWatcher();
    return this;
  }

  #ensureWatcher() {
    if (!this.started || this.watcher || !this.existsImpl(this.root)) return;
    try {
      const watcher = this.watchImpl(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        const relative = filename == null ? "" : String(filename);
        if (relative && !/\.jsonl$/i.test(relative)) return;
        const absolute = this.#rolloutPath(relative);
        if (absolute) this.pendingPaths.add(absolute);
        else this.pendingUnknownPath = true;
        this.#schedule();
      });
      this.watcher = watcher;
      watcher.on?.("error", () => this.#dropWatcher(watcher));
      watcher.on?.("close", () => {
        if (this.watcher === watcher) this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.debounceTimer = null;
    this.fallbackTimer = null;
    this.pendingPaths.clear();
    this.pendingUnknownPath = false;
    const watcher = this.watcher;
    this.watcher = null;
    try { watcher?.close?.(); } catch {}
  }

  #schedule() {
    if (!this.started || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const paths = [...this.pendingPaths].sort();
      const unknownPath = this.pendingUnknownPath;
      this.pendingPaths.clear();
      this.pendingUnknownPath = false;
      this.#notify("filesystem", { paths, unknownPath });
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  #notify(source, details = {}) {
    if (!this.started) return;
    try {
      this.onActivity({
        source,
        watching: this.watching,
        paths: Array.isArray(details.paths) ? details.paths : [],
        unknownPath: details.unknownPath === true,
      });
    } catch {}
  }

  #rolloutPath(relative) {
    if (!relative) return null;
    const candidate = path.resolve(this.root, relative);
    const fromRoot = path.relative(this.root, candidate);
    if (fromRoot === "" || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null;
    return candidate;
  }

  #dropWatcher(watcher) {
    if (this.watcher !== watcher) return;
    this.watcher = null;
    try { watcher.close?.(); } catch {}
  }
}
