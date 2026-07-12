import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { writePrivateJson } from "./config.mjs";

function validRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deliveryId = String(value.deliveryId || "").trim();
  const threadId = String(value.threadId || "").trim();
  const parentThreadId = String(value.parentThreadId || "").trim();
  if (!deliveryId || !threadId || !parentThreadId) return null;
  const rawEvent = value.event && typeof value.event === "object" && !Array.isArray(value.event)
    ? value.event
    : null;
  const event = rawEvent
    && rawEvent.kind === "thread.detail"
    && rawEvent.reason === "fork"
    && rawEvent.deliveryId === deliveryId
    && rawEvent.thread?.id === threadId
    ? rawEvent
    : null;
  if (rawEvent && !event) return null;
  return { deliveryId, threadId, parentThreadId, event };
}

export class PendingFollowStore {
  constructor(file) {
    this.file = path.resolve(String(file || ""));
    if (!file) throw new TypeError("PendingFollowStore requires a file.");
  }

  get() {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      const record = parsed?.version === 1 ? validRecord(parsed.pending) : null;
      if (!record) throw new Error("invalid");
      try { chmodSync(this.file, 0o600); } catch {}
      return record;
    } catch {
      try {
        const invalid = `${this.file}.invalid-${Date.now()}`;
        renameSync(this.file, invalid);
        chmodSync(invalid, 0o600);
      } catch {}
      return null;
    }
  }

  save(record) {
    const normalized = validRecord(record);
    if (!normalized) throw new TypeError("A valid pending follow record is required.");
    writePrivateJson(this.file, { version: 1, pending: normalized });
    return normalized;
  }

  clear(deliveryId = null) {
    const current = this.get();
    if (!current) return false;
    if (deliveryId && current.deliveryId !== deliveryId) return false;
    rmSync(this.file, { force: true });
    return true;
  }
}
