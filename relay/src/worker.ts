import { CODEX_CONTACT_IMAGE_BASE64 } from "./contact-card-image.ts";
import { parseMenuSelection, parseSlashCommand, renderHelp, renderOutboundEvent, renderThreadDirectory, renderThreadMenu, threadHeader, threadTitle } from "../../protocol/presentation.ts";
import type { OutboundEvent, MenuItem } from "../../protocol/presentation.ts";
import type {
  Env,
  InstallationPairingRow,
  MenuSnapshotRow,
  PairingAttemptLimitRow,
  PhoneBindingRow,
  HandoffReplyRow,
  HandoffThreadRow,
  ServiceInstallationRow,
} from "./types.ts";

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;

// The relay is intentionally small: one Worker file handles registration,
// Sendblue webhooks, local Codex WebSockets, and outbound Sendblue sends.
// Durable storage is only for routing metadata; message content is kept in the
// Durable Object buffer and scrubbed when local Codex claims it.

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};
const CONTACT_CARD_MESSAGE = "Add me as a contact so you remember who I am.";
const CONTACT_CARD_FILENAME = "contact.vcf";
const CONTACT_CARD_IMAGE_FILENAME = "codex-contact.jpg";
const THREAD_LIST_COMMANDS = new Set(["list", "threads", "/threads", "/recent"]);
const MENU_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

// Pairing is the security boundary that lets an iMessage sender control a local
// Codex thread. Codes are intentionally short for human texting, so they expire
// quickly and failed code-shaped guesses are throttled by phone number.
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
const PAIRING_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const PAIRING_ATTEMPT_BLOCK_MS = 30 * 60 * 1000;
const MAX_PAIRING_FAILURES_PER_WINDOW = 5;
const INVALID_PAIRING_CODE_MESSAGE = "That pairing code is invalid or expired. Start iMessage Handoff again in Codex to get a fresh code.";

// Abuse controls are deliberately boring. Sendblue is billed per phone number,
// so the practical hosted-relay risk is oversized payloads and noisy request
// floods, not per-message spend. These caps fail requests before large parsing,
// D1 growth, or media upload work can run away.
const DEFAULT_JSON_BODY_MAX_BYTES = 128 * 1024;
const WEBHOOK_JSON_BODY_MAX_BYTES = 256 * 1024;
const CATALOG_JSON_BODY_MAX_BYTES = 1024 * 1024;
const SERVICE_OUTBOUND_JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;
const STATUS_JSON_BODY_MAX_BYTES = 72 * 1024 * 1024;
const REQUEST_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_INSTALLATIONS_PER_IP_PER_WINDOW = 30;
const MAX_THREAD_REQUESTS_PER_IP_PER_WINDOW = 1000;
const MAX_OWNER_REQUESTS_PER_WINDOW = 1000;
const MAX_CWD_LENGTH = 512;
const MAX_TITLE_LENGTH = 160;
const MAX_HANDOFF_SUMMARY_LENGTH = 1000;
const MAX_STATUS_LENGTH = 40;
const MAX_ASSISTANT_MESSAGE_LENGTH = 20_000;
const MAX_WEBHOOK_CONTENT_LENGTH = 20_000;
const MAX_URL_LENGTH = 2048;
const MAX_ENABLED_THREADS_PER_OWNER = 25;
const MAX_CATALOG_THREADS_PER_OWNER = 500;
const MAX_CATALOG_BATCH = 500;
const MAX_GENERATED_IMAGES = 5;
const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_GENERATED_IMAGE_TOTAL_BYTES = MAX_GENERATED_IMAGES * MAX_GENERATED_IMAGE_BYTES;
const ALLOWED_GENERATED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// Sendblue can deliver one image as several webhooks. Wait briefly before
// surfacing grouped media so Codex receives one complete iMessage reply.
const MEDIA_GROUP_QUIET_MS = 3000;

interface RegisterBody {
  cwd?: unknown;
  title?: unknown;
  handoffSummary?: unknown;
}

interface ServiceRegisterBody {
  clientId?: unknown;
  serviceVersion?: unknown;
  capabilities?: unknown;
}

interface CatalogThreadInput {
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  projectLabel?: unknown;
  projectKey?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  activityAt?: unknown;
  stateSince?: unknown;
  status?: unknown;
  reasoningEffort?: unknown;
  archived?: unknown;
  visible?: unknown;
}

interface ServiceCatalogBody {
  threads?: unknown;
  complete?: unknown;
}

interface OutboundBody {
  event?: unknown;
}

interface StatusBody {
  cwd?: unknown;
  lastAssistantMessage?: unknown;
  generatedImages?: unknown;
  status?: unknown;
  createdAt?: unknown;
}

interface SendblueWebhookBody {
  content?: unknown;
  is_outbound?: unknown;
  status?: unknown;
  message_handle?: unknown;
  from_number?: unknown;
  number?: unknown;
  media_url?: unknown;
}

type JsonRecord = Record<string, unknown>;

interface GeneratedImageInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

interface ReplyMedia {
  url: string;
}

export class HandoffSocket {
  private readonly state: DurableObjectState;
  // This is the in-memory message buffer. When HANDOFF_SOCKET is bound,
  // inbound message text/media does not go to D1; it lives here until claim.
  private readonly replies = new Map<string, HandoffReplyRow>();
  // Soft hourly request counters live in the same global DO as the reply buffer.
  // They are intentionally in-memory: if the DO restarts, the counters reset,
  // which is fine for a lightweight abuse brake and avoids a D1 write per hit.
  private readonly requestLimits = new Map<string, { count: number; windowStartMs: number }>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Internal HTTP routes are used by the Worker to insert and claim messages
    // from the same buffer that WebSocket clients listen to.
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      if (request.method === "POST" && parts[0] === "threads" && parts[1] && parts[2] === "replies" && parts.length === 3) {
        return await this.handleInsertReply(request, parts[1]);
      }
      if (
        request.method === "POST" &&
        parts[0] === "threads" &&
        parts[1] &&
        parts[2] === "replies" &&
        parts[3] &&
        parts[4] === "claim" &&
        parts.length === 5
      ) {
        return this.handleClaimReply(parts[1], parts[3]);
      }
      if (request.method === "GET" && parts[0] === "external-replies" && parts[1] && parts.length === 2) {
        return json({ exists: this.hasExternalReply(parts[1]) });
      }
      if (request.method === "POST" && parts[0] === "rate-limit" && parts.length === 1) {
        return await this.handleRateLimit(request);
      }
      if (request.method === "POST" && parts[0] === "owners" && parts[1] && parts[2] === "control") {
        const body = await readJsonBody<JsonRecord>(request);
        const delivered = this.notifyOwner(parts[1], {
          type: "control",
          command: optionalString(body.command),
          threadId: optionalString(body.threadId),
          argument: optionalString(body.argument),
        });
        return json({ ok: delivered > 0, delivered }, delivered > 0 ? {} : { status: 409 });
      }
      if (request.method === "GET" && parts[0] === "owners" && parts[1] && parts[2] === "connected") {
        return json({ connected: this.state.getWebSockets(`owner:${parts[1]}`).length > 0 });
      }
      return error(404, "Not found.");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const isOwnerSocket = parts[0] === "owners" && parts[1] && parts[2] === "events";
    const threadId = parts[0] === "threads" ? parts[1] ?? "" : "";
    const ownerId = isOwnerSocket ? parts[1] : "";
    const socketTag = ownerId ? `owner:${ownerId}` : threadId;
    this.state.acceptWebSocket(server, socketTag ? [socketTag] : undefined);
    if (ownerId) {
      this.notifyOwnerSocketOrSchedule(ownerId, server);
    } else if (threadId) {
      // A Stop hook may connect after a message already arrived, so send the
      // next queued message immediately when possible.
      this.notifySocketOrScheduleNextPending(threadId, server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // The local script sends a small "connected" message. The ack is mostly for
    // diagnostics; actual delivery is driven by reply-pending events.
    const text = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);
    let parsed: JsonRecord | null = null;
    try {
      const value = JSON.parse(text) as unknown;
      parsed = isRecord(value) ? value : null;
    } catch {
      parsed = null;
    }

    ws.send(JSON.stringify({
      type: "ack",
      received: true,
      receivedAt: nowIso(),
      messageType: optionalString(parsed?.type),
    }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }

  private pendingRows(threadId: string) {
    return [...this.replies.values()]
      .filter((reply) => reply.thread_id === threadId && reply.status === "pending")
      .sort((a, b) => (
        (a.media_index ?? 0) - (b.media_index ?? 0)
        || a.created_at.localeCompare(b.created_at)
      ));
  }

  private hasExternalReply(externalId: string) {
    return [...this.replies.values()].some((reply) => reply.external_id === externalId);
  }

  private async handleRateLimit(request: Request) {
    // The Worker asks the DO to count request buckets before it enters the more
    // expensive route handlers. This does not stop traffic at Cloudflare's edge,
    // but it keeps one IP/token from repeatedly driving D1 and Sendblue paths.
    const body = await readJsonBody<{ key?: unknown; limit?: unknown; windowMs?: unknown }>(request);
    const key = requireLimitedString(body.key, "key", 200);
    const limit = Number(body.limit);
    const windowMs = Number(body.windowMs);
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1000) {
      throw new Error("Invalid rate limit.");
    }

    const now = Date.now();
    const current = this.requestLimits.get(key);
    const next = !current || current.windowStartMs + windowMs <= now
      ? { count: 1, windowStartMs: now }
      : { count: current.count + 1, windowStartMs: current.windowStartMs };
    this.requestLimits.set(key, next);
    return json({
      ok: true,
      allowed: next.count <= limit,
      count: next.count,
      retryAfterSeconds: next.count <= limit
        ? 0
        : Math.max(1, Math.ceil((next.windowStartMs + windowMs - now) / 1000)),
    });
  }

  private async handleInsertReply(request: Request, threadId: string) {
    // The Worker calls this after routing a Sendblue webhook to the active
    // thread. "applied" rows are dedupe tombstones for control messages.
    const body = await readJsonBody<{
      body?: unknown;
      externalId?: unknown;
      status?: unknown;
      mediaUrl?: unknown;
      ownerId?: unknown;
    }>(request);
    const status = optionalString(body.status) === "applied" ? "applied" : "pending";
    const externalId = optionalString(body.externalId);
    const mediaUrl = optionalString(body.mediaUrl);
    const ownerId = optionalString(body.ownerId);
    const isTombstone = status === "applied";
    const id = makeId("reply");
    const createdAt = nowIso();
    const { mediaGroupId, mediaIndex } = sendblueMediaGroup(externalId, mediaUrl);
    this.replies.set(id, {
      id,
      thread_id: threadId,
      external_id: externalId,
      body: isTombstone ? "" : optionalString(body.body) ?? "",
      media: isTombstone ? null : replyMediaJson(mediaUrl),
      media_group_id: mediaGroupId,
      media_index: mediaIndex,
      status,
      created_at: createdAt,
      applied_at: isTombstone ? createdAt : null,
      owner_id: ownerId,
    });
    if (!isTombstone && !mediaGroupId) {
      // Plain text can be delivered as soon as it arrives.
      const payload = { type: "reply-pending", threadId, replyId: id, createdAt };
      if (ownerId) this.notifyOwner(ownerId, payload);
      else this.notifyNextPending(threadId);
    } else if (!isTombstone) {
      // Media groups need the quiet window before they are safe to claim.
      this.scheduleMediaPendingNotification(threadId, ownerId);
    }
    return json({ id });
  }

  private notifyNextPending(threadId: string, ownerId?: string | null) {
    const payload = this.nextPendingPayload(threadId);
    if (!payload) {
      return;
    }
    if (ownerId) {
      this.notifyOwner(ownerId, payload);
    } else {
      this.notifyThread(threadId, payload);
    }
  }

  private notifySocketOrScheduleNextPending(threadId: string, socket: WebSocket) {
    const payload = this.nextPendingPayload(threadId);
    if (payload) {
      socket.send(JSON.stringify(payload));
      return;
    }
    // If only an unready media group is waiting, schedule a later notification
    // so a client that connects during the quiet window still gets woken up.
    this.scheduleMediaPendingNotification(threadId);
  }

  private notifyOwnerSocketOrSchedule(ownerId: string, socket: WebSocket) {
    const pending = [...this.replies.values()]
      .filter((reply) => reply.owner_id === ownerId && reply.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const threadIds = [...new Set(pending.map((row) => row.thread_id))];
    const payloads = threadIds.flatMap((threadId) => this.pendingPayloads(threadId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const payload of payloads) {
      socket.send(JSON.stringify(payload));
    }
    for (const threadId of threadIds) this.scheduleMediaPendingNotification(threadId, ownerId);
  }

  private pendingPayloads(threadId: string) {
    return eligiblePendingReplies(this.pendingRows(threadId)).flatMap((pending) => pending ? [{
      type: "reply-pending",
      threadId,
      replyId: pending.id,
      createdAt: pending.createdAt,
    }] : []);
  }

  private nextPendingPayload(threadId: string) {
    return this.pendingPayloads(threadId)[0] ?? null;
  }

  private scheduleMediaPendingNotification(threadId: string, ownerId?: string | null) {
    const waitMs = this.nextMediaPendingWaitMs(threadId);
    if (waitMs === null) {
      return;
    }
    setTimeout(() => {
      for (const payload of this.pendingPayloads(threadId)) {
        if (ownerId) this.notifyOwner(ownerId, payload);
        else this.notifyThread(threadId, payload);
      }
    }, waitMs);
  }

  private nextMediaPendingWaitMs(threadId: string) {
    const grouped = new Map<string, HandoffReplyRow[]>();
    for (const row of this.pendingRows(threadId)) {
      if (row.media_group_id) {
        grouped.set(row.media_group_id, [...(grouped.get(row.media_group_id) ?? []), row]);
      }
    }
    const waits = [...grouped.values()].flatMap((rows) => {
      const newest = Math.max(...rows.map((row) => Date.parse(row.created_at)).filter(Number.isFinite));
      if (!Number.isFinite(newest)) {
        return [];
      }
      const waitMs = newest + MEDIA_GROUP_QUIET_MS - Date.now();
      return waitMs > 0 ? [waitMs] : [];
    });
    return waits.length > 0 ? Math.max(1, Math.min(...waits)) : null;
  }

  private notifyThread(threadId: string, payload: JsonRecord) {
    const message = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets(threadId)) {
      try {
        socket.send(message);
      } catch {
        // The runtime will clean up dead sockets.
      }
    }
  }

  private notifyOwner(ownerId: string, payload: JsonRecord) {
    const message = JSON.stringify(payload);
    let delivered = 0;
    for (const socket of this.state.getWebSockets(`owner:${ownerId}`)) {
      try {
        socket.send(message);
        delivered += 1;
      } catch {
        // The runtime will clean up dead sockets.
      }
    }
    return delivered;
  }

  private handleClaimReply(threadId: string, replyId: string) {
    // Claim is the handoff point from relay memory to local Codex. After this,
    // the stored body/media are scrubbed so conversation content is not retained.
    const selectedReply = this.replies.get(replyId);
    if (!selectedReply || selectedReply.thread_id !== threadId || selectedReply.status !== "pending") {
      return json({ ok: false, error: "Reply is not pending." }, { status: 409 });
    }

    let replyRows = [selectedReply];
    if (selectedReply.media_group_id) {
      replyRows = this.pendingRows(threadId).filter((reply) => reply.media_group_id === selectedReply.media_group_id);
    }
    const reply = combineReplyRows(replyRows);
    const appliedAt = nowIso();
    for (const row of replyRows) {
      this.replies.set(row.id, {
        ...row,
        status: "applied",
        body: "",
        media: null,
        applied_at: appliedAt,
      });
    }

    this.notifyNextPending(threadId, selectedReply.owner_id);

    return json({ ok: true, reply });
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers,
    },
  });
}

function error(status: number, message: string) {
  return json({ error: message }, { status });
}

function requestTooLarge(message: string) {
  throw Object.assign(new Error(message), { status: 413 });
}

async function readJsonBody<T>(request: Request, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES): Promise<T> {
  // Workers Free/Pro can accept much larger bodies than this app needs. Check
  // Content-Length when present, then verify the actual decoded text size so
  // chunked requests cannot sneak around the cap.
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    requestTooLarge("Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    requestTooLarge("Request body is too large.");
  }
  if (!text.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function authToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function authTokenFromRequestOrUrl(request: Request) {
  return authToken(request) || new URL(request.url).searchParams.get("token")?.trim() || "";
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertMaxLength(value: string | null, name: string, maxLength: number) {
  if (value && value.length > maxLength) {
    throw Object.assign(new Error(`${name} must be ${maxLength} characters or fewer.`), { status: 413 });
  }
  return value;
}

function requireLimitedString(value: unknown, name: string, maxLength: number) {
  return assertMaxLength(requireString(value, name), name, maxLength) as string;
}

function optionalLimitedString(value: unknown, name: string, maxLength: number) {
  return assertMaxLength(optionalString(value), name, maxLength);
}

function rateLimited(message = "Too many requests. Try again later.") {
  throw Object.assign(new Error(message), { status: 429 });
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromMs(ms: number) {
  return new Date(ms).toISOString();
}

function clientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return request.headers.get("cf-connecting-ip")?.trim() || forwardedFor || "unknown";
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeInstallToken() {
  // Install tokens are local identity: whoever has this token can control the
  // associated phone binding, so it should stay in the local skill state dir.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `ih_${bytesToHex(bytes)}`;
}

async function ownerIdFromToken(token: string) {
  // The relay stores only a deterministic hash-derived owner id, not the raw
  // local token. That keeps D1 useful for routing without storing bearer tokens.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`imessage-handoff:${token}`));
  return bytesToHex(new Uint8Array(digest));
}

async function requireOwnerId(request: Request) {
  const token = authToken(request);
  if (!token) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  return ownerIdFromToken(token);
}

function makePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function isPairingCodeCandidate(content: string | null) {
  return Boolean(content && /^[A-Z2-9]{6}$/.test(content.trim().toUpperCase()));
}

async function findThread(env: Env, threadId: string) {
  return env.DB.prepare("SELECT * FROM handoff_threads WHERE id = ?")
    .bind(threadId)
    .first<HandoffThreadRow>();
}

function assertAuthorized(thread: HandoffThreadRow | null, ownerId: string) {
  if (!thread) {
    throw Object.assign(new Error("Thread not found."), { status: 404 });
  }
  if (ownerId !== thread.owner_id) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  return thread;
}

function publicThread(thread: HandoffThreadRow) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    title: thread.title,
    handoffSummary: thread.handoff_summary,
    status: thread.status,
    handoffEnabled: thread.handoff_enabled === 1,
    pairingCode: thread.pairing_code,
    pairingCodeExpiresAt: thread.pairing_code_expires_at,
    lastStopAt: thread.last_stop_at,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    projectKey: thread.project_key ?? null,
    projectLabel: thread.project_label ?? null,
    activityAt: thread.activity_at ?? thread.updated_at,
    stateSince: thread.state_since ?? thread.updated_at,
    reasoningEffort: thread.reasoning_effort ?? null,
  };
}

async function handleRegister(request: Request, env: Env, threadId: string) {
  // start-handoff registers the current Codex thread. If the phone is already
  // paired, this also switches that phone's active thread to the new one.
  const body = await readJsonBody<RegisterBody>(request);
  const ownerId = await requireOwnerId(request);
  const cwd = requireLimitedString(body.cwd, "cwd", MAX_CWD_LENGTH);
  const title = optionalLimitedString(body.title, "title", MAX_TITLE_LENGTH);
  const handoffSummary = optionalLimitedString(body.handoffSummary, "handoffSummary", MAX_HANDOFF_SUMMARY_LENGTH);
  const existingThread = await findThread(env, threadId);
  if (existingThread) {
    assertAuthorized(existingThread, ownerId);
  }
  // Metadata is cheap, but not free. Keep one install token from leaving an
  // unlimited pile of enabled thread rows behind on the hosted relay.
  const enabledThreads = await listEnabledThreadsForOwner(env, ownerId);
  const alreadyEnabled = existingThread?.handoff_enabled === 1;
  if (!alreadyEnabled && enabledThreads.length >= MAX_ENABLED_THREADS_PER_OWNER) {
    rateLimited("Too many active handoff threads. Stop an existing thread before starting another.");
  }
  const existingBinding = await findPhoneBindingForOwner(env, ownerId);
  const pairingRequired = !existingBinding;
  const pairingCode = pairingRequired ? makePairingCode() : null;
  const pairingCodeExpiresAt = pairingRequired ? isoFromMs(Date.now() + PAIRING_CODE_TTL_MS) : null;
  const createdAt = nowIso();

  await env.DB.prepare(
    `INSERT INTO handoff_threads (
      id, owner_id, cwd, title, handoff_summary, status, handoff_enabled, pairing_code,
      pairing_code_expires_at, last_stop_at, created_at, updated_at, catalog_source,
      archived, visible
    ) VALUES (?, ?, ?, ?, ?, 'enabled', 1, ?, ?, NULL, ?, ?, 'legacy', 0, 1)
    ON CONFLICT(id) DO UPDATE SET
      owner_id = excluded.owner_id,
      cwd = excluded.cwd,
      title = excluded.title,
      handoff_summary = excluded.handoff_summary,
      status = 'enabled',
      handoff_enabled = 1,
      catalog_source = 'legacy',
      archived = 0,
      visible = 1,
      pairing_code = excluded.pairing_code,
      pairing_code_expires_at = excluded.pairing_code_expires_at,
      updated_at = excluded.updated_at`,
  ).bind(threadId, ownerId, cwd, title, handoffSummary, pairingCode, pairingCodeExpiresAt, createdAt, createdAt).run();

  await env.DB.prepare(
    "UPDATE handoff_threads SET pairing_code = NULL, pairing_code_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND id != ?",
  ).bind(createdAt, ownerId, threadId).run();

  if (existingBinding) {
    await env.DB.prepare(
      "UPDATE phone_bindings SET active_thread_id = ?, updated_at = ? WHERE owner_id = ?",
    ).bind(threadId, createdAt, ownerId).run();
    const registeredThread = await findThread(env, threadId);
    if (registeredThread) {
      await sendControlMessage(env, existingBinding.phone_number, handoffActivationMessage(registeredThread));
    }
  }

  return json({
    id: threadId,
    sendblueNumber: env.SENDBLUE_FROM_NUMBER || "+12344198201",
    paired: Boolean(existingBinding),
    pairingRequired,
    pairingCode,
    pairingCodeExpiresAt,
    skipNextStatusSend: Boolean(existingBinding),
  });
}

function handleCreateInstallation() {
  return json({ token: makeInstallToken() });
}

async function findServiceInstallation(env: Env, ownerId: string) {
  return env.DB.prepare("SELECT * FROM service_installations WHERE owner_id = ?")
    .bind(ownerId)
    .first<ServiceInstallationRow>();
}

function serviceSupports(installation: ServiceInstallationRow | null, capability: string) {
  if (!installation) return false;
  try {
    const values = JSON.parse(installation.capabilities) as unknown;
    return Array.isArray(values) && values.includes(capability);
  } catch {
    return false;
  }
}

async function isServiceSocketConnected(env: Env, ownerId: string) {
  if (!env.HANDOFF_SOCKET) return false;
  try {
    const response = await env.HANDOFF_SOCKET.get(env.HANDOFF_SOCKET.idFromName("global"))
      .fetch(new Request(`https://imessage-handoff.internal/owners/${ownerId}/connected`));
    if (!response.ok) return false;
    const body = await response.json() as { connected?: boolean };
    return body.connected === true;
  } catch {
    return false;
  }
}

async function findInstallationPairingByCode(env: Env, pairingCode: string) {
  return env.DB.prepare(
    "SELECT * FROM installation_pairings WHERE pairing_code = ? AND pairing_code_expires_at > ?",
  ).bind(pairingCode, nowIso()).first<InstallationPairingRow>();
}

async function findInstallationPairingForOwner(env: Env, ownerId: string) {
  return env.DB.prepare("SELECT * FROM installation_pairings WHERE owner_id = ?")
    .bind(ownerId).first<InstallationPairingRow>();
}

async function handleServiceRegister(request: Request, env: Env) {
  const ownerId = await requireOwnerId(request);
  const body = await readJsonBody<ServiceRegisterBody>(request);
  const clientId = requireLimitedString(body.clientId, "clientId", 120);
  const serviceVersion = requireLimitedString(body.serviceVersion, "serviceVersion", 40);
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.flatMap((value) => typeof value === "string" ? [value.slice(0, 80)] : []).slice(0, 40)
    : [];
  const now = nowIso();
  const existing = await findServiceInstallation(env, ownerId);
  await env.DB.prepare(
    `INSERT INTO service_installations (
      owner_id, client_id, service_version, capabilities, delivery_mode, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'service', ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET
      client_id = excluded.client_id,
      service_version = excluded.service_version,
      capabilities = excluded.capabilities,
      delivery_mode = 'service',
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at`,
  ).bind(ownerId, clientId, serviceVersion, JSON.stringify(capabilities), now, existing?.created_at ?? now, now).run();

  const binding = await findPhoneBindingForOwner(env, ownerId);
  let pairingCode: string | null = null;
  let pairingCodeExpiresAt: string | null = null;
  if (!binding) {
    const currentPairing = await findInstallationPairingForOwner(env, ownerId);
    const reusable = currentPairing?.pairing_code && currentPairing.pairing_code_expires_at
      && Date.parse(currentPairing.pairing_code_expires_at) > Date.now();
    pairingCode = reusable ? currentPairing.pairing_code : makePairingCode();
    pairingCodeExpiresAt = reusable ? currentPairing.pairing_code_expires_at : isoFromMs(Date.now() + PAIRING_CODE_TTL_MS);
    await env.DB.prepare(
      `INSERT INTO installation_pairings (owner_id, pairing_code, pairing_code_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         pairing_code = excluded.pairing_code,
         pairing_code_expires_at = excluded.pairing_code_expires_at,
         updated_at = excluded.updated_at`,
    ).bind(ownerId, pairingCode, pairingCodeExpiresAt, now, now).run();
  }

  return json({
    ok: true,
    paired: Boolean(binding),
    pairingRequired: !binding,
    pairingCode,
    pairingCodeExpiresAt,
    sendblueNumber: env.SENDBLUE_FROM_NUMBER || "+12344198201",
    activeThreadId: binding?.active_thread_id ?? null,
  });
}

function catalogThread(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Each catalog thread must be an object.");
  }
  const status = optionalLimitedString(value.status, "thread.status", MAX_STATUS_LENGTH) ?? "idle";
  if (!["working", "pending", "idle", "error"].includes(status)) {
    throw new Error("thread.status must be working, pending, idle, or error.");
  }
  const updatedAt = optionalLimitedString(value.updatedAt, "thread.updatedAt", 64) ?? nowIso();
  const activityAt = optionalLimitedString(value.activityAt, "thread.activityAt", 64) ?? updatedAt;
  return {
    id: requireLimitedString(value.id, "thread.id", 160),
    title: optionalLimitedString(value.title, "thread.title", MAX_TITLE_LENGTH),
    cwd: optionalLimitedString(value.cwd, "thread.cwd", MAX_CWD_LENGTH) ?? "Codex",
    projectLabel: optionalLimitedString(value.projectLabel, "thread.projectLabel", 120),
    projectKey: optionalLimitedString(value.projectKey, "thread.projectKey", 160)
      ?? optionalLimitedString(value.projectLabel, "thread.projectLabel", 120)
      ?? "codex",
    createdAt: optionalLimitedString(value.createdAt, "thread.createdAt", 64) ?? nowIso(),
    updatedAt,
    activityAt,
    stateSince: optionalLimitedString(value.stateSince, "thread.stateSince", 64) ?? activityAt,
    status,
    reasoningEffort: optionalLimitedString(value.reasoningEffort, "thread.reasoningEffort", 40),
    archived: value.archived === true ? 1 : 0,
    visible: value.visible === false ? 0 : 1,
  };
}

async function handleServiceCatalog(request: Request, env: Env) {
  const ownerId = await requireOwnerId(request);
  const body = await readJsonBody<ServiceCatalogBody>(request, CATALOG_JSON_BODY_MAX_BYTES);
  if (body.complete !== true) {
    throw new Error("complete must be true for a full catalog snapshot.");
  }
  if (!Array.isArray(body.threads) || body.threads.length > MAX_CATALOG_BATCH) {
    throw new Error(`threads must be an array of at most ${MAX_CATALOG_BATCH} items.`);
  }
  const items = body.threads.map(catalogThread);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("Catalog thread ids must be unique.");
  }
  const now = nowIso();
  const generation = makeId("catalog");
  const write = await env.DB.prepare(
    `WITH incoming AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.cwd') AS cwd,
        json_extract(value, '$.title') AS title,
        json_extract(value, '$.status') AS status,
        json_extract(value, '$.createdAt') AS created_at,
        json_extract(value, '$.updatedAt') AS updated_at,
        json_extract(value, '$.projectLabel') AS project_label,
        json_extract(value, '$.projectKey') AS project_key,
        json_extract(value, '$.archived') AS archived,
        json_extract(value, '$.visible') AS visible,
        json_extract(value, '$.activityAt') AS activity_at,
        json_extract(value, '$.stateSince') AS state_since,
        json_extract(value, '$.reasoningEffort') AS reasoning_effort
      FROM json_each(?)
    )
    INSERT INTO handoff_threads (
      id, owner_id, cwd, title, handoff_summary, status, handoff_enabled, pairing_code,
      pairing_code_expires_at, last_stop_at, created_at, updated_at, project_label,
      project_key, catalog_source, archived, visible, last_seen_at, catalog_generation,
      activity_at, state_since, reasoning_effort
    )
    SELECT
      id, ?, cwd, title, NULL, status, 1, NULL, NULL, NULL, created_at, updated_at,
      project_label, project_key, 'service', archived, visible, ?, ?, activity_at,
      state_since, reasoning_effort
    FROM incoming
    WHERE 1
    ON CONFLICT(id) DO UPDATE SET
      owner_id = excluded.owner_id,
      cwd = excluded.cwd,
      title = excluded.title,
      status = excluded.status,
      project_label = excluded.project_label,
      project_key = excluded.project_key,
      catalog_source = 'service',
      archived = excluded.archived,
      visible = excluded.visible,
      handoff_enabled = 1,
      last_seen_at = excluded.last_seen_at,
      catalog_generation = excluded.catalog_generation,
      activity_at = excluded.activity_at,
      state_since = excluded.state_since,
      reasoning_effort = excluded.reasoning_effort,
      updated_at = excluded.updated_at
    WHERE handoff_threads.owner_id = excluded.owner_id`,
  ).bind(JSON.stringify(items), ownerId, now, generation).run();
  if (Number(write.meta?.changes) !== items.length) {
    throw Object.assign(new Error("Catalog contains an unavailable task id."), { status: 409 });
  }
  await env.DB.prepare(
    `UPDATE handoff_threads
      SET visible = 0, last_seen_at = ?
      WHERE owner_id = ?
        AND (
          COALESCE(catalog_source, '') != 'service'
          OR COALESCE(catalog_generation, '') != ?
        )`,
  ).bind(now, ownerId, generation).run();
  return json({ ok: true, synchronized: items.length, limit: MAX_CATALOG_THREADS_PER_OWNER });
}

async function handleServiceStatus(request: Request, env: Env) {
  const ownerId = await requireOwnerId(request);
  const installation = await findServiceInstallation(env, ownerId);
  const binding = await findPhoneBindingForOwner(env, ownerId);
  const activeThread = binding?.active_thread_id ? await findThread(env, binding.active_thread_id) : null;
  return json({
    ok: true,
    connected: Boolean(installation) && await isServiceSocketConnected(env, ownerId),
    paired: Boolean(binding),
    activeThread: activeThread ? publicThread(activeThread) : null,
    lastSeenAt: installation?.last_seen_at ?? null,
    clientId: installation?.client_id ?? null,
    serviceVersion: installation?.service_version ?? null,
  });
}

async function handleServiceUnregister(request: Request, env: Env) {
  const ownerId = await requireOwnerId(request);
  await env.DB.prepare("DELETE FROM service_installations WHERE owner_id = ?").bind(ownerId).run();
  await env.DB.prepare(
    `UPDATE handoff_threads
      SET visible = 0, handoff_enabled = 0, status = 'stopped', updated_at = ?
      WHERE owner_id = ? AND catalog_source = 'service'`,
  ).bind(nowIso(), ownerId).run();
  const binding = await findPhoneBindingForOwner(env, ownerId);
  let activeThreadId = binding?.active_thread_id ?? null;
  if (binding) {
    activeThreadId = (await listEnabledThreadsForOwner(env, ownerId))[0]?.id ?? null;
    await setActiveThreadForOwner(env, ownerId, activeThreadId);
  }
  return json({ ok: true, deliveryMode: "legacy", activeThreadId });
}

function outboundEvent(value: unknown) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("event is required.");
  }
  return value as unknown as OutboundEvent;
}

async function serviceDirectoryReferences(env: Env, ownerId: string, event: Extract<OutboundEvent, { kind: "service.directory" }>) {
  if (!isRecord(event.directory) || !Array.isArray(event.directory.groups)) {
    throw new Error("directory.groups is required.");
  }
  const references: string[] = [];
  for (const group of event.directory.groups) {
    if (!isRecord(group) || !Array.isArray(group.threads)) throw new Error("Each directory group must contain threads.");
    for (const item of group.threads) {
      if (!isRecord(item)) throw new Error("Each directory thread must be an object.");
      const id = requireLimitedString(item.id, "directory.thread.id", 160);
      if (Number(item.index) !== references.length + 1) throw new Error("Directory thread indexes must be continuous.");
      references.push(`thread:${id}`);
    }
  }
  if (references.length > MAX_CATALOG_THREADS_PER_OWNER) throw new Error("Directory contains too many threads.");
  if (new Set(references).size !== references.length) throw new Error("Directory thread ids must be unique.");
  const available = new Set((await listEnabledThreadsForOwner(env, ownerId)).map((thread) => `thread:${thread.id}`));
  if (references.some((reference) => !available.has(reference))) {
    throw Object.assign(new Error("Directory contains an unavailable task."), { status: 409 });
  }
  return references;
}

async function handleServiceOutbound(request: Request, env: Env) {
  const ownerId = await requireOwnerId(request);
  const body = await readJsonBody<OutboundBody>(request, SERVICE_OUTBOUND_JSON_BODY_MAX_BYTES);
  const binding = await findPhoneBindingForOwner(env, ownerId);
  if (!binding) {
    throw Object.assign(new Error("Phone is not paired."), { status: 409 });
  }
  const event = outboundEvent(body.event);
  const directoryReferences = event.kind === "service.directory"
    ? await serviceDirectoryReferences(env, ownerId, event)
    : null;
  const rendered = renderOutboundEvent(event);
  const chunks: string[] = [];
  if (event.kind === "thread.output" && rendered.length > 8000) {
    const bodyChunks = splitText(event.body, 7800);
    for (let index = 0; index < bodyChunks.length; index += 1) {
      chunks.push(`${threadHeader(event.thread, { index: index + 1, total: bodyChunks.length })}\n${threadTitle(event.thread)}\n\n${bodyChunks[index]}`);
    }
  } else if (rendered.length > 8000 && "thread" in event && event.thread) {
    const renderedChunks = splitText(rendered, 7600);
    for (let index = 0; index < renderedChunks.length; index += 1) {
      const continuation = index === 0
        ? ""
        : `${threadHeader(event.thread, { index: index + 1, total: renderedChunks.length })}\n${threadTitle(event.thread)}\n\n`;
      chunks.push(`${continuation}${renderedChunks[index]}`);
    }
  } else if (rendered.length > 8000) {
    const renderedChunks = splitText(rendered, 7600);
    for (let index = 0; index < renderedChunks.length; index += 1) {
      const label = event.kind === "service.directory" ? "THREADS" : "CONTINUED";
      const continuation = index === 0 ? "" : `CODEX CONTROL · ${label} · ${index + 1}/${renderedChunks.length}\n\n`;
      chunks.push(`${continuation}${renderedChunks[index]}`);
    }
  } else {
    chunks.push(rendered);
  }
  try {
    await sendSendblueTypingIndicator(env, binding.phone_number, "stop");
  } catch {
    // Typing is best effort.
  }
  // A directory may span several provider messages. Replace any older mapping
  // with an empty, unexpired sentinel before part 1 so an immediate numeric
  // reply can never select a row from the previous directory. Publish the real
  // mapping only after every part is accepted by Sendblue.
  if (directoryReferences) await saveMenuSnapshot(env, binding, [], []);
  let result = null;
  for (const chunk of chunks) {
    if (chunk.length > MAX_ASSISTANT_MESSAGE_LENGTH) requestTooLarge("Rendered message is too large.");
    result = await sendSendblueMessage(env, binding.phone_number, chunk);
  }
  if (directoryReferences) await saveMenuSnapshot(env, binding, [], directoryReferences);
  if (event.kind === "thread.progress") {
    try {
      await sendSendblueTypingIndicator(env, binding.phone_number, "start");
    } catch {
      // A progress bubble should not fail just because typing cannot resume.
    }
  }
  return json({ ok: true, notification: { sent: true, status: result?.status, messageHandle: result?.messageHandle, parts: chunks.length } });
}

function splitText(value: string, maxLength: number) {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining.length > maxLength) {
    let index = remaining.lastIndexOf("\n", maxLength);
    if (index < Math.floor(maxLength * 0.6)) index = remaining.lastIndexOf(" ", maxLength);
    if (index < 1) index = maxLength;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [""];
}

async function findPhoneBinding(env: Env, phoneNumber: string) {
  return env.DB.prepare("SELECT phone_number, owner_id, active_thread_id, contact_card_sent_at, created_at, updated_at FROM phone_bindings WHERE phone_number = ?")
    .bind(phoneNumber)
    .first<PhoneBindingRow>();
}

async function findPhoneBindingForOwner(env: Env, ownerId: string) {
  return env.DB.prepare("SELECT phone_number, owner_id, active_thread_id, contact_card_sent_at, created_at, updated_at FROM phone_bindings WHERE owner_id = ?")
    .bind(ownerId)
    .first<PhoneBindingRow>();
}

async function findPairingThread(env: Env, pairingCode: string) {
  return env.DB.prepare("SELECT * FROM handoff_threads WHERE pairing_code = ? AND handoff_enabled = 1 AND pairing_code_expires_at > ?")
    .bind(pairingCode, nowIso())
    .first<HandoffThreadRow>();
}

async function findPairingAttemptLimit(env: Env, phoneNumber: string) {
  return env.DB.prepare("SELECT phone_number, failed_count, window_start_at, blocked_until, updated_at FROM pairing_attempt_limits WHERE phone_number = ?")
    .bind(phoneNumber)
    .first<PairingAttemptLimitRow>();
}

async function enforceRequestRateLimit(env: Env, bucketKey: string, limit: number) {
  // Keep the public route handlers simple: they declare a bucket and limit, and
  // this helper delegates the actual counter to HandoffSocket's in-memory map.
  const response = await relaySocket(env)
    .fetch(new Request("https://imessage-handoff.internal/rate-limit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: bucketKey, limit, windowMs: REQUEST_RATE_LIMIT_WINDOW_MS }),
    }));
  const body = await response.json() as { allowed?: boolean };
  if (!response.ok || body.allowed !== true) {
    rateLimited();
  }
}

function retryAfterSeconds(blockedUntil: string, nowMs = Date.now()) {
  const blockedUntilMs = Date.parse(blockedUntil);
  if (!Number.isFinite(blockedUntilMs)) {
    return 0;
  }
  return Math.max(0, Math.ceil((blockedUntilMs - nowMs) / 1000));
}

function pairingRateLimitMessage(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many pairing attempts. Try again in about ${minutes} minutes, or start iMessage Handoff again in Codex for a fresh code.`;
}

async function pairingRateLimitStatus(env: Env, phoneNumber: string) {
  const row = await findPairingAttemptLimit(env, phoneNumber);
  if (!row?.blocked_until) {
    return { blocked: false, retryAfterSeconds: 0 };
  }
  const seconds = retryAfterSeconds(row.blocked_until);
  return { blocked: seconds > 0, retryAfterSeconds: seconds };
}

async function recordFailedPairingAttempt(env: Env, phoneNumber: string) {
  const nowMs = Date.now();
  const now = isoFromMs(nowMs);
  const row = await findPairingAttemptLimit(env, phoneNumber);
  const windowExpired = !row || !Number.isFinite(Date.parse(row.window_start_at))
    || Date.parse(row.window_start_at) + PAIRING_ATTEMPT_WINDOW_MS <= nowMs;
  const windowStartAt = windowExpired ? now : row.window_start_at;
  const failedCount = windowExpired ? 1 : row.failed_count + 1;
  const blockedUntil = failedCount > MAX_PAIRING_FAILURES_PER_WINDOW
    ? isoFromMs(nowMs + PAIRING_ATTEMPT_BLOCK_MS)
    : null;

  await env.DB.prepare(
    `INSERT INTO pairing_attempt_limits (phone_number, failed_count, window_start_at, blocked_until, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone_number) DO UPDATE SET
        failed_count = excluded.failed_count,
        window_start_at = excluded.window_start_at,
        blocked_until = excluded.blocked_until,
        updated_at = excluded.updated_at`,
  ).bind(phoneNumber, failedCount, windowStartAt, blockedUntil, now).run();

  return {
    blocked: Boolean(blockedUntil),
    retryAfterSeconds: blockedUntil ? retryAfterSeconds(blockedUntil, nowMs) : 0,
  };
}

async function clearPairingAttempts(env: Env, phoneNumber: string) {
  await env.DB.prepare("DELETE FROM pairing_attempt_limits WHERE phone_number = ?")
    .bind(phoneNumber)
    .run();
}

async function findExternalReply(env: Env, externalId: string) {
  // Sendblue may retry webhooks. The DO stores external ids in memory so we can
  // dedupe retries without writing message content to D1.
  const response = await relaySocket(env)
    .fetch(new Request(`https://imessage-handoff.internal/external-replies/${encodeURIComponent(externalId)}`));
  const body = await response.json() as { exists?: boolean };
  return body.exists ? { id: externalId } : null;
}

async function findPhoneForThread(env: Env, threadId: string) {
  return env.DB.prepare("SELECT phone_number, owner_id, active_thread_id, contact_card_sent_at, created_at, updated_at FROM phone_bindings WHERE active_thread_id = ?")
    .bind(threadId)
    .first<PhoneBindingRow>();
}

async function findDeliveryBinding(env: Env, thread: HandoffThreadRow) {
  return await findServiceInstallation(env, thread.owner_id)
    ? await findPhoneBindingForOwner(env, thread.owner_id)
    : await findPhoneForThread(env, thread.id);
}

async function listEnabledThreadsForOwner(env: Env, ownerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT *
      FROM handoff_threads
      WHERE owner_id = ? AND handoff_enabled = 1 AND visible = 1 AND archived = 0
      ORDER BY
        CASE status WHEN 'working' THEN 0 WHEN 'pending' THEN 1 WHEN 'error' THEN 2 ELSE 3 END,
        COALESCE(activity_at, updated_at) DESC,
        updated_at DESC,
        created_at DESC,
        id DESC`,
  ).bind(ownerId).all<HandoffThreadRow>();
  return results;
}

function threadDisplayName(thread: HandoffThreadRow) {
  if (thread.title?.trim()) {
    return thread.title.trim();
  }
  const cwdName = thread.cwd.split("/").filter(Boolean).at(-1);
  return cwdName || thread.id;
}

function quotedThreadDisplayName(thread: HandoffThreadRow) {
  return `"${threadDisplayName(thread).replaceAll('"', "'")}"`;
}

function handoffActivationMessage(thread: HandoffThreadRow) {
  // This is sent to iMessage when a paired user starts or switches a thread.
  // Keep it short because it appears as a normal chat message.
  const connectionLine = thread.title?.trim()
    ? `You’re connected to ${quotedThreadDisplayName(thread)} on Codex.`
    : "You’re connected to this Codex thread.";
  return [
    connectionLine,
    thread.handoff_summary?.trim() || null,
    "What do you want to do next?",
  ].filter(Boolean).join("\n\n");
}

function threadLabel(thread: HandoffThreadRow) {
  return {
    id: thread.id,
    title: threadDisplayName(thread),
    projectKey: thread.project_key ?? thread.project_label ?? "codex",
    projectLabel: thread.project_label ?? null,
    status: threadStatus(thread),
    activityAt: thread.activity_at ?? thread.updated_at,
    stateSince: thread.state_since ?? thread.activity_at ?? thread.updated_at,
    reasoningEffort: thread.reasoning_effort ?? null,
  };
}

function menuItems(threads: HandoffThreadRow[], activeThreadId: string | null): MenuItem[] {
  return threads.map((thread) => ({ ...threadLabel(thread), current: thread.id === activeThreadId }));
}

type DirectoryStatus = "working" | "pending" | "idle" | "error";

interface DirectoryProject {
  projectKey: string;
  projectLabel: string;
  other: boolean;
  status: DirectoryStatus;
  activityAt: string;
  current: boolean;
  threads: HandoffThreadRow[];
}

function threadStatus(thread: HandoffThreadRow): DirectoryStatus {
  return thread.status === "working" || thread.status === "pending" || thread.status === "error"
    ? thread.status
    : "idle";
}

function statusRank(status: DirectoryStatus) {
  return status === "working" ? 0 : status === "pending" ? 1 : status === "error" ? 2 : 3;
}

function projectStatus(threads: HandoffThreadRow[]): DirectoryStatus {
  return threads.map(threadStatus).sort((a, b) => statusRank(a) - statusRank(b))[0] ?? "idle";
}

function projectGroups(threads: HandoffThreadRow[], activeThreadId: string | null) {
  const byProject = new Map<string, HandoffThreadRow[]>();
  for (const thread of threads) {
    const key = thread.project_label?.trim()
      ? thread.project_key?.trim() || thread.project_label.trim()
      : "other-tasks";
    byProject.set(key, [...(byProject.get(key) ?? []), thread]);
  }
  const groups: DirectoryProject[] = [...byProject.entries()].map(([projectKey, rows]) => {
    const sorted = [...rows].sort((a, b) => (
      Number(b.id === activeThreadId) - Number(a.id === activeThreadId)
      || statusRank(threadStatus(a)) - statusRank(threadStatus(b))
      || String(b.activity_at ?? b.updated_at).localeCompare(String(a.activity_at ?? a.updated_at))
      || b.id.localeCompare(a.id)
    ));
    return {
      projectKey,
      projectLabel: sorted[0]?.project_label?.trim() || "Other tasks",
      other: !sorted[0]?.project_label?.trim(),
      status: projectStatus(sorted),
      activityAt: sorted.reduce((latest, row) => {
        const value = row.activity_at ?? row.updated_at;
        return value > latest ? value : latest;
      }, ""),
      current: sorted.some((row) => row.id === activeThreadId),
      threads: sorted,
    };
  });
  const byLabel = new Map<string, DirectoryProject[]>();
  for (const group of groups) {
    if (group.other) continue;
    const label = group.projectLabel.toLocaleLowerCase();
    byLabel.set(label, [...(byLabel.get(label) ?? []), group]);
  }
  for (const duplicates of byLabel.values()) {
    if (duplicates.length < 2) continue;
    [...duplicates].sort((left, right) => left.projectKey.localeCompare(right.projectKey)).forEach((group, index) => {
      group.projectLabel = `${group.projectLabel} · ${index + 1}`;
    });
  }
  return groups.sort((a, b) => (
    Number(a.other) - Number(b.other)
    || Number(b.current) - Number(a.current)
    || statusRank(a.status) - statusRank(b.status)
    || b.activityAt.localeCompare(a.activityAt)
    || a.projectLabel.localeCompare(b.projectLabel)
  ));
}

function buildThreadDirectory(
  threads: HandoffThreadRow[],
  activeThreadId: string | null,
  options: { rowLimit?: number; collapsedLimit?: number; expandedProjectLimit?: number; extended?: boolean } = {},
) {
  const rowLimit = options.rowLimit ?? 8;
  const collapsedLimit = options.collapsedLimit ?? 5;
  const expandedProjectLimit = options.expandedProjectLimit ?? 3;
  const groups = projectGroups(threads, activeThreadId);
  const important = groups.filter((group) => group.current || group.status !== "idle");
  const expanded = [...important];
  for (const group of groups) {
    if (expanded.includes(group)) continue;
    if (expanded.length >= Math.max(expandedProjectLimit, important.length)) break;
    expanded.push(group);
  }
  expanded.splice(Math.max(expandedProjectLimit, Math.min(8, important.length || expandedProjectLimit)));

  const visibleByProject = new Map<DirectoryProject, HandoffThreadRow[]>();
  for (const group of expanded) visibleByProject.set(group, []);
  let rowCount = 0;
  while (rowCount < rowLimit) {
    let added = false;
    for (const group of expanded) {
      if (rowCount >= rowLimit) break;
      const selected = visibleByProject.get(group) ?? [];
      const next = group.threads[selected.length];
      if (!next) continue;
      selected.push(next);
      visibleByProject.set(group, selected);
      rowCount += 1;
      added = true;
    }
    if (!added) break;
  }

  let menuIndex = 1;
  const references: string[] = [];
  const renderedGroups = expanded.flatMap((group) => {
    const selected = visibleByProject.get(group) ?? [];
    if (selected.length === 0) return [];
    const items = selected.map((thread) => {
      references.push(`thread:${thread.id}`);
      return { ...threadLabel(thread), current: thread.id === activeThreadId, index: menuIndex++ };
    });
    return [{
      projectKey: group.projectKey,
      projectLabel: group.projectLabel,
      status: group.status,
      activityAt: group.activityAt,
      threadCount: group.threads.length,
      hiddenCount: Math.max(0, group.threads.length - selected.length),
      threads: items,
    }];
  });
  const expandedKeys = new Set(expanded.map((group) => group.projectKey));
  const collapsedProjects = groups.filter((group) => !expandedKeys.has(group.projectKey)).slice(0, collapsedLimit).map((group) => {
    references.push(`project:${group.projectKey}`);
    return {
      projectKey: group.projectKey,
      projectLabel: group.projectLabel,
      status: group.status,
      activityAt: group.activityAt,
      threadCount: group.threads.length,
      index: menuIndex++,
    };
  });
  return {
    directory: {
      label: "THREADS" as const,
      totalTasks: threads.length,
      groups: renderedGroups,
      collapsedProjects,
      note: references.length > 0
        ? options.extended
          ? "Reply with a number to open.  /projects · /search · /help"
          : "Reply with a number to open.  /recent · /search · /help"
        : undefined,
    },
    references,
  };
}

function buildProjectDirectory(threads: HandoffThreadRow[], activeThreadId: string | null, projectKey: string) {
  const group = projectGroups(threads, activeThreadId).find((item) => item.projectKey === projectKey);
  if (!group) return null;
  const selected = group.threads.slice(0, 25);
  const references = selected.map((thread) => `thread:${thread.id}`);
  return {
    directory: {
      label: "THREADS" as const,
      totalTasks: group.threads.length,
      groups: [{
        projectKey: group.projectKey,
        projectLabel: group.projectLabel,
        status: group.status,
        activityAt: group.activityAt,
        threadCount: group.threads.length,
        hiddenCount: Math.max(0, group.threads.length - selected.length),
        threads: selected.map((thread, index) => ({ ...threadLabel(thread), current: thread.id === activeThreadId, index: index + 1 })),
      }],
      collapsedProjects: [],
      note: references.length > 0 ? "Reply with a number to open.  /threads · /search · /help" : undefined,
    },
    references,
  };
}

async function saveMenuSnapshot(env: Env, binding: PhoneBindingRow, threads: HandoffThreadRow[], references?: string[]) {
  const now = nowIso();
  const expiresAt = isoFromMs(Date.now() + MENU_SNAPSHOT_TTL_MS);
  const ids = references ?? threads.map((thread) => thread.id);
  await env.DB.prepare(
    `INSERT INTO menu_snapshots (phone_number, owner_id, items_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(phone_number) DO UPDATE SET
       owner_id = excluded.owner_id,
       items_json = excluded.items_json,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).bind(binding.phone_number, binding.owner_id, JSON.stringify(ids), expiresAt, now).run();
  return { ids, expiresAt };
}

async function findMenuSnapshot(env: Env, phoneNumber: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM menu_snapshots WHERE phone_number = ? AND expires_at > ?",
  ).bind(phoneNumber, nowIso()).first<MenuSnapshotRow>();
  if (!row) {
    return null;
  }
  try {
    const ids = JSON.parse(row.items_json) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

async function hasMenuSnapshot(env: Env, phoneNumber: string) {
  return Boolean(await env.DB.prepare(
    "SELECT * FROM menu_snapshots WHERE phone_number = ?",
  ).bind(phoneNumber).first<MenuSnapshotRow>());
}

function parseReplyMedia(value: string | null) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const url = optionalString(item.url);
      return url ? [{ url }] : [];
    });
  } catch {
    return [];
  }
}

function replyMediaJson(mediaUrl: string | null) {
  return mediaUrl ? JSON.stringify([{ url: mediaUrl } satisfies ReplyMedia]) : null;
}

function sendblueMediaGroup(externalId: string | null, mediaUrl: string | null) {
  // Sendblue image batches usually share a message handle prefix with a numeric
  // suffix. Treat that prefix as the group id so Codex sees one combined prompt.
  if (!externalId || !mediaUrl) {
    return { mediaGroupId: null, mediaIndex: null };
  }
  const match = externalId.match(/^(.*)_(\d+)$/);
  return {
    mediaGroupId: match ? match[1] : externalId,
    mediaIndex: match ? Number(match[2]) : 0,
  };
}

function combineReplyRows(rows: HandoffReplyRow[]) {
  // A "reply" shown to Codex can be one text row or a media group. Combine rows
  // into the smallest prompt-shaped object the local Stop hook needs.
  const ordered = [...rows].sort((a, b) => (
    (a.media_index ?? 0) - (b.media_index ?? 0)
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id)
  ));
  const first = ordered[0];
  const body = ordered.find((reply) => reply.body.trim())?.body ?? "";
  const media = ordered.flatMap((reply) => parseReplyMedia(reply.media));
  return first ? {
    id: first.id,
    body,
    media,
    createdAt: first.created_at,
  } : null;
}

function eligiblePendingReplies(rows: HandoffReplyRow[]) {
  // Text is eligible immediately. Media groups become eligible only after no
  // newer image has arrived for MEDIA_GROUP_QUIET_MS.
  const groups = new Map<string, HandoffReplyRow[]>();
  const eligible: Array<ReturnType<typeof combineReplyRows>> = [];
  const cutoff = Date.now() - MEDIA_GROUP_QUIET_MS;

  for (const row of rows) {
    if (!row.media_group_id) {
      eligible.push(combineReplyRows([row]));
      continue;
    }
    groups.set(row.media_group_id, [...(groups.get(row.media_group_id) ?? []), row]);
  }

  for (const groupRows of groups.values()) {
    const newest = Math.max(...groupRows.map((row) => Date.parse(row.created_at)).filter(Number.isFinite));
    if (!Number.isFinite(newest) || newest <= cutoff) {
      eligible.push(combineReplyRows(groupRows));
    }
  }

  return eligible
    .filter(Boolean)
    .sort((a, b) => String(a?.createdAt).localeCompare(String(b?.createdAt)));
}

async function sendControlMessage(env: Env, phoneNumber: string, message: string) {
  // Control messages are best effort. They make the UX nicer, but failure should
  // not prevent pairing, switching, or stopping from completing.
  try {
    await sendSendblueMessage(env, phoneNumber, message);
  } catch {
    console.warn("Sendblue control message failed.");
  }
}

async function recordAppliedControl(
  env: Env,
  binding: PhoneBindingRow,
  content: string | null,
  externalId: string | null,
) {
  if (!externalId || !binding.active_thread_id) return;
  await insertHandoffReply(env, binding.active_thread_id, content ?? "", externalId, "applied", null, binding.owner_id);
}

async function sendOwnerControl(
  env: Env,
  ownerId: string,
  command: string,
  threadId?: string | null,
  argument?: string | null,
) {
  const response = await relaySocket(env).fetch(new Request(`https://imessage-handoff.internal/owners/${ownerId}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, threadId: threadId ?? null, argument: argument ?? null }),
  }));
  if (response.status === 409) return false;
  if (!response.ok) throw new Error("Local Codex service did not accept the command.");
  const result = await response.json() as { delivered?: number };
  return Number(result.delivered) > 0;
}

async function startTypingAndSendOwnerControl(
  env: Env,
  binding: PhoneBindingRow,
  command: string,
  argument?: string | null,
) {
  const delivered = await sendOwnerControl(env, binding.owner_id, command, binding.active_thread_id, argument);
  if (!delivered) {
    await sendControlMessage(env, binding.phone_number, renderOutboundEvent({
      kind: "service.notice",
      code: "needs-attention",
      body: "The local Codex service is offline. Try again after it reconnects.",
    }));
    return false;
  }
  try {
    await sendSendblueTypingIndicator(env, binding.phone_number, "start");
  } catch {
    // Typing is best effort; the local control still needs to run.
  }
  return true;
}

async function sendReadReceipt(env: Env, phoneNumber: string) {
  // Best effort: mark the inbound conversation as read as soon as the webhook is
  // accepted. Failure should not block pairing or prompt delivery.
  try {
    await sendSendblueReadReceipt(env, phoneNumber);
  } catch {
    console.warn("Sendblue read receipt failed.");
  }
}

async function sendPairingContactCard(env: Env, phoneNumber: string, origin: string) {
  // A vCard lets the user save this Sendblue number as "Codex" so future
  // messages are recognizable in iMessage. It is optional and sent only once.
  await sendSendblueMessage(env, phoneNumber, CONTACT_CARD_MESSAGE);
  await sendSendblueMessage(env, phoneNumber, null, new URL(`/${CONTACT_CARD_FILENAME}`, origin).toString());
}

async function setActiveThreadForOwner(env: Env, ownerId: string, threadId: string | null) {
  await env.DB.prepare(
    "UPDATE phone_bindings SET active_thread_id = ?, updated_at = ? WHERE owner_id = ?",
  ).bind(threadId, nowIso(), ownerId).run();
}

async function touchThread(env: Env, threadId: string) {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE handoff_threads
      SET updated_at = ?, activity_at = ?, state_since = ?,
          status = CASE WHEN catalog_source = 'service' THEN 'pending' ELSE status END
      WHERE id = ?`,
  )
    .bind(now, now, now, threadId)
    .run();
}

function sendblueApiBaseUrl(env: Env) {
  return (env.SENDBLUE_API_BASE_URL || "https://api.sendblue.com/api").replace(/\/+$/, "");
}

function sendblueAuthHeaders(env: Env) {
  const apiKey = env.SENDBLUE_API_KEY?.trim();
  const secretKey = env.SENDBLUE_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) {
    throw new Error("Sendblue credentials are missing.");
  }
  return {
    "content-type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": secretKey,
  };
}

function sendblueAuthOnlyHeaders(env: Env) {
  const apiKey = env.SENDBLUE_API_KEY?.trim();
  const secretKey = env.SENDBLUE_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) {
    throw new Error("Sendblue credentials are missing.");
  }
  return {
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": secretKey,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readSendblueJson(response: Response) {
  // Do not include provider response bodies in thrown errors. Some providers
  // echo request content in error payloads, which would risk logging messages.
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Sendblue API returned a non-JSON response.");
  }
}

function assertSendblueAccepted(body: unknown) {
  const wrapper = isRecord(body) ? body : {};
  const payload = isRecord(wrapper.data) ? wrapper.data : wrapper;
  const status = optionalString(payload.status) ?? optionalString(wrapper.status);
  const normalizedStatus = status?.toUpperCase();
  const messageHandle = optionalString(payload.message_handle) ?? optionalString(wrapper.message_handle);
  const errorCode = payload.error_code ?? wrapper.error_code;

  if (normalizedStatus === "ERROR" || normalizedStatus === "DECLINED") {
    throw new Error(`Sendblue rejected message with status ${normalizedStatus}.`);
  }
  if (errorCode !== null && errorCode !== undefined && errorCode !== 0 && errorCode !== "0") {
    throw new Error(`Sendblue rejected message with error_code ${String(errorCode)}.`);
  }
  if (!messageHandle) {
    throw new Error("Sendblue response did not include a message_handle.");
  }
  return {
    messageHandle,
    status: normalizedStatus ?? "ACCEPTED",
  };
}

function mediaUrlFromSendblue(body: unknown) {
  const wrapper = isRecord(body) ? body : {};
  const payload = isRecord(wrapper.data) ? wrapper.data : wrapper;
  const mediaUrl = optionalString(payload.media_url)
    ?? optionalString(payload.url)
    ?? optionalString(payload.mediaUrl)
    ?? optionalString(wrapper.media_url);
  if (!mediaUrl) {
    throw new Error("Sendblue media upload response did not include a media_url.");
  }
  return mediaUrl;
}

function formatForSendblue(content: string) {
  // Codex replies can contain Markdown. Convert the common cases to plain text
  // so iMessage receives something readable.
  return content
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function base64DecodedLength(value: string) {
  // Calculate decoded size before calling atob. That lets us reject oversized
  // generated images without first allocating the decoded byte array.
  const clean = value.replace(/\s/g, "");
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error("Generated image data must be valid base64.");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return (clean.length / 4) * 3 - padding;
}

function parseGeneratedImages(value: unknown) {
  // The local Stop hook sends generated images as base64. Limit both count and
  // decoded bytes before upload so a compromised token cannot use /status as a
  // general large-file ingress path.
  if (!Array.isArray(value)) {
    return [];
  }
  const images: GeneratedImageInput[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const dataBase64 = optionalString(item.dataBase64);
    if (!dataBase64) {
      continue;
    }
    const mimeType = optionalString(item.mimeType) ?? "image/png";
    if (!ALLOWED_GENERATED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error("Generated image mimeType is not supported.");
    }
    const decodedBytes = base64DecodedLength(dataBase64);
    if (decodedBytes > MAX_GENERATED_IMAGE_BYTES) {
      requestTooLarge("Generated image is too large.");
    }
    totalBytes += decodedBytes;
    if (totalBytes > MAX_GENERATED_IMAGE_TOTAL_BYTES) {
      requestTooLarge("Generated images are too large.");
    }
    if (images.length >= MAX_GENERATED_IMAGES) {
      requestTooLarge("Too many generated images.");
    }
    images.push({
      dataBase64,
      filename: optionalLimitedString(item.filename, "filename", 120) ?? "image.png",
      mimeType,
    });
  }
  return images;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function escapeVCardValue(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldVCardLine(line: string) {
  // vCard lines are folded with CRLF + space. iOS contact previews are more
  // reliable with embedded photos than with remote PHOTO URLs, but the base64
  // line needs folding so parsers accept the card.
  const chunks = [];
  for (let i = 0; i < line.length; i += 73) {
    chunks.push((i === 0 ? "" : " ") + line.slice(i, i + 73));
  }
  return chunks.join("\r\n");
}

function contactCardResponse(request: Request, env: Env) {
  const phoneNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+12344198201";
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCardValue("Codex")}`,
    `N:${escapeVCardValue("Codex")};;;;`,
    `TEL;TYPE=CELL:${phoneNumber}`,
    foldVCardLine(`PHOTO;ENCODING=b;TYPE=JPEG:${CODEX_CONTACT_IMAGE_BASE64}`),
    "END:VCARD",
    "",
  ].join("\r\n");

  return new Response(vcard, {
    headers: {
      "content-type": "text/vcard; charset=utf-8",
      "content-disposition": `attachment; filename="${CONTACT_CARD_FILENAME}"`,
      "cache-control": "public, max-age=3600",
    },
  });
}

function contactCardImageResponse() {
  return new Response(base64ToBytes(CODEX_CONTACT_IMAGE_BASE64), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function uploadSendblueMedia(env: Env, image: GeneratedImageInput) {
  const form = new FormData();
  const bytes = base64ToBytes(image.dataBase64);
  form.append("file", new Blob([bytes], { type: image.mimeType }), image.filename);

  const response = await fetch(`${sendblueApiBaseUrl(env)}/upload-file`, {
    method: "POST",
    headers: sendblueAuthOnlyHeaders(env),
    body: form,
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue media API returned HTTP ${response.status}.`);
  }
  return mediaUrlFromSendblue(body);
}

async function sendSendblueMessage(env: Env, number: string, content: string | null, mediaUrl: string | null = null) {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+12344198201";
  const payload: Record<string, string> = {
    number,
    from_number: fromNumber,
  };
  if (content) {
    payload.content = content;
  }
  if (mediaUrl) {
    payload.media_url = mediaUrl;
  }

  const response = await fetch(`${sendblueApiBaseUrl(env)}/send-message`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify(payload),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue API returned HTTP ${response.status}.`);
  }
  return assertSendblueAccepted(body);
}

async function sendSendblueCarousel(env: Env, number: string, mediaUrls: string[]) {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+12344198201";

  const response = await fetch(`${sendblueApiBaseUrl(env)}/send-carousel`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify({
      number,
      from_number: fromNumber,
      media_urls: mediaUrls,
    }),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue carousel API returned HTTP ${response.status}.`);
  }
  return assertSendblueAccepted(body);
}

async function lookupSendblueService(env: Env, number: string) {
  const url = new URL(`${sendblueApiBaseUrl(env)}/evaluate-service`);
  url.searchParams.set("number", number);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: sendblueAuthOnlyHeaders(env),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue lookup API returned HTTP ${response.status}.`);
  }
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const service = isRecord(payload) ? optionalString(payload.service) : null;
  return service?.toLowerCase() ?? null;
}

async function shouldUseSendblueCarousel(env: Env, number: string) {
  try {
    return await lookupSendblueService(env, number) === "imessage";
  } catch {
    console.warn("Sendblue service lookup failed.");
  }
  return false;
}

async function sendStatusNotification(
  env: Env,
  number: string,
  lastAssistantMessage: string | null,
  images: GeneratedImageInput[],
) {
  // A Stop hook status can be text, generated images, or both. Carousels are
  // iMessage-only, so non-iMessage recipients get separate media messages.
  const formattedText = lastAssistantMessage ? formatForSendblue(lastAssistantMessage) : null;
  const mediaUrls = await Promise.all(images.map((image) => uploadSendblueMedia(env, image)));

  if (mediaUrls.length === 0) {
    return formattedText ? sendSendblueMessage(env, number, formattedText) : null;
  }
  if (mediaUrls.length === 1) {
    return sendSendblueMessage(env, number, formattedText, mediaUrls[0]);
  }
  if (await shouldUseSendblueCarousel(env, number)) {
    if (formattedText) {
      await sendSendblueMessage(env, number, formattedText);
    }
    return sendSendblueCarousel(env, number, mediaUrls);
  }
  let sendResult: Awaited<ReturnType<typeof sendSendblueMessage>> | null = null;
  if (formattedText) {
    sendResult = await sendSendblueMessage(env, number, formattedText);
  }
  for (const mediaUrl of mediaUrls) {
    sendResult = await sendSendblueMessage(env, number, null, mediaUrl);
  }
  return sendResult;
}

async function sendSendblueTypingIndicator(env: Env, number: string, state: "start" | "stop" = "start") {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+12344198201";
  const response = await fetch(`${sendblueApiBaseUrl(env)}/send-typing-indicator`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify({
      number,
      from_number: fromNumber,
      ...(state === "stop" ? { state } : {}),
    }),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue typing API returned HTTP ${response.status}.`);
  }
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const indicatorStatus = isRecord(payload) ? optionalString(payload.status)?.toUpperCase() : null;
  if (indicatorStatus === "ERROR") {
    throw new Error("Sendblue typing indicator failed.");
  }
}

async function sendSendblueReadReceipt(env: Env, number: string) {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+12344198201";
  const response = await fetch(`${sendblueApiBaseUrl(env)}/mark-read`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify({
      number,
      from_number: fromNumber,
    }),
  });
  await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue read receipt API returned HTTP ${response.status}.`);
  }
}

async function handleStatus(request: Request, env: Env, threadId: string) {
  // Called by the Stop hook after Codex finishes a local turn. It updates thread
  // status and forwards the final assistant reply back to iMessage if paired.
  // This is the only route that legitimately carries large bodies because
  // generated images arrive here as base64.
  const body = await readJsonBody<StatusBody>(request, STATUS_JSON_BODY_MAX_BYTES);
  const ownerId = await requireOwnerId(request);
  const thread = assertAuthorized(await findThread(env, threadId), ownerId);
  const updatedAt = nowIso();
  const lastStopAt = optionalLimitedString(body.createdAt, "createdAt", 64) ?? updatedAt;
  const status = optionalLimitedString(body.status, "status", MAX_STATUS_LENGTH) ?? "stopped";
  const cwd = optionalLimitedString(body.cwd, "cwd", MAX_CWD_LENGTH) ?? thread.cwd;
  const lastAssistantMessage = optionalLimitedString(body.lastAssistantMessage, "lastAssistantMessage", MAX_ASSISTANT_MESSAGE_LENGTH);
  const generatedImages = parseGeneratedImages(body.generatedImages);
  let notification: JsonRecord | null = null;

  await env.DB.prepare(
    `UPDATE handoff_threads
      SET cwd = ?,
          status = ?,
          last_stop_at = ?,
          updated_at = ?,
          activity_at = ?,
          state_since = ?
      WHERE id = ?`,
  ).bind(cwd, status, lastStopAt, updatedAt, updatedAt, updatedAt, threadId).run();

  if (lastAssistantMessage || generatedImages.length > 0) {
    const binding = await findDeliveryBinding(env, thread);
    if (binding) {
      try {
        if (generatedImages.length > 0 && thread.catalog_source === "service") {
          await sendSendblueMessage(env, binding.phone_number, [
            threadHeader(threadLabel(thread)),
            threadDisplayName(thread),
            "Generated output follows.",
          ].join("\n\n"));
        }
        const sendResult = await sendStatusNotification(env, binding.phone_number, lastAssistantMessage, generatedImages);
        if (sendResult) {
          notification = {
            sent: true,
            status: sendResult.status,
            messageHandle: sendResult.messageHandle,
          };
        }
      } catch (caught) {
        const errorMessage = caught instanceof Error ? caught.message : "Sendblue status notification failed.";
        notification = {
          sent: false,
          status: "ERROR",
          error: errorMessage,
        };
        console.warn("Sendblue status notification failed.");
        // Handoff status publishing should never break the local Stop hook.
      }
    } else {
      notification = {
        sent: false,
        status: "NO_BINDING",
      };
    }
  }

  return json({ ok: true, notification });
}

async function handleClaim(request: Request, env: Env, threadId: string, replyId: string, ctx?: WaitUntilContext) {
  // Claim returns exactly one remote prompt to local Codex and marks it applied.
  // The typing indicator is best-effort; Sendblue delivers it only for iMessage.
  const ownerId = await requireOwnerId(request);
  assertAuthorized(await findThread(env, threadId), ownerId);
  const claim = await relaySocket(env)
    .fetch(new Request(`https://imessage-handoff.internal/threads/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(replyId)}/claim`, {
      method: "POST",
    }));
  if (!claim.ok) {
    return claim;
  }
  const body = await claim.json() as { ok?: boolean; reply?: unknown };
  const typingIndicator = (async () => {
    const thread = await findThread(env, threadId);
    const binding = thread ? await findDeliveryBinding(env, thread) : null;
    if (!binding) {
      return;
    }
    try {
      await sendSendblueTypingIndicator(env, binding.phone_number);
    } catch {
      console.warn("Sendblue typing indicator failed.");
    }
  })();
  // Tests can call the handler without a Worker context. The promise is caught
  // above either way; in production, waitUntil keeps it alive after the response.
  if (ctx) {
    ctx.waitUntil(typingIndicator);
  }
  return json(body);
}

async function insertHandoffReply(
  env: Env,
  threadId: string,
  body: string,
  externalId: string | null,
  status: "pending" | "applied" = "pending",
  mediaUrl: string | null = null,
  ownerId: string | null = null,
) {
  // Inbound content always goes through the global DO so it stays out of D1.
  const response = await relaySocket(env)
    .fetch(new Request(`https://imessage-handoff.internal/threads/${encodeURIComponent(threadId)}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, externalId, status, mediaUrl, ownerId }),
    }));
  const responseBody = await response.json() as { id?: string };
  if (!response.ok || !responseBody.id) {
    throw new Error("Handoff relay buffer did not accept reply.");
  }
  return responseBody.id;
}

function relaySocket(env: Env) {
  if (!env.HANDOFF_SOCKET) {
    throw Object.assign(new Error("Handoff socket Durable Object is not configured."), { status: 500 });
  }
  return env.HANDOFF_SOCKET.get(env.HANDOFF_SOCKET.idFromName("global"));
}

async function handleSendblueWebhook(request: Request, env: Env, ctx?: WaitUntilContext) {
  // Sendblue calls this for inbound and outbound events. We only care about
  // inbound RECEIVED messages from a phone number, and we require a shared secret.
  const expectedSecret = env.SENDBLUE_WEBHOOK_SECRET?.trim();
  if (!expectedSecret) {
    return error(500, "Sendblue webhook secret is not configured.");
  }
  if (request.headers.get("sb-signing-secret") !== expectedSecret) {
    return error(401, "Unauthorized.");
  }

  const body = await readJsonBody<SendblueWebhookBody>(request, WEBHOOK_JSON_BODY_MAX_BYTES);
  const content = optionalLimitedString(body.content, "content", MAX_WEBHOOK_CONTENT_LENGTH);
  const mediaUrl = optionalLimitedString(body.media_url, "media_url", MAX_URL_LENGTH);
  const fromNumber = optionalLimitedString(body.from_number, "from_number", 64) ?? optionalLimitedString(body.number, "number", 64);
  const externalId = optionalLimitedString(body.message_handle, "message_handle", 200);
  const status = optionalLimitedString(body.status, "status", MAX_STATUS_LENGTH);
  const isOutbound = body.is_outbound === true || String(body.is_outbound).toLowerCase() === "true";

  if (isOutbound || status?.toUpperCase() !== "RECEIVED" || (!content && !mediaUrl) || !fromNumber) {
    return json({ ok: true, ignored: true });
  }
  const readReceipt = sendReadReceipt(env, fromNumber);
  if (ctx) {
    ctx.waitUntil(readReceipt);
  } else {
    await readReceipt;
  }
  if (externalId && await findExternalReply(env, externalId)) {
    return json({ ok: true, duplicate: true });
  }

  const pairingCodeCandidate = content ? content.toUpperCase() : null;
  const looksLikePairingCode = isPairingCodeCandidate(pairingCodeCandidate);
  if (looksLikePairingCode) {
    // A blocked phone should not receive provider-side replies for repeated
    // guesses after the local block is active.
    const limit = await pairingRateLimitStatus(env, fromNumber);
    if (limit.blocked) {
      await sendControlMessage(env, fromNumber, pairingRateLimitMessage(limit.retryAfterSeconds));
      return json({
        ok: true,
        paired: false,
        rateLimited: true,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
  }

  const pairingThread = looksLikePairingCode ? await findPairingThread(env, pairingCodeCandidate ?? "") : null;
  const servicePairing = looksLikePairingCode ? await findInstallationPairingByCode(env, pairingCodeCandidate ?? "") : null;
  if (servicePairing) {
    const now = nowIso();
    const threads = await listEnabledThreadsForOwner(env, servicePairing.owner_id);
    const activeThreadId = threads[0]?.id ?? null;
    const previousBinding = await findPhoneBinding(env, fromNumber);
    await env.DB.prepare("DELETE FROM phone_bindings WHERE owner_id = ? AND phone_number != ?")
      .bind(servicePairing.owner_id, fromNumber).run();
    await env.DB.prepare(
      `INSERT INTO phone_bindings (phone_number, owner_id, active_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(phone_number) DO UPDATE SET
         owner_id = excluded.owner_id,
         active_thread_id = excluded.active_thread_id,
         updated_at = excluded.updated_at`,
    ).bind(fromNumber, servicePairing.owner_id, activeThreadId, now, now).run();
    await env.DB.prepare(
      "UPDATE installation_pairings SET pairing_code = NULL, pairing_code_expires_at = NULL, updated_at = ? WHERE owner_id = ?",
    ).bind(now, servicePairing.owner_id).run();
    await clearPairingAttempts(env, fromNumber);
    if (externalId && activeThreadId) {
      await insertHandoffReply(env, activeThreadId, content ?? "", externalId, "applied", null, servicePairing.owner_id);
    }
    if (!previousBinding?.contact_card_sent_at) {
      try {
        await sendPairingContactCard(env, fromNumber, new URL(request.url).origin);
        const sentAt = nowIso();
        await env.DB.prepare("UPDATE phone_bindings SET contact_card_sent_at = ?, updated_at = ? WHERE phone_number = ?")
          .bind(sentAt, sentAt, fromNumber).run();
      } catch {
        console.warn("Sendblue contact card failed.");
      }
    }
    await sendControlMessage(env, fromNumber, renderOutboundEvent({
      kind: "service.notice",
      code: "connected",
      body: `${threads.length} recent thread${threads.length === 1 ? " is" : "s are"} available.\n\nText /threads to choose one.`,
    }));
    return json({ ok: true, paired: true, threadId: activeThreadId, service: true });
  }
  if (pairingThread) {
    // First-time setup: user texts the pairing code, linking this phone number
    // to the owner id derived from the local install token.
    const now = nowIso();
    const previousBinding = await findPhoneBinding(env, fromNumber);
    await env.DB.prepare(
      "DELETE FROM phone_bindings WHERE owner_id = ? AND phone_number != ?",
    ).bind(pairingThread.owner_id, fromNumber).run();
    await env.DB.prepare(
      `INSERT INTO phone_bindings (phone_number, owner_id, active_thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO UPDATE SET
          owner_id = excluded.owner_id,
          active_thread_id = excluded.active_thread_id,
          updated_at = excluded.updated_at`,
    ).bind(fromNumber, pairingThread.owner_id, pairingThread.id, now, now).run();
    await env.DB.prepare(
      "UPDATE handoff_threads SET pairing_code = NULL, pairing_code_expires_at = NULL, updated_at = ? WHERE id = ?",
    ).bind(now, pairingThread.id).run();
    await clearPairingAttempts(env, fromNumber);
    if (externalId) {
      await insertHandoffReply(env, pairingThread.id, content ?? "", externalId, "applied");
    }
    if (!previousBinding?.contact_card_sent_at) {
      try {
        await sendPairingContactCard(env, fromNumber, new URL(request.url).origin);
        const sentAt = nowIso();
        await env.DB.prepare(
          "UPDATE phone_bindings SET contact_card_sent_at = ?, updated_at = ? WHERE phone_number = ?",
        ).bind(sentAt, sentAt, fromNumber).run();
      } catch {
        console.warn("Sendblue contact card failed.");
      }
    }
    try {
      await sendSendblueMessage(env, fromNumber, handoffActivationMessage(pairingThread));
    } catch {
      // Pairing should still succeed if the confirmation send is temporarily unavailable.
    }
    return json({ ok: true, paired: true, threadId: pairingThread.id });
  }

  const binding = await findPhoneBinding(env, fromNumber);
  if (!binding) {
    if (looksLikePairingCode) {
      // Unknown normal texts are ignored, but code-shaped texts get a helpful
      // response and count against the phone's pairing-attempt window.
      const limit = await recordFailedPairingAttempt(env, fromNumber);
      const message = limit.blocked
        ? pairingRateLimitMessage(limit.retryAfterSeconds)
        : INVALID_PAIRING_CODE_MESSAGE;
      await sendControlMessage(env, fromNumber, message);
      return json({
        ok: true,
        paired: false,
        invalidPairingCode: !limit.blocked,
        rateLimited: limit.blocked,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    return json({ ok: true, ignored: true });
  }

  const commandText = content?.trim().toLowerCase() ?? "";
  const slashCommand = content ? parseSlashCommand(content) : null;
  if (!mediaUrl && (
    THREAD_LIST_COMMANDS.has(commandText)
    || slashCommand?.command === "threads"
    || slashCommand?.command === "recent"
    || slashCommand?.command === "refresh"
  )) {
    const persistentService = await findServiceInstallation(env, binding.owner_id);
    if (serviceSupports(persistentService, "local-directory-v1")) {
      const argument = slashCommand?.command === "recent"
        ? "recent"
        : slashCommand?.command === "refresh"
          ? "refresh"
          : null;
      const routed = await startTypingAndSendOwnerControl(env, binding, "threads", argument);
      await recordAppliedControl(env, binding, content, externalId);
      return json({
        ok: true,
        command: slashCommand?.command === "refresh" ? "refresh" : "list",
        routed,
      });
    }
    const threads = await listEnabledThreadsForOwner(env, binding.owner_id);
    const extended = slashCommand?.command === "recent";
    const planned = buildThreadDirectory(threads, binding.active_thread_id, extended
      ? { rowLimit: 10, collapsedLimit: 10, expandedProjectLimit: 4, extended: true }
      : {});
    await saveMenuSnapshot(env, binding, [], planned.references);
    await sendControlMessage(env, fromNumber, renderThreadDirectory(planned.directory, { now: new Date() }));
    if (externalId && binding.active_thread_id) {
      await insertHandoffReply(env, binding.active_thread_id, content ?? "", externalId, "applied");
    }
    return json({
      ok: true,
      command: slashCommand?.command === "refresh" ? "refresh" : "list",
      threadCount: threads.length,
      projectCount: projectGroups(threads, binding.active_thread_id).length,
    });
  }

  if (!mediaUrl && slashCommand?.command === "help") {
    await sendControlMessage(env, fromNumber, renderHelp());
    await recordAppliedControl(env, binding, content, externalId);
    return json({ ok: true, command: "help" });
  }

  const detailCommands: Record<string, string> = {
    thread: "open",
    status: "open",
    request: "request",
    message: "request",
    turn: "turn",
    history: "history",
    reasoning: "reasoning",
    retry: "retry",
    dismiss: "dismiss",
  };
  if (!mediaUrl && slashCommand && detailCommands[slashCommand.command]) {
    if (!binding.active_thread_id) {
      await sendControlMessage(env, fromNumber, renderOutboundEvent({
        kind: "service.notice",
        code: "needs-attention",
        body: "No thread is selected.\nText /threads to choose one.",
      }));
      return json({ ok: true, command: slashCommand.command, routed: false });
    }
    const argument = slashCommand.command === "status"
      ? "status"
      : slashCommand.argument;
    const routed = await startTypingAndSendOwnerControl(env, binding, detailCommands[slashCommand.command], argument);
    await recordAppliedControl(env, binding, content, externalId);
    return json({ ok: true, command: slashCommand.command, routed, threadId: binding.active_thread_id });
  }

  if (!mediaUrl && slashCommand?.command === "search") {
    const query = slashCommand.argument?.toLowerCase() ?? "";
    const threads = (await listEnabledThreadsForOwner(env, binding.owner_id))
      .filter((thread) => !query || `${thread.title ?? ""} ${thread.project_label ?? ""}`.toLowerCase().includes(query))
      .slice(0, 8);
    await saveMenuSnapshot(env, binding, [], threads.map((thread) => `thread:${thread.id}`));
    await sendControlMessage(env, fromNumber, renderThreadMenu(menuItems(threads, binding.active_thread_id)));
    await recordAppliedControl(env, binding, content, externalId);
    return json({ ok: true, command: "search", threadCount: threads.length });
  }

  if (!mediaUrl && slashCommand?.command === "projects") {
    const groups = projectGroups(await listEnabledThreadsForOwner(env, binding.owner_id), binding.active_thread_id).slice(0, 25);
    const items = groups.map((group) => ({
      title: group.projectLabel,
      projectKey: group.projectKey,
      status: group.status,
      activityAt: group.activityAt,
      threadCount: group.threads.length,
    }));
    await saveMenuSnapshot(env, binding, [], groups.map((group) => `project:${group.projectKey}`));
    await sendControlMessage(env, fromNumber, renderThreadMenu(items, { label: "PROJECTS", note: "Reply with a number to browse that project." }));
    await recordAppliedControl(env, binding, content, externalId);
    return json({ ok: true, command: "projects", projectCount: groups.length });
  }

  if (!mediaUrl && slashCommand?.command === "cancel") {
    const routed = await sendOwnerControl(env, binding.owner_id, "cancel", binding.active_thread_id);
    if (!routed) {
      await sendControlMessage(env, fromNumber, renderOutboundEvent({
        kind: "service.notice",
        code: "needs-attention",
        body: "The local Codex service is offline. There is no connected run to cancel.",
      }));
    }
    await recordAppliedControl(env, binding, content, externalId);
    return json({ ok: true, command: "cancel", routed });
  }

  if (!mediaUrl && content?.trim().startsWith("/") && !slashCommand) {
    await sendControlMessage(env, fromNumber, [
      renderOutboundEvent({ kind: "service.notice", code: "needs-attention", body: "That command is not available." }),
      renderHelp(),
    ].join("\n\n"));
    await recordAppliedControl(env, binding, content, externalId);
    return json({ ok: true, command: "unknown" });
  }

  const selection = content ? parseMenuSelection(content) : null;
  const snapshotIds = !mediaUrl && selection ? await findMenuSnapshot(env, fromNumber) : null;
  if (!mediaUrl && content && selection && !snapshotIds && await hasMenuSnapshot(env, fromNumber)) {
    const persistentService = await findServiceInstallation(env, binding.owner_id);
    if (serviceSupports(persistentService, "local-directory-v1")) {
      await sendControlMessage(env, fromNumber, renderOutboundEvent({
        kind: "service.notice",
        code: "needs-attention",
        body: "That menu expired. A fresh directory is on the way; reply with a new number.",
      }));
      const routed = await startTypingAndSendOwnerControl(env, binding, "threads", "refresh");
      await recordAppliedControl(env, binding, content, externalId);
      return json({ ok: true, command: "stale-menu", refreshed: routed });
    }
    const threads = await listEnabledThreadsForOwner(env, binding.owner_id);
    const planned = buildThreadDirectory(threads, binding.active_thread_id);
    await saveMenuSnapshot(env, binding, [], planned.references);
    await sendControlMessage(env, fromNumber, renderOutboundEvent({
      kind: "service.notice",
      code: "needs-attention",
      body: "That menu expired. Here is a fresh directory; reply with a new number.",
    }));
    await sendControlMessage(env, fromNumber, renderThreadDirectory(planned.directory, { now: new Date() }));
    if (externalId && binding.active_thread_id) {
      await insertHandoffReply(env, binding.active_thread_id, content, externalId, "applied", null, binding.owner_id);
    }
    return json({ ok: true, command: "stale-menu", refreshed: true });
  }
  if (!mediaUrl && content && selection && snapshotIds) {
    const selectedId = snapshotIds[selection.index];
    if (selectedId?.startsWith("project:")) {
      const projectKey = selectedId.slice("project:".length);
      const threads = await listEnabledThreadsForOwner(env, binding.owner_id);
      const planned = buildProjectDirectory(threads, binding.active_thread_id, projectKey);
      if (!planned) {
        await sendControlMessage(env, fromNumber, renderOutboundEvent({
          kind: "service.notice",
          code: "needs-attention",
          body: "That project is no longer available.\nText /threads for a fresh list.",
        }));
        return json({ ok: true, command: "project", projectKey, threadCount: 0 });
      }
      await saveMenuSnapshot(env, binding, [], planned.references);
      if (selection.prompt) {
        planned.directory.note = "Choose a task first. The text after the project number was not sent; use “N: your message” on this task list.";
      }
      await sendControlMessage(env, fromNumber, renderThreadDirectory(planned.directory, { now: new Date() }));
      await recordAppliedControl(env, binding, content, externalId);
      return json({ ok: true, command: "project", projectKey, threadCount: planned.references.length, promptNotSent: Boolean(selection.prompt) });
    }
    const threadId = selectedId?.startsWith("thread:") ? selectedId.slice("thread:".length) : selectedId;
    const selected = threadId ? await findThread(env, threadId) : null;
    if (
      !selected
      || selected.owner_id !== binding.owner_id
      || selected.handoff_enabled !== 1
      || selected.visible === 0
      || selected.archived === 1
    ) {
      await sendControlMessage(env, fromNumber, renderOutboundEvent({
        kind: "service.notice",
        code: "needs-attention",
        body: "That menu has changed.\nText /threads for a fresh list.",
      }));
      if (externalId && binding.active_thread_id) {
        await insertHandoffReply(env, binding.active_thread_id, content, externalId, "applied");
      }
      return json({ ok: true, command: "switch", switched: false });
    }
    const persistentService = await findServiceInstallation(env, binding.owner_id);
    const serviceOnline = Boolean(persistentService) && await isServiceSocketConnected(env, binding.owner_id);
    const contextChanged = binding.active_thread_id !== selected.id;
    await setActiveThreadForOwner(env, binding.owner_id, selected.id);
    if (contextChanged && persistentService) {
      await sendControlMessage(env, fromNumber, renderOutboundEvent({ kind: "service.switched", thread: threadLabel(selected) }));
    }
    if (selection.prompt) {
      if ((persistentService || selected.catalog_source === "service") && !serviceOnline) {
        await sendControlMessage(env, fromNumber, renderOutboundEvent({
          kind: "service.notice",
          code: "needs-attention",
          body: "The local Codex service is offline. Your message was not queued; try again after it reconnects.",
        }));
        return json({ ok: true, command: "switch-and-send", switched: true, threadId: selected.id, serviceOffline: true });
      }
      const replyId = await insertHandoffReply(env, selected.id, selection.prompt, externalId, "pending", null, serviceOnline ? binding.owner_id : null);
      await touchThread(env, selected.id);
      return json({ ok: true, command: "switch-and-send", switched: true, threadId: selected.id, replyId });
    } else if (externalId) {
      await insertHandoffReply(env, selected.id, content, externalId, "applied");
    }
    const selectedBinding = { ...binding, active_thread_id: selected.id };
    if (persistentService) await startTypingAndSendOwnerControl(env, selectedBinding, "open");
    return json({ ok: true, command: "switch", switched: true, threadId: selected.id });
  }

  if (!binding.active_thread_id) {
    await sendControlMessage(env, fromNumber, renderOutboundEvent({ kind: "service.notice", code: "needs-attention", body: "No thread is selected.\nText /threads to choose one." }));
    return json({ ok: true, ignored: true, noActiveThread: true });
  }

  const activeThread = await findThread(env, binding.active_thread_id);
  if (!activeThread || activeThread.handoff_enabled !== 1 || activeThread.visible === 0 || activeThread.archived === 1) {
    await setActiveThreadForOwner(env, binding.owner_id, null);
    await sendControlMessage(env, fromNumber, renderOutboundEvent({ kind: "service.notice", code: "needs-attention", body: "The selected thread is no longer available.\nText /threads to choose another." }));
    return json({ ok: true, ignored: true, noActiveThread: true });
  }

  const serviceDelivery = await findServiceInstallation(env, binding.owner_id);
  const serviceOnline = Boolean(serviceDelivery) && await isServiceSocketConnected(env, binding.owner_id);
  if ((serviceDelivery || activeThread.catalog_source === "service") && !serviceOnline) {
    await sendControlMessage(env, fromNumber, renderOutboundEvent({
      kind: "service.notice",
      code: "needs-attention",
      body: "The local Codex service is offline. Restart iMessage Handoff before sending task messages.",
    }));
    return json({ ok: true, ignored: true, serviceOffline: true });
  }
  const replyId = await insertHandoffReply(
    env,
    binding.active_thread_id,
    content ?? "",
    externalId,
    "pending",
    mediaUrl,
    serviceOnline && serviceDelivery?.delivery_mode === "service" ? binding.owner_id : null,
  );
  await touchThread(env, binding.active_thread_id);
  return json({ ok: true, replyId });
}

async function handleGetThread(request: Request, env: Env, threadId: string) {
  // Debug/read endpoint for local development and smoke tests.
  const ownerId = await requireOwnerId(request);
  const thread = assertAuthorized(await findThread(env, threadId), ownerId);
  return json(publicThread(thread));
}

async function handleStopThread(request: Request, env: Env, threadId: string) {
  // stop-handoff disables the current thread and, if possible, moves the paired
  // phone to the next most recently active thread.
  const ownerId = await requireOwnerId(request);
  const thread = assertAuthorized(await findThread(env, threadId), ownerId);
  const stoppedAt = nowIso();

  await env.DB.prepare(
    `UPDATE handoff_threads
      SET status = 'stopped',
          handoff_enabled = 0,
          pairing_code = NULL,
          pairing_code_expires_at = NULL,
          updated_at = ?
      WHERE id = ?`,
  ).bind(stoppedAt, threadId).run();

  let nextActiveThreadId: string | null = null;
  const binding = await findPhoneBindingForOwner(env, thread.owner_id);
  if (binding?.active_thread_id === threadId) {
    const remaining = await listEnabledThreadsForOwner(env, thread.owner_id);
    nextActiveThreadId = remaining[0]?.id ?? null;
    await setActiveThreadForOwner(env, thread.owner_id, nextActiveThreadId);
  } else {
    nextActiveThreadId = binding?.active_thread_id ?? null;
  }

  return json({ ok: true, id: threadId, handoffEnabled: false, nextActiveThreadId });
}

async function handleThreadEvents(request: Request, env: Env, threadId: string) {
  // WebSocket delivery: authenticate in the Worker, then hand the upgraded
  // connection to the single global DO that owns the in-memory buffer.
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return error(426, "WebSocket upgrade required.");
  }
  const token = authTokenFromRequestOrUrl(request);
  if (!token) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  const ownerId = await ownerIdFromToken(token);
  assertAuthorized(await findThread(env, threadId), ownerId);
  if ((await findServiceInstallation(env, ownerId))?.delivery_mode === "service") {
    return error(409, "Persistent service delivery is enabled.");
  }
  if (!env.HANDOFF_SOCKET) {
    return error(500, "Handoff socket Durable Object is not configured.");
  }

  const id = env.HANDOFF_SOCKET.idFromName("global");
  return env.HANDOFF_SOCKET.get(id).fetch(request);
}

async function handleServiceEvents(request: Request, env: Env) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return error(426, "WebSocket upgrade required.");
  }
  const token = authTokenFromRequestOrUrl(request);
  if (!token) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  const ownerId = await ownerIdFromToken(token);
  if (!await findServiceInstallation(env, ownerId)) {
    throw Object.assign(new Error("Service is not registered."), { status: 404 });
  }
  if (!env.HANDOFF_SOCKET) {
    return error(500, "Handoff socket Durable Object is not configured.");
  }
  const forwarded = new Request(new URL(`/owners/${ownerId}/events`, request.url), request);
  return env.HANDOFF_SOCKET.get(env.HANDOFF_SOCKET.idFromName("global")).fetch(forwarded);
}

export async function handleRequest(request: Request, env: Env, ctx?: WaitUntilContext) {
  // Thin router. Keeping routes explicit makes the public surface easy to audit.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "imessage-handoff" });
    }

    if (request.method === "GET" && url.pathname === `/${CONTACT_CARD_FILENAME}`) {
      return contactCardResponse(request, env);
    }

    if (request.method === "GET" && url.pathname === `/${CONTACT_CARD_IMAGE_FILENAME}`) {
      return contactCardImageResponse();
    }

    if (request.method === "POST" && url.pathname === "/webhooks/sendblue") {
      return await handleSendblueWebhook(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/installations") {
      // Install tokens are anonymous identity creation. This IP bucket is a
      // coarse speed bump for scripts minting tokens in a loop.
      await enforceRequestRateLimit(env, `installations:${clientIp(request)}`, MAX_INSTALLATIONS_PER_IP_PER_WINDOW);
      return handleCreateInstallation();
    }

    if (url.pathname === "/service/register" && request.method === "POST") {
      return await handleServiceRegister(request, env);
    }
    if (url.pathname === "/service/register" && request.method === "DELETE") {
      return await handleServiceUnregister(request, env);
    }
    if (url.pathname === "/service/catalog" && request.method === "PUT") {
      return await handleServiceCatalog(request, env);
    }
    if (url.pathname === "/service/events" && request.method === "GET") {
      return await handleServiceEvents(request, env);
    }
    if (url.pathname === "/service/status" && request.method === "GET") {
      return await handleServiceStatus(request, env);
    }
    if (url.pathname === "/service/events/outbound" && request.method === "POST") {
      return await handleServiceOutbound(request, env);
    }

    if (parts[0] === "threads" && parts[1]) {
      const threadId = parts[1];
      // Thread APIs are authenticated, but an attacker can still send random
      // bearer tokens. Use both IP and owner buckets: IP slows random-token
      // spray, owner slows one real token from hammering expensive routes.
      await enforceRequestRateLimit(env, `threads-ip:${clientIp(request)}`, MAX_THREAD_REQUESTS_PER_IP_PER_WINDOW);
      const token = authTokenFromRequestOrUrl(request);
      if (token) {
        await enforceRequestRateLimit(env, `owner:${await ownerIdFromToken(token)}`, MAX_OWNER_REQUESTS_PER_WINDOW);
      }
      if (request.method === "GET" && parts[2] === "events" && parts.length === 3) {
        return await handleThreadEvents(request, env, threadId);
      }
      if (request.method === "POST" && parts.length === 2) {
        return await handleRegister(request, env, threadId);
      }
      if (request.method === "POST" && parts[2] === "status" && parts.length === 3) {
        return await handleStatus(request, env, threadId);
      }
      if (request.method === "POST" && parts[2] === "stop" && parts.length === 3) {
        return await handleStopThread(request, env, threadId);
      }
      if (
        request.method === "POST" &&
        parts[2] === "replies" &&
        parts[3] &&
        parts[4] === "claim" &&
        parts.length === 5
      ) {
        return await handleClaim(request, env, threadId, parts[3], ctx);
      }
      if (request.method === "GET" && parts.length === 2) {
        return await handleGetThread(request, env, threadId);
      }
    }

    return error(404, "Not found.");
  } catch (caught) {
    const status = typeof (caught as { status?: unknown }).status === "number"
      ? (caught as { status: number }).status
      : 400;
    return error(status, caught instanceof Error ? caught.message : String(caught));
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
};
