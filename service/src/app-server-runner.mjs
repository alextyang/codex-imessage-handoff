import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 15_000;
const MAX_PROTOCOL_BUFFER = 8 * 1024 * 1024;
const UNCERTAIN_TURN_OUTCOME_CODES = new Set([
  "CODEX_DISCONNECTED",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_TIMEOUT",
  "CODEX_UNAVAILABLE",
]);

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
  const diagnostic = String(error?.message || "");
  if (Number(error?.code) === -32001 && /overload|retry later/i.test(diagnostic)) {
    return codedError("BUSY", "The shared Codex service is busy; retry later.");
  }
  if (/already.*(running|locked)|session.*lock|thread.*busy/i.test(diagnostic)) {
    return codedError("BUSY", "Thread is busy.");
  }
  if (/not logged in|authentication|unauthorized|status\s*401/i.test(diagnostic)) {
    return codedError("AUTH_REQUIRED", "Codex authentication is required.");
  }
  if (/thread.*(not found|unknown)|rollout.*not found/i.test(diagnostic)) {
    return codedError("THREAD_NOT_FOUND", "The Codex thread could not be found.");
  }
  return codedError(fallbackCode, "Codex could not complete the request.");
}

function serverRequestResult(method) {
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

export class AppServerRpcClient {
  constructor(options = {}) {
    this.codexPath = options.codexPath || process.env.CODEX_BIN || "codex";
    this.codexHome = options.codexHome || process.env.CODEX_HOME || null;
    this.expectedCodexHome = path.resolve(this.codexHome || path.join(os.homedir(), ".codex"));
    this.socketPath = options.socketPath
      || process.env.CODEX_APP_SERVER_SOCKET
      || `${this.codexHome || `${process.env.HOME}/.codex`}/app-server-control/app-server-control.sock`;
    // A custom process transport remains available for deterministic protocol
    // tests. Production connects to the daemon's websocket-over-Unix socket.
    this.spawnImpl = options.spawnImpl || null;
    this.webSocketFactory = options.webSocketFactory || ((url, webSocketOptions) => new WebSocket(url, webSocketOptions));
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    this.interruptGraceMs = options.interruptGraceMs || DEFAULT_INTERRUPT_GRACE_MS;
    this.child = null;
    this.socket = null;
    this.ready = false;
    this.connecting = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.protocolBuffer = "";
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
    this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex app-server connection was replaced."), false);
    if (this.spawnImpl) await this.#connectProxyProcess();
    else await this.#connectWebSocket();

    try {
      const initialized = await this.#requestWithoutConnect("initialize", {
        clientInfo: { name: "imessage-handoff", title: "iMessage Handoff", version: "1" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
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
      const unavailable = error?.code === "CODEX_UNAVAILABLE" || error?.code === "CODEX_WRONG_HOME"
        ? error
        : codedError("CODEX_UNAVAILABLE", "The managed Codex app-server is unavailable.", error);
      const child = this.child;
      const socket = this.socket;
      this.#disconnect(unavailable);
      if (child?.exitCode === null) child.kill("SIGTERM");
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate?.();
      throw unavailable;
    }
  }

  async #connectProxyProcess() {
    const args = ["app-server", "proxy"];
    if (this.socketPath) args.push("--sock", this.socketPath);
    let child;
    try {
      child = this.spawnImpl(this.codexPath, args, {
        env: { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw codedError("CODEX_UNAVAILABLE", "Codex could not be started.", error);
    }
    this.child = child;
    this.ready = false;
    this.protocolBuffer = "";
    child.stdout.on("data", (chunk) => this.#receive(chunk));
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex app-server connection closed.", error)));
    child.once("error", (error) => this.#disconnect(codedError("CODEX_UNAVAILABLE", "Codex could not be started.", error)));
    child.once("close", () => this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex app-server connection closed.")));
  }

  async #connectWebSocket() {
    let socket;
    try {
      socket = this.webSocketFactory("ws://localhost/rpc", {
        createConnection: (_options, callback) => net.createConnection(this.socketPath, callback),
        perMessageDeflate: false,
      });
    } catch (error) {
      throw codedError("CODEX_UNAVAILABLE", "The managed Codex app-server is unavailable.", error);
    }
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let opened = false;
      const failBeforeOpen = (error) => {
        if (opened) return false;
        clearTimeout(timer);
        this.socket = null;
        socket.terminate?.();
        reject(error);
        return true;
      };
      const timer = setTimeout(() => {
        failBeforeOpen(codedError("CODEX_TIMEOUT", "The managed Codex app-server did not connect in time."));
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
        if (failBeforeOpen(codedError("CODEX_UNAVAILABLE", "The managed Codex app-server is unavailable.", error))) return;
        this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex app-server connection closed.", error));
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        if (failBeforeOpen(codedError("CODEX_UNAVAILABLE", "The managed Codex app-server is unavailable."))) return;
        this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex app-server connection closed."));
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
        reject(codedError("CODEX_TIMEOUT", "The Codex app-server did not respond in time."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { resolve, reject, timer });
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
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw codedError("CODEX_DISCONNECTED", "The Codex app-server connection is not available.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(chunk) {
    this.protocolBuffer += String(chunk);
    if (this.protocolBuffer.length > MAX_PROTOCOL_BUFFER && !this.protocolBuffer.includes("\n")) {
      const child = this.child;
      this.#disconnect(codedError("CODEX_PROTOCOL_ERROR", "The Codex app-server sent an invalid response."));
      if (child?.exitCode === null) child.kill("SIGTERM");
      return;
    }
    for (;;) {
      const newline = this.protocolBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.protocolBuffer.slice(0, newline).replace(/\r$/, "");
      this.protocolBuffer = this.protocolBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handleMessage(message);
    }
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
    return this.socket?.readyState === WebSocket.OPEN
      || this.socket?.readyState === 1
      || this.child?.exitCode === null;
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
      this.#handleServerRequest(message);
      return;
    }
    if (message?.method) this.#handleNotification(message);
  }

  #handleServerRequest(message) {
    const result = serverRequestResult(message.method);
    try {
      if (result !== null) this.#send({ id: message.id, result });
      else this.#send({
        id: message.id,
        error: { code: -32001, message: "This request requires interaction in the Codex app." },
      });
    } catch {
      // A connection failure will reject the active turn and pending requests.
    }
  }

  #handleNotification(message) {
    const active = this.activeTurn;
    if (!active) return;
    const params = message.params || {};
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
    if (message.method === "error" && params.willRetry === false) {
      this.#failTurn(active, errorFromResponse(params.error));
    }
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
    this.activeTurn = null;
    if (active.turnStartSubmitted && UNCERTAIN_TURN_OUTCOME_CODES.has(error?.code)) {
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
    const child = this.child;
    const socket = this.socket;
    this.#disconnect(codedError("CODEX_DISCONNECTED", "The Codex app-server connection closed."));
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== 3) {
      try { socket.close(); } catch { socket.terminate?.(); }
    }
  }

  #disconnect(error, rejectActive = true) {
    this.ready = false;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    if (rejectActive && this.activeTurn) this.#failTurn(this.activeTurn, error);
    this.child = null;
    this.socket = null;
    this.protocolBuffer = "";
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
        turnTimeoutMs,
      });
    } finally {
      if (this.ownsClient) this.client.close();
    }
  }
}
