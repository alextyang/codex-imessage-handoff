import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const STATE_VERSION = 1;
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const BASELINE_SCAN_BYTES = 16 * 1024 * 1024;
const BASELINE_LINE_BYTES = 1024 * 1024;
const REVERSE_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_SUPPRESSIONS = 64;
const TERMINAL_STATUSES = new Set([
  "SENT",
  "DUPLICATE",
  "INACTIVE",
  "STALE_SELECTION",
  "NO_BINDING",
]);

function emptyState() {
  return { version: STATE_VERSION, active: null, updatedAt: null };
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedBody(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function bodyDigest(value) {
  return digest(normalizedBody(value));
}

function identity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameIdentity(active, stat) {
  const current = identity(stat);
  return active?.device === current.device && active?.inode === current.inode;
}

function selectionId() {
  return randomBytes(16).toString("hex");
}

function suppressionToken() {
  return randomBytes(16).toString("hex");
}

function finiteByteLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_MAX_READ_BYTES;
  return Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(number)));
}

function threadDetails(thread) {
  if (!thread || typeof thread !== "object") return null;
  const threadId = String(thread.id ?? thread.threadId ?? "").trim();
  const rawPath = String(thread.rolloutPath ?? thread.rollout_path ?? "").trim();
  if (!threadId || !rawPath) return null;
  return { threadId, filePath: path.resolve(rawPath) };
}

function normalizeActive(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const threadId = String(value.threadId ?? "").trim();
  const filePath = String(value.path ?? "").trim();
  const offset = Number(value.offset);
  if (!threadId || !filePath || !Number.isSafeInteger(offset) || offset < 0) return null;
  const suppressions = Array.isArray(value.suppressions)
    ? value.suppressions.flatMap((item, index) => {
      if (typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) {
        return [{ token: digest(`legacy-suppression\0${index}\0${item}`).slice(0, 32), bodyHash: item }];
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const token = typeof item.token === "string" ? item.token.trim() : "";
      const hash = typeof item.bodyHash === "string" ? item.bodyHash : "";
      return token && token.length <= 128 && /^[a-f0-9]{64}$/.test(hash)
        ? [{ token, bodyHash: hash }]
        : [];
    }).slice(-MAX_SUPPRESSIONS)
    : [];
  const pendingValue = value.pendingGroup;
  const pendingGroup = pendingValue
    && typeof pendingValue === "object"
    && !Array.isArray(pendingValue)
    && Number.isSafeInteger(pendingValue.startOffset)
    && pendingValue.startOffset === offset
    && Number.isSafeInteger(pendingValue.endOffset)
    && pendingValue.endOffset > pendingValue.startOffset
    && typeof pendingValue.bodyHash === "string"
    && /^[a-f0-9]{64}$/.test(pendingValue.bodyHash)
    && typeof pendingValue.deliveryId === "string"
    && /^[a-f0-9]{64}$/.test(pendingValue.deliveryId)
    ? {
      startOffset: pendingValue.startOffset,
      endOffset: pendingValue.endOffset,
      bodyHash: pendingValue.bodyHash,
      deliveryId: pendingValue.deliveryId,
    }
    : null;
  return {
    threadId,
    path: path.resolve(filePath),
    device: typeof value.device === "string" ? value.device : null,
    inode: typeof value.inode === "string" ? value.inode : null,
    offset,
    turnId: typeof value.turnId === "string" && value.turnId ? value.turnId : null,
    selectionId: typeof value.selectionId === "string" && value.selectionId
      ? value.selectionId
      : selectionId(),
    suppressions,
    discardingOversize: value.discardingOversize === true,
    pendingGroup,
  };
}

function quarantine(stateFile) {
  try {
    const quarantined = `${stateFile}.invalid-${Date.now()}`;
    renameSync(stateFile, quarantined);
    chmodSync(quarantined, 0o600);
  } catch {}
}

function readState(stateFile) {
  if (!existsSync(stateFile)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    quarantine(stateFile);
    return emptyState();
  }
  if (!parsed || parsed.version !== STATE_VERSION) {
    quarantine(stateFile);
    return emptyState();
  }
  try { chmodSync(stateFile, 0o600); } catch {}
  return {
    version: STATE_VERSION,
    active: normalizeActive(parsed.active),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
  };
}

function writePrivateState(stateFile, state) {
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, stateFile);
  chmodSync(stateFile, 0o600);
}

function openFile(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      closeSync(descriptor);
      return null;
    }
    return { descriptor, stat };
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    return null;
  }
}

function readBytes(descriptor, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, bytes, read, length - read, position + read);
    if (count <= 0) break;
    read += count;
  }
  return bytes.subarray(0, read);
}

// Return the byte immediately after the last complete JSONL record. A partial
// tail is deliberately left unread so it can finish after activation.
function completeFileOffset(descriptor, size) {
  if (size <= 0) return 0;
  let end = size;
  while (end > 0) {
    const length = Math.min(64 * 1024, end);
    const start = end - length;
    const bytes = readBytes(descriptor, start, length);
    const newline = bytes.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

function previousLine(descriptor, end, budget) {
  if (end <= 0 || budget <= 0) return { line: null, previousEnd: 0, read: 0, exhausted: true };
  let read = 0;
  let cursor = end;
  const trailing = readBytes(descriptor, cursor - 1, 1);
  read += trailing.length;
  if (trailing[0] === 0x0a) cursor -= 1;
  const pieces = [];
  let lineBytes = 0;
  let oversized = false;

  while (cursor > 0 && read < budget) {
    const length = Math.min(REVERSE_SCAN_CHUNK_BYTES, cursor, budget - read);
    if (length <= 0) break;
    const start = cursor - length;
    const bytes = readBytes(descriptor, start, length);
    read += bytes.length;
    const newline = bytes.lastIndexOf(0x0a);
    const part = bytes.subarray(newline + 1);
    if (!oversized) {
      if (lineBytes + part.length <= BASELINE_LINE_BYTES) {
        pieces.unshift(Buffer.from(part));
        lineBytes += part.length;
      } else {
        pieces.length = 0;
        oversized = true;
      }
    }
    if (newline >= 0) {
      return {
        line: oversized ? null : Buffer.concat(pieces).toString("utf8").replace(/\r$/, ""),
        previousEnd: start + newline + 1,
        read,
        exhausted: false,
      };
    }
    cursor = start;
  }

  if (cursor === 0) {
    return {
      line: oversized ? null : Buffer.concat(pieces).toString("utf8").replace(/\r$/, ""),
      previousEnd: 0,
      read,
      exhausted: false,
    };
  }
  return { line: null, previousEnd: 0, read, exhausted: true };
}

// Baseline history is never emitted, but retaining its latest open turn id
// keeps subsequent commentary correctly attributed when selection happens
// midway through a turn. Scan backward, with fixed byte/line bounds, until the
// newest task boundary is found.
function activeTurnAtBaseline(descriptor, offset) {
  let end = offset;
  let remaining = BASELINE_SCAN_BYTES;
  while (end > 0 && remaining > 0) {
    const previous = previousLine(descriptor, end, remaining);
    remaining -= previous.read;
    if (previous.exhausted) return null;
    end = previous.previousEnd;
    const line = previous.line;
    if (!line || (!line.includes("task_started")
      && !line.includes("task_complete")
      && !line.includes("turn_aborted")
      && !line.includes("thread_rolled_back"))) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const type = record?.payload?.type;
    if (type === "task_started") {
      return typeof record.payload.turn_id === "string" && record.payload.turn_id
        ? record.payload.turn_id
        : null;
    }
    if (type === "task_complete" || type === "turn_aborted" || type === "thread_rolled_back") return null;
  }
  return null;
}

function messageText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function canonicalMessage(record) {
  const payload = record?.payload;
  if (record?.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
    return normalizedBody(payload.message)
      ? { role: "user", phase: "user_message", body: payload.message }
      : null;
  }
  if (record?.type === "response_item"
    && payload?.type === "message"
    && payload?.role === "assistant"
    && payload?.phase === "commentary") {
    const body = messageText(payload.content);
    return normalizedBody(body) ? { role: "assistant", phase: "commentary", body } : null;
  }
  return null;
}

function isMessageBoundary(record) {
  const payload = record?.payload;
  if (record?.type === "event_msg") {
    return payload?.type === "user_message"
      || payload?.type === "task_started"
      || payload?.type === "task_complete"
      || payload?.type === "turn_aborted"
      || payload?.type === "thread_rolled_back";
  }
  return record?.type === "response_item"
    && payload?.type === "message"
    && payload?.role === "assistant"
    && payload?.phase === "final_answer";
}

function parseRecord(lineBytes) {
  try {
    let line = lineBytes.toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function terminalDelivery(result) {
  if (result?.sent === true || result?.notification?.sent === true) {
    return { terminal: true, outcome: "SENT" };
  }
  const status = [result?.status, result?.notification?.status, result?.code, result?.notification?.code]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toUpperCase())
    .find((value) => TERMINAL_STATUSES.has(value));
  return status ? { terminal: true, outcome: status } : { terminal: false, outcome: null };
}

function summary(activeThreadId) {
  return {
    active: Boolean(activeThreadId),
    threadId: activeThreadId,
    baselined: 0,
    processed: 0,
    delivered: 0,
    suppressed: 0,
    discarded: 0,
    ignored: 0,
    retryable: 0,
    partial: false,
    more: false,
    reason: null,
  };
}

/**
 * Persistently tails the selected Codex rollout without replaying its history.
 * The state file contains cursor metadata and body hashes only; message bodies
 * exist solely in the short-lived delivery callback payload.
 */
export class LiveMirror {
  constructor(options) {
    const normalized = typeof options === "string" ? { stateFile: options } : options;
    const stateFile = String(normalized?.stateFile ?? "").trim();
    if (!stateFile) throw new TypeError("LiveMirror requires a stateFile.");
    this.stateFile = path.resolve(stateFile);
    this.maxReadBytes = finiteByteLimit(normalized?.maxReadBytes);
    this.state = readState(this.stateFile);
    this.selectionEpoch = 0;
    this.reconcileChain = Promise.resolve();
  }

  get activeThreadId() {
    return this.state.active?.threadId ?? null;
  }

  activate(thread, { resume = true } = {}) {
    const details = threadDetails(thread);
    if (!details) throw new TypeError("LiveMirror.activate requires a thread id and rollout path.");
    const current = this.state.active;
    const opened = openFile(details.filePath);
    try {
      const canResume = resume !== false
        && current?.threadId === details.threadId
        && current?.path === details.filePath
        && (!opened || (sameIdentity(current, opened.stat) && current.offset <= opened.stat.size));
      if (canResume) {
        return {
          threadId: current.threadId,
          selectionId: current.selectionId,
          resumed: true,
          baselined: false,
          available: Boolean(opened),
          offset: current.offset,
        };
      }

      const fileIdentity = opened ? identity(opened.stat) : { device: null, inode: null };
      const offset = opened ? completeFileOffset(opened.descriptor, opened.stat.size) : 0;
      this.state.active = {
        threadId: details.threadId,
        path: details.filePath,
        ...fileIdentity,
        offset,
        turnId: opened ? activeTurnAtBaseline(opened.descriptor, offset) : null,
        selectionId: selectionId(),
        suppressions: [],
        discardingOversize: false,
        pendingGroup: null,
      };
      this.selectionEpoch += 1;
      this.#save();
      return {
        threadId: details.threadId,
        selectionId: this.state.active.selectionId,
        resumed: false,
        baselined: Boolean(opened),
        available: Boolean(opened),
        offset,
      };
    } finally {
      if (opened) closeSync(opened.descriptor);
    }
  }

  suppressUser(threadId, body) {
    const id = String(threadId ?? "").trim();
    if (!id || id !== this.activeThreadId || typeof body !== "string" || !normalizedBody(body)) return null;
    const token = suppressionToken();
    this.state.active.suppressions.push({ token, bodyHash: bodyDigest(body) });
    this.state.active.suppressions = this.state.active.suppressions.slice(-MAX_SUPPRESSIONS);
    this.#save();
    return token;
  }

  clearSuppression(token) {
    const normalized = typeof token === "string" ? token.trim() : "";
    if (!normalized || !this.state.active) return false;
    const index = this.state.active.suppressions.findIndex((entry) => entry.token === normalized);
    if (index < 0) return false;
    this.state.active.suppressions.splice(index, 1);
    this.#save();
    return true;
  }

  deactivate() {
    if (!this.state.active) return false;
    this.state.active = null;
    this.selectionEpoch += 1;
    this.#save();
    return true;
  }

  reconcile(thread, options = {}) {
    const task = () => this.#reconcile(thread, options);
    const result = this.reconcileChain.then(task, task);
    this.reconcileChain = result.then(() => undefined, () => undefined);
    return result;
  }

  #save() {
    this.state.updatedAt = new Date().toISOString();
    writePrivateState(this.stateFile, this.state);
  }

  #baseline(details, opened) {
    const active = this.state.active;
    const fileIdentity = identity(opened.stat);
    active.path = details.filePath;
    active.device = fileIdentity.device;
    active.inode = fileIdentity.inode;
    active.offset = completeFileOffset(opened.descriptor, opened.stat.size);
    active.turnId = activeTurnAtBaseline(opened.descriptor, active.offset);
    active.selectionId = selectionId();
    active.suppressions = [];
    active.discardingOversize = false;
    active.pendingGroup = null;
    this.selectionEpoch += 1;
    this.#save();
  }

  async #reconcile(thread, { deliver } = {}) {
    if (typeof deliver !== "function") throw new TypeError("LiveMirror.reconcile requires deliver.");
    const details = threadDetails(thread);
    if (!details) throw new TypeError("LiveMirror.reconcile requires a thread id and rollout path.");
    const result = summary(this.activeThreadId);
    if (!this.state.active || details.threadId !== this.state.active.threadId) {
      result.active = false;
      result.reason = "STALE_SELECTION";
      return result;
    }

    const opened = openFile(details.filePath);
    if (!opened) {
      result.reason = "UNAVAILABLE";
      return result;
    }
    try {
      const active = this.state.active;
      if (active.path !== details.filePath || !sameIdentity(active, opened.stat) || active.offset > opened.stat.size) {
        this.#baseline(details, opened);
        result.baselined = 1;
        result.reason = "REBASELINED";
        return result;
      }
      if (active.offset >= opened.stat.size) return result;

      const epoch = this.selectionEpoch;
      const selectedId = active.selectionId;
      const startOffset = active.offset;
      const available = opened.stat.size - startOffset;
      const pendingBytes = active.pendingGroup?.startOffset === startOffset
        ? active.pendingGroup.endOffset - startOffset
        : 0;
      const readLimit = Math.min(MAX_READ_BYTES, Math.max(this.maxReadBytes, pendingBytes));
      const bytes = readBytes(opened.descriptor, startOffset, Math.min(readLimit, available));
      if (!bytes.length) return result;

      let index = 0;
      let dirty = false;
      if (active.discardingOversize) {
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) {
          active.offset += bytes.length;
          dirty = true;
          result.more = active.offset < opened.stat.size;
          result.partial = !result.more;
          this.#save();
          return result;
        }
        active.offset += newline + 1;
        active.discardingOversize = false;
        index = newline + 1;
        dirty = true;
        result.processed += 1;
        result.ignored += 1;
      }

      while (index < bytes.length) {
        const newline = bytes.indexOf(0x0a, index);
        if (newline < 0) break;
        const lineStart = active.offset;
        const lineBytes = bytes.subarray(index, newline);
        const nextOffset = lineStart + lineBytes.length + 1;
        index = newline + 1;
        result.processed += 1;

        const record = parseRecord(lineBytes);

        if (active.pendingGroup?.startOffset === lineStart
          && canonicalMessage(record)?.role !== "assistant") {
          // A retry must still begin with the commentary record whose hashed
          // bucket metadata was persisted. If the same inode was rewritten,
          // do not advance into or deliver the altered stream.
          this.#baseline(details, opened);
          result.baselined = 1;
          result.reason = "REBASELINED";
          return result;
        }

        if (!record || typeof record !== "object") {
          active.offset = nextOffset;
          result.ignored += 1;
          dirty = true;
          continue;
        }

        const payload = record.payload;
        if (record.type === "event_msg" && payload?.type === "task_started") {
          active.turnId = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : null;
          active.offset = nextOffset;
          result.ignored += 1;
          dirty = true;
          continue;
        }
        if (record.type === "event_msg"
          && (payload?.type === "task_complete"
            || payload?.type === "turn_aborted"
            || payload?.type === "thread_rolled_back")
          && (!payload.turn_id || payload.turn_id === active.turnId)) {
          active.turnId = null;
          active.offset = nextOffset;
          result.ignored += 1;
          dirty = true;
          continue;
        }

        const visible = canonicalMessage(record);
        if (!visible) {
          active.offset = nextOffset;
          result.ignored += 1;
          dirty = true;
          continue;
        }

        if (visible.role === "user") {
          const suppression = bodyDigest(visible.body);
          const suppressionIndex = active.suppressions.findIndex((entry) => entry.bodyHash === suppression);
          if (suppressionIndex >= 0) {
            active.suppressions.splice(suppressionIndex, 1);
            active.offset = nextOffset;
            result.suppressed += 1;
            dirty = true;
            continue;
          }
        }

        let deliveryBody = visible.body;
        let deliveryEnd = nextOffset;
        let deliveryIndex = index;
        const pendingGroup = visible.role === "assistant" ? active.pendingGroup : null;
        if (visible.role === "assistant") {
          const bodies = [normalizedBody(visible.body)];
          const pendingEnd = pendingGroup?.endOffset ?? null;
          let scanIndex = index;

          // Commentary is emitted in readable buckets. Private reasoning and
          // other non-visible records may sit between commentary records, but
          // user, final, turn, and selection boundaries always end the bucket.
          while (scanIndex < bytes.length) {
            const candidateNewline = bytes.indexOf(0x0a, scanIndex);
            if (candidateNewline < 0) break;
            const candidateEnd = startOffset + candidateNewline + 1;
            if (pendingEnd !== null && candidateEnd > pendingEnd) break;
            const candidate = parseRecord(bytes.subarray(scanIndex, candidateNewline));
            if (isMessageBoundary(candidate)) break;
            const candidateVisible = canonicalMessage(candidate);
            if (candidateVisible?.role === "user") break;

            scanIndex = candidateNewline + 1;
            deliveryIndex = scanIndex;
            deliveryEnd = candidateEnd;
            result.processed += 1;
            if (candidateVisible?.role === "assistant") {
              bodies.push(normalizedBody(candidateVisible.body));
            } else {
              result.ignored += 1;
            }
            if (pendingEnd !== null && deliveryEnd === pendingEnd) break;
          }
          deliveryBody = bodies.join("\n\n");

          if (pendingGroup && (deliveryEnd !== pendingGroup.endOffset
            || bodyDigest(deliveryBody) !== pendingGroup.bodyHash)) {
            // The same inode was modified underneath a pending delivery. A
            // fresh EOF baseline is safer than sending altered content under
            // an id that may already have reached the provider.
            this.#baseline(details, opened);
            result.baselined = 1;
            result.reason = "REBASELINED";
            return result;
          }
        }

        // Persist all preceding cursor/turn changes before making an external
        // call. A crash can then cause only a deterministic duplicate retry.
        let deliveryId = digest([
          visible.role === "assistant" ? "live-mirror-v2-group" : "live-mirror-v1",
          active.threadId,
          active.device,
          active.inode,
          String(lineStart),
          String(deliveryEnd),
          visible.role,
          visible.phase,
          deliveryBody,
        ].join("\0"));
        if (pendingGroup) deliveryId = pendingGroup.deliveryId;
        if (visible.role === "assistant" && !pendingGroup) {
          active.pendingGroup = {
            startOffset: lineStart,
            endOffset: deliveryEnd,
            bodyHash: bodyDigest(deliveryBody),
            deliveryId,
          };
          dirty = true;
        }
        if (dirty) {
          this.#save();
          dirty = false;
        }
        const event = {
          deliveryId,
          threadId: active.threadId,
          selectionId: selectedId,
          turnId: active.turnId,
          role: visible.role,
          phase: visible.phase,
          body: deliveryBody,
          createdAt: typeof record.timestamp === "string" ? record.timestamp : null,
        };

        let outcome = { terminal: false, outcome: null };
        try {
          outcome = terminalDelivery(await deliver(event));
        } catch {
          // Delivery content and provider errors are intentionally not logged.
        }
        if (epoch !== this.selectionEpoch || selectedId !== this.state.active?.selectionId) {
          result.active = false;
          result.reason = "STALE_SELECTION";
          return result;
        }
        if (!outcome.terminal) {
          result.retryable += 1;
          result.more = true;
          return result;
        }

        active.offset = deliveryEnd;
        if (visible.role === "assistant") active.pendingGroup = null;
        index = deliveryIndex;
        dirty = true;
        if (outcome.outcome === "SENT") result.delivered += 1;
        else result.discarded += 1;
      }

      const unreadInWindow = bytes.length - index;
      if (unreadInWindow > 0
        && index === 0
        && bytes.length === this.maxReadBytes
        && opened.stat.size > startOffset + bytes.length) {
        // The record exceeds the configured bound. Discard it incrementally
        // without retaining or logging its body, then resume at its newline.
        active.offset += bytes.length;
        active.discardingOversize = true;
        dirty = true;
        result.more = true;
      } else {
        result.partial = unreadInWindow > 0;
        const windowHasUnreadFile = startOffset + bytes.length < opened.stat.size;
        result.more = windowHasUnreadFile || (active.offset < opened.stat.size && !result.partial);
        if (windowHasUnreadFile) result.partial = false;
      }
      if (dirty) this.#save();
      return result;
    } finally {
      closeSync(opened.descriptor);
    }
  }
}
