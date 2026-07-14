const EXPLICIT_HOST_OFFLINE_CODES = new Set([
  "CODEX_HOST_OFFLINE",
]);

function timestamp(now) {
  return new Date(now()).toISOString();
}

function safeCode(error) {
  const code = String(error?.code || "CODEX_REMOTE_UNAVAILABLE");
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "CODEX_REMOTE_UNAVAILABLE";
}

/**
 * Runtime evidence for the optional Codex Remote Control capability.
 *
 * This intentionally does not share a `healthy` bit with the local Messages
 * watch. The service can remain ready to receive and durably queue messages
 * while Remote Control is degraded or the Codex host is offline.
 */
export class RemoteControlAvailability {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.value = {
      status: "unknown",
      available: null,
      hostStatus: "unknown",
      code: null,
      checkedAt: null,
    };
  }

  snapshot() {
    return { ...this.value };
  }

  observeAvailable() {
    this.value = {
      status: "available",
      available: true,
      hostStatus: "online",
      code: null,
      checkedAt: timestamp(this.now),
    };
    return this.snapshot();
  }

  observeFailure(error) {
    const code = safeCode(error);
    this.value = {
      status: "degraded",
      available: false,
      // A timeout, auth failure, or missing pairing proves only that this
      // client cannot currently control Codex. Do not misreport the Mac as
      // offline unless the Remote Control host registry said exactly that.
      hostStatus: EXPLICIT_HOST_OFFLINE_CODES.has(code) ? "offline" : "unknown",
      code,
      checkedAt: timestamp(this.now),
    };
    return this.snapshot();
  }
}

export function remoteControlPresenceState(availability) {
  if (availability?.status === "available" && availability?.hostStatus === "online") return "online";
  if (availability?.hostStatus === "offline") return "offline";
  return null;
}
