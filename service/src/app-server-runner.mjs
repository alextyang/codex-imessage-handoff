import { existsSync } from "node:fs";
import path from "node:path";
import {
  approvalDisclosureIsLosslesslyRenderable,
  hasConcreteCommandDisclosure,
  hasConcreteFileChangeDisclosure,
} from "./approval-disclosure.mjs";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 15_000;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 2 * 60_000;
const MAX_SERVER_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_SERVER_REQUEST_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_SERVER_REQUEST_RESPONSE_BYTES = 64 * 1024;
const MAX_SERVER_REQUEST_STRING_BYTES = 16 * 1024;
const MAX_SERVER_REQUEST_COLLECTION_ITEMS = 32;
const MAX_SERVER_REQUEST_JSON_DEPTH = 6;
const UNCERTAIN_TURN_OUTCOME_CODES = new Set([
  "CODEX_DISCONNECTED",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_TIMEOUT",
  "CODEX_UNAVAILABLE",
  "CODEX_REMOTE_UNAVAILABLE",
  "CODEX_HOST_OFFLINE",
  "CODEX_HOST_UNAVAILABLE",
  "CODEX_REMOTE_ENROLLMENT_REQUIRED",
  "CODEX_REMOTE_FORBIDDEN",
  "CODEX_REMOTE_PROTOCOL_ERROR",
  "CODEX_AUTH_REQUIRED",
  "CODEX_AUTH_STALE",
]);

function isUncertainTurnOutcome(error) {
  const code = String(error?.code || "");
  return UNCERTAIN_TURN_OUTCOME_CODES.has(code)
    || code.startsWith("CODEX_REMOTE_")
    || code.startsWith("REMOTE_CONTROL_");
}

const QUIET_NOTIFICATIONS = [
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "rawResponseItem/completed",
];

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function transportError(error, code, message) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error
    : codedError(code, message, error);
}

function clientUserMessageId(value, required = false) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    if (required) throw codedError("CODEX_CLIENT_MESSAGE_INVALID", "A client user-message id is required.");
    return null;
  }
  if (id.length > 256 || /[\u0000-\u001f]/.test(id)) {
    throw codedError("CODEX_CLIENT_MESSAGE_INVALID", "The client user-message id is invalid.");
  }
  return id;
}

function responseForClientUserMessageId(result, requestedId) {
  const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
  const matches = turns.filter((turn) => Array.isArray(turn?.items) && turn.items.some((item) => (
    item?.type === "userMessage" && item.clientId === requestedId
  )));
  if (matches.length > 1) {
    throw codedError(
      "CODEX_CLIENT_MESSAGE_DUPLICATE",
      "Codex contains more than one turn for the same client message id.",
    );
  }
  const turn = matches[0] || null;
  if (!turn) return null;
  const messages = turn.items.filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
  const finalMessages = messages.filter((item) => item.phase === "final_answer");
  const finalResponse = (finalMessages.length ? finalMessages : messages).at(-1)?.text || null;
  const status = String(turn.status || "");
  return {
    id: String(turn.id || ""),
    state: status === "inProgress" ? "running" : status === "completed" ? "completed" : "aborted",
    finalResponse,
    status,
  };
}

function samePath(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && path.resolve(left) === path.resolve(right);
}

function safely(callback, ...args) {
  try {
    callback?.(...args);
  } catch {
    // Presentation callbacks must never break the Codex protocol connection.
  }
}

function phaseForNotification(message) {
  const method = String(message?.method || "");
  const item = message?.params?.item;
  const type = String(item?.type || "");
  if (method === "turn/started") return "Starting work.";
  if (method === "turn/completed") return "Finishing the response.";
  if (method !== "item/started") return null;
  if (type === "commandExecution") return "Running project tools.";
  if (type === "fileChange") return "Updating project files.";
  if (type === "mcpToolCall" || type === "dynamicToolCall") return "Using a connected tool.";
  if (type === "imageGeneration") return "Creating an image.";
  return null;
}

function generatedImagePath(item) {
  if (!item || typeof item !== "object" || item.type !== "imageGeneration") return null;
  for (const value of [item.savedPath, item.result]) {
    if (typeof value === "string" && /\.(png|jpe?g|webp|gif)$/i.test(value) && existsSync(value)) return value;
  }
  return null;
}

function errorFromResponse(error, fallbackCode = "CODEX_FAILED") {
  const diagnostic = typeof error === "string" ? error : String(error?.message || "");
  if (/\bnot paired for this client\b/i.test(diagnostic)) {
    return codedError(
      "CODEX_REMOTE_PAIRING_REQUIRED",
      "Pair iMessage Remote Access with this Codex app before continuing.",
    );
  }
  if (Number(error?.code) === -32001 && /overload|retry later/i.test(diagnostic)) {
    return codedError("BUSY", "Codex is busy; retry later.");
  }
  if (/already.*(running|locked)|session.*lock|thread.*busy/i.test(diagnostic)) {
    return codedError("BUSY", "Thread is busy.");
  }
  if (/not logged in|authentication|unauthorized|status\s*401/i.test(diagnostic)) {
    return codedError("CODEX_AUTH_REQUIRED", "Codex authentication is required.");
  }
  if (/thread.*(not found|unknown)|rollout.*not found/i.test(diagnostic)) {
    return codedError("THREAD_NOT_FOUND", "The Codex thread could not be found.");
  }
  return codedError(fallbackCode, "Codex could not complete the request.");
}

function defaultServerRequestResult(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "denied" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/tool/call":
      return { contentItems: [], success: false };
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    default:
      return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeProtocolId(value, maximumBytes = 512) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f]/.test(value)) return null;
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : null;
}

function safeRequestId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  return safeProtocolId(value, 256);
}

function truncateUtf8(value, maximumBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function descriptorBudget() {
  // Keep room for the whitelisted descriptor's field names and JSON syntax in
  // addition to the variable values accounted for by the recursive copier.
  return { remaining: MAX_SERVER_REQUEST_DESCRIPTOR_BYTES - 16 * 1024, truncated: false };
}

function boundedDescriptorText(value, budget, maximumBytes = MAX_SERVER_REQUEST_STRING_BYTES) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const available = Math.max(0, Math.min(maximumBytes, budget.remaining));
  const output = truncateUtf8(value, available);
  const used = Buffer.byteLength(output, "utf8");
  budget.remaining = Math.max(0, budget.remaining - used - 4);
  if (output !== value) budget.truncated = true;
  return output;
}

function boundedDescriptorJson(value, budget, depth = 0, seen = new Set()) {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return null;
  }
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean") {
    budget.remaining -= 8;
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    budget.remaining -= 24;
    return value;
  }
  if (typeof value === "string") return boundedDescriptorText(value, budget);
  if (depth >= MAX_SERVER_REQUEST_JSON_DEPTH || typeof value !== "object" || seen.has(value)) {
    budget.truncated = true;
    return null;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output = [];
      const limit = Math.min(value.length, MAX_SERVER_REQUEST_COLLECTION_ITEMS);
      if (value.length > limit) budget.truncated = true;
      for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
        output.push(boundedDescriptorJson(value[index], budget, depth + 1, seen));
      }
      return output;
    }
    const output = {};
    const entries = Object.entries(value)
      .filter(([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor");
    const limit = Math.min(entries.length, MAX_SERVER_REQUEST_COLLECTION_ITEMS);
    if (entries.length > limit) budget.truncated = true;
    for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
      const [rawKey, item] = entries[index];
      const key = truncateUtf8(rawKey, 256);
      if (key !== rawKey) budget.truncated = true;
      budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(key, "utf8") - 6);
      output[key] = boundedDescriptorJson(item, budget, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function deepFreezeJson(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreezeJson(item, seen);
  return Object.freeze(value);
}

function finalizeServerRequestDescriptor(descriptor, budget) {
  if (budget.truncated) descriptor.truncated = true;
  try {
    if (Buffer.byteLength(JSON.stringify(descriptor), "utf8") > MAX_SERVER_REQUEST_DESCRIPTOR_BYTES) return null;
    return deepFreezeJson(descriptor);
  } catch {
    return null;
  }
}

function requestContext(method, params, active) {
  if (!active || !isRecord(params)) return null;
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  const threadId = safeProtocolId(legacy ? params.conversationId : params.threadId);
  if (!threadId || threadId !== active.threadId) return null;
  const suppliedTurnId = legacy || params.turnId === null || params.turnId === undefined
    ? null
    : safeProtocolId(params.turnId);
  if (!legacy && params.turnId !== null && params.turnId !== undefined && !suppliedTurnId) return null;
  if (active.turnId && suppliedTurnId && active.turnId !== suppliedTurnId) return null;
  return { threadId, turnId: suppliedTurnId || active.turnId || null };
}

function descriptorBase(message, active, kind) {
  const context = requestContext(message.method, message.params, active);
  const requestId = safeRequestId(message.id);
  if (!context || requestId === null) return null;
  return {
    context,
    descriptor: {
      kind,
      method: message.method,
      requestId,
      threadId: context.threadId,
      turnId: context.turnId,
    },
    budget: descriptorBudget(),
  };
}

function approvalDescriptor(message, active) {
  const params = message.params;
  const legacy = message.method === "execCommandApproval" || message.method === "applyPatchApproval";
  const command = message.method === "item/commandExecution/requestApproval" || message.method === "execCommandApproval";
  const base = descriptorBase(message, active, "approval");
  if (!base) return null;
  const { descriptor, budget } = base;
  descriptor.approval = command ? "command" : "fileChange";
  descriptor.protocol = legacy ? "legacy" : "v2";
  descriptor.itemId = safeProtocolId(legacy ? params.callId : params.itemId) || null;
  if (!descriptor.itemId) return null;
  descriptor.approvalId = safeProtocolId(params.approvalId) || null;
  descriptor.startedAtMs = Number.isFinite(params.startedAtMs) ? params.startedAtMs : null;
  descriptor.reason = boundedDescriptorText(params.reason, budget, 4 * 1024);
  descriptor.cwd = boundedDescriptorText(params.cwd, budget, 4 * 1024);
  if (command) {
    descriptor.command = legacy
      ? boundedDescriptorJson(params.command, budget)
      : boundedDescriptorText(params.command, budget);
    descriptor.commandActions = boundedDescriptorJson(
      legacy ? params.parsedCmd : params.commandActions,
      budget,
    );
    descriptor.environmentId = boundedDescriptorText(params.environmentId, budget, 512);
    descriptor.networkApprovalContext = boundedDescriptorJson(params.networkApprovalContext, budget);
    descriptor.proposedExecpolicyAmendment = boundedDescriptorJson(params.proposedExecpolicyAmendment, budget);
    descriptor.proposedNetworkPolicyAmendments = boundedDescriptorJson(
      params.proposedNetworkPolicyAmendments,
      budget,
    );
  } else {
    descriptor.grantRoot = boundedDescriptorText(params.grantRoot, budget, 4 * 1024);
    if (legacy) {
      const changes = [];
      const entries = isRecord(params.fileChanges) ? Object.entries(params.fileChanges) : [];
      const limit = Math.min(entries.length, MAX_SERVER_REQUEST_COLLECTION_ITEMS);
      if (entries.length > limit) budget.truncated = true;
      for (const [file, change] of entries.slice(0, limit)) {
        const record = isRecord(change) ? change : {};
        changes.push({
          path: boundedDescriptorText(file, budget, 4 * 1024),
          type: boundedDescriptorText(record.type, budget, 64),
          preview: boundedDescriptorText(record.content ?? record.unified_diff, budget, 2 * 1024),
          movePath: boundedDescriptorText(record.move_path, budget, 4 * 1024),
        });
      }
      descriptor.changes = changes;
    }
  }
  return finalizeServerRequestDescriptor(descriptor, budget);
}

function userInputDescriptor(message, active) {
  const base = descriptorBase(message, active, "userInput");
  if (!base || !Array.isArray(message.params.questions)) return null;
  const { descriptor, budget } = base;
  const questions = [];
  const questionIds = new Set();
  const limit = Math.min(message.params.questions.length, 16);
  if (message.params.questions.length > limit) budget.truncated = true;
  for (const question of message.params.questions.slice(0, limit)) {
    if (!isRecord(question)) return null;
    const id = safeProtocolId(question.id, 256);
    if (!id || questionIds.has(id) || id === "__proto__" || id === "prototype" || id === "constructor") return null;
    questionIds.add(id);
    const options = question.options === null
      ? null
      : Array.isArray(question.options)
        ? question.options.slice(0, 16).map((option) => ({
          label: boundedDescriptorText(option?.label, budget, 1024),
          description: boundedDescriptorText(option?.description, budget, 2 * 1024),
        }))
        : null;
    if (Array.isArray(question.options) && question.options.length > 16) budget.truncated = true;
    questions.push({
      id,
      header: boundedDescriptorText(question.header, budget, 512),
      question: boundedDescriptorText(question.question, budget, 4 * 1024),
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    });
  }
  descriptor.itemId = safeProtocolId(message.params.itemId) || null;
  if (!descriptor.itemId) return null;
  descriptor.questions = questions;
  descriptor.autoResolutionMs = Number.isFinite(message.params.autoResolutionMs)
    ? Math.max(0, message.params.autoResolutionMs)
    : null;
  return finalizeServerRequestDescriptor(descriptor, budget);
}

function elicitationDescriptor(message, active) {
  const base = descriptorBase(message, active, "elicitation");
  if (!base) return null;
  const { descriptor, budget } = base;
  const mode = message.params.mode;
  if (mode !== "form" && mode !== "openai/form" && mode !== "url") return null;
  descriptor.mode = mode;
  descriptor.serverName = boundedDescriptorText(message.params.serverName, budget, 512);
  descriptor.message = boundedDescriptorText(message.params.message, budget, 4 * 1024);
  descriptor.requestedSchema = boundedDescriptorJson(message.params.requestedSchema, budget);
  descriptor.meta = boundedDescriptorJson(message.params._meta, budget);
  if (mode === "url") {
    descriptor.url = boundedDescriptorText(message.params.url, budget, 8 * 1024);
    descriptor.elicitationId = safeProtocolId(message.params.elicitationId) || null;
  }
  return finalizeServerRequestDescriptor(descriptor, budget);
}

function dynamicToolDescriptor(message, active) {
  const base = descriptorBase(message, active, "dynamicTool");
  if (!base) return null;
  const { descriptor, budget } = base;
  descriptor.callId = safeProtocolId(message.params.callId) || null;
  descriptor.namespace = boundedDescriptorText(message.params.namespace, budget, 512);
  descriptor.tool = boundedDescriptorText(message.params.tool, budget, 512);
  if (!descriptor.callId || !descriptor.tool) return null;
  descriptor.arguments = boundedDescriptorJson(message.params.arguments, budget);
  return finalizeServerRequestDescriptor(descriptor, budget);
}

function serverRequestDescriptor(message, active) {
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "execCommandApproval":
    case "applyPatchApproval":
      return approvalDescriptor(message, active);
    case "item/tool/requestUserInput":
      return userInputDescriptor(message, active);
    case "mcpServer/elicitation/request":
      return elicitationDescriptor(message, active);
    case "item/tool/call":
      return dynamicToolDescriptor(message, active);
    default:
      return null;
  }
}

function normalizedApprovalDecision(value) {
  if (!isRecord(value)) return null;
  return value.decision === "accept"
    || value.decision === "acceptForSession"
    || value.decision === "decline"
    || value.decision === "cancel"
    ? value.decision
    : null;
}

function strictBoundedJson(value, maximumBytes = MAX_SERVER_REQUEST_RESPONSE_BYTES) {
  const seen = new Set();
  let items = 0;
  function clone(candidate, depth = 0) {
    items += 1;
    if (items > 512 || depth > MAX_SERVER_REQUEST_JSON_DEPTH) throw new Error("response is too complex");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("response contains a non-finite number");
      return candidate;
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > MAX_SERVER_REQUEST_STRING_BYTES) throw new Error("response string is too large");
      return candidate;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) throw new Error("response is not JSON-safe");
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > MAX_SERVER_REQUEST_COLLECTION_ITEMS) throw new Error("response array is too large");
        return candidate.map((item) => clone(item, depth + 1));
      }
      const entries = Object.entries(candidate);
      if (entries.length > MAX_SERVER_REQUEST_COLLECTION_ITEMS) throw new Error("response object is too large");
      const output = {};
      for (const [key, item] of entries) {
        if (!safeProtocolId(key, 256) || key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new Error("response key is invalid");
        }
        output[key] = clone(item, depth + 1);
      }
      return output;
    } finally {
      seen.delete(candidate);
    }
  }
  const output = clone(value);
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > maximumBytes) throw new Error("response is too large");
  return output;
}

function approvalResponse(method, decision, descriptor) {
  const normalized = normalizedApprovalDecision(decision);
  if (!normalized) return null;
  const grantsAuthority = normalized === "accept" || normalized === "acceptForSession";
  if (grantsAuthority && (
    descriptor?.truncated === true
    || !approvalDisclosureIsLosslesslyRenderable(descriptor)
    || (descriptor?.approval === "command" && !hasConcreteCommandDisclosure(descriptor))
    || (descriptor?.approval === "fileChange" && !hasConcreteFileChangeDisclosure(descriptor))
  )) return null;
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return {
      decision: {
        accept: "approved",
        acceptForSession: "approved_for_session",
        decline: "denied",
        cancel: "abort",
      }[normalized],
    };
  }
  return { decision: normalized };
}

function userInputResponse(decision, descriptor) {
  if (!isRecord(decision) || !isRecord(decision.answers)) return null;
  const allowed = new Set(descriptor.questions.map((question) => question.id));
  const output = {};
  for (const [questionId, answerValue] of Object.entries(decision.answers)) {
    if (!allowed.has(questionId)) return null;
    const answers = Array.isArray(answerValue)
      ? answerValue
      : isRecord(answerValue) && Array.isArray(answerValue.answers)
        ? answerValue.answers
        : null;
    if (!answers || answers.length > 8 || answers.some((answer) => (
      typeof answer !== "string" || Buffer.byteLength(answer, "utf8") > 4 * 1024
    ))) return null;
    output[questionId] = { answers: [...answers] };
  }
  const response = { answers: output };
  return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_SERVER_REQUEST_RESPONSE_BYTES
    ? response
    : null;
}

function elicitationResponse(decision) {
  if (!isRecord(decision)
    || (decision.action !== "accept" && decision.action !== "decline" && decision.action !== "cancel")) return null;
  if (decision.action !== "accept") return { action: decision.action, content: null, _meta: null };
  try {
    const content = strictBoundedJson(decision.content ?? null);
    const metaValue = Object.hasOwn(decision, "_meta") ? decision._meta : decision.meta;
    const meta = strictBoundedJson(metaValue ?? null);
    const response = { action: "accept", content, _meta: meta };
    return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_SERVER_REQUEST_RESPONSE_BYTES
      ? response
      : null;
  } catch {
    return null;
  }
}

function dynamicToolResponse(decision) {
  if (!isRecord(decision) || typeof decision.success !== "boolean" || !Array.isArray(decision.contentItems)) return null;
  if (decision.contentItems.length > 16) return null;
  const contentItems = [];
  for (const item of decision.contentItems) {
    if (!isRecord(item)) return null;
    if ((item.type === "text" || item.type === "inputText") && typeof item.text === "string"
      && Buffer.byteLength(item.text, "utf8") <= 32 * 1024) {
      contentItems.push({ type: "inputText", text: item.text });
      continue;
    }
    if ((item.type === "image" || item.type === "inputImage") && typeof item.imageUrl === "string"
      && Buffer.byteLength(item.imageUrl, "utf8") <= 32 * 1024) {
      contentItems.push({ type: "inputImage", imageUrl: item.imageUrl });
      continue;
    }
    return null;
  }
  const response = { contentItems, success: decision.success };
  return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_SERVER_REQUEST_RESPONSE_BYTES
    ? response
    : null;
}

function responseForServerDecision(method, decision, descriptor) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "execCommandApproval":
    case "applyPatchApproval":
      return approvalResponse(method, decision, descriptor);
    case "item/tool/requestUserInput":
      return userInputResponse(decision, descriptor);
    case "mcpServer/elicitation/request":
      return elicitationResponse(decision);
    case "item/tool/call":
      return dynamicToolResponse(decision);
    default:
      return null;
  }
}

function serverRequestKey(id) {
  return `${typeof id}:${String(id)}`;
}

export class AppServerRpcClient {
  constructor(options = {}) {
    this.codexHome = options.codexHome || process.env.CODEX_HOME || null;
    this.expectedCodexHome = path.resolve(this.codexHome || path.join(process.env.HOME || "", ".codex"));
    if (typeof options.webSocketFactory !== "function") {
      throw codedError(
        "CODEX_REMOTE_TRANSPORT_REQUIRED",
        "Codex Remote Control must provide the app-server stream.",
      );
    }
    // The protocol client deliberately receives an already-authorized logical
    // Remote Control stream. It cannot spawn Codex, open a local socket, or
    // own the host app-server process.
    this.webSocketFactory = options.webSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    this.interruptGraceMs = options.interruptGraceMs || DEFAULT_INTERRUPT_GRACE_MS;
    this.serverRequestTimeoutMs = Math.max(1, Math.min(
      MAX_SERVER_REQUEST_TIMEOUT_MS,
      Number(options.serverRequestTimeoutMs) || DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
    ));
    this.socket = null;
    this.ready = false;
    this.connecting = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.activeTurn = null;
  }

  isRunning() {
    return Boolean(this.activeTurn);
  }

  async connect() {
    if (this.ready && this.#transportOpen()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connectOnce();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async #connectOnce() {
    this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex Remote Control stream was replaced."), false);
    await this.#connectWebSocket();

    try {
      const initialized = await this.#requestWithoutConnect("initialize", {
        clientInfo: { name: "imessage-handoff", title: "iMessage Handoff", version: "1" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: true,
          optOutNotificationMethods: QUIET_NOTIFICATIONS,
        },
      });
      if (!samePath(initialized?.codexHome, this.expectedCodexHome)) {
        throw codedError(
          "CODEX_WRONG_HOME",
          "The managed Codex app-server is using a different Codex home.",
        );
      }
      this.#send({ method: "initialized" });
      this.ready = true;
    } catch (error) {
      const unavailable = transportError(error, "CODEX_UNAVAILABLE", "Codex Remote Control is unavailable.");
      const socket = this.socket;
      this.#disconnect(unavailable);
      if (socket && socket.readyState !== SOCKET_CLOSED) {
        try { socket.close(); } catch {}
      }
      throw unavailable;
    }
  }

  async #connectWebSocket() {
    let socket;
    try {
      socket = this.webSocketFactory();
    } catch (error) {
      throw transportError(error, "CODEX_UNAVAILABLE", "Codex Remote Control is unavailable.");
    }
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let opened = false;
      const failBeforeOpen = (error) => {
        if (opened) return false;
        clearTimeout(timer);
        this.socket = null;
        try { socket.close(); } catch {}
        reject(error);
        return true;
      };
      const timer = setTimeout(() => {
        failBeforeOpen(codedError("CODEX_TIMEOUT", "Codex Remote Control did not connect in time."));
      }, this.requestTimeoutMs);
      timer.unref?.();
      socket.on("open", () => {
        if (this.socket !== socket) return;
        opened = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on("message", (data) => {
        if (this.socket === socket) this.#receiveMessage(data);
      });
      socket.on("error", (error) => {
        if (this.socket !== socket) return;
        if (failBeforeOpen(transportError(error, "CODEX_UNAVAILABLE", "Codex Remote Control is unavailable."))) return;
        this.#disconnect(transportError(error, "CODEX_DISCONNECTED", "The Codex Remote Control connection closed."));
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        if (failBeforeOpen(codedError("CODEX_UNAVAILABLE", "Codex Remote Control is unavailable."))) return;
        this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex Remote Control stream closed."));
      });
    });
  }

  async request(method, params, options = {}) {
    await this.connect();
    return this.#requestWithoutConnect(method, params, options);
  }

  async startThread({ cwd, threadSource } = {}) {
    if (this.activeTurn) throw codedError("BUSY", "Another Codex run is active.");
    const canonicalCwd = String(cwd || "").trim();
    const canonicalSource = String(threadSource || "").trim();
    if (!canonicalCwd) throw codedError("MISSING_CWD", "A thread working directory is required.");
    if (!canonicalSource || canonicalSource.length > 512 || /[\u0000-\u001f]/.test(canonicalSource)) {
      throw codedError("INVALID_THREAD_SOURCE", "A valid thread source is required.");
    }
    const result = await this.request("thread/start", {
      cwd: canonicalCwd,
      ephemeral: false,
      threadSource: canonicalSource,
    });
    const threadId = typeof result?.thread?.id === "string" ? result.thread.id.trim() : "";
    if (!threadId) {
      throw codedError("CODEX_PROTOCOL_ERROR", "Codex did not return a valid thread identifier.");
    }
    return result;
  }

  async findTurnByClientUserMessageId(threadIdValue, clientUserMessageIdValue) {
    if (this.activeTurn) throw codedError("BUSY", "Another Codex run is active.");
    const threadId = String(threadIdValue || "").trim();
    const requestedId = clientUserMessageId(clientUserMessageIdValue, true);
    if (!threadId) throw codedError("CODEX_THREAD_INVALID", "A canonical thread id is required.");
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    return responseForClientUserMessageId(result, requestedId);
  }

  #requestWithoutConnect(method, params, options = {}) {
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(codedError("CODEX_TIMEOUT", "Codex Remote Control did not respond in time."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.#send({ id, method, params });
        options.onSent?.();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  #send(message) {
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    throw codedError("CODEX_DISCONNECTED", "The Codex Remote Control stream is not available.");
  }

  #receiveMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    this.#handleMessage(message);
  }

  #transportOpen() {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  #handleMessage(message) {
    if (message && Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(errorFromResponse(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message && Object.hasOwn(message, "id") && message.method) {
      void this.#handleServerRequest(message);
      return;
    }
    if (message?.method) this.#handleNotification(message);
  }

  async #handleServerRequest(message) {
    if (safeRequestId(message.id) === null) return;
    if (message.method === "currentTime/read") {
      try {
        this.#send({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      } catch {
        // A connection failure will reject the active turn and pending requests.
      }
      return;
    }
    const fallback = defaultServerRequestResult(message.method);
    if (fallback === null) {
      try {
        this.#send({
          id: message.id,
          error: { code: -32001, message: "This request requires interaction in the Codex app." },
        });
      } catch {
        // Unknown requests remain fail-closed if the transport is already gone.
      }
      return;
    }

    const active = this.activeTurn;
    const descriptor = serverRequestDescriptor(message, active);
    const handler = active?.onServerRequest;
    if (!descriptor || typeof handler !== "function") {
      try { this.#send({ id: message.id, result: fallback }); } catch {}
      return;
    }

    const key = serverRequestKey(message.id);
    const duplicate = this.serverRequests.get(key);
    if (duplicate) {
      this.#finishServerRequest(duplicate, duplicate.fallback, true);
      return;
    }
    const requestedAutoResolution = message.method === "item/tool/requestUserInput"
      && Number.isFinite(message.params?.autoResolutionMs)
      && message.params.autoResolutionMs > 0
      ? message.params.autoResolutionMs
      : this.serverRequestTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.serverRequestTimeoutMs, requestedAutoResolution));
    const controller = new AbortController();
    const state = {
      key,
      id: message.id,
      method: message.method,
      descriptor,
      fallback,
      active,
      socket: this.socket,
      controller,
      timer: null,
      done: false,
    };
    this.serverRequests.set(key, state);
    const handlerOutcome = Promise.resolve()
      .then(() => handler(descriptor, { signal: controller.signal, timeoutMs }))
      .then((decision) => ({ decision }), () => ({ failed: true }));
    const timeoutOutcome = new Promise((resolve) => {
      state.timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      state.timer.unref?.();
    });
    const outcome = await Promise.race([handlerOutcome, timeoutOutcome]);
    if (outcome.failed || outcome.timedOut) {
      this.#finishServerRequest(state, fallback, true);
      return;
    }
    let result = fallback;
    try {
      result = responseForServerDecision(message.method, outcome.decision, descriptor) || fallback;
    } catch {
      // Treat hostile objects, throwing getters, and every validator failure as
      // an explicit denial. Broker output never reaches app-server unchecked.
    }
    this.#finishServerRequest(state, result);
  }

  #finishServerRequest(state, result, abort = false) {
    if (!state || state.done || this.serverRequests.get(state.key) !== state) return false;
    state.done = true;
    clearTimeout(state.timer);
    this.serverRequests.delete(state.key);
    if (abort) state.controller.abort();
    if (this.socket !== state.socket || this.activeTurn !== state.active || !this.#transportOpen()) return false;
    try {
      this.#send({ id: state.id, result });
      return true;
    } catch {
      return false;
    }
  }

  #declineServerRequests(active = null) {
    for (const state of [...this.serverRequests.values()]) {
      if (!active || state.active === active) this.#finishServerRequest(state, state.fallback, true);
    }
  }

  #handleNotification(message) {
    const params = message.params || {};
    if (message.method === "error" && params.willRetry === false) {
      const error = errorFromResponse(params.error || params);
      const initialization = [...this.pending.entries()].filter(([, request]) => request.method === "initialize");
      if (initialization.length > 0) {
        for (const [id, request] of initialization) {
          this.pending.delete(id);
          clearTimeout(request.timer);
          request.reject(error);
        }
        return;
      }
      if (this.activeTurn) this.#failTurn(this.activeTurn, error);
      return;
    }

    const active = this.activeTurn;
    if (!active) return;
    if (params.threadId && params.threadId !== active.threadId) return;
    const notificationTurnId = params.turnId || params.turn?.id || null;
    if (active.turnId && notificationTurnId && notificationTurnId !== active.turnId) return;

    const phase = phaseForNotification(message);
    if (phase && phase !== active.lastPhase) {
      active.lastPhase = phase;
      safely(active.onPhase, phase);
    }

    if (message.method === "turn/started" && !active.turnId && params.turn?.id) active.turnId = params.turn.id;
    if (message.method === "item/started" && params.item?.id) {
      active.itemPhases.set(params.item.id, params.item?.phase || null);
    }
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      safely(active.onReasoningDelta, String(params.delta || ""), {
        itemId: params.itemId || null,
        turnId: notificationTurnId,
      });
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = String(params.delta || "");
      const itemId = params.itemId || "unknown";
      active.agentDeltas.set(itemId, `${active.agentDeltas.get(itemId) || ""}${delta}`);
      safely(active.onAssistantDelta, delta, {
        itemId,
        phase: active.itemPhases.get(itemId) || null,
        turnId: notificationTurnId,
      });
    }
    if (message.method === "item/completed") this.#recordCompletedItem(active, params.item);
    if (message.method === "turn/completed") this.#completeTurn(active, params.turn);
  }

  #recordCompletedItem(active, item) {
    if (!item || typeof item !== "object") return;
    if (item.id && active.completedItemIds.has(item.id)) return;
    if (item.id) active.completedItemIds.add(item.id);
    const imagePath = generatedImagePath(item);
    if (imagePath && !active.generatedImages.has(imagePath)) {
      active.generatedImages.add(imagePath);
      safely(active.onGeneratedImage, imagePath);
    }
    if (item.type !== "agentMessage") return;
    active.agentMessages.push({ text: String(item.text || ""), phase: item.phase || null, id: item.id || null });
    safely(active.onAssistantMessage, String(item.text || ""), {
      itemId: item.id || null,
      phase: item.phase || null,
    });
  }

  #completeTurn(active, turn) {
    if (this.activeTurn !== active || active.settled) return;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) this.#recordCompletedItem(active, item);
    const status = String(turn?.status || "completed");
    if (active.timedOut) {
      this.#failTurn(active, active.timeoutError);
      return;
    }
    if (active.cancelled || status === "interrupted") {
      this.#settleTurn(active, { status: "cancelled", body: "" });
      return;
    }
    if (status === "failed") {
      this.#failTurn(active, errorFromResponse(turn?.error));
      return;
    }
    const finalMessages = active.agentMessages.filter((item) => item.phase === "final_answer");
    const candidates = finalMessages.length > 0 ? finalMessages : active.agentMessages;
    let body = candidates.at(-1)?.text;
    if (!body) body = [...active.agentDeltas.values()].at(-1) || "";
    this.#settleTurn(active, {
      status: "completed",
      body: body || "Codex completed without a text response.",
      generatedImages: [...active.generatedImages],
    });
  }

  #failTurn(active, error) {
    if (this.activeTurn !== active || active.settled) return;
    active.settled = true;
    clearTimeout(active.turnTimer);
    clearTimeout(active.interruptTimer);
    this.#declineServerRequests(active);
    this.activeTurn = null;
    if (active.turnStartSubmitted && isUncertainTurnOutcome(error)) {
      error.turnOutcomeUnknown = true;
      error.clientUserMessageId = active.clientUserMessageId;
      error.turnId = active.turnId;
    }
    active.reject(error);
  }

  #settleTurn(active, result) {
    if (this.activeTurn !== active || active.settled) return;
    active.settled = true;
    clearTimeout(active.turnTimer);
    clearTimeout(active.interruptTimer);
    this.#declineServerRequests(active);
    this.activeTurn = null;
    active.resolve(result);
  }

  async runTurn(options) {
    if (this.activeTurn) throw codedError("BUSY", "Another Codex run is active.");
    const active = {
      threadId: options.thread.id,
      clientUserMessageId: clientUserMessageId(options.clientUserMessageId),
      turnStartSubmitted: false,
      turnId: null,
      cancelled: false,
      timedOut: false,
      settled: false,
      lastPhase: null,
      itemPhases: new Map(),
      completedItemIds: new Set(),
      agentDeltas: new Map(),
      agentMessages: [],
      generatedImages: new Set(),
      onPhase: options.onPhase,
      onReasoningDelta: options.onReasoningDelta,
      onAssistantDelta: options.onAssistantDelta,
      onAssistantMessage: options.onAssistantMessage,
      onGeneratedImage: options.onGeneratedImage,
      onServerRequest: options.onServerRequest,
      turnTimer: null,
      interruptTimer: null,
      interruptRequested: false,
      timeoutError: null,
      resolve: null,
      reject: null,
    };
    const completion = new Promise((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    // A timeout can settle this promise while connect/resume is still being
    // awaited below. Mark that early rejection as observed immediately; the
    // promise returned from runTurn still adopts and exposes the same result.
    completion.catch(() => {});
    this.activeTurn = active;
    active.turnTimer = setTimeout(() => {
      this.#timeoutTurn(active);
    }, options.turnTimeoutMs || this.turnTimeoutMs);
    active.turnTimer.unref?.();

    try {
      await this.connect();
      if (active.timedOut) {
        this.#failTurn(active, active.timeoutError);
        return completion;
      }
      await this.request("thread/resume", {
        threadId: options.thread.id,
        cwd: options.thread.cwd,
        excludeTurns: true,
      });
      if (active.timedOut) {
        this.#failTurn(active, active.timeoutError);
        return completion;
      }
      if (active.cancelled) {
        this.#settleTurn(active, { status: "cancelled", body: "" });
        return completion;
      }
      const input = [
        { type: "text", text: String(options.prompt), text_elements: [] },
        ...(options.images || []).map((image) => ({ type: "localImage", path: String(image) })),
      ];
      const params = { threadId: options.thread.id, input };
      if (active.clientUserMessageId) params.clientUserMessageId = active.clientUserMessageId;
      if (typeof options.reasoningEffort === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(options.reasoningEffort)) {
        params.effort = options.reasoningEffort;
      }
      const started = await this.request("turn/start", params, {
        onSent: () => { active.turnStartSubmitted = true; },
      });
      if (started?.turn?.id) active.turnId = started.turn.id;
      if (active.timedOut && active.turnId) this.#requestInterrupt(active);
      else if (active.cancelled && active.turnId) this.#interrupt(active);
    } catch (error) {
      this.#failTurn(active, error?.code ? error : errorFromResponse(error));
    }
    return completion;
  }

  cancel(threadId) {
    const active = this.activeTurn;
    if (!active || (threadId && active.threadId !== threadId)) return false;
    active.cancelled = true;
    this.#declineServerRequests(active);
    if (active.turnId) this.#interrupt(active);
    return true;
  }

  async interruptTurn(threadId, turnId) {
    const canonicalThreadId = String(threadId || "").trim();
    const canonicalTurnId = String(turnId || "").trim();
    if (!canonicalThreadId || !canonicalTurnId) {
      throw codedError("CODEX_TURN_INVALID", "A canonical thread and turn are required to interrupt recovered work.");
    }
    await this.request("turn/interrupt", { threadId: canonicalThreadId, turnId: canonicalTurnId });
    return true;
  }

  #interrupt(active) {
    if (active.settled) return;
    this.#requestInterrupt(active);
    if (active.interruptTimer) return;
    active.interruptTimer = setTimeout(() => {
      this.#settleTurn(active, { status: "cancelled", body: "" });
    }, this.interruptGraceMs);
    active.interruptTimer.unref?.();
  }

  #requestInterrupt(active) {
    if (active.interruptRequested || active.settled || !active.turnId) return;
    active.interruptRequested = true;
    this.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }).catch((error) => {
      if (!active.timedOut) this.#failTurn(active, error);
    });
  }

  #timeoutTurn(active) {
    if (this.activeTurn !== active || active.settled || active.cancelled) return;
    active.timedOut = true;
    active.timeoutError = codedError("CODEX_TIMEOUT", "Codex did not complete the turn in time.");
    clearTimeout(active.turnTimer);
    this.#requestInterrupt(active);
    if (active.interruptTimer) return;
    active.interruptTimer = setTimeout(() => {
      this.#failTurn(active, active.timeoutError);
    }, this.interruptGraceMs);
    active.interruptTimer.unref?.();
  }

  close() {
    const socket = this.socket;
    this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex Remote Control stream closed."));
    if (socket && socket.readyState !== SOCKET_CLOSED) {
      try { socket.close(); } catch {}
    }
  }

  #disconnect(error, rejectActive = true) {
    this.ready = false;
    this.#declineServerRequests();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    if (rejectActive && this.activeTurn) this.#failTurn(this.activeTurn, error);
    this.socket = null;
  }
}

export class AppServerCodexRunner {
  constructor(options = {}) {
    this.client = options.client || new AppServerRpcClient(options);
    this.ownsClient = !options.client;
  }

  isRunning() {
    return this.client.isRunning();
  }

  cancel(threadId) {
    return this.client.cancel(threadId);
  }

  async cancelRecoveredTurn(threadId, turnId) {
    try {
      return await this.client.interruptTurn(threadId, turnId);
    } finally {
      if (this.ownsClient) this.client.close();
    }
  }

  async createThread({ cwd, threadSource } = {}) {
    const canonicalCwd = String(cwd || "").trim();
    if (!canonicalCwd || !existsSync(canonicalCwd)) {
      throw codedError("MISSING_CWD", "Thread working directory no longer exists.");
    }
    try {
      const result = await this.client.startThread({ cwd: canonicalCwd, threadSource });
      return {
        ...result.thread,
        id: result.thread.id.trim(),
        cwd: result.cwd || result.thread.cwd || canonicalCwd,
        model: result.model || null,
        reasoningEffort: result.reasoningEffort || null,
        modelProvider: result.modelProvider || result.thread.modelProvider || null,
      };
    } finally {
      if (this.ownsClient) this.client.close();
    }
  }

  async findTurnByClientUserMessageId(threadId, clientMessageId) {
    try {
      return await this.client.findTurnByClientUserMessageId(threadId, clientMessageId);
    } finally {
      if (this.ownsClient) this.client.close();
    }
  }

  async run({
    thread,
    prompt,
    images = [],
    clientUserMessageId,
    reasoningEffort,
    onPhase = () => {},
    onReasoningDelta = () => {},
    onAssistantDelta = () => {},
    onAssistantMessage = () => {},
    onGeneratedImage = () => {},
    onServerRequest,
    turnTimeoutMs,
  }) {
    if (!existsSync(thread.cwd)) throw codedError("MISSING_CWD", "Thread working directory no longer exists.");
    if (this.client.isRunning()) throw codedError("BUSY", "Another Codex run is active.");
    try {
      return await this.client.runTurn({
        thread,
        prompt,
        images,
        clientUserMessageId,
        reasoningEffort,
        onPhase,
        onReasoningDelta,
        onAssistantDelta,
        onAssistantMessage,
        onGeneratedImage,
        onServerRequest,
        turnTimeoutMs,
      });
    } finally {
      if (this.ownsClient) this.client.close();
    }
  }
}
