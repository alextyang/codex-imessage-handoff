import { normalizeSidebarTitle } from "./sidebar-title-index.mjs";

export const DEFAULT_LIVE_TITLE_TTL_MS = 10 * 60_000;

/**
 * Keep a live app-server rename authoritative until the persisted sidebar
 * index catches up or proves it contains a newer rename.
 */
export class SidebarTitleArbiter {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_LIVE_TITLE_TTL_MS);
    this.live = new Map();
  }

  resolve(threadIdValue, value, options = {}) {
    const threadId = String(threadIdValue || "").trim();
    if (!threadId) return null;
    const source = options.source === "notification" ? "notification" : "index";
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { title: value, updatedAt: null };
    let title = normalizeSidebarTitle(record.title);
    const now = Number(this.now());
    if (source === "notification") {
      if (!title) return null;
      this.#prune(now);
      this.live.set(threadId, { title, observedAt: now });
      return title;
    }

    const live = this.#current(threadId, now);
    if (!live) return title;
    const indexIsNewer = Number.isFinite(record.updatedAt) && record.updatedAt > live.observedAt;
    if (!title || (title !== live.title && !indexIsNewer)) return live.title;
    // Persistence caught up, or the index contains a provably newer rename.
    this.live.delete(threadId);
    return title;
  }

  #current(threadId, now) {
    const live = this.live.get(threadId);
    if (!live) return null;
    if (Number.isFinite(now) && now - live.observedAt <= this.ttlMs) return live;
    this.live.delete(threadId);
    return null;
  }

  #prune(now) {
    if (!Number.isFinite(now)) return;
    for (const [threadId, live] of this.live) {
      if (now - live.observedAt > this.ttlMs) this.live.delete(threadId);
    }
  }
}
