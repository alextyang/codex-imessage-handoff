const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

function currentTime(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new TypeError("LiveMirrorRetryBackoff now() must return a finite number.");
  return value;
}

/**
 * Timer-free retry state for the live mirror. Call recordFailure() after a
 * retryable result, gate later attempts with ready(), and reset after success.
 */
export class LiveMirrorRetryBackoff {
  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("LiveMirrorRetryBackoff requires a now function.");
    this.now = now;
    this.nextDelayMs = INITIAL_DELAY_MS;
    this.readyAtMs = null;
  }

  recordFailure() {
    const delayMs = this.nextDelayMs;
    this.readyAtMs = currentTime(this.now) + delayMs;
    this.nextDelayMs = Math.min(MAX_DELAY_MS, delayMs * 2);
    return delayMs;
  }

  remaining() {
    if (this.readyAtMs === null) return 0;
    return Math.max(0, this.readyAtMs - currentTime(this.now));
  }

  ready() {
    return this.remaining() === 0;
  }

  reset() {
    this.nextDelayMs = INITIAL_DELAY_MS;
    this.readyAtMs = null;
  }
}
