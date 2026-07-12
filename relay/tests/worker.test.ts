import assert from "node:assert/strict";
import test from "node:test";
import { HandoffSocket, handleRequest } from "../src/worker.ts";
import type { Env, InstallationPairingRow, MenuSnapshotRow, PairingAttemptLimitRow, PhoneBindingRow, HandoffReplyRow, HandoffThreadRow, ServiceInstallationRow } from "../src/types.ts";

// The relay tests run the Worker directly in Node. These fakes keep the tests
// fast while still exercising the same request handlers that Wrangler serves.
async function ownerIdForToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`imessage-handoff:${token}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DEV_OWNER_ID = await ownerIdForToken("dev-token");
const relayBuffers = new WeakMap<Env, HandoffSocket>();
const nativeFetch = globalThis.fetch;

test.beforeEach(() => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "QUEUED", message_handle: "default-test-message" }), { status: 200 });
});

test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});

function outboundContents(calls: Array<Record<string, unknown> | null>) {
  return calls
    .filter((call) => call && typeof call.content === "string")
    .map((call) => call?.content);
}

class FakeStatement {
  #db: FakeD1Database;
  #sql: string;
  #values: unknown[] = [];

  constructor(db: FakeD1Database, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }

  async run() {
    return this.#db.run(this.#sql, this.#values);
  }

  async first<T>() {
    return this.#db.first<T>(this.#sql, this.#values);
  }

  async all<T>() {
    return this.#db.all<T>(this.#sql, this.#values);
  }
}

class FakeD1Database {
  // This is a tiny in-memory stand-in for the specific D1 queries the Worker
  // issues. When a production query changes, this fake usually needs the same
  // behavior added so tests continue to mirror the deployed relay.
  threads = new Map<string, HandoffThreadRow>();
  phoneBindings = new Map<string, PhoneBindingRow>();
  pairingAttemptLimits = new Map<string, PairingAttemptLimitRow>();
  serviceInstallations = new Map<string, ServiceInstallationRow>();
  installationPairings = new Map<string, InstallationPairingRow>();
  menuSnapshots = new Map<string, MenuSnapshotRow>();
  runCount = 0;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  run(sql: string, values: unknown[]) {
    this.runCount += 1;
    if (sql.includes("INSERT INTO handoff_threads")) {
      if (sql.includes("json_each")) {
        const [itemsJson, ownerId, lastSeenAt, catalogGeneration] = values as string[];
        const items = JSON.parse(itemsJson) as Array<Record<string, unknown>>;
        let changes = 0;
        for (const item of items) {
          const id = String(item.id);
          const existing = this.threads.get(id);
          if (existing && existing.owner_id !== String(ownerId)) continue;
          this.threads.set(id, {
            id, owner_id: String(ownerId), cwd: String(item.cwd), title: item.title ? String(item.title) : null,
            handoff_summary: existing?.handoff_summary ?? null, status: String(item.status), handoff_enabled: 1,
            pairing_code: null, pairing_code_expires_at: null, last_stop_at: existing?.last_stop_at ?? null,
            created_at: existing?.created_at ?? String(item.createdAt), updated_at: String(item.updatedAt),
            project_label: item.projectLabel ? String(item.projectLabel) : null, catalog_source: "service",
            project_key: item.projectKey ? String(item.projectKey) : null,
            archived: Number(item.archived), visible: Number(item.visible), last_seen_at: String(lastSeenAt),
            catalog_generation: String(catalogGeneration),
            activity_at: String(item.activityAt), state_since: String(item.stateSince),
            reasoning_effort: item.reasoningEffort ? String(item.reasoningEffort) : null,
          });
          changes += 1;
        }
        return { meta: { changes } };
      }
      const [id, ownerId, cwd, title, handoffSummary, pairingCode, pairingCodeExpiresAt, createdAt, updatedAt] = values as string[];
      const existing = this.threads.get(id);
      this.threads.set(id, {
        id,
        owner_id: ownerId,
        cwd,
        title: title ?? null,
        handoff_summary: handoffSummary ?? null,
        status: "enabled",
        handoff_enabled: 1,
        pairing_code: pairingCode,
        pairing_code_expires_at: pairingCodeExpiresAt,
        last_stop_at: existing?.last_stop_at ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
        catalog_source: "legacy",
        archived: 0,
        visible: 1,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO service_installations")) {
      const [ownerId, clientId, serviceVersion, capabilities, lastSeenAt, createdAt, updatedAt] = values as string[];
      this.serviceInstallations.set(ownerId, {
        owner_id: ownerId, client_id: clientId, service_version: serviceVersion, capabilities,
        delivery_mode: "service", last_seen_at: lastSeenAt, created_at: this.serviceInstallations.get(ownerId)?.created_at ?? createdAt, updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("DELETE FROM service_installations")) {
      return { meta: { changes: this.serviceInstallations.delete(String(values[0])) ? 1 : 0 } };
    }

    if (sql.includes("INSERT INTO installation_pairings")) {
      const [ownerId, pairingCode, expiresAt, createdAt, updatedAt] = values as string[];
      this.installationPairings.set(ownerId, { owner_id: ownerId, pairing_code: pairingCode, pairing_code_expires_at: expiresAt, created_at: this.installationPairings.get(ownerId)?.created_at ?? createdAt, updated_at: updatedAt });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE installation_pairings")) {
      const [updatedAt, ownerId] = values as string[];
      const row = this.installationPairings.get(ownerId);
      if (row) { row.pairing_code = null; row.pairing_code_expires_at = null; row.updated_at = updatedAt; }
      return { meta: { changes: row ? 1 : 0 } };
    }

    if (sql.includes("INSERT INTO menu_snapshots")) {
      const [phoneNumber, ownerId, itemsJson, expiresAt, createdAt] = values as string[];
      this.menuSnapshots.set(phoneNumber, { phone_number: phoneNumber, owner_id: ownerId, items_json: itemsJson, expires_at: expiresAt, created_at: createdAt });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE phone_bindings") && sql.includes("WHERE owner_id = ?")) {
      const [nextThreadId, updatedAt, ownerId] = values as string[];
      for (const binding of this.phoneBindings.values()) {
        if (binding.owner_id === ownerId) {
          binding.active_thread_id = nextThreadId;
          binding.updated_at = updatedAt;
        }
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE phone_bindings") && sql.includes("contact_card_sent_at")) {
      const [sentAt, updatedAt, phoneNumber] = values as string[];
      const binding = this.phoneBindings.get(phoneNumber);
      if (binding) {
        binding.contact_card_sent_at = sentAt;
        binding.updated_at = updatedAt;
      }
      return { meta: { changes: binding ? 1 : 0 } };
    }

    if (sql.includes("SET visible = 0, handoff_enabled = 0") && sql.includes("catalog_source = 'service'")) {
      const [updatedAt, ownerId] = values as string[];
      let changes = 0;
      for (const thread of this.threads.values()) {
        if (thread.owner_id === ownerId && thread.catalog_source === "service") {
          thread.visible = 0;
          thread.handoff_enabled = 0;
          thread.status = "stopped";
          thread.updated_at = updatedAt;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("SET visible = 0") && sql.includes("catalog_source = 'service'")) {
      const [lastSeenAt, ownerId, catalogGeneration] = values as string[];
      let changes = 0;
      for (const thread of this.threads.values()) {
        if (
          thread.owner_id === ownerId
          && thread.catalog_source === "service"
          && (thread.catalog_generation ?? "") !== catalogGeneration
        ) {
          thread.visible = 0;
          thread.last_seen_at = lastSeenAt;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("SET visible = 0") && sql.includes("COALESCE(catalog_source")) {
      const [lastSeenAt, ownerId, catalogGeneration] = values as string[];
      let changes = 0;
      for (const thread of this.threads.values()) {
        if (
          thread.owner_id === ownerId
          && (thread.catalog_source !== "service" || (thread.catalog_generation ?? "") !== catalogGeneration)
        ) {
          thread.visible = 0;
          thread.last_seen_at = lastSeenAt;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("pairing_code = NULL") && !sql.includes("handoff_enabled = 0")) {
      if (sql.includes("WHERE owner_id = ?")) {
        const [updatedAt, ownerId, excludedId] = values as string[];
        for (const thread of this.threads.values()) {
          if (thread.owner_id === ownerId && thread.id !== excludedId) {
            thread.pairing_code = null;
            thread.pairing_code_expires_at = null;
            thread.updated_at = updatedAt;
          }
        }
        return { meta: { changes: 1 } };
      }
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.pairing_code = null;
      thread.pairing_code_expires_at = null;
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("handoff_enabled = 0")) {
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.status = "stopped";
      thread.handoff_enabled = 0;
      thread.pairing_code = null;
      thread.pairing_code_expires_at = null;
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("status = CASE WHEN catalog_source = 'service' THEN 'pending'")) {
      const [updatedAt, activityAt, stateSince, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.updated_at = updatedAt;
      thread.activity_at = activityAt;
      thread.state_since = stateSince;
      if (thread.catalog_source === "service") thread.status = "pending";
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("SET cwd = ?")) {
      const [cwd, status, lastStopAt, updatedAt, activityAt, stateSince, id] = values as Array<string | null>;
      const thread = this.threads.get(String(id));
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.cwd = String(cwd);
      thread.status = String(status);
      thread.last_stop_at = String(lastStopAt);
      thread.updated_at = String(updatedAt);
      thread.activity_at = String(activityAt);
      thread.state_since = String(stateSince);
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO pairing_attempt_limits")) {
      const [phoneNumber, failedCount, windowStartAt, blockedUntil, updatedAt] = values as Array<string | number | null>;
      const normalizedPhone = String(phoneNumber);
      this.pairingAttemptLimits.set(normalizedPhone, {
        phone_number: normalizedPhone,
        failed_count: Number(failedCount),
        window_start_at: String(windowStartAt),
        blocked_until: blockedUntil ? String(blockedUntil) : null,
        updated_at: String(updatedAt),
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("DELETE FROM pairing_attempt_limits")) {
      const deleted = this.pairingAttemptLimits.delete(String(values[0]));
      return { meta: { changes: deleted ? 1 : 0 } };
    }

    if (sql.includes("DELETE FROM phone_bindings")) {
      const [ownerId, phoneNumber] = values as string[];
      for (const [key, binding] of this.phoneBindings.entries()) {
        if (binding.owner_id === ownerId && binding.phone_number !== phoneNumber) {
          this.phoneBindings.delete(key);
        }
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO phone_bindings")) {
      const [phoneNumber, ownerId, activeThreadId, createdAt, updatedAt] = values as string[];
      const existing = this.phoneBindings.get(phoneNumber);
      for (const [key, binding] of this.phoneBindings.entries()) {
        if (binding.owner_id === ownerId && binding.phone_number !== phoneNumber) {
          this.phoneBindings.delete(key);
        }
      }
      this.phoneBindings.set(phoneNumber, {
        phone_number: phoneNumber,
        owner_id: ownerId,
        active_thread_id: activeThreadId,
        contact_card_sent_at: existing?.contact_card_sent_at ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected run SQL: ${sql}`);
  }

  first<T>(sql: string, values: unknown[]) {
    if (sql.includes("FROM service_installations WHERE owner_id = ?")) {
      return (this.serviceInstallations.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("FROM installation_pairings WHERE pairing_code = ?")) {
      const code = String(values[0]);
      const now = String(values[1]);
      return ([...this.installationPairings.values()].find((row) => row.pairing_code === code && String(row.pairing_code_expires_at) > now) ?? null) as T | null;
    }

    if (sql.includes("FROM installation_pairings WHERE owner_id = ?")) {
      return (this.installationPairings.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("FROM menu_snapshots WHERE phone_number = ?")) {
      const row = this.menuSnapshots.get(String(values[0]));
      if (!sql.includes("expires_at > ?")) return (row ?? null) as T | null;
      return (row && row.expires_at > String(values[1]) ? row : null) as T | null;
    }
    if (sql.includes("FROM phone_bindings WHERE phone_number = ?")) {
      return (this.phoneBindings.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("FROM phone_bindings WHERE owner_id = ?")) {
      const ownerId = String(values[0]);
      return ([...this.phoneBindings.values()].find((binding) => binding.owner_id === ownerId) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM handoff_threads WHERE pairing_code = ?")) {
      const pairingCode = String(values[0]);
      const now = String(values[1] ?? "");
      return ([...this.threads.values()].find((thread) =>
        thread.pairing_code === pairingCode
        && thread.handoff_enabled === 1
        && Boolean(thread.pairing_code_expires_at)
        && String(thread.pairing_code_expires_at) > now
      ) ?? null) as T | null;
    }

    if (sql.includes("FROM pairing_attempt_limits WHERE phone_number = ?")) {
      return (this.pairingAttemptLimits.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM handoff_threads")) {
      return (this.threads.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("FROM phone_bindings WHERE active_thread_id = ?")) {
      const threadId = String(values[0]);
      return ([...this.phoneBindings.values()].find((binding) => binding.active_thread_id === threadId) ?? null) as T | null;
    }

    throw new Error(`Unexpected first SQL: ${sql}`);
  }

  all<T>(sql: string, values: unknown[]) {
    if (sql.includes("FROM handoff_threads") && sql.includes("handoff_enabled = 1")) {
      const ownerId = String(values[0]);
      const results = [...this.threads.values()]
        .filter((thread) => thread.owner_id === ownerId && thread.handoff_enabled === 1 && thread.visible !== 0 && thread.archived !== 1)
        .sort((a, b) => {
          const rank = (status: string) => status === "working" ? 0 : status === "pending" ? 1 : status === "error" ? 2 : 3;
          return rank(a.status) - rank(b.status)
            || String(b.activity_at ?? b.updated_at).localeCompare(String(a.activity_at ?? a.updated_at))
            || b.updated_at.localeCompare(a.updated_at)
            || b.created_at.localeCompare(a.created_at)
            || b.id.localeCompare(a.id);
        }) as T[];
      return { results };
    }

    throw new Error(`Unexpected all SQL: ${sql}`);
  }
}

function env() {
  const testEnv = {
    DB: new FakeD1Database() as unknown as D1Database,
    SENDBLUE_API_KEY: "sendblue-key",
    SENDBLUE_SECRET_KEY: "sendblue-secret",
    SENDBLUE_WEBHOOK_SECRET: "webhook-secret",
    SENDBLUE_FROM_NUMBER: "+12344198201",
    SENDBLUE_API_BASE_URL: "https://api.sendblue.test/api",
  } satisfies Env;
  attachRelayBuffer(testEnv);
  return testEnv;
}

function attachRelayBuffer(testEnv: Env) {
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets() {
      return [];
    },
  } as unknown as DurableObjectState);
  testEnv.HANDOFF_SOCKET = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        id,
        fetch: (request: Request) => relay.fetch(request),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  relayBuffers.set(testEnv, relay);
  return relay;
}

function attachOwnerControlCapture(testEnv: Env, sent: Array<Record<string, unknown>>) {
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      if (tag !== `owner:${DEV_OWNER_ID}`) return [];
      return [{ send(message: string) { sent.push(JSON.parse(message)); } }];
    },
  } as unknown as DurableObjectState);
  testEnv.HANDOFF_SOCKET = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get(id: DurableObjectId) {
      return { id, fetch: (request: Request) => relay.fetch(request) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  relayBuffers.set(testEnv, relay);
  return relay;
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://imessage-handoff.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function relayReplies(testEnv: Env) {
  const relay = relayBuffers.get(testEnv);
  assert.ok(relay, "test env has a relay buffer");
  return [...(relay as unknown as { replies: Map<string, HandoffReplyRow> }).replies.values()];
}

function pendingReplies(testEnv: Env, threadId?: string) {
  return relayReplies(testEnv).filter((reply) => reply.status === "pending" && (!threadId || reply.thread_id === threadId));
}

async function notification(response: Response) {
  return (await json(response)).notification as Record<string, unknown>;
}

async function register(testEnv: Env, overrides: Record<string, unknown> = {}) {
  const threadId = "thread-test-1";
  const response = await handleRequest(req(`/threads/${threadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "iMessage test", ...overrides }),
  }), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.id, threadId);
  return threadId;
}

function sendblueWebhook(body: Record<string, unknown>, secret = "webhook-secret") {
  return req("/webhooks/sendblue", {
    method: "POST",
    headers: { "sb-signing-secret": secret },
    body: JSON.stringify(body),
  });
}

function inboundMessage(content: string, handle = "msg_1", fromNumber = "+15551234567") {
  return {
    content,
    is_outbound: false,
    status: "RECEIVED",
    message_handle: handle,
    from_number: fromNumber,
    number: fromNumber,
  };
}

function inboundImage(content: string, mediaUrl: string, handle = "msg_img_1", fromNumber = "+15551234567") {
  return {
    ...inboundMessage(content, handle, fromNumber),
    media_url: mediaUrl,
  };
}

function generatedImage(filename: string, data = "png-bytes") {
  return {
    filename,
    mimeType: "image/png",
    dataBase64: Buffer.from(data).toString("base64"),
  };
}

function generatedImageBytes(filename: string, bytes: Uint8Array) {
  return {
    filename,
    mimeType: "image/png",
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

async function registerService(testEnv: Env, options: { serviceVersion?: string; capabilities?: string[] } = {}) {
  const response = await handleRequest(req("/service/register", {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      clientId: "client-test",
      serviceVersion: options.serviceVersion || "0.3.2",
      capabilities: options.capabilities || ["catalog-v2", "local-directory-v1"],
    }),
  }), testEnv);
  assert.equal(response.status, 200);
  return json(response);
}

test("creates install tokens", async () => {
  const testEnv = env();
  const response = await handleRequest(req("/installations", { method: "POST" }), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(typeof body.token, "string");
  assert.match(String(body.token), /^ih_[a-f0-9]{64}$/);
});

test("rate limits installation token creation by client IP", async () => {
  const testEnv = env();
  for (let index = 0; index < 30; index += 1) {
    const response = await handleRequest(req("/installations", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), testEnv);
    assert.equal(response.status, 200);
  }

  const limited = await handleRequest(req("/installations", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.10" },
  }), testEnv);
  assert.equal(limited.status, 429);
});

test("serves the Codex contact card and image", async () => {
  const testEnv = env();
  const card = await handleRequest(req("/contact.vcf"), testEnv);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "text/vcard; charset=utf-8");
  const body = await card.text();
  assert.match(body, /FN:Codex/);
  assert.match(body, /N:Codex;;;;/);
  assert.match(body, /TEL;TYPE=CELL:\+12344198201/);
  assert.match(body, /PHOTO;ENCODING=b;TYPE=JPEG:/);
  assert.match(body, /\r\n [A-Za-z0-9+/=]+/);
  assert.doesNotMatch(body, /^ORG:/m);
  assert.doesNotMatch(body, /^URL:/m);
  assert.doesNotMatch(body, /^NOTE:/m);

  const image = await handleRequest(req("/codex-contact.jpg"), testEnv);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.ok((await image.arrayBuffer()).byteLength > 1000);
});

test("creates and upserts a handoff thread with an explicit id", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const upsert = await handleRequest(req(`/threads/${threadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project-renamed",
      title: "iMessage test updated",
      handoffSummary: "You were reviewing iMessage handoff copy.",
    }),
  }), testEnv);
  assert.equal(upsert.status, 200);
  const upsertBody = await json(upsert);
  assert.equal(upsertBody.pairingRequired, true);
  assert.equal(upsertBody.paired, false);

  const response = await handleRequest(req(`/threads/${threadId}`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(response);
  assert.equal(body.id, threadId);
  assert.equal(typeof body.pairingCode, "string");
  assert.equal(String(body.pairingCode).length, 6);
  assert.equal(typeof body.pairingCodeExpiresAt, "string");
  assert.equal(Date.parse(String(body.pairingCodeExpiresAt)) > Date.now(), true);
  assert.equal(body.cwd, "/tmp/project-renamed");
  assert.equal(body.title, "iMessage test updated");
  assert.equal(body.handoffSummary, "You were reviewing iMessage handoff copy.");
  assert.equal(body.status, "enabled");
  assert.equal(body.handoffEnabled, true);
});

test("limits enabled handoff threads per owner", async () => {
  const testEnv = env();
  for (let index = 1; index <= 25; index += 1) {
    const response = await handleRequest(req(`/threads/thread-limit-${index}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/project", title: `Thread ${index}` }),
    }), testEnv);
    assert.equal(response.status, 200);
  }

  const limited = await handleRequest(req("/threads/thread-limit-26", {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "Thread 26" }),
  }), testEnv);
  assert.equal(limited.status, 429);
  assert.match(String((await json(limited)).error), /Too many active handoff threads/);
});

test("proxies authorized thread websocket upgrades to the Durable Object", async () => {
  const testEnv: Env = env();
  const threadId = await register(testEnv);
  const calls: Array<{ name: string; url: string }> = [];
  testEnv.HANDOFF_SOCKET = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        id,
        fetch: async (request: Request) => {
          calls.push({ name: (id as unknown as { name: string }).name, url: request.url });
          if (new URL(request.url).pathname === "/rate-limit") {
            return new Response(JSON.stringify({ ok: true, allowed: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  const response = await handleRequest(req(`/threads/${threadId}/events?token=dev-token`, {
    headers: { upgrade: "websocket" },
  }), testEnv);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      name: "global",
      url: "https://imessage-handoff.internal/rate-limit",
    },
    {
      name: "global",
      url: "https://imessage-handoff.internal/rate-limit",
    },
    {
      name: "global",
      url: `https://imessage-handoff.test/threads/${threadId}/events?token=dev-token`,
    },
  ]);
});

test("rejects unauthorized thread websocket upgrades", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);

  const response = await handleRequest(req(`/threads/${threadId}/events?token=wrong-token`, {
    headers: { upgrade: "websocket" },
  }), testEnv);

  assert.equal(response.status, 401);
});

test("relay buffer notifies connected thread websockets when replies arrive", async () => {
  const sent: string[] = [];
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      assert.equal(tag, "thread-test-1");
      return [{
        send(message: string) {
          sent.push(message);
        },
      }];
    },
  } as unknown as DurableObjectState);

  const response = await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-1/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "hello", externalId: "msg_notify", status: "pending" }),
  }));

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  const message = JSON.parse(sent[0] ?? "{}");
  assert.equal(message.type, "reply-pending");
  assert.equal(message.threadId, "thread-test-1");
  assert.match(message.replyId, /^reply_/);
});

test("relay buffer notifies the installation socket for any owned thread", async () => {
  const sent: string[] = [];
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      if (tag !== "owner:owner-test") return [];
      return [{ send(message: string) { sent.push(message); } }];
    },
  } as unknown as DurableObjectState);
  const response = await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-2/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "hello", externalId: "owner-notify", status: "pending", ownerId: "owner-test" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0] ?? "{}"), {
    type: "reply-pending",
    threadId: "thread-test-2",
    replyId: JSON.parse(await response.clone().text()).id,
    createdAt: JSON.parse(sent[0] ?? "{}").createdAt,
  });
});

test("relay buffer sends queued replies to a socket on connect", async () => {
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets() {
      return [];
    },
  } as unknown as DurableObjectState);

  await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-1/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "queued", externalId: "msg_queued", status: "pending" }),
  }));

  const sent: string[] = [];
  (relay as unknown as {
    notifySocketOrScheduleNextPending(threadId: string, socket: { send(message: string): void }): void;
  }).notifySocketOrScheduleNextPending("thread-test-1", {
    send(message: string) {
      sent.push(message);
    },
  });

  assert.equal(sent.length, 1);
  const message = JSON.parse(sent[0] ?? "{}");
  assert.equal(message.type, "reply-pending");
  assert.equal(message.threadId, "thread-test-1");
  assert.match(message.replyId, /^reply_/);
});

test("installation socket receives every offline pending reply and claim advances the queue", async () => {
  const sent: string[] = [];
  let connected = false;
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      return connected && tag === "owner:owner-all"
        ? [{ send(message: string) { sent.push(message); } }]
        : [];
    },
  } as unknown as DurableObjectState);
  const insert = async (externalId: string) => {
    const response = await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-all/replies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: externalId, externalId, status: "pending", ownerId: "owner-all" }),
    }));
    return String((await response.json() as { id: string }).id);
  };
  const first = await insert("offline-1");
  const second = await insert("offline-2");
  connected = true;
  (relay as unknown as {
    notifyOwnerSocketOrSchedule(ownerId: string, socket: { send(message: string): void }): void;
  }).notifyOwnerSocketOrSchedule("owner-all", { send(message: string) { sent.push(message); } });
  assert.deepEqual(sent.map((value) => JSON.parse(value).replyId), [first, second]);

  sent.length = 0;
  const claim = await relay.fetch(new Request(`https://imessage-handoff.internal/threads/thread-all/replies/${first}/claim`, { method: "POST" }));
  assert.equal(claim.status, 200);
  assert.equal(JSON.parse(sent.at(-1) || "{}").replyId, second);
});

test("relay buffer waits for media group quiet window before websocket notification", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<() => void> = [];
  globalThis.setTimeout = ((callback: TimerHandler) => {
    timers.push(callback as () => void);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const sent: string[] = [];
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      assert.equal(tag, "thread-test-1");
      return [{
        send(message: string) {
          sent.push(message);
        },
      }];
    },
  } as unknown as DurableObjectState);

  try {
    await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-1/replies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "inspect",
        externalId: "media_group_1",
        status: "pending",
        mediaUrl: "https://cdn.sendblue.test/one.png",
      }),
    }));

    assert.equal(sent.length, 0);
    assert.equal(timers.length, 1);
    for (const reply of (relay as unknown as { replies: Map<string, HandoffReplyRow> }).replies.values()) {
      reply.created_at = "2026-04-25T18:20:00.000Z";
    }
    timers[0]?.();

    assert.equal(sent.length, 1);
    const message = JSON.parse(sent[0] ?? "{}");
    assert.equal(message.type, "reply-pending");
    assert.equal(message.threadId, "thread-test-1");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pairs a phone by code without enqueueing a pending reply", async () => {
  const testEnv = env();
  const threadId = await register(testEnv, {
    handoffSummary: "You were deciding what the first playable prototype should include.",
  });
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_1")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.paired, true);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);
    assert.equal(db.threads.get(threadId)?.pairing_code, null);
    assert.equal(db.threads.get(threadId)?.pairing_code_expires_at, null);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [{
      number: "+15551234567",
      from_number: "+12344198201",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Add me as a contact so you remember who I am.",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_url: "https://imessage-handoff.test/contact.vcf",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: 'You’re connected to "iMessage test" on Codex.\n\nYou were deciding what the first playable prototype should include.\n\nWhat do you want to do next?',
    }]);
    assert.equal(typeof db.phoneBindings.get("+15551234567")?.contact_card_sent_at, "string");

    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends the pairing contact card only once per phone", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: "previous-owner",
    active_thread_id: null,
    contact_card_sent_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_seen_contact")), testEnv);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(outboundContents(calls), [
    'You’re connected to "iMessage test" on Codex.\n\nWhat do you want to do next?',
  ]);
  assert.equal(db.phoneBindings.get("+15551234567")?.owner_id, DEV_OWNER_ID);
  assert.equal(db.phoneBindings.get("+15551234567")?.contact_card_sent_at, "2026-01-01T00:00:00.000Z");
});

test("activation message omits the summary paragraph when no summary exists", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_no_summary")), testEnv);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(outboundContents(calls), [
    "Add me as a contact so you remember who I am.",
    'You’re connected to "iMessage test" on Codex.\n\nWhat do you want to do next?',
  ]);
});

test("activation message uses generic copy when no title exists", async () => {
  const testEnv = env();
  const threadId = await register(testEnv, { title: "" });
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_no_title")), testEnv);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(outboundContents(calls), [
    "Add me as a contact so you remember who I am.",
    "You’re connected to this Codex thread.\n\nWhat do you want to do next?",
  ]);
});

test("pairing allows SMS numbers so Sendblue can use SMS fallback", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_sms")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.paired, true);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);
    assert.equal(db.threads.get(threadId)?.pairing_code, null);
    assert.equal(db.threads.get(threadId)?.pairing_code_expires_at, null);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [{
      number: "+15551234567",
      from_number: "+12344198201",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Add me as a contact so you remember who I am.",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_url: "https://imessage-handoff.test/contact.vcf",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: 'You’re connected to "iMessage test" on Codex.\n\nWhat do you want to do next?',
    }]);
    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subsequent inbound texts from a paired phone enqueue for the active thread", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundMessage("What is 2 + 2?", "msg_2")), testEnv);
  assert.equal(response.status, 200);
  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, "What is 2 + 2?");
});

test("relay buffer keeps inbound message content out of D1", async () => {
  const testEnv = env();
  attachRelayBuffer(testEnv);
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundMessage("What is buffered?", "msg_buffered")), testEnv);
  assert.equal(response.status, 200);
  // The fake D1 no longer implements message-content tables, so this request
  // would throw if the Worker tried to persist the inbound body there.

  const body = await json(response) as { replyId?: string };
  const replyId = body.replyId;
  assert.equal(typeof replyId, "string");
  const originalFetch = globalThis.fetch;
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "SENT", message_handle: "typing-1" }), { status: 200 });
  try {
    const claim = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv, {
      waitUntil: (promise) => waitUntilPromises.push(promise),
    });
    assert.equal(claim.status, 200);
    const claimBody = await json(claim) as { reply: { body: string } };
    assert.equal(claimBody.reply.body, "What is buffered?");
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const duplicate = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  assert.equal(duplicate.status, 409);
});

test("image-only sendblue webhook creates a pending media reply after quiet window", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundImage("", "https://cdn.example.test/cow.jpg", "img_1")), testEnv);
  assert.equal(response.status, 200);
  const reply = pendingReplies(testEnv, threadId)[0];
  assert.equal(reply?.body, "");
  assert.deepEqual(JSON.parse(String(reply?.media)), [{ url: "https://cdn.example.test/cow.jpg" }]);
  assert.equal(reply?.media_group_id, "img");
  assert.equal(reply?.media_index, 1);
  if (reply) {
    reply.created_at = "2026-04-25T18:30:00.000Z";
  }

  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, "");
  assert.deepEqual(JSON.parse(String(replies[0]?.media)), [{ url: "https://cdn.example.test/cow.jpg" }]);
});

test("text plus image webhook stores both body and media", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  await handleRequest(sendblueWebhook(inboundImage("What is this?", "https://cdn.example.test/photo.png", "img_2")), testEnv);
  const reply = pendingReplies(testEnv, threadId)[0];
  assert.equal(reply?.body, "What is this?");
  assert.deepEqual(JSON.parse(String(reply?.media)), [{ url: "https://cdn.example.test/photo.png" }]);
});

test("multi-image sendblue webhooks claim as one grouped reply after quiet window", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundImage("Compare these", "https://cdn.example.test/one.png", "group_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundImage("", "https://cdn.example.test/two.png", "group_2")), testEnv);

  assert.equal(pendingReplies(testEnv, threadId).length, 2);

  for (const reply of pendingReplies(testEnv, threadId)) {
    reply.created_at = reply.media_index === 1 ? "2026-04-25T18:30:00.000Z" : "2026-04-25T18:30:01.000Z";
  }

  const firstReplyId = pendingReplies(testEnv, threadId).find((reply) => reply.media_index === 1)?.id;
  assert.equal(typeof firstReplyId, "string");

  const originalFetch = globalThis.fetch;
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  try {
    const claim = await handleRequest(req(`/threads/${threadId}/replies/${firstReplyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv, {
      waitUntil: (promise) => waitUntilPromises.push(promise),
    });
    assert.equal(claim.status, 200);
    const claimBody = await json(claim) as { reply: { body: string; media: Array<{ url: string }> } };
    assert.equal(claimBody.reply.body, "Compare these");
    assert.deepEqual(claimBody.reply.media, [
      { url: "https://cdn.example.test/one.png" },
      { url: "https://cdn.example.test/two.png" },
    ]);
    await Promise.all(waitUntilPromises);
    const tombstones = relayReplies(testEnv).filter((reply) => reply.media_group_id === "group");
    assert.deepEqual(tombstones.map((reply) => ({ status: reply.status, body: reply.body, media: reply.media })), [
      { status: "applied", body: "", media: null },
      { status: "applied", body: "", media: null },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list and numeric switching remain text-only when media is attached", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  await handleRequest(sendblueWebhook(inboundImage("list", "https://cdn.example.test/list.png", "media_list")), testEnv);
  await handleRequest(sendblueWebhook(inboundImage("1", "https://cdn.example.test/one.png", "media_number")), testEnv);

  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((reply) => reply.body), ["list", "1"]);
});

test("starting another thread for a paired user makes it active", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const secondThreadId = "thread-test-2";
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  let secondBody: Record<string, unknown> = {};
  try {
    const startSecond = await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        title: "Second",
        handoffSummary: "You were choosing the next iMessage task.",
      }),
    }), testEnv);
    assert.equal(startSecond.status, 200);
    secondBody = await json(startSecond);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(secondBody.pairingRequired, false);
  assert.equal(secondBody.paired, true);
  assert.equal(secondBody.pairingCode, null);
  assert.equal(secondBody.skipNextStatusSend, true);
  assert.deepEqual(outboundContents(calls), ['You’re connected to "Second" on Codex.\n\nYou were choosing the next iMessage task.\n\nWhat do you want to do next?']);
  assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, secondThreadId);
  assert.equal(db.threads.get(secondThreadId)?.pairing_code, null);

  await handleRequest(sendblueWebhook(inboundMessage("Use the new one", "msg_2")), testEnv);
  assert.equal(pendingReplies(testEnv, firstThreadId).length, 0);
  assert.equal(pendingReplies(testEnv, secondThreadId).length, 1);
});

test("list command returns a numbered grouped directory with live status", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const secondThreadId = "thread-test-2";
    await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/second", title: "Second" }),
    }), testEnv);
    calls.length = 0;
    db.threads.get(firstThreadId)!.updated_at = "2026-04-25T18:20:00.000Z";
    db.threads.get(secondThreadId)!.updated_at = "2026-04-25T18:21:00.000Z";

    const response = await handleRequest(sendblueWebhook(inboundMessage("list", "list_msg_1")), testEnv);
    assert.equal(response.status, 200);
    const directory = String(outboundContents(calls).at(-1));
    assert.match(directory, /^CODEX CONTROL · THREADS/);
    assert.match(directory, /OTHER TASKS\n1\. Second/);
    assert.match(directory, /Selected · Idle/);
    assert.match(directory, /2\. iMessage test/);
    assert.doesNotMatch(directory, /enabled|stopped/i);
    const pending = pendingReplies(testEnv);
    assert.deepEqual(pending, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list command reports when the paired phone has no iMessage handoff threads", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  db.threads.get(threadId)!.handoff_enabled = 0;
  db.phoneBindings.get("+15551234567")!.active_thread_id = null;

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage("list", "list_msg_empty")), testEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(outboundContents(calls), ["CODEX CONTROL · THREADS\n\n0 tasks · refreshed now\n\nNo pending or recently active tasks."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal text reports when there is no active thread to forward to", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  db.threads.get(threadId)!.handoff_enabled = 0;
  db.phoneBindings.get("+15551234567")!.active_thread_id = null;

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage("What is 2 + 2?", "msg_no_thread")), testEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(outboundContents(calls), ["CODEX CONTROL · NEEDS ATTENTION\n\nNo thread is selected.\nText /threads to choose one."]);
    const pending = pendingReplies(testEnv);
    assert.deepEqual(pending, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("number command switches the active thread using the current list order", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const secondThreadId = "thread-test-2";
    await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/second", title: "Second" }),
    }), testEnv);
    calls.length = 0;
    db.threads.get(firstThreadId)!.updated_at = "2026-04-25T18:20:00.000Z";
    db.threads.get(secondThreadId)!.updated_at = "2026-04-25T18:21:00.000Z";

    await handleRequest(sendblueWebhook(inboundMessage("/threads", "list_before_switch")), testEnv);
    calls.length = 0;
    const response = await handleRequest(sendblueWebhook(inboundMessage("2", "switch_msg_1")), testEnv);
    assert.equal(response.status, 200);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, firstThreadId);
    assert.deepEqual(outboundContents(calls), []);

    await handleRequest(sendblueWebhook(inboundMessage("Now use the first thread", "msg_2")), testEnv);
    assert.equal(pendingReplies(testEnv, firstThreadId).length, 1);
    assert.equal(pendingReplies(testEnv, secondThreadId).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("out-of-range menu selection does not change the active thread or enqueue a reply", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    await handleRequest(sendblueWebhook(inboundMessage("/threads", "list_before_bad_switch")), testEnv);
    calls.length = 0;
    const response = await handleRequest(sendblueWebhook(inboundMessage("2", "switch_msg_bad")), testEnv);
    assert.equal(response.status, 200);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);
    assert.deepEqual(outboundContents(calls), ["CODEX CONTROL · NEEDS ATTENTION\n\nThat menu has changed.\nText /threads for a fresh list."]);
    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired numeric menu replies refresh the directory instead of reaching Codex", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_expired_menu")), testEnv);
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    await handleRequest(sendblueWebhook(inboundMessage("/threads", "expired_menu_list")), testEnv);
    db.menuSnapshots.get("+15551234567")!.expires_at = "2020-01-01T00:00:00.000Z";
    calls.length = 0;
    const response = await handleRequest(sendblueWebhook(inboundMessage("1", "expired_menu_choice")), testEnv);
    assert.equal((await json(response)).command, "stale-menu");
    assert.equal(pendingReplies(testEnv, threadId).length, 0);
    assert.match(String(outboundContents(calls)[0]), /menu expired/i);
    assert.match(String(outboundContents(calls)[1]), /^CODEX CONTROL · THREADS/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stopping a thread disables it and switches to the newest remaining thread", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const secondThreadId = "thread-test-2";
    await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/second", title: "Second" }),
    }), testEnv);
    calls.length = 0;
    db.threads.get(firstThreadId)!.updated_at = "2026-04-25T18:20:00.000Z";
    db.threads.get(secondThreadId)!.updated_at = "2026-04-25T18:21:00.000Z";
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, secondThreadId);

    const stop = await handleRequest(req(`/threads/${secondThreadId}/stop`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(stop.status, 200);
    assert.equal((await json(stop)).nextActiveThreadId, firstThreadId);
    assert.equal(db.threads.get(secondThreadId)?.handoff_enabled, 0);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, firstThreadId);

    await handleRequest(sendblueWebhook(inboundMessage("list", "list_after_stop")), testEnv);
    const directory = String(outboundContents(calls).at(-1));
    assert.match(directory, /^CODEX CONTROL · THREADS/);
    assert.match(directory, /1\. iMessage test/);
    assert.match(directory, /Selected · Idle/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("starting another thread for an unpaired user replaces the old pairing code", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const firstCode = db.threads.get(firstThreadId)?.pairing_code;
  assert.equal(typeof firstCode, "string");

  const secondThreadId = "thread-test-2";
  const startSecond = await handleRequest(req(`/threads/${secondThreadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "Second" }),
  }), testEnv);
  assert.equal(startSecond.status, 200);
  assert.equal(db.threads.get(firstThreadId)?.pairing_code, null);
  assert.equal(db.threads.get(firstThreadId)?.pairing_code_expires_at, null);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const oldCodeResponse = await handleRequest(sendblueWebhook(inboundMessage(String(firstCode), "old_pair_msg")), testEnv);
    assert.equal(oldCodeResponse.status, 200);
    const oldCodeBody = await json(oldCodeResponse);
    assert.equal(oldCodeBody.invalidPairingCode, true);
    assert.deepEqual(outboundContents(calls), [
      "That pairing code is invalid or expired. Start iMessage Handoff again in Codex to get a fresh code.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown senders are acknowledged without enqueueing", async () => {
  const testEnv = env();
  const response = await handleRequest(sendblueWebhook(inboundMessage("hello", "msg_unknown")), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ignored, true);
});

test("expired pairing codes do not pair and send an invalid code message", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");
  db.threads.get(threadId)!.pairing_code_expires_at = "2026-01-01T00:00:00.000Z";

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "expired_pair_msg")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.paired, false);
    assert.equal(body.invalidPairingCode, true);
    assert.equal(db.phoneBindings.get("+15551234567"), undefined);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(outboundContents(calls.map((call) => call.body)), [
      "That pairing code is invalid or expired. Start iMessage Handoff again in Codex to get a fresh code.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed pairing attempts are rate limited per phone number", async () => {
  const testEnv = env();
  await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const badCodes = ["BADA2A", "BADA3A", "BADA4A", "BADA5A", "BADA6A", "BADA7A"];
    for (let index = 0; index < 5; index += 1) {
      const response = await handleRequest(sendblueWebhook(inboundMessage(String(badCodes[index]), `bad_pair_${index}`)), testEnv);
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.invalidPairingCode, true);
      assert.equal(body.rateLimited, false);
    }

    const limited = await handleRequest(sendblueWebhook(inboundMessage(String(badCodes[5]), "bad_pair_6")), testEnv);
    assert.equal(limited.status, 200);
    const body = await json(limited);
    assert.equal(body.paired, false);
    assert.equal(body.rateLimited, true);
    assert.equal(typeof body.retryAfterSeconds, "number");
    assert.equal(Number(body.retryAfterSeconds) > 0, true);
    assert.equal(db.pairingAttemptLimits.get("+15551234567")?.failed_count, 6);
    assert.match(String(outboundContents(calls).at(-1)), /Too many pairing attempts\. Try again in about 30 minutes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("blocked phones cannot pair even with a valid code until the block expires", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = String(db.threads.get(threadId)?.pairing_code);
  db.pairingAttemptLimits.set("+15551234567", {
    phone_number: "+15551234567",
    failed_count: 6,
    window_start_at: new Date().toISOString(),
    blocked_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(pairingCode, "blocked_valid_pair")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.rateLimited, true);
    assert.equal(db.phoneBindings.get("+15551234567"), undefined);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/send-message",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful pairing clears prior failed attempts", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = String(db.threads.get(threadId)?.pairing_code);
  db.pairingAttemptLimits.set("+15551234567", {
    phone_number: "+15551234567",
    failed_count: 3,
    window_start_at: new Date().toISOString(),
    blocked_until: null,
    updated_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(pairingCode, "valid_after_failures")), testEnv);
    assert.equal(response.status, 200);
    assert.equal((await json(response)).paired, true);
    assert.equal(db.pairingAttemptLimits.get("+15551234567"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate sendblue message handles are ignored", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("once", "msg_2")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("twice", "msg_2")), testEnv);

  assert.deepEqual(pendingReplies(testEnv, threadId).map((reply) => reply.body), ["once"]);
});

test("bad sendblue webhook secret is rejected", async () => {
  const testEnv = env();
  const response = await handleRequest(sendblueWebhook(inboundMessage("hello"), "wrong-secret"), testEnv);
  assert.equal(response.status, 401);
});

test("missing sendblue webhook secret is rejected as misconfigured", async () => {
  const testEnv: Env = {
    ...env(),
    SENDBLUE_WEBHOOK_SECRET: undefined,
  };

  const response = await handleRequest(sendblueWebhook(inboundMessage("hello")), testEnv);
  assert.equal(response.status, 500);
  assert.match(String((await json(response)).error), /webhook secret/i);
});

test("sendblue webhook ignores outbound non-received and empty events", async () => {
  const testEnv = env();
  const outbound = await handleRequest(sendblueWebhook({ ...inboundMessage("hello"), is_outbound: true }), testEnv);
  const pending = await handleRequest(sendblueWebhook({ ...inboundMessage("hello"), status: "PENDING", message_handle: "msg_pending" }), testEnv);
  const empty = await handleRequest(sendblueWebhook(inboundMessage("   ", "msg_empty")), testEnv);
  assert.equal(outbound.status, 200);
  assert.equal(pending.status, 200);
  assert.equal(empty.status, 200);
});

test("enqueues replies from paired Sendblue texts", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("Append a line", "msg_2")), testEnv);

  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, "Append a line");
});

test("claims a pending reply exactly once", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("Do it once", "msg_2")), testEnv);
  const replyId = pendingReplies(testEnv, threadId)[0]?.id;
  assert.equal(typeof replyId, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  };
  try {
    const claim = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv, {
      waitUntil: (promise) => waitUntilPromises.push(promise),
    });
    assert.equal(claim.status, 200);
    assert.equal((await json(claim)).ok, true);
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
    assert.deepEqual(calls, [{
      url: "https://api.sendblue.test/api/send-typing-indicator",
      body: {
        number: "+15551234567",
        from_number: "+12344198201",
      },
    }]);

    const duplicate = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(duplicate.status, 409);

    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publishes status and shows debug thread state", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const status = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      lastAssistantMessage: "Done.",
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(status.status, 200);

  const debug = await handleRequest(req(`/threads/${threadId}`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(debug);
  assert.equal(body.id, threadId);
  assert.equal(body.lastAssistantMessage, undefined);
  assert.equal(body.lastStopAt, "2026-04-25T18:25:00.000Z");
});

test("publishes every non-empty status to sendblue", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const requestBody = {
      cwd: "/tmp/project",
      lastAssistantMessage: "Created [TEMP](/Owners/gabe/project/TEMP).",
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    };
    const first = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify(requestBody),
    }), testEnv);
    const duplicate = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify(requestBody),
    }), testEnv);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.sendblue.test/api/send-message");
    assert.equal(calls[0]?.headers.get("sb-api-key-id"), "sendblue-key");
    assert.equal(calls[0]?.headers.get("sb-api-secret-key"), "sendblue-secret");
    assert.deepEqual(calls[0]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Created TEMP.",
    });
    assert.equal((await notification(duplicate)).messageHandle, "message-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publishes each changed assistant message", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    for (const lastAssistantMessage of ["81", "Created [TEMP](/tmp/TEMP)."]) {
      const response = await handleRequest(req(`/threads/${threadId}/status`, {
        method: "POST",
        headers: { authorization: "Bearer dev-token" },
        body: JSON.stringify({
          cwd: "/tmp/project",
          lastAssistantMessage,
          status: "stopped",
          createdAt: "2026-04-25T18:25:00.000Z",
        }),
      }), testEnv);
      assert.equal(response.status, 200);
    }

    assert.deepEqual(outboundContents(calls), ["81", "Created TEMP."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads one generated image and sends it with send-message", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: "https://cdn.sendblue.test/cow.png" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: null,
        generatedImages: [generatedImage("cow.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls, [
      { url: "https://api.sendblue.test/api/upload-file", body: "form-data" },
      {
        url: "https://api.sendblue.test/api/send-message",
        body: {
          number: "+15551234567",
          from_number: "+12344198201",
          media_url: "https://cdn.sendblue.test/cow.png",
        },
      },
    ]);
    assert.equal((await notification(status)).messageHandle, "message-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects status messages that exceed the text cap", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      lastAssistantMessage: "x".repeat(20_001),
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(response.status, 413);
});

test("rejects more than five generated images", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      generatedImages: [
        generatedImage("1.png"),
        generatedImage("2.png"),
        generatedImage("3.png"),
        generatedImage("4.png"),
        generatedImage("5.png"),
        generatedImage("6.png"),
      ],
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(response.status, 413);
});

test("rejects generated images larger than ten megabytes", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      generatedImages: [generatedImageBytes("too-big.png", new Uint8Array((10 * 1024 * 1024) + 1))],
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(response.status, 413);
});

test("sends text and one generated image together", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: "https://cdn.sendblue.test/cow.png" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Here is **a cow**.",
        generatedImages: [generatedImage("cow.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls[1], {
      url: "https://api.sendblue.test/api/send-message",
      body: {
        number: "+15551234567",
        from_number: "+12344198201",
        content: "Here is a cow.",
        media_url: "https://cdn.sendblue.test/cow.png",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads multiple generated images and sends a carousel for iMessage users", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: `https://cdn.sendblue.test/image-${calls.length}.png` }), { status: 200 });
    }
    if (url.includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "carousel-1" }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: null,
        generatedImages: [generatedImage("first.png"), generatedImage("second.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-carousel",
    ]);
    assert.deepEqual(calls[3]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_urls: [
        "https://cdn.sendblue.test/image-1.png",
        "https://cdn.sendblue.test/image-2.png",
      ],
    });
    assert.equal((await notification(status)).messageHandle, "carousel-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends text before carousel for iMessage users with multiple generated images", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: `https://cdn.sendblue.test/image-${calls.length}.png` }), { status: 200 });
    }
    if (url.includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    const handle = url.endsWith("/send-carousel") ? "carousel-1" : "message-1";
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: handle }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Two cow options.",
        generatedImages: [generatedImage("first.png"), generatedImage("second.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-carousel",
    ]);
    assert.deepEqual(calls[3]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Two cow options.",
    });
    assert.deepEqual(calls[4]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_urls: [
        "https://cdn.sendblue.test/image-1.png",
        "https://cdn.sendblue.test/image-2.png",
      ],
    });
    assert.equal((await notification(status)).messageHandle, "carousel-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends multiple generated images separately for SMS users", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: `https://cdn.sendblue.test/image-${calls.length}.png` }), { status: 200 });
    }
    if (url.includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "SMS" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        generatedImages: [generatedImage("first.png"), generatedImage("second.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls[3]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_url: "https://cdn.sendblue.test/image-1.png",
    });
    assert.deepEqual(calls[4]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_url: "https://cdn.sendblue.test/image-2.png",
    });
    assert.equal((await notification(status)).messageHandle, "message-5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends multiple generated images separately when service lookup fails", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: `https://cdn.sendblue.test/image-${calls.length}.png` }), { status: 200 });
    }
    if (url.includes("/evaluate-service")) {
      return new Response(JSON.stringify({ status: "ERROR" }), { status: 500 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        generatedImages: [generatedImage("first.png"), generatedImage("second.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue media failure does not fail status publish", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: "ERROR", message: "Upload failed" }), { status: 500 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: null,
        generatedImages: [generatedImage("cow.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.match(String((await notification(status)).error), /Sendblue media API returned HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue failure does not fail status publish", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Done.",
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.equal((await notification(status)).status, "ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue error body is redacted without failing status publish", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      status: "ERROR",
      error_code: 10001,
      error_message: "Message failed to send: Done.",
    }), { status: 200 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Done.",
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    const result = await notification(status);
    assert.equal(result.status, "ERROR");
    assert.equal(result.error, "Sendblue rejected message with status ERROR.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue response without a message handle returns notification error", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "OK" }), { status: 200 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Done.",
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.equal((await notification(status)).status, "ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects requests with the wrong thread token", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}`, {
    headers: { authorization: "Bearer wrong-token" },
  }), testEnv);
  assert.equal(response.status, 401);
});

test("persistent service registers and synchronizes a thread catalog", async () => {
  const testEnv = env();
  const registration = await registerService(testEnv);
  assert.equal(registration.pairingRequired, true);
  assert.equal(String(registration.pairingCode).length, 6);
  const offlineStatus = await handleRequest(req("/service/status", { headers: { authorization: "Bearer dev-token" } }), testEnv);
  assert.equal((await json(offlineStatus)).connected, false);
  attachOwnerControlCapture(testEnv, []);
  const onlineStatus = await handleRequest(req("/service/status", { headers: { authorization: "Bearer dev-token" } }), testEnv);
  assert.equal((await json(onlineStatus)).connected, true);

  const response = await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads: [{
      id: "service-thread-1",
      title: "Service redesign",
      cwd: "/tmp/imessage",
      projectKey: "project-imessage",
      projectLabel: "imessage",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activityAt: "2026-07-12T00:01:00.000Z",
      stateSince: "2026-07-12T00:00:30.000Z",
      status: "pending",
      reasoningEffort: "high",
      visible: true,
      archived: false,
    }] }),
  }), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.synchronized, 1);
  const row = (testEnv.DB as unknown as FakeD1Database).threads.get("service-thread-1");
  assert.equal(row?.catalog_source, "service");
  assert.equal(row?.project_key, "project-imessage");
  assert.equal(row?.project_label, "imessage");
  assert.equal(row?.status, "pending");
  assert.equal(row?.activity_at, "2026-07-12T00:01:00.000Z");
  assert.equal(row?.state_since, "2026-07-12T00:00:30.000Z");
  assert.equal(row?.reasoning_effort, "high");
});

test("persistent service unregister restores legacy relay delivery", async () => {
  const testEnv = env();
  await registerService(testEnv);
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads: [{ id: "unregister-task", title: "Task", cwd: "project" }] }),
  }), testEnv);
  (testEnv.DB as unknown as FakeD1Database).phoneBindings.set("+15551234567", {
    phone_number: "+15551234567", owner_id: DEV_OWNER_ID, active_thread_id: "unregister-task",
    contact_card_sent_at: null, created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z",
  });
  const response = await handleRequest(req("/service/register", {
    method: "DELETE",
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  assert.equal(response.status, 200);
  assert.equal((testEnv.DB as unknown as FakeD1Database).serviceInstallations.has(DEV_OWNER_ID), false);
  assert.equal((testEnv.DB as unknown as FakeD1Database).threads.get("unregister-task")?.visible, 0);
  assert.equal((testEnv.DB as unknown as FakeD1Database).threads.get("unregister-task")?.handoff_enabled, 0);
  assert.equal((testEnv.DB as unknown as FakeD1Database).phoneBindings.get("+15551234567")?.active_thread_id, null);
  assert.equal((await json(response)).deliveryMode, "legacy");

  const legacy = await handleRequest(req("/threads/unregister-task", {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "Task" }),
  }), testEnv);
  assert.equal(legacy.status, 200);
  assert.equal((testEnv.DB as unknown as FakeD1Database).threads.get("unregister-task")?.catalog_source, "legacy");
  assert.equal((testEnv.DB as unknown as FakeD1Database).threads.get("unregister-task")?.visible, 1);
  const inbound = await handleRequest(sendblueWebhook(inboundMessage("Legacy message", "legacy-after-unregister")), testEnv);
  assert.equal(inbound.status, 200);
  assert.equal(pendingReplies(testEnv, "unregister-task").length, 1);
});

test("persistent service catalog is a validated full replacement", async () => {
  const testEnv = env();
  await registerService(testEnv);
  const put = (body: Record<string, unknown>) => handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify(body),
  }), testEnv);
  const thread = (id: string, projectKey: string) => ({
    id, title: id, cwd: projectKey, projectKey, projectLabel: "Shared label",
    updatedAt: "2026-07-12T00:00:00.000Z", activityAt: "2026-07-12T00:00:00.000Z",
    status: "idle",
  });

  const db = testEnv.DB as unknown as FakeD1Database;
  db.threads.set("legacy-stale", {
    id: "legacy-stale", owner_id: DEV_OWNER_ID, cwd: "legacy", title: "Legacy task",
    handoff_summary: null, status: "idle", handoff_enabled: 1, pairing_code: null,
    pairing_code_expires_at: null, last_stop_at: null, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", visible: 1,
  });
  assert.equal((await put({ complete: true, threads: [thread("one", "project-one"), thread("two", "project-two")] })).status, 200);
  assert.equal(db.threads.get("legacy-stale")?.visible, 0, "service snapshots retire leftover legacy rows");
  const firstGeneration = db.threads.get("one")?.catalog_generation;
  assert.ok(firstGeneration);
  assert.equal(db.threads.get("two")?.catalog_generation, firstGeneration);
  assert.equal((await put({ complete: true, threads: [thread("two", "project-two")] })).status, 200);
  assert.equal(db.threads.get("one")?.visible, 0);
  assert.equal(db.threads.get("two")?.visible, 1);
  assert.notEqual(db.threads.get("two")?.catalog_generation, firstGeneration);

  const duplicate = await put({ complete: true, threads: [thread("two", "project-two"), thread("two", "project-two")] });
  assert.equal(duplicate.status, 400);
  assert.match(String((await json(duplicate)).error), /unique/i);
  assert.equal(db.threads.get("two")?.visible, 1, "validation happens before replacement");

  const incomplete = await put({ threads: [thread("two", "project-two")] });
  assert.equal(incomplete.status, 400);
  assert.match(String((await json(incomplete)).error), /complete/i);

  const large = Array.from({ length: 500 }, (_, index) => ({
    ...thread(`large-${index}`, `project-${index}`),
    title: `Task ${index} ${"x".repeat(145)}`.slice(0, 160),
  }));
  const writesBeforeLargeSync = db.runCount;
  const largeResponse = await put({ complete: true, threads: large });
  assert.equal(largeResponse.status, 200, "the advertised 500-task snapshot fits the catalog body cap");
  assert.equal(db.runCount - writesBeforeLargeSync, 2, "catalog replacement is one set-based upsert plus one stale-row update");

  const existing = db.threads.get("large-0");
  db.threads.set("foreign-id", { ...existing!, id: "foreign-id", owner_id: "another-owner" });
  const collision = await put({ complete: true, threads: [thread("foreign-id", "foreign-project")] });
  assert.equal(collision.status, 409);
  assert.equal(db.threads.get("foreign-id")?.owner_id, "another-owner");
});

test("thread detail commands route immediately with arguments and start typing", async () => {
  const testEnv = env();
  const registration = await registerService(testEnv);
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads: [{
      id: "service-thread-1", title: "Service redesign", cwd: "imessage",
      projectKey: "project-imessage", projectLabel: "imessage", status: "idle",
    }] }),
  }), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(registration.pairingCode), "service-pair-controls")), testEnv);
  const controls: Array<Record<string, unknown>> = [];
  attachOwnerControlCapture(testEnv, controls);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ status: "SENT", message_handle: `out-${calls.length}` }), { status: 200 });
  };
  try {
    const commands = [
      ["/history 3", "history", "3"],
      ["/message", "request", null],
      ["/turn", "turn", null],
      ["/reasoning high", "reasoning", "high"],
      ["/status", "open", "status"],
      ["/retry", "retry", null],
      ["/dismiss", "dismiss", null],
    ] as const;
    for (let index = 0; index < commands.length; index += 1) {
      const [text, command, argument] = commands[index];
      const response = await handleRequest(sendblueWebhook(inboundMessage(text, `control-${index}`)), testEnv);
      assert.equal(response.status, 200);
      assert.deepEqual(controls.at(-1), {
        type: "control", command, threadId: "service-thread-1", argument,
      });
    }
    assert.ok(calls.filter((url) => url.includes("send-typing-indicator")).length >= commands.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("thread controls report an offline local service instead of disappearing", async () => {
  const testEnv = env();
  const registration = await registerService(testEnv);
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads: [{ id: "offline-thread", title: "Offline task", cwd: "offline", projectKey: "offline", projectLabel: "Offline" }] }),
  }), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(registration.pairingCode), "offline_pair")), testEnv);
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ status: "SENT", message_handle: `offline-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage("/thread", "offline_control")), testEnv);
    assert.equal((await json(response)).routed, false);
    assert.match(String(outboundContents(calls.map((call) => call.body)).at(-1)), /local Codex service is offline/i);
    assert.equal(calls.some((call) => call.url.includes("send-typing-indicator")), false);
    const ordinary = await handleRequest(sendblueWebhook(inboundMessage("Please run the tests", "offline_prompt")), testEnv);
    assert.equal((await json(ordinary)).serviceOffline, true);
    assert.equal(pendingReplies(testEnv, "offline-thread").length, 0);
    assert.match(String(outboundContents(calls.map((call) => call.body)).at(-1)), /local Codex service is offline/i);
    const list = await handleRequest(sendblueWebhook(inboundMessage("/threads", "offline_list")), testEnv);
    assert.equal((await json(list)).routed, false);
    assert.match(String(outboundContents(calls.map((call) => call.body)).at(-1)), /local Codex service is offline/i);
    const shortcut = await handleRequest(sendblueWebhook(inboundMessage("1: run it", "offline_shortcut")), testEnv);
    assert.equal((await json(shortcut)).serviceOffline, true);
    assert.equal(pendingReplies(testEnv, "offline-thread").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("older persistent clients keep the relay-rendered directory during a rolling upgrade", async () => {
  const testEnv = env();
  const registration = await registerService(testEnv, { serviceVersion: "0.3.1", capabilities: ["catalog-v2"] });
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads: [{ id: "old-client-thread", title: "Compatible task", cwd: "project", projectKey: "project", projectLabel: "Project" }] }),
  }), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(registration.pairingCode), "old-client-pair")), testEnv);
  const controls: Array<Record<string, unknown>> = [];
  attachOwnerControlCapture(testEnv, controls);
  const calls: Array<Record<string, unknown> | null> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "SENT", message_handle: `old-${calls.length}` }), { status: 200 });
  };
  try {
    const list = await handleRequest(sendblueWebhook(inboundMessage("/threads", "old-client-list")), testEnv);
    assert.equal(list.status, 200);
    assert.equal(controls.length, 0);
    assert.match(String(outboundContents(calls).at(-1)), /^CODEX CONTROL · THREADS/);
    assert.match(String(outboundContents(calls).at(-1)), /Compatible task/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local directory previews stay transient and numeric thread opens use its exact visual order", async () => {
  const testEnv = env();
  const registration = await registerService(testEnv);
  const threads = Array.from({ length: 5 }, (_, index) => ({
    id: `thread-${index + 1}`,
    title: `Task ${index + 1}`,
    cwd: `project-${index + 1}`,
    projectKey: `project-key-${index + 1}`,
    projectLabel: index === 4 ? null : index < 2 ? "Same label" : `Project ${index + 1}`,
    status: index === 1 ? "pending" : "idle",
    activityAt: `2026-07-12T00:0${5 - index}:00.000Z`,
  }));
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads }),
  }), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(registration.pairingCode), "service-pair-directory")), testEnv);
  const controls: Array<Record<string, unknown>> = [];
  attachOwnerControlCapture(testEnv, controls);
  const calls: Array<Record<string, unknown> | null> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "SENT", message_handle: `out-${calls.length}` }), { status: 200 });
  };
  try {
    const list = await handleRequest(sendblueWebhook(inboundMessage("/threads", "directory-list")), testEnv);
    assert.equal(list.status, 200);
    assert.equal((await json(list)).routed, true);
    assert.deepEqual(controls.at(-1), { type: "control", command: "threads", threadId: "thread-2", argument: null });

    calls.length = 0;
    const directory = {
      kind: "service.directory",
      directory: {
        label: "THREADS",
        totalTasks: 4,
        criteria: "pending + activity in last 48h",
        groups: [
          {
            projectKey: "project-key-1",
            projectLabel: "Same label · 1",
            threads: [
              { id: "thread-2", index: 1, title: "Task 2", current: true, status: "pending", stateSince: "2026-07-12T00:04:00.000Z", requestPreview: "Newest private queued request" },
              { id: "thread-1", index: 2, title: "Task 1", status: "idle", activityAt: "2026-07-12T00:05:00.000Z", requestPreview: "Private preview never in D1" },
            ],
          },
          {
            projectKey: "project-key-3",
            projectLabel: "Project 3",
            threads: [{ id: "thread-3", index: 3, title: "Task 3", status: "idle", activityAt: "2026-07-12T00:03:00.000Z", requestPreview: "Recent project request" }],
          },
          {
            projectKey: "other-tasks",
            projectLabel: "Other tasks",
            threads: [{ id: "thread-5", index: 4, title: "Task 5", status: "idle", activityAt: "2026-07-12T00:01:00.000Z", requestPreview: "General Codex question" }],
          },
        ],
      },
    };
    const delivered = await handleRequest(req("/service/events/outbound", {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ event: directory }),
    }), testEnv);
    assert.equal(delivered.status, 200);
    const rendered = String(outboundContents(calls).at(-1));
    assert.match(rendered, /SAME LABEL · 1/);
    assert.match(rendered, /“Private preview never in D1”/);
    assert.match(rendered, /OTHER TASKS/);
    assert.doesNotMatch(rendered, /Task 4/);
    const db = testEnv.DB as unknown as FakeD1Database;
    const snapshot = JSON.parse(String(db.menuSnapshots.get("+15551234567")?.items_json)) as string[];
    assert.deepEqual(snapshot, ["thread:thread-2", "thread:thread-1", "thread:thread-3", "thread:thread-5"]);
    assert.doesNotMatch(JSON.stringify([...db.threads.values()]), /Private preview never in D1/);
    assert.doesNotMatch(String(db.menuSnapshots.get("+15551234567")?.items_json), /Private preview never in D1/);

    const invalidDirectory = JSON.parse(JSON.stringify(directory));
    invalidDirectory.directory.groups[1].threads[0].index = 2;
    const invalid = await handleRequest(req("/service/events/outbound", {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ event: invalidDirectory }),
    }), testEnv);
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(String(db.menuSnapshots.get("+15551234567")?.items_json)), snapshot);

    calls.length = 0;
    const refresh = await handleRequest(sendblueWebhook(inboundMessage("/refresh", "directory-refresh")), testEnv);
    assert.equal(refresh.status, 200);
    assert.equal((await json(refresh)).command, "refresh");
    assert.deepEqual(controls.at(-1), { type: "control", command: "threads", threadId: "thread-2", argument: "refresh" });

    calls.length = 0;
    const open = await handleRequest(sendblueWebhook(inboundMessage("2", "directory-open")), testEnv);
    assert.equal(open.status, 200);
    assert.equal(controls.at(-1)?.type, "control");
    assert.equal(controls.at(-1)?.command, "open");
    assert.equal(controls.at(-1)?.threadId, "thread-1");
    assert.match(String(outboundContents(calls).at(0)), /^CODEX CONTROL · SWITCHED/);

    db.menuSnapshots.get("+15551234567")!.expires_at = "2026-01-01T00:00:00.000Z";
    const stale = await handleRequest(sendblueWebhook(inboundMessage("1", "directory-stale")), testEnv);
    assert.equal((await json(stale)).refreshed, true);
    assert.deepEqual(controls.at(-1), { type: "control", command: "threads", threadId: "thread-1", argument: "refresh" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistent service keeps an unexpired pairing code stable", async () => {
  const testEnv = env();
  const first = await registerService(testEnv);
  const second = await registerService(testEnv);
  assert.equal(second.pairingCode, first.pairingCode);
  assert.equal(second.pairingCodeExpiresAt, first.pairingCodeExpiresAt);
});

test("persistent service event socket is authenticated at installation scope", async () => {
  const testEnv: Env = env();
  await registerService(testEnv);
  let forwardedPath = "";
  testEnv.HANDOFF_SOCKET = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get(id: DurableObjectId) {
      return { id, fetch: async (request: Request) => {
        forwardedPath = new URL(request.url).pathname;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      } } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const response = await handleRequest(req("/service/events?token=dev-token", { headers: { upgrade: "websocket" } }), testEnv);
  assert.equal(response.status, 200);
  assert.equal(forwardedPath, `/owners/${DEV_OWNER_ID}/events`);
});

test("installation pairing reuses the phone binding and renders a clean connected message", async () => {
  const testEnv = env();
  const registration = await registerService(testEnv);
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads: [{ id: "service-thread-1", title: "Service redesign", cwd: "/tmp/imessage", projectKey: "project-imessage", projectLabel: "imessage" }] }),
  }), testEnv);
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "out-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(registration.pairingCode), "service-pair-1")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.service, true);
    assert.equal((testEnv.DB as unknown as FakeD1Database).phoneBindings.get("+15551234567")?.active_thread_id, "service-thread-1");
    assert.match(String(outboundContents(calls).at(-1)), /^CODEX CONTROL · CONNECTED/);
    assert.doesNotMatch(String(outboundContents(calls).at(-1)), /hook|relay|token/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service outbound labels model output with its source thread", async () => {
  const testEnv = env();
  await registerService(testEnv);
  (testEnv.DB as unknown as FakeD1Database).phoneBindings.set("+15551234567", {
    phone_number: "+15551234567", owner_id: DEV_OWNER_ID, active_thread_id: "thread-1",
    contact_card_sent_at: null, created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z",
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "out-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(req("/service/events/outbound", {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ event: { kind: "thread.output", thread: { title: "Music crawler" }, body: "All tests pass." } }),
    }), testEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(outboundContents(calls), ["CODEX THREAD · CODEX\nMusic crawler\n\nAll tests pass."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service outbound splits long thread output with source headers", async () => {
  const testEnv = env();
  await registerService(testEnv);
  (testEnv.DB as unknown as FakeD1Database).phoneBindings.set("+15551234567", {
    phone_number: "+15551234567", owner_id: DEV_OWNER_ID, active_thread_id: "thread-1",
    contact_card_sent_at: null, created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z",
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `out-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(req("/service/events/outbound", {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ event: { kind: "thread.output", thread: { title: "Long task" }, body: "A".repeat(9000) } }),
    }), testEnv);
    assert.equal(response.status, 200);
    const contents = outboundContents(calls);
    assert.equal(contents.length, 2);
    assert.match(String(contents[0]), /^CODEX THREAD · CODEX · 1\/2/);
    assert.match(String(contents[1]), /^CODEX THREAD · CODEX · 2\/2/);
    assert.equal(((await json(response)).notification as Record<string, unknown>).parts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("partial multi-part directory delivery cannot leave an older numeric mapping active", async () => {
  const testEnv = env();
  await registerService(testEnv);
  const threads = Array.from({ length: 60 }, (_, index) => ({
    id: `large-directory-${index}`,
    title: `Task ${index} ${"T".repeat(120)}`,
    cwd: "large-project",
    projectKey: "large-project",
    projectLabel: "Large project",
  }));
  await handleRequest(req("/service/catalog", {
    method: "PUT",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ complete: true, threads }),
  }), testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567", owner_id: DEV_OWNER_ID, active_thread_id: threads[0].id,
    contact_card_sent_at: null, created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z",
  });
  db.menuSnapshots.set("+15551234567", {
    phone_number: "+15551234567", owner_id: DEV_OWNER_ID, items_json: JSON.stringify(["thread:older-task"]),
    expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-07-12T00:00:00.000Z",
  });
  let sends = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("send-message")) {
      sends += 1;
      if (sends === 2) return new Response(JSON.stringify({ error: "provider failure" }), { status: 500 });
    }
    return new Response(JSON.stringify({ status: "SENT", message_handle: `large-${sends}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(req("/service/events/outbound", {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ event: {
        kind: "service.directory",
        directory: {
          label: "THREADS",
          totalTasks: threads.length,
          groups: [{
            projectKey: "large-project",
            projectLabel: "Large project",
            threads: threads.map((thread, index) => ({
              id: thread.id,
              index: index + 1,
              title: thread.title,
              status: "idle",
              activityAt: "2026-07-12T00:00:00.000Z",
              requestPreview: `Preview ${index} ${"P".repeat(150)}`,
            })),
          }],
        },
      } }),
    }), testEnv);
    assert.equal(response.status, 400);
    assert.equal(sends, 2, "the fixture must fail after at least one visible directory part");
    assert.deepEqual(JSON.parse(String(db.menuSnapshots.get("+15551234567")?.items_json)), []);
    assert.ok(Date.parse(String(db.menuSnapshots.get("+15551234567")?.expires_at)) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service outbound chunks long detail and history views with continuation headers", async () => {
  const testEnv = env();
  await registerService(testEnv);
  (testEnv.DB as unknown as FakeD1Database).phoneBindings.set("+15551234567", {
    phone_number: "+15551234567", owner_id: DEV_OWNER_ID, active_thread_id: "thread-1",
    contact_card_sent_at: null, created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z",
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `out-${calls.length}` }), { status: 200 });
  };
  try {
    const events = [
      {
        kind: "thread.detail",
        thread: { title: "Long detail", projectLabel: "Interaction service" },
        state: "idle",
        requestPreview: { body: "Review the complete result." },
        assistantMessages: [{ body: "D".repeat(18_000), phase: "final_answer" }],
      },
      {
        kind: "thread.history",
        thread: { title: "Long history", projectLabel: "Interaction service" },
        turns: [{ request: "Show the prior result.", finalResponse: "H".repeat(18_000) }],
      },
    ];
    for (const event of events) {
      calls.length = 0;
      const response = await handleRequest(req("/service/events/outbound", {
        method: "POST",
        headers: { authorization: "Bearer dev-token" },
        body: JSON.stringify({ event }),
      }), testEnv);
      assert.equal(response.status, 200);
      const contents = outboundContents(calls);
      assert.ok(contents.length >= 3);
      assert.match(String(contents[0]), /^CODEX THREAD · INTERACTION SERVICE/);
      assert.match(String(contents[1]), /^CODEX THREAD · INTERACTION SERVICE · 2\//);
      assert.ok(contents.every((content) => String(content).length <= 8000));
      assert.equal(((await json(response)).notification as Record<string, unknown>).parts, contents.length);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
