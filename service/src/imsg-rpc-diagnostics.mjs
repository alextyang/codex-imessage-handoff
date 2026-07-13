const MAX_REMOTE_ERROR_INPUT_BYTES = 2 * 1024;
const MAX_REMOTE_CODE_ABS = 1_000_000;

const STANDARD_REMOTE_ERRORS = new Map([
  [-32700, { remoteCategory: "parse-error", remoteMessage: "The RPC request could not be parsed." }],
  [-32600, { remoteCategory: "invalid-request", remoteMessage: "The RPC request was invalid." }],
  [-32601, { remoteCategory: "method-not-found", remoteMessage: "The RPC method was unavailable." }],
  [-32602, { remoteCategory: "invalid-params", remoteMessage: "The RPC parameters were invalid." }],
  [-32603, { remoteCategory: "internal-error", remoteMessage: "The RPC operation failed internally." }],
]);

const POLL_CONSTRUCTION_FAILURES = new Map([
  ["missing-class", {
    remoteCategory: "poll-construction-missing-class",
    remoteMessage: "The native Messages class was unavailable while constructing the poll.",
  }],
  ["empty-balloon", {
    remoteCategory: "poll-construction-empty-balloon",
    remoteMessage: "The native poll balloon identifier was unavailable.",
  }],
  ["legacy-item-alloc", {
    remoteCategory: "poll-construction-legacy-item-allocation",
    remoteMessage: "The legacy poll reply item could not be allocated.",
  }],
  ["legacy-item-init", {
    remoteCategory: "poll-construction-legacy-item-initialization",
    remoteMessage: "The legacy poll reply item could not be initialized.",
  }],
  ["legacy-wrap", {
    remoteCategory: "poll-construction-legacy-wrapper",
    remoteMessage: "The legacy poll reply item could not be wrapped.",
  }],
  ["atomic-selector", {
    remoteCategory: "poll-construction-atomic-selector",
    remoteMessage: "The native atomic poll initializer was unavailable.",
  }],
  ["atomic-init-nil", {
    remoteCategory: "poll-construction-atomic-initialization",
    remoteMessage: "The native and fallback poll reply initializers did not return a message.",
  }],
]);

// RPC error `data` can contain message bodies, participant identities, GUIDs,
// and local paths. Never retain it. These classifiers only turn recognized
// implementation diagnostics into fixed, content-free labels.
const SAFE_REMOTE_ERROR_CLASSIFIERS = [
  {
    pattern: /\bcould not resolve reply target for poll(?:\s*:|\b)/i,
    remoteCategory: "poll-reply-target-unresolved",
    remoteMessage: "The poll reply target could not be resolved.",
  },
  {
    pattern: /\bcould not construct poll immessage\b/i,
    remoteCategory: "poll-message-construction-failed",
    remoteMessage: "The poll reply message could not be constructed.",
  },
  {
    pattern: /\bpoll immessage initializer unavailable\b/i,
    remoteCategory: "poll-initializer-unavailable",
    remoteMessage: "The native poll initializer was unavailable.",
  },
  {
    pattern: /\bcould not resolve active imessage sender handle for poll payload\b/i,
    remoteCategory: "poll-sender-unavailable",
    remoteMessage: "The poll sender identity was unavailable.",
  },
  {
    pattern: /\bcould not (?:build|encode|archive|render|create) (?:the )?poll (?:payload|preview image|url)\b/i,
    remoteCategory: "poll-payload-failed",
    remoteMessage: "The native poll payload could not be created.",
  },
  {
    pattern: /\bpoll definition payload exceeds \d+ bytes\b/i,
    remoteCategory: "poll-payload-too-large",
    remoteMessage: "The native poll payload exceeded the Messages size limit.",
  },
  {
    pattern: /\bsend-poll failed(?:\s*:|\b)/i,
    remoteCategory: "poll-send-failed",
    remoteMessage: "The native poll send failed.",
  },
  {
    pattern: /\bchat not found(?:\s*:|\b)/i,
    remoteCategory: "chat-not-found",
    remoteMessage: "The configured Messages chat was not found.",
  },
];

const SAFE_DIAGNOSTICS = new Map(
  [...STANDARD_REMOTE_ERRORS.values(), ...POLL_CONSTRUCTION_FAILURES.values(), ...SAFE_REMOTE_ERROR_CLASSIFIERS]
    .map(({ remoteCategory, remoteMessage }) => [remoteCategory, remoteMessage]),
);

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function boundedRemoteCode(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_REMOTE_CODE_ABS
    ? value
    : undefined;
}

function boundedRemoteInput(value) {
  if (typeof value !== "string" || !value || byteLength(value) > MAX_REMOTE_ERROR_INPUT_BYTES) return "";
  return value;
}

export function safeRemoteRpcDiagnostic(value) {
  const remoteCode = boundedRemoteCode(value?.code);
  const diagnosticInput = `${boundedRemoteInput(value?.message)}\n${boundedRemoteInput(value?.data)}`;
  const constructionCode = diagnosticInput
    .match(/\bcould not construct poll immessage \[([a-z-]+)\]/i)?.[1]
    ?.toLowerCase();
  const classified = (constructionCode && POLL_CONSTRUCTION_FAILURES.get(constructionCode))
    || SAFE_REMOTE_ERROR_CLASSIFIERS.find(({ pattern }) => pattern.test(diagnosticInput));
  const standard = remoteCode === undefined ? null : STANDARD_REMOTE_ERRORS.get(remoteCode);
  return {
    ...(remoteCode !== undefined ? { remoteCode } : {}),
    ...(classified || standard || {}),
  };
}

export function safeImsgFailureDetails(value = {}) {
  const output = {};
  if (["remote-error", "timeout", "eof", "transport"].includes(value.failureSource)) {
    output.failureSource = value.failureSource;
  }
  const remoteCode = boundedRemoteCode(value.remoteCode);
  if (remoteCode !== undefined) output.remoteCode = remoteCode;
  const remoteMessage = SAFE_DIAGNOSTICS.get(value.remoteCategory);
  if (remoteMessage) {
    output.remoteCategory = value.remoteCategory;
    output.remoteMessage = remoteMessage;
  }
  return output;
}

export function imsgRpcFailureSource(error) {
  if (error?.code === "IMSG_RPC_REMOTE_ERROR") return "remote-error";
  if (error?.code === "IMSG_RPC_TIMEOUT") return "timeout";
  if (error?.code === "IMSG_RPC_CLOSED") return "eof";
  return "transport";
}
