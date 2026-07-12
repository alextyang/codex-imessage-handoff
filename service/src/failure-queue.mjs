export class FailureQueue {
  constructor() {
    this.byThread = new Map();
  }

  has(threadId) {
    return (this.byThread.get(String(threadId || "")) || []).length > 0;
  }

  list(threadId) {
    return this.byThread.get(String(threadId || "")) || [];
  }

  record(threadId, failure) {
    const id = String(threadId || "");
    const queue = this.list(id);
    const value = { ...failure, queuedAt: failure.queuedAt || new Date().toISOString(), retrying: false };
    const existing = queue.findIndex((item) => item.replyId === value.replyId);
    if (existing >= 0) queue[existing] = value;
    else queue.push(value);
    queue.sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt)));
    this.byThread.set(id, queue);
    return value;
  }

  next(threadId) {
    return this.list(threadId).find((item) => !item.retrying) || null;
  }

  markRetrying(threadId, replyId) {
    const failure = this.list(threadId).find((item) => item.replyId === replyId);
    if (!failure) return false;
    failure.retrying = true;
    return true;
  }

  remove(threadId, replyId) {
    const id = String(threadId || "");
    const remaining = this.list(id).filter((item) => item.replyId !== replyId);
    if (remaining.length) this.byThread.set(id, remaining);
    else this.byThread.delete(id);
    return remaining.length;
  }
}
