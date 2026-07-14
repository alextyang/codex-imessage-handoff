function messageKey(action) {
  return typeof action?.messageKey === "string" ? action.messageKey.trim() : "";
}

const TERMINAL_FAILURE_CODES = new Set([
  "NO_POLL",
  "POLL_GUID_MISSING",
  "POLL_OPTIONS_MISSING",
  "ROOT_GUID_MISSING",
  "UNSUPPORTED",
]);

export function isTerminalLocalActionFailure(code) {
  return TERMINAL_FAILURE_CODES.has(String(code || ""));
}

export function isImmediateLocalAction(action) {
  return action?.kind === "reaction-control" && action.command === "stop";
}

// Keeps ordinary actions ordered while coalescing the same durable inbound
// action across watch recovery, startup replay, and the live subscription.
// Once an attempt settles the key is released so the bounded retry timer can
// deliberately schedule another attempt when the action remains pending.
export class LocalActionDispatch {
  constructor(process) {
    if (typeof process !== "function") throw new TypeError("LocalActionDispatch requires a processor.");
    this.process = process;
    this.chain = Promise.resolve();
    this.scheduled = new Map();
  }

  enqueue(action, { immediate = false } = {}) {
    const key = messageKey(action);
    if (!key) return Promise.resolve();
    const existing = this.scheduled.get(key);
    if (existing) return existing;

    const execute = () => this.process(action);
    const operation = immediate
      ? Promise.resolve().then(execute)
      : this.chain.catch(() => {}).then(execute);
    if (!immediate) this.chain = operation.catch(() => {});
    this.scheduled.set(key, operation);
    const release = () => {
      if (this.scheduled.get(key) === operation) this.scheduled.delete(key);
    };
    operation.then(release, release);
    return operation;
  }
}
