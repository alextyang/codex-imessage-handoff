import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import {
  imsgRpcFailureSource,
  safeImsgFailureDetails,
  safeRemoteRpcDiagnostic,
} from "./imsg-rpc-diagnostics.mjs";
import { IMSG_RPC_SEND_TIMEOUT_MS } from "./imsg-timeouts.mjs";

const DEFAULT_RPC_TIMEOUT_MS = 8_000;
const DEFAULT_STOP_TIMEOUT_MS = 500;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 128 * 1024;
const STATUS_MAX_BYTES = 512 * 1024;

export const REQUIRED_PINNED_IMSG_CAPABILITIES = Object.freeze([
  "watch",
  "richText",
  "replies",
  "polls",
  "pollCaptionControl",
  "pollVoting",
  "tapbacks",
  "customEmojiTapbacks",
  "typing",
  "readReceipts",
  "attachments",
]);

const SEND_METHODS = new Set([
  "send.rich",
  "send.attachment",
  "poll.send",
  "poll.vote",
  "poll.unvote",
  "tapback",
  "typing",
  "read",
  "message.edit",
  "message.unsend",
]);

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcFailure(code, message, options = {}) {
  return Object.assign(new Error(message), {
    code,
    attempted: options.attempted === true,
    ...safeImsgFailureDetails(options),
  });
}

function accepted(result, transport = "rpc") {
  return {
    ...(isObject(result) ? result : {}),
    classification: "accepted",
    accepted: true,
    ambiguous: false,
    unsupported: false,
    retrySafe: false,
    transport,
  };
}

function unsupported(reason) {
  return {
    classification: "unsupported",
    accepted: false,
    ambiguous: false,
    unsupported: true,
    retrySafe: true,
    reason,
  };
}

function ambiguous(reason, details = {}) {
  return {
    classification: "ambiguous",
    accepted: false,
    ambiguous: true,
    unsupported: false,
    retrySafe: false,
    reason,
    ...safeImsgFailureDetails(details),
  };
}

function normalizeTarget(params, { allowRecipient = true, requireChat = false } = {}) {
  const source = isObject(params) ? params : {};
  const candidates = [
    ["to", source.to],
    ["chat_id", source.chat_id ?? source.chatId],
    ["chat_identifier", source.chat_identifier ?? source.chatIdentifier],
    ["chat_guid", source.chat_guid ?? source.chatGuid],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (candidates.length !== 1) throw rpcFailure("IMSG_INVALID_INPUT", "Exactly one message target is required.");
  const [key, raw] = candidates[0];
  if ((!allowRecipient || requireChat) && key === "to") {
    throw rpcFailure("IMSG_INVALID_INPUT", "An existing Messages chat is required.");
  }
  if (key === "chat_id") {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw rpcFailure("IMSG_INVALID_INPUT", "chat_id must be a positive integer.");
    return { chat_id: value };
  }
  const value = String(raw).trim();
  if (!value || value.length > 4096) throw rpcFailure("IMSG_INVALID_INPUT", "The message target is invalid.");
  return { [key]: value };
}

function requireBoundedString(value, field, { optional = false, maxBytes = DEFAULT_MAX_TEXT_BYTES } = {}) {
  if ((value === undefined || value === null) && optional) return undefined;
  if (typeof value !== "string") throw rpcFailure("IMSG_INVALID_INPUT", `${field} must be a string.`);
  if (byteLength(value) > maxBytes) throw rpcFailure("IMSG_MESSAGE_TOO_LARGE", `${field} is too large.`);
  return value;
}

function normalizeFormatting(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 512) throw rpcFailure("IMSG_INVALID_INPUT", "text_formatting must be an array.");
  const styles = new Set(["bold", "italic", "underline", "strikethrough"]);
  return value.map((entry) => {
    if (!isObject(entry)) throw rpcFailure("IMSG_INVALID_INPUT", "A formatting range is invalid.");
    const start = Number(entry.start);
    const length = Number(entry.length);
    const selected = Array.isArray(entry.styles) ? entry.styles.map(String) : [];
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || !selected.length || selected.some((style) => !styles.has(style))) {
      throw rpcFailure("IMSG_INVALID_INPUT", "A formatting range is invalid.");
    }
    return { start, length, styles: [...new Set(selected)] };
  });
}

function normalizeRichSend(params) {
  const target = normalizeTarget(params, { allowRecipient: false, requireChat: true });
  const url = requireBoundedString(params?.url, "url", { optional: true, maxBytes: 8192 });
  const file = requireBoundedString(params?.file ?? params?.path, "file", { optional: true, maxBytes: 4096 });
  const text = requireBoundedString(params?.text, "text", { optional: true });
  const formatting = normalizeFormatting(params?.text_formatting ?? params?.textFormatting ?? params?.formatting);
  const effect = requireBoundedString(params?.effect ?? params?.effect_id ?? params?.effectId, "effect", { optional: true, maxBytes: 256 });
  const subject = requireBoundedString(params?.subject, "subject", { optional: true, maxBytes: 4096 });
  const reply = requireBoundedString(params?.reply_to ?? params?.replyTo ?? params?.reply_to_guid, "reply_to", { optional: true, maxBytes: 4096 });
  const ddScan = params?.dd_scan ?? params?.ddScan;
  const clientGuid = requireBoundedString(params?.client_guid, "client_guid", { optional: true, maxBytes: 36 });
  if (ddScan !== undefined && typeof ddScan !== "boolean") {
    throw rpcFailure("IMSG_INVALID_INPUT", "dd_scan must be a boolean.");
  }
  if (clientGuid && !/^[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/u.test(clientGuid)) {
    throw rpcFailure("IMSG_INVALID_INPUT", "client_guid must be a canonical uppercase UUIDv4.");
  }

  if (url) {
    if (!/^https?:\/\//i.test(url)) throw rpcFailure("IMSG_INVALID_INPUT", "url must use HTTP or HTTPS.");
    if (file || text || formatting || effect || subject || reply || clientGuid) throw rpcFailure("IMSG_INVALID_INPUT", "A rich link cannot be combined with other send options.");
    return { method: "send.rich", params: { ...target, url } };
  }
  if (file) {
    if (text || formatting || effect || subject || clientGuid) throw rpcFailure("IMSG_INVALID_INPUT", "A rich attachment cannot be combined with rich text options.");
    const audio = params?.audio ?? params?.is_audio ?? params?.as_voice;
    return {
      method: "send.attachment",
      params: { ...target, file, ...(reply ? { reply_to: reply } : {}), ...(audio === true ? { audio: true } : {}) },
    };
  }
  if (!text) throw rpcFailure("IMSG_INVALID_INPUT", "Rich text, a file, or a URL is required.");
  if (formatting?.some((range) => range.start + range.length > text.length)) {
    throw rpcFailure("IMSG_INVALID_INPUT", "A formatting range exceeds the text body.");
  }
  return {
    // A caller-owned GUID is a separate RPC surface, not an optional modifier
    // on the legacy send method. An older imsg RPC binary must reject the
    // method before it can silently discard client_guid and send a message the
    // caller cannot correlate.
    method: clientGuid ? "send.rich.client-guid" : "send.rich",
    params: {
      ...target,
      text,
      ...(formatting ? { text_formatting: formatting } : {}),
      ...(effect ? { effect } : {}),
      ...(subject ? { subject } : {}),
      ...(reply ? { reply_to: reply } : {}),
      ...(ddScan !== undefined ? { dd_scan: ddScan } : {}),
      ...(clientGuid ? { client_guid: clientGuid } : {}),
    },
  };
}

function normalizePoll(params) {
  const target = normalizeTarget(params, { allowRecipient: false, requireChat: true });
  const question = requireBoundedString(params?.question, "question");
  const options = Array.isArray(params?.options) ? params.options.map((value) => requireBoundedString(value, "poll option", { maxBytes: 4096 }).trim()).filter(Boolean) : [];
  // Apple Messages supports at most 12 choices in a native poll.
  if (!question.trim() || options.length < 2 || options.length > 12) throw rpcFailure("IMSG_INVALID_INPUT", "A poll requires a question and 2–12 options.");
  const comment = requireBoundedString(params?.comment, "comment", { optional: true });
  const reply = requireBoundedString(params?.reply_to ?? params?.replyTo ?? params?.reply_to_guid, "reply_to", { optional: true, maxBytes: 4096 });
  const sendCaption = params?.send_caption ?? params?.sendCaption;
  if (sendCaption !== undefined && typeof sendCaption !== "boolean") {
    throw rpcFailure("IMSG_INVALID_INPUT", "send_caption must be a boolean.");
  }
  return {
    ...target,
    question,
    options,
    ...(comment ? { comment } : {}),
    ...(reply ? { reply_to: reply } : {}),
    ...(sendCaption !== undefined ? { send_caption: sendCaption } : {}),
  };
}

function normalizeMutationTarget(params) {
  return normalizeTarget(params, { allowRecipient: true });
}

function parseOneJsonLine(stdout, maxBytes = STATUS_MAX_BYTES) {
  const value = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
  if (value.byteLength > maxBytes) throw rpcFailure("IMSG_OUTPUT_TOO_LARGE", "imsg returned too much data.");
  const lines = value.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1 || byteLength(lines[0]) > maxBytes) throw rpcFailure("IMSG_MALFORMED_OUTPUT", "imsg returned malformed output.");
  try {
    const parsed = JSON.parse(lines[0]);
    if (!isObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw rpcFailure("IMSG_MALFORMED_OUTPUT", "imsg returned malformed output.");
  }
}

function execFilePromise(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout = "", stderr = "") => {
      if (settled) return;
      settled = true;
      if (error) {
        error.stdout = stdout;
        error.stderr = "";
        reject(error);
      } else {
        resolve({ stdout, stderr: "" });
      }
    };
    try {
      const result = execFileImpl(file, args, options, finish);
      if (result && typeof result.then === "function") {
        result.then((value) => finish(null, value?.stdout ?? value ?? "", ""), (error) => finish(error));
      }
    } catch (error) {
      finish(error);
    }
  });
}

function normalizedCapabilities(path, raw) {
  const methods = Array.isArray(raw?.rpc_methods) ? raw.rpc_methods.filter((value) => typeof value === "string") : [];
  const methodSet = new Set(methods);
  const selectors = isObject(raw?.selectors) ? Object.fromEntries(Object.entries(raw.selectors).filter(([, value]) => typeof value === "boolean")) : {};
  const basic = raw?.basic_features === true;
  const advanced = raw?.advanced_features === true && raw?.v2_ready === true;
  const has = (method) => methodSet.has(method);
  return {
    available: true,
    path,
    version: typeof raw?.version === "string" ? raw.version : null,
    basic,
    advanced,
    sip: typeof raw?.sip === "string" ? raw.sip : "unknown",
    bridgeVersion: Number.isSafeInteger(raw?.bridge_version) ? raw.bridge_version : 0,
    v2Ready: raw?.v2_ready === true,
    rpcMethods: methods,
    selectors,
    capabilities: {
      rpc: methods.length > 0,
      watch: has("watch.subscribe") && has("watch.unsubscribe"),
      richText: advanced && has("send.rich"),
      clientMessageGuid: advanced && has("send.rich.client-guid") && selectors.clientMessageGuid === true,
      effects: advanced && has("send.rich"),
      replies: advanced && has("send.rich"),
      attachments: advanced && has("send.attachment"),
      urlPreviews: advanced && has("send.rich") && selectors.urlPreviewMessage === true && selectors.sendRichLinkAction === true,
      polls: advanced && has("poll.send") && selectors.pollPayloadMessage === true,
      pollCaptionControl: advanced && has("poll.send") && raw?.poll_caption_control === true,
      pollVoting: advanced && has("poll.vote") && selectors.pollVoteMessage === true,
      tapbacks: advanced && has("tapback"),
      customEmojiTapbacks: advanced && has("tapback") && raw?.custom_emoji_tapbacks === true,
      typing: advanced && has("typing") && raw?.typing_indicators === true,
      readReceipts: advanced && has("read") && raw?.read_receipts === true,
      sendStatus: has("message.send_status"),
      edits: advanced && has("message.edit")
        && (selectors.editMessageItemTranslation === true
          || selectors.editMessage === true
          || selectors.editMessageItem === true),
      unsend: advanced && has("message.unsend") && selectors.retractMessagePart === true,
    },
  };
}

export class ImsgClient {
  constructor(options = {}) {
    this.binary = options.binary || process.env.IMSG_BIN || null;
    this.candidates = Array.isArray(options.candidates) ? options.candidates : ["/opt/homebrew/bin/imsg", "/usr/local/bin/imsg", "imsg"];
    this.spawnImpl = options.spawnImpl || nodeSpawn;
    this.execFileImpl = options.execFileImpl || nodeExecFile;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? IMSG_RPC_SEND_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.logger = options.logger || null;
    this.path = null;
    this.capabilityCache = null;
    this.child = null;
    this.startPromise = null;
    this.rpcReady = false;
    this.stopping = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.watchers = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrNoticeSent = false;
  }

  async locate({ refresh = false } = {}) {
    if (this.path && !refresh) return this.path;
    const candidates = [...new Set(this.binary ? [this.binary] : this.candidates)];
    for (const candidate of candidates) {
      try {
        const { stdout } = await execFilePromise(this.execFileImpl, candidate, ["--version"], { timeout: this.rpcTimeoutMs, maxBuffer: STATUS_MAX_BYTES, encoding: "utf8" });
        if (byteLength(stdout) <= STATUS_MAX_BYTES) {
          this.path = candidate;
          return candidate;
        }
      } catch {
        // Probe the next known installation location without exposing diagnostics.
      }
    }
    throw rpcFailure("IMSG_NOT_FOUND", "imsg is not installed or is not executable.");
  }

  async status({ refresh = false } = {}) {
    if (this.capabilityCache && !refresh) return this.capabilityCache;
    let path;
    try {
      path = await this.locate({ refresh });
    } catch {
      return { available: false, path: null, version: null, basic: false, advanced: false, rpcMethods: [], selectors: {}, capabilities: {} };
    }
    try {
      const { stdout } = await execFilePromise(this.execFileImpl, path, ["status", "--json"], { timeout: this.rpcTimeoutMs, maxBuffer: STATUS_MAX_BYTES, encoding: "utf8" });
      this.capabilityCache = normalizedCapabilities(path, parseOneJsonLine(stdout));
    } catch {
      this.capabilityCache = { available: true, path, version: null, basic: false, advanced: false, statusAvailable: false, rpcMethods: [], selectors: {}, capabilities: {} };
    }
    return this.capabilityCache;
  }

  probeCapabilities(options) {
    return this.status(options);
  }

  async latestMessage(params) {
    let normalized;
    try {
      normalized = normalizeTarget(params, { allowRecipient: false, requireChat: true });
    } catch (error) {
      throw rpcFailure(error.code || "IMSG_INVALID_INPUT", "A valid Messages chat is required for history baselining.");
    }
    const path = await this.locate();
    const args = ["history"];
    if (normalized.chat_id) args.push("--chat-id", String(normalized.chat_id));
    else if (normalized.chat_identifier) args.push("--participants", normalized.chat_identifier);
    else throw rpcFailure("IMSG_INVALID_INPUT", "A numeric Messages chat is required for history baselining.");
    // Messages can assign the inbound self-chat copy a higher ROWID than the
    // chronologically later outbound copy. Read a small tail and baseline the
    // maximum ROWID; `history --limit 1` alone can otherwise leave that echo
    // eligible for a fresh watch subscription.
    args.push("--limit", "50", "--json");
    let stdout;
    try {
      ({ stdout } = await execFilePromise(this.execFileImpl, path, args, {
        timeout: this.rpcTimeoutMs,
        maxBuffer: STATUS_MAX_BYTES,
        encoding: "utf8",
      }));
    } catch {
      throw rpcFailure("IMSG_HISTORY_UNAVAILABLE", "imsg could not baseline the selected Messages chat.");
    }
    const output = Buffer.from(String(stdout || ""));
    if (output.byteLength > STATUS_MAX_BYTES) {
      throw rpcFailure("IMSG_OUTPUT_TOO_LARGE", "imsg returned too much history data.");
    }
    const lines = output.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) return null;
    if (lines.length > 50) throw rpcFailure("IMSG_MALFORMED_OUTPUT", "imsg returned too much history data.");
    let rows;
    try {
      rows = lines.map((line) => JSON.parse(line)).filter(isObject);
    } catch {
      throw rpcFailure("IMSG_MALFORMED_OUTPUT", "imsg returned malformed history data.");
    }
    if (rows.length !== lines.length) throw rpcFailure("IMSG_MALFORMED_OUTPUT", "imsg returned malformed history data.");
    return rows.reduce((latest, row) => {
      const id = Number(row.id ?? row.rowid ?? row.row_id);
      const latestId = Number(latest?.id ?? latest?.rowid ?? latest?.row_id);
      if (!Number.isSafeInteger(id)) return latest;
      return !Number.isSafeInteger(latestId) || id > latestId ? row : latest;
    }, rows[0]);
  }

  async _spawnRpc() {
    const path = await this.locate();
    let child;
    try {
      child = this.spawnImpl(path, ["rpc"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw rpcFailure("IMSG_RPC_UNAVAILABLE", "imsg RPC could not be started.", { attempted: false });
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      try { child?.kill?.("SIGTERM"); } catch {}
      throw rpcFailure("IMSG_RPC_UNAVAILABLE", "imsg RPC could not be started.", { attempted: false });
    }
    this.child = child;
    this.rpcReady = false;
    this.stopping = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrNoticeSent = false;
    child.stdout.on("data", (chunk) => this._handleStdout(chunk));
    child.stderr.on("data", () => {
      if (!this.stderrNoticeSent) {
        this.stderrNoticeSent = true;
        this.logger?.warn?.("imsg RPC emitted diagnostic output; details were suppressed.");
      }
    });
    child.stdin.on?.("error", () => this._handleTransportFailure("IMSG_RPC_CLOSED", "imsg RPC input closed unexpectedly.", child));
    child.once?.("error", () => this._handleTransportFailure("IMSG_RPC_UNAVAILABLE", "imsg RPC exited unexpectedly.", child));
    child.once?.("close", () => this._handleTransportFailure("IMSG_RPC_CLOSED", "imsg RPC exited unexpectedly.", child));
  }

  async start() {
    if (this.child && this.rpcReady) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await this._spawnRpc();
      try {
        await this._request("chats.list", { limit: 1 }, { timeoutMs: this.rpcTimeoutMs, sendOperation: false });
        this.rpcReady = true;
        return this;
      } catch (error) {
        await this._stopChild();
        throw rpcFailure("IMSG_RPC_UNAVAILABLE", "imsg RPC is unavailable.", { attempted: false });
      }
    })().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    return this._request(method, params, { timeoutMs: options.timeoutMs ?? this.rpcTimeoutMs, sendOperation: options.sendOperation ?? SEND_METHODS.has(method) });
  }

  _request(method, params, { timeoutMs, sendOperation }) {
    if (!this.child?.stdin || this.child.killed || this.child.exitCode !== null) {
      return Promise.reject(rpcFailure("IMSG_RPC_CLOSED", "imsg RPC is not running.", { attempted: false }));
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: isObject(params) ? params : {} });
    if (byteLength(payload) > this.maxMessageBytes) return Promise.reject(rpcFailure("IMSG_MESSAGE_TOO_LARGE", "The imsg RPC request is too large.", { attempted: false }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(rpcFailure("IMSG_RPC_TIMEOUT", "imsg RPC timed out.", { attempted: true }));
        this._protocolViolation("IMSG_RPC_TIMEOUT", "imsg RPC timed out.");
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, sendOperation });
      try {
        this.child.stdin.write(`${payload}\n`, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(rpcFailure("IMSG_RPC_WRITE_FAILED", "imsg RPC could not accept the request.", { attempted: true }));
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(rpcFailure("IMSG_RPC_WRITE_FAILED", "imsg RPC could not accept the request.", { attempted: true }));
      }
    });
  }

  _handleStdout(chunk) {
    if (!this.child) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    if (this.stdoutBuffer.byteLength > this.maxLineBytes && this.stdoutBuffer.indexOf(0x0a) === -1) {
      this._protocolViolation("IMSG_RPC_LINE_TOO_LARGE", "imsg RPC returned an oversized line.");
      return;
    }
    let newline;
    while ((newline = this.stdoutBuffer.indexOf(0x0a)) !== -1) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > this.maxLineBytes) {
        this._protocolViolation("IMSG_RPC_LINE_TOO_LARGE", "imsg RPC returned an oversized line.");
        return;
      }
      if (!line.length || (line.length === 1 && line[0] === 0x0d)) continue;
      this._handleLine(line.toString("utf8").replace(/\r$/, ""));
      if (!this.child) return;
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._protocolViolation("IMSG_MALFORMED_RPC", "imsg RPC returned malformed JSON.");
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this._protocolViolation("IMSG_MALFORMED_RPC", "imsg RPC returned an invalid message.");
      return;
    }
    if (message.id === undefined) {
      if (typeof message.method !== "string" || !isObject(message.params)) {
        this._protocolViolation("IMSG_MALFORMED_RPC", "imsg RPC returned an invalid notification.");
        return;
      }
      this._handleNotification(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this._protocolViolation("IMSG_MALFORMED_RPC", "imsg RPC returned an unknown response.");
      return;
    }
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError || (hasError && !isObject(message.error))) {
      this._protocolViolation("IMSG_MALFORMED_RPC", "imsg RPC returned an invalid response.");
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (hasError) {
      pending.reject(rpcFailure("IMSG_RPC_REMOTE_ERROR", "imsg RPC rejected the request.", {
        attempted: true,
        failureSource: "remote-error",
        ...safeRemoteRpcDiagnostic(message.error),
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  _handleNotification(message) {
    if (message.method !== "message") return;
    const subscription = message.params.subscription;
    if (!Number.isSafeInteger(subscription) || subscription <= 0 || !isObject(message.params.message)) {
      this._protocolViolation("IMSG_MALFORMED_RPC", "imsg RPC returned an invalid message notification.");
      return;
    }
    const watcher = this.watchers.get(subscription);
    if (!watcher) return;
    try {
      watcher.onMessage(message.params.message);
    } catch {
      // Consumer failures must not destabilize the transport.
    }
  }

  _protocolViolation(code, message) {
    const child = this.child;
    this._handleTransportFailure(code, message);
    try { child?.kill?.("SIGTERM"); } catch {}
  }

  _handleTransportFailure(code, message, sourceChild = null) {
    if (sourceChild && sourceChild !== this.child) return;
    if (!this.child && !this.pending.size) return;
    const wasStopping = this.stopping;
    this.child = null;
    this.rpcReady = false;
    this.stdoutBuffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(rpcFailure(code, message, { attempted: true }));
    }
    this.pending.clear();
    for (const watcher of this.watchers.values()) {
      try { watcher.onError?.(wasStopping ? null : rpcFailure(code, message)); } catch {}
    }
    this.watchers.clear();
  }

  _methodSupported(capabilities, method, feature) {
    if (!capabilities?.available || !capabilities.rpcMethods?.includes(method)) return false;
    return feature ? capabilities.capabilities?.[feature] === true : true;
  }

  async _classifiedRpcSend(method, params, { feature } = {}) {
    const capabilities = await this.status();
    if (!this._methodSupported(capabilities, method, feature)) return unsupported(`${feature || method}-unavailable`);
    try {
      const result = await this.request(method, params, { timeoutMs: this.sendTimeoutMs, sendOperation: true });
      if (!isObject(result) || result.ok !== true) return ambiguous("invalid-result");
      return accepted(result);
    } catch (error) {
      if (error?.code === "IMSG_RPC_REMOTE_ERROR" && error?.remoteCode === -32601) return unsupported("rpc-method-unavailable");
      return ambiguous(
        error?.code === "IMSG_RPC_TIMEOUT" ? "timeout" : "transport-or-send-failure",
        { ...error, failureSource: imsgRpcFailureSource(error) },
      );
    }
  }

  async sendRich(params) {
    let normalized;
    try {
      normalized = normalizeRichSend(params);
    } catch (error) {
      return unsupported(error.code || "invalid-input");
    }
    const feature = normalized.params.client_guid
      ? "clientMessageGuid"
      : normalized.method === "send.attachment"
        ? "attachments"
        : normalized.params.url ? "urlPreviews" : "richText";
    return this._classifiedRpcSend(normalized.method, normalized.params, { feature });
  }

  sendAttachment(params) {
    return this.sendRich({ ...params, file: params?.file ?? params?.path });
  }

  async sendPoll(params) {
    let normalized;
    try {
      normalized = normalizePoll(params);
    } catch (error) {
      return unsupported(error.code || "invalid-input");
    }
    const feature = normalized.send_caption === false ? "pollCaptionControl" : "polls";
    return this._classifiedRpcSend("poll.send", normalized, { feature });
  }

  async votePoll(params, { remove = false } = {}) {
    let target;
    try {
      target = normalizeTarget(params, { allowRecipient: false, requireChat: true });
      const pollGuid = requireBoundedString(params?.poll_guid ?? params?.pollGuid, "poll_guid", { maxBytes: 4096 });
      const optionId = requireBoundedString(params?.option_id ?? params?.optionId, "option_id", { maxBytes: 4096 });
      if (!pollGuid || !optionId) throw rpcFailure("IMSG_INVALID_INPUT", "A poll and option are required.");
      return this._classifiedRpcSend(remove ? "poll.unvote" : "poll.vote", { ...target, poll_guid: pollGuid, option_id: optionId }, { feature: "pollVoting" });
    } catch (error) {
      return unsupported(error.code || "invalid-input");
    }
  }

  sendPollVote(params, options) {
    return this.votePoll(params, options);
  }

  async tapback(params) {
    let rpcParams;
    try {
      const target = normalizeTarget(params, { allowRecipient: false, requireChat: true });
      const messageGuid = requireBoundedString(params?.message_guid ?? params?.messageGuid ?? params?.message_id, "message_guid", { maxBytes: 4096 });
      const reaction = requireBoundedString(params?.reaction ?? params?.kind ?? params?.emoji, "reaction", { maxBytes: 128 });
      if (!messageGuid || !reaction) throw rpcFailure("IMSG_INVALID_INPUT", "A message and reaction are required.");
      rpcParams = { ...target, message_guid: messageGuid, reaction, ...(params?.remove === true ? { remove: true } : {}) };
    } catch (error) {
      return unsupported(error.code || "invalid-input");
    }
    return this._classifiedRpcSend("tapback", rpcParams, { feature: "tapbacks" });
  }

  async setTyping(params, typing = true) {
    let target;
    try { target = normalizeMutationTarget(params); } catch (error) { return unsupported(error.code || "invalid-input"); }
    return this._classifiedRpcSend("typing", { ...target, typing: typing === true }, { feature: "typing" });
  }

  typing(params, typing = true) {
    return this.setTyping(params, typing);
  }

  async markRead(params) {
    let target;
    try { target = normalizeMutationTarget(params); } catch (error) { return unsupported(error.code || "invalid-input"); }
    return this._classifiedRpcSend("read", target, { feature: "readReceipts" });
  }

  read(params) {
    return this.markRead(params);
  }

  async sendStatus(guid) {
    let value;
    try { value = requireBoundedString(guid, "guid", { maxBytes: 4096 }); } catch (error) { return unsupported(error.code || "invalid-input"); }
    const capabilities = await this.status();
    if (!this._methodSupported(capabilities, "message.send_status", "sendStatus")) return unsupported("send-status-unavailable");
    try {
      const result = await this.request("message.send_status", { guid: value });
      return isObject(result) && result.ok === true ? accepted(result) : ambiguous("invalid-result");
    } catch {
      return ambiguous("status-query-failure");
    }
  }

  getSendStatus(guid) {
    return this.sendStatus(guid);
  }

  async editMessage(params) {
    let rpcParams;
    try {
      const target = normalizeTarget(params, { allowRecipient: false, requireChat: true });
      const messageGuid = requireBoundedString(params?.message_guid ?? params?.messageGuid ?? params?.message_id, "message_guid", { maxBytes: 4096 });
      const text = requireBoundedString(params?.text, "text");
      if (!messageGuid || !text) throw rpcFailure("IMSG_INVALID_INPUT", "A message and replacement text are required.");
      const partIndex = params?.part_index ?? params?.partIndex;
      if (partIndex !== undefined && (!Number.isSafeInteger(Number(partIndex)) || Number(partIndex) < 0)) {
        throw rpcFailure("IMSG_INVALID_INPUT", "part_index must be a non-negative integer.");
      }
      rpcParams = { ...target, message_guid: messageGuid, text, ...(partIndex !== undefined ? { part_index: Number(partIndex) } : {}) };
    } catch (error) {
      return unsupported(error.code || "invalid-input");
    }
    return this._classifiedRpcSend("message.edit", rpcParams, { feature: "edits" });
  }

  async unsendMessage(params) {
    let rpcParams;
    try {
      const target = normalizeTarget(params, { allowRecipient: false, requireChat: true });
      const messageGuid = requireBoundedString(params?.message_guid ?? params?.messageGuid ?? params?.message_id, "message_guid", { maxBytes: 4096 });
      if (!messageGuid) throw rpcFailure("IMSG_INVALID_INPUT", "A message is required.");
      const partIndex = params?.part_index ?? params?.partIndex;
      if (partIndex !== undefined && (!Number.isSafeInteger(Number(partIndex)) || Number(partIndex) < 0)) {
        throw rpcFailure("IMSG_INVALID_INPUT", "part_index must be a non-negative integer.");
      }
      rpcParams = { ...target, message_guid: messageGuid, ...(partIndex !== undefined ? { part_index: Number(partIndex) } : {}) };
    } catch (error) {
      return unsupported(error.code || "invalid-input");
    }
    return this._classifiedRpcSend("message.unsend", rpcParams, { feature: "unsend" });
  }

  async subscribeWatch(params = {}, handlers = {}) {
    const capabilities = await this.status();
    if (!this._methodSupported(capabilities, "watch.subscribe", "watch")) throw rpcFailure("IMSG_UNSUPPORTED", "imsg watch RPC is unavailable.");
    const result = await this.request("watch.subscribe", params);
    const subscription = Number(result?.subscription);
    if (!Number.isSafeInteger(subscription) || subscription <= 0) throw rpcFailure("IMSG_MALFORMED_RPC", "imsg returned an invalid subscription.", { attempted: true });
    this.watchers.set(subscription, {
      onMessage: typeof handlers === "function" ? handlers : handlers.onMessage || (() => {}),
      onError: typeof handlers === "function" ? null : handlers.onError,
    });
    return { subscription, unsubscribe: () => this.unsubscribeWatch(subscription) };
  }

  watch(params, handlers) {
    return this.subscribeWatch(params, handlers);
  }

  async unsubscribeWatch(subscription) {
    const watcher = this.watchers.get(subscription);
    if (!watcher) return false;
    this.watchers.delete(subscription);
    try {
      await this.request("watch.unsubscribe", { subscription });
      return true;
    } catch {
      return false;
    }
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async _stopChild() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    this.rpcReady = false;
    try { child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      child.once?.("close", finish);
      const timer = setTimeout(() => {
        try { child.kill?.("SIGTERM"); } catch {}
        finish();
      }, this.stopTimeoutMs);
      timer.unref?.();
      if (child.exitCode !== null) finish();
    });
    this.stopping = false;
  }

  async stop() {
    const subscriptions = [...this.watchers.keys()];
    if (this.child && this.rpcReady) {
      await Promise.allSettled(subscriptions.map((subscription) => this._request("watch.unsubscribe", { subscription }, { timeoutMs: Math.min(this.rpcTimeoutMs, this.stopTimeoutMs), sendOperation: false })));
    }
    this.watchers.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(rpcFailure("IMSG_RPC_STOPPED", "imsg RPC was stopped.", { attempted: true }));
    }
    this.pending.clear();
    await this._stopChild();
  }
}

export const imsgResult = Object.freeze({ accepted, ambiguous, unsupported });
