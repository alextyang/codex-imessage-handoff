import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Detail/history reads are intentionally wider than catalog state reads. A
// tool-heavy turn can put megabytes between the user request and final answer;
// keep enough tail to reconstruct the whole visible turn without ever parsing
// tool/reasoning records into the outbound presentation.
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINES = 100_000;
const STATE_MAX_BYTES = 256 * 1024;
const STATE_MAX_LINES = 4_000;

const stateCache = new Map();

function rolloutPath(threadOrPath) {
  if (typeof threadOrPath === "string") return threadOrPath;
  if (threadOrPath && typeof threadOrPath.rolloutPath === "string") return threadOrPath.rolloutPath;
  if (threadOrPath && typeof threadOrPath.rollout_path === "string") return threadOrPath.rollout_path;
  return "";
}

function finiteLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(maximum, Math.floor(number));
}

function dateMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFrom(value, fallback) {
  const ms = dateMs(value) ?? dateMs(fallback);
  return ms === null ? null : new Date(ms).toISOString();
}

function messageText(content, expectedType) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === expectedType && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function turnIdFromMessage(payload) {
  const metadata = payload?.internal_chat_message_metadata_passthrough;
  return metadata && typeof metadata === "object" && typeof metadata.turn_id === "string"
    ? metadata.turn_id
    : null;
}

function readTailRecords(filePath, options = {}) {
  const maxBytes = finiteLimit(options.maxBytes, DEFAULT_MAX_BYTES, 64 * 1024 * 1024);
  const maxLines = finiteLimit(options.maxLines, DEFAULT_MAX_LINES, 100_000);
  let descriptor;
  try {
    descriptor = openSync(filePath, "r");
    const stat = fstatSync(descriptor);
    const requestedEnd = Number(options.endOffset);
    const endOffset = Number.isSafeInteger(requestedEnd) && requestedEnd >= 0
      ? Math.min(stat.size, requestedEnd)
      : stat.size;
    const desiredStart = Math.max(0, endOffset - maxBytes);
    const actualStart = desiredStart > 0 ? desiredStart - 1 : 0;
    const length = endOffset - actualStart;
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(descriptor, buffer, offset, length - offset, actualStart + offset);
      if (read <= 0) break;
      offset += read;
    }
    let bytes = buffer.subarray(0, offset);
    let truncated = desiredStart > 0;
    if (desiredStart > 0) {
      const startsAtBoundary = bytes[0] === 0x0a;
      bytes = bytes.subarray(1);
      if (!startsAtBoundary) {
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) {
          return { records: [], truncated: true, malformedTail: false, malformedLines: 0, stat };
        }
        bytes = bytes.subarray(newline + 1);
      }
    }

    let lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines);
      truncated = true;
    }

    const records = [];
    let malformedLines = 0;
    let malformedTail = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object") records.push(value);
      } catch {
        malformedLines += 1;
        if (index === lines.length - 1) malformedTail = true;
      }
    }
    return { records, truncated, malformedTail, malformedLines, stat };
  } catch (error) {
    return {
      records: [],
      truncated: false,
      malformedTail: false,
      malformedLines: 0,
      stat: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function newTurn(id, sequence) {
  return {
    id,
    state: "running",
    clientUserMessageId: null,
    request: "",
    assistantMessages: [],
    commentary: [],
    finalResponse: null,
    lastMessage: null,
    startedAt: null,
    completedAt: null,
    activityAt: null,
    _firstSequence: sequence,
    _startSequence: null,
    _terminalSequence: null,
    _requestSequence: -1,
    _requestSource: null,
    _inherited: false,
    _rolledBack: false,
  };
}

function publicTurn(turn) {
  if (!turn) return null;
  return {
    id: turn.id,
    state: turn.state,
    clientUserMessageId: turn.clientUserMessageId,
    request: turn.request,
    assistantMessages: turn.assistantMessages.map(({ text, phase, timestamp }) => ({ text, phase, timestamp })),
    commentary: [...turn.commentary],
    finalResponse: turn.finalResponse,
    lastMessage: turn.lastMessage,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    activityAt: turn.activityAt,
  };
}

function parseTurns(records, metadata = {}) {
  const turns = new Map();
  const ordered = [];
  let activeTurnId = null;
  let latestActivityAt = null;
  let latestBoundary = null;

  function ensureTurn(id, sequence) {
    if (!id) return null;
    let turn = turns.get(id);
    if (!turn) {
      turn = newTurn(id, sequence);
      turns.set(id, turn);
      ordered.push(turn);
    }
    return turn;
  }

  function assignRequest(turn, text, sequence, source) {
    if (!turn || typeof text !== "string") return;
    if (turn._inherited && text && text !== turn.request) {
      turn.assistantMessages = [];
      turn.commentary = [];
      turn.finalResponse = null;
      turn.lastMessage = null;
    }
    if (text) turn._inherited = false;
    const sourcePriority = source === "user_message" ? 2 : 1;
    const existingPriority = turn._requestSource === "user_message" ? 2 : turn._requestSource ? 1 : 0;
    if (sequence > turn._requestSequence || (sequence === turn._requestSequence && sourcePriority >= existingPriority)) {
      turn.request = text;
      turn._requestSequence = sequence;
      turn._requestSource = source;
    }
  }

  function assignAssistant(turn, text, phase, timestamp, source) {
    if (!turn || typeof text !== "string" || !text) return;
    const duplicate = turn.assistantMessages.find((message) => message.text === text);
    if (duplicate) {
      if (source === "response_item") {
        duplicate.phase = phase;
        duplicate.timestamp = timestamp || duplicate.timestamp;
        duplicate._source = source;
      }
    } else {
      turn.assistantMessages.push({ text, phase, timestamp, _source: source });
    }
    if (phase === "commentary" && !turn.commentary.includes(text)) turn.commentary.push(text);
    if (phase === "final_answer") turn.finalResponse = text;
    turn.lastMessage = text;
    turn.activityAt = timestamp || turn.activityAt;
  }

  for (let sequence = 0; sequence < records.length; sequence += 1) {
    const record = records[sequence];
    const payload = record?.payload;
    const recordAt = isoFrom(record?.timestamp);
    if (recordAt) latestActivityAt = recordAt;

    if (record?.type === "event_msg" && payload?.type === "task_started") {
      const previous = activeTurnId ? turns.get(activeTurnId) : null;
      const turn = ensureTurn(typeof payload.turn_id === "string" ? payload.turn_id : null, sequence);
      if (!turn) continue;
      if (previous && previous !== turn && previous.state === "running" && !turn.request) {
        turn.request = previous.request;
        turn.clientUserMessageId = previous.clientUserMessageId;
        turn.assistantMessages = previous.assistantMessages.map((message) => ({ ...message }));
        turn.commentary = [...previous.commentary];
        turn.finalResponse = previous.finalResponse;
        turn.lastMessage = previous.lastMessage;
        turn._inherited = true;
      }
      turn.state = "running";
      turn.startedAt = isoFrom(payload.started_at, record.timestamp);
      turn.activityAt = turn.startedAt || recordAt;
      turn._startSequence = sequence;
      activeTurnId = turn.id;
      latestBoundary = { type: "started", sequence, turnId: turn.id };
      continue;
    }

    if (record?.type === "response_item" && payload?.type === "message") {
      const id = turnIdFromMessage(payload) || activeTurnId;
      const turn = ensureTurn(id, sequence);
      if (!turn) continue;
      if (payload.role === "user") {
        assignRequest(turn, messageText(payload.content, "input_text"), sequence, "response_item");
        turn.activityAt = recordAt || turn.activityAt;
      } else if (payload.role === "assistant") {
        const text = messageText(payload.content, "output_text");
        if (!text) continue;
        const phase = typeof payload.phase === "string" ? payload.phase : "message";
        assignAssistant(turn, text, phase, recordAt, "response_item");
      }
      continue;
    }

    if (record?.type === "event_msg" && payload?.type === "agent_message") {
      const turn = ensureTurn(activeTurnId, sequence);
      if (turn && typeof payload.message === "string") {
        const phase = typeof payload.phase === "string" ? payload.phase : "message";
        assignAssistant(turn, payload.message, phase, recordAt, "event_msg");
      }
      continue;
    }

    if (record?.type === "event_msg" && payload?.type === "user_message") {
      const turn = ensureTurn(activeTurnId, sequence);
      if (turn && typeof payload.message === "string") {
        assignRequest(turn, payload.message, sequence, "user_message");
        if (typeof payload.client_id === "string" && payload.client_id) {
          turn.clientUserMessageId = payload.client_id;
        }
        turn.activityAt = recordAt || turn.activityAt;
      }
      continue;
    }

    if (record?.type === "event_msg" && payload?.type === "task_complete") {
      const turn = ensureTurn(typeof payload.turn_id === "string" ? payload.turn_id : activeTurnId, sequence);
      if (!turn) continue;
      turn.state = "completed";
      turn.completedAt = isoFrom(payload.completed_at, record.timestamp);
      turn.activityAt = turn.completedAt || recordAt || turn.activityAt;
      if (typeof payload.last_agent_message === "string") {
        turn.finalResponse = payload.last_agent_message;
        turn.lastMessage = payload.last_agent_message;
      }
      turn._terminalSequence = sequence;
      if (activeTurnId === turn.id) activeTurnId = null;
      latestBoundary = { type: "completed", sequence, turnId: turn.id };
      continue;
    }

    if (record?.type === "event_msg" && payload?.type === "turn_aborted") {
      const turn = ensureTurn(typeof payload.turn_id === "string" ? payload.turn_id : activeTurnId, sequence);
      if (!turn) continue;
      turn.state = "aborted";
      turn.completedAt = isoFrom(payload.completed_at, record.timestamp);
      turn.activityAt = turn.completedAt || recordAt || turn.activityAt;
      turn._terminalSequence = sequence;
      if (activeTurnId === turn.id) activeTurnId = null;
      latestBoundary = { type: "aborted", sequence, turnId: turn.id };
      continue;
    }

    if (record?.type === "event_msg" && payload?.type === "thread_rolled_back") {
      const count = Math.max(0, Math.floor(Number(payload.num_turns) || 0));
      const candidates = ordered
        .filter((turn) => turn._terminalSequence !== null && turn._terminalSequence < sequence && !turn._rolledBack)
        .sort((left, right) => right._terminalSequence - left._terminalSequence)
        .slice(0, count);
      for (const turn of candidates) turn._rolledBack = true;
      activeTurnId = null;
      latestBoundary = { type: "rolled_back", sequence, turnId: null };
    }
  }

  const visibleTurns = ordered.filter((turn) => !turn._rolledBack);
  const runningTurns = visibleTurns
    .filter((turn) => turn.state === "running")
    .sort((left, right) => (right._startSequence ?? right._firstSequence) - (left._startSequence ?? left._firstSequence));
  const terminalTurns = visibleTurns
    .filter((turn) => turn.state === "completed" || turn.state === "aborted")
    .sort((left, right) => (right._terminalSequence ?? right._firstSequence) - (left._terminalSequence ?? left._firstSequence));
  const completedTurns = terminalTurns.filter((turn) => turn.state === "completed");

  let currentTurn = null;
  let state = "unknown";
  if (latestBoundary?.type === "started") {
    currentTurn = turns.get(latestBoundary.turnId) || runningTurns[0] || null;
    state = "running";
  } else if (latestBoundary?.type === "completed") {
    state = "idle";
  } else if (latestBoundary?.type === "aborted") {
    state = "aborted";
  } else if (latestBoundary?.type === "rolled_back") {
    state = "idle";
  } else if (runningTurns.length > 0) {
    currentTurn = runningTurns[0];
    state = "running";
  } else if (terminalTurns[0]?.state === "completed") {
    state = "idle";
  } else if (terminalTurns[0]?.state === "aborted") {
    state = "aborted";
  }

  const latestTerminalTurn = terminalTurns[0] || null;
  const latestTurn = currentTurn || latestTerminalTurn;
  const lastTurnAt = latestTurn?.activityAt || latestTurn?.completedAt || latestTurn?.startedAt || null;
  const activityAt = currentTurn?.activityAt || latestTerminalTurn?.activityAt || latestActivityAt;
  return {
    state,
    activityAt,
    activityAtMs: dateMs(activityAt),
    hasTurn: Boolean(latestTurn),
    lastTurnAt,
    lastTurnAtMs: dateMs(lastTurnAt),
    currentTurn: publicTurn(currentTurn),
    latestTurn: publicTurn(latestTurn),
    latestCompletedTurn: publicTurn(completedTurns[0] || null),
    completedTurns: completedTurns.map(publicTurn),
    turns: visibleTurns.map(publicTurn),
    // A bounded read can omit older turns. Keep the observed count useful,
    // while making it explicit when callers must render it as a lower bound.
    turnCount: visibleTurns.length,
    turnCountLowerBound: Boolean(metadata.truncated),
    truncated: Boolean(metadata.truncated),
    malformedTail: Boolean(metadata.malformedTail),
    malformedLines: Number(metadata.malformedLines) || 0,
    error: metadata.error || null,
  };
}

export function readThreadHistory(threadOrPath, options = {}) {
  const filePath = rolloutPath(threadOrPath);
  if (!filePath) {
    return parseTurns([], { error: "Thread rollout path is unavailable." });
  }
  const tail = readTailRecords(filePath, options);
  return parseTurns(tail.records, tail);
}

export function getThreadState(threadOrPath) {
  const filePath = rolloutPath(threadOrPath);
  if (!filePath) return { state: "unknown", activityAt: null, activityAtMs: null, hasTurn: false, lastTurnAt: null, lastTurnAtMs: null, stateSince: null, currentTurnId: null, truncated: false, malformedTail: false };
  let tail = readTailRecords(filePath, { maxBytes: STATE_MAX_BYTES, maxLines: STATE_MAX_LINES });
  const cacheKey = tail.stat ? `${filePath}:${tail.stat.ino}:${tail.stat.size}:${tail.stat.mtimeMs}` : null;
  if (cacheKey && stateCache.has(cacheKey)) return stateCache.get(cacheKey);
  let parsed = parseTurns(tail.records, tail);
  for (const maxBytes of [1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
    if (parsed.state !== "unknown" || !tail.truncated) break;
    tail = readTailRecords(filePath, { maxBytes, maxLines: 100_000 });
    parsed = parseTurns(tail.records, tail);
  }
  const state = {
    state: parsed.state,
    activityAt: parsed.activityAt,
    activityAtMs: parsed.activityAtMs,
    hasTurn: parsed.hasTurn,
    lastTurnAt: parsed.lastTurnAt,
    lastTurnAtMs: parsed.lastTurnAtMs,
    stateSince: parsed.currentTurn?.startedAt || parsed.latestTurn?.completedAt || parsed.activityAt,
    currentTurnId: parsed.currentTurn?.id || null,
    truncated: parsed.truncated,
    malformedTail: parsed.malformedTail,
  };
  if (cacheKey) {
    for (const key of stateCache.keys()) {
      if (key.startsWith(`${filePath}:`)) stateCache.delete(key);
    }
    if (stateCache.size >= 512) stateCache.clear();
    stateCache.set(cacheKey, state);
  }
  return state;
}

export function captureThreadRunCheckpoint(threadOrPath, capturedAt = new Date().toISOString()) {
  const history = readThreadHistory(threadOrPath);
  const latest = history.currentTurn || history.latestTurn;
  return {
    turnId: latest?.id || null,
    activityAt: latest?.activityAt || latest?.completedAt || latest?.startedAt || null,
    capturedAt: isoFrom(capturedAt) || new Date().toISOString(),
  };
}

/**
 * Permit same-task predecessors already durably owned by this service, but
 * refuse to submit a queued prompt after any unrelated Codex turn advanced
 * the task. This prevents delayed iMessage work from inverting conversation
 * order after the user continues the task locally.
 */
export function assertClaimedThreadUnchanged(threadOrPath, event = {}) {
  const history = readThreadHistory(threadOrPath);
  const turns = Array.isArray(history.turns) ? history.turns : [];
  const checkpoint = event.threadCheckpoint && typeof event.threadCheckpoint === "object"
    ? event.threadCheckpoint
    : null;
  let candidates;
  if (checkpoint) {
    const baselineTurnId = typeof checkpoint.turnId === "string" ? checkpoint.turnId : null;
    if (baselineTurnId) {
      const index = turns.findIndex((turn) => turn.id === baselineTurnId);
      if (index < 0) {
        throw Object.assign(new Error("The claimed task checkpoint is no longer observable."), {
          code: "STALE_THREAD_CHECKPOINT",
        });
      }
      candidates = turns.slice(index + 1);
    } else {
      // No visible turn at admission means every turn now present is newer.
      candidates = turns;
    }
  } else {
    // Backward-compatible protection for jobs admitted before checkpoints
    // existed. The durable queue time is the only safe baseline available.
    const queuedAtMs = dateMs(event.queuedAt);
    if (!Number.isFinite(queuedAtMs)) {
      throw Object.assign(new Error("The claimed task checkpoint is unavailable."), {
        code: "STALE_THREAD_CHECKPOINT",
      });
    }
    candidates = turns.filter((turn) => {
      const startedAtMs = dateMs(turn.startedAt);
      return Number.isFinite(startedAtMs) && startedAtMs >= queuedAtMs - 1_000;
    });
  }

  const ownClientId = typeof event.clientUserMessageId === "string" ? event.clientUserMessageId : null;
  const permitted = new Set(Array.isArray(event.predecessorClientUserMessageIds)
    ? event.predecessorClientUserMessageIds.filter((value) => typeof value === "string")
    : []);
  const foreign = candidates.find((turn) => (
    !turn.clientUserMessageId
    || (turn.clientUserMessageId !== ownClientId && !permitted.has(turn.clientUserMessageId))
  ));
  if (foreign) {
    throw Object.assign(new Error("The task changed after this iMessage prompt was claimed."), {
      code: "STALE_THREAD_ADVANCED",
      currentTurnId: foreign.id || null,
    });
  }
  return history;
}

/**
 * Refuse to start an iMessage-owned turn when the rollout already contains a
 * live turn. RunManager serializes turns started by this daemon, so a running
 * boundary observed at this preflight belongs to Codex outside the pending
 * service run (normally the local app).
 *
 * This is deliberately an optimistic filesystem preflight, not a lock. Codex's
 * app-server's own session lock remains the authority if another turn starts
 * after this read and before the service opens the shared thread.
 */
export function assertThreadReadyForIMessageRun(threadOrPath) {
  const state = getThreadState(threadOrPath);
  if (state.state !== "running") return state;
  throw Object.assign(new Error("Thread is already running outside this iMessage request."), {
    code: "BUSY",
    currentTurnId: state.currentTurnId,
  });
}

export function getTurn(threadOrPath) {
  const history = readThreadHistory(threadOrPath);
  return history.currentTurn || history.latestTurn;
}

export function getLatestRequest(threadOrPath) {
  return getTurn(threadOrPath)?.request || "";
}

export function getHistory(threadOrPath, limit = 5) {
  const safeLimit = finiteLimit(limit, 5, 50);
  return readThreadHistory(threadOrPath).completedTurns.slice(0, safeLimit);
}

function preview(text, limit) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!limit || normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function getThreadDetail(thread, options = {}) {
  const history = readThreadHistory(thread, options);
  const turn = history.currentTurn || history.latestTurn;
  const state = options.stateOverride || history.state;
  const request = turn?.request || "";
  const historyLimit = finiteLimit(options.historyLimit, 5, 50);
  const userPreviewLimit = finiteLimit(options.userPreviewLimit, 240, 4_000);
  return {
    thread,
    state,
    observedState: history.state,
    reasoningEffort: options.reasoningEffort ?? thread?.reasoningEffort ?? null,
    activityAt: history.activityAt,
    activityAtMs: history.activityAtMs,
    turn,
    currentTurn: history.currentTurn,
    latestCompletedTurn: history.latestCompletedTurn,
    request,
    fullRequest: request,
    requestPreview: preview(request, userPreviewLimit),
    assistantMessages: turn?.assistantMessages || [],
    commentary: turn?.commentary || [],
    finalResponse: turn?.finalResponse ?? null,
    lastMessage: turn?.lastMessage ?? null,
    history: history.completedTurns.slice(0, historyLimit),
    turnCount: history.turnCount,
    turnCountLowerBound: history.turnCountLowerBound,
    truncated: history.truncated,
    malformedTail: history.malformedTail,
  };
}
