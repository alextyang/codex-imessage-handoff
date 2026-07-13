import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function readState(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value?.version === 1 && ["online", "offline"].includes(value.observedState)
      ? value
      : null;
  } catch {
    return null;
  }
}
function writeState(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function canonicalState(value) {
  if (value !== "online" && value !== "offline") throw new TypeError("Presence state must be online or offline.");
  return value;
}

export class PresenceTracker {
  constructor(file, options = {}) {
    if (!file) throw new TypeError("PresenceTracker requires a private state file.");
    this.file = path.resolve(file);
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || randomUUID;
    this.chain = Promise.resolve();
  }

  observe(state, options = {}) {
    const operation = () => this.#observe(canonicalState(state), options);
    const queued = this.chain.then(operation, operation);
    this.chain = queued.catch(() => {});
    return queued;
  }

  async #observe(state, { active = false, deliver = async () => ({ terminal: false }) } = {}) {
    const prior = readState(this.file);
    if (!prior) {
      const transitionId = this.randomUUID();
      const value = {
        version: 1,
        observedState: state,
        transitionId,
        transitionAt: new Date(this.now()).toISOString(),
        settledTransitionId: transitionId,
        delivery: "baseline",
      };
      writeState(this.file, value);
      return { changed: false, baseline: true, sent: false, state };
    }

    let value = prior;
    if (prior.observedState !== state) {
      const transitionId = this.randomUUID();
      const transitionAt = new Date(this.now()).toISOString();
      if (state === "online" && prior.observedState === "offline" && prior.delivery !== "sent") {
        // An online notice only makes sense after the matching offline notice was
        // confirmed sent. If transport health recovers while that offline edge
        // is still pending (or it was intentionally suppressed), collapse the
        // flap instead of announcing a recovery the user never saw fail.
        value = {
          version: 1,
          observedState: state,
          transitionId,
          transitionAt,
          settledTransitionId: transitionId,
          delivery: "suppressed-undelivered-offline",
        };
        writeState(this.file, value);
        return { changed: true, sent: false, suppressed: true, collapsed: true, state };
      }
      value = {
        version: 1,
        observedState: state,
        transitionId,
        transitionAt,
        settledTransitionId: null,
        delivery: "pending",
      };
      // Commit the edge before attempting delivery. A crash after an accepted
      // send retries with the same transition id, which the transport dedupes.
      writeState(this.file, value);
    } else if (value.settledTransitionId === value.transitionId) {
      return { changed: false, baseline: false, sent: false, state };
    }

    if (active !== true) {
      value = { ...value, settledTransitionId: value.transitionId, delivery: "suppressed-inactive" };
      writeState(this.file, value);
      return { changed: true, sent: false, suppressed: true, state };
    }

    const deliveryId = `presence:${value.transitionId}`;
    const result = await deliver({ kind: "service.presence", state, deliveryId });
    if (result?.terminal === false || result?.sent === false) {
      return { changed: true, sent: false, pending: true, state, deliveryId };
    }
    value = {
      ...value,
      settledTransitionId: value.transitionId,
      delivery: "sent",
      deliveredAt: new Date(this.now()).toISOString(),
    };
    writeState(this.file, value);
    return { changed: true, sent: true, state, deliveryId };
  }
}
