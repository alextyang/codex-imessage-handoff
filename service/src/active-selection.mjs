function normalizedTimestamp(value, fallback = null) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export class ActiveSelection {
  constructor() {
    this.id = null;
    this.selectedAt = null;
    this.epoch = 0;
  }

  update(threadId, selectedAt, now = new Date().toISOString()) {
    const nextId = String(threadId || "").trim() || null;
    const nextAt = nextId ? normalizedTimestamp(selectedAt, normalizedTimestamp(now)) : null;
    const changed = nextId !== this.id;
    const currentMs = Date.parse(this.selectedAt || "");
    const nextMs = Date.parse(nextAt || "");
    const advanced = nextId !== null
      && Number.isFinite(nextMs)
      && (!Number.isFinite(currentMs) || nextMs > currentMs);
    if (changed || advanced) this.epoch += 1;
    this.id = nextId;
    if (!nextId) this.selectedAt = null;
    else if (changed || advanced) this.selectedAt = nextAt;
    return { id: this.id, selectedAt: this.selectedAt, epoch: this.epoch, changed, advanced };
  }

  capture() {
    return { id: this.id, epoch: this.epoch };
  }

  isCurrent(snapshot) {
    return Boolean(snapshot)
      && snapshot.id === this.id
      && snapshot.epoch === this.epoch;
  }
}
