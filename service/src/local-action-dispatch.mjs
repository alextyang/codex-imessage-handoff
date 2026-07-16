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
  return (action?.kind === "reaction-control" && action.command === "stop")
    || action?.kind === "controller-response"
    || action?.kind === "controller-cancel";
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
    this.laneChains = new Map([["default", this.chain]]);
    this.scheduled = new Map();
  }

  enqueue(action, { immediate = false, lane = "default" } = {}) {
    const key = messageKey(action);
    if (!key) return Promise.resolve();
    const existing = this.scheduled.get(key);
    if (existing) return existing;

    const execute = () => this.process(action);
    const laneKey = String(lane || "default").slice(0, 40);
    const prior = this.laneChains.get(laneKey) || Promise.resolve();
    const operation = immediate
      ? Promise.resolve().then(execute)
      : prior.catch(() => {}).then(execute);
    if (!immediate) {
      const continuation = operation.catch(() => {});
      this.laneChains.set(laneKey, continuation);
      if (laneKey === "default") this.chain = continuation;
    }
    this.scheduled.set(key, operation);
    const release = () => {
      if (this.scheduled.get(key) === operation) this.scheduled.delete(key);
    };
    operation.then(release, release);
    return operation;
  }
}
