import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { writePrivateJson } from "./config.mjs";
import { serviceHome } from "./paths.mjs";

const VERSION = 1;
const MAX_FLOWS = 32;
const FLOW_TTL_MS = 30 * 60 * 1000;
const STAGES = new Set(["project", "reasoning", "prompt", "creating", "queued"]);

function clean(value, limit = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= limit && !/[\u0000-\u001f]/.test(text) ? text : null;
}

function flowIdFor(messageKey) {
  const key = clean(messageKey, 256);
  if (!key) throw new TypeError("A durable inbound message key is required.");
  return createHash("sha256").update(`imessage-new-thread-v1:${key}`).digest("hex").slice(0, 32);
}

function emptyStore() {
  return { version: VERSION, flows: Object.create(null) };
}

function normalizeFlow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = clean(value.id, 64);
  const messageKey = clean(value.messageKey, 256);
  const stage = clean(value.stage, 32);
  const createdAt = clean(value.createdAt, 64);
  const updatedAt = clean(value.updatedAt, 64);
  const expiresAt = clean(value.expiresAt, 64);
  const attemptedAt = clean(value.createAttemptedAt, 64);
  if (!id || !messageKey || !STAGES.has(stage) || !createdAt || !updatedAt || !expiresAt
    || !Number.isFinite(Date.parse(expiresAt))) return null;
  return {
    id,
    messageKey,
    stage,
    createdAt,
    updatedAt,
    expiresAt,
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 32_000) : "",
    attachments: Array.isArray(value.attachments) ? structuredClone(value.attachments.slice(0, 5)) : [],
    guid: clean(value.guid, 256),
    projectKey: clean(value.projectKey, 256),
    projectLabel: clean(value.projectLabel, 256),
    cwd: clean(value.cwd, 4_096),
    otherTask: value.otherTask === true,
    reasoning: clean(value.reasoning, 32),
    threadSource: clean(value.threadSource, 512),
    threadId: clean(value.threadId, 200),
    promptSetupKey: clean(value.promptSetupKey, 256),
    submissionKey: clean(value.submissionKey, 256),
    createAttemptedAt: attemptedAt && Number.isFinite(Date.parse(attemptedAt)) ? attemptedAt : null,
  };
}

function readStore(now = Date.now()) {
  const file = `${serviceHome()}/new-thread-state.json`;
  if (!existsSync(file)) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error("New-task state could not be read safely.", { cause: error }), { code: "INVALID_NEW_THREAD_STATE" });
  }
  if (!parsed || parsed.version !== VERSION || !parsed.flows || typeof parsed.flows !== "object" || Array.isArray(parsed.flows)) {
    throw Object.assign(new Error("New-task state has an unsupported format."), { code: "INVALID_NEW_THREAD_STATE" });
  }
  const flows = Object.create(null);
  for (const value of Object.values(parsed.flows)) {
    const flow = normalizeFlow(value);
    if (flow && Date.parse(flow.expiresAt) > now) flows[flow.id] = flow;
  }
  return { version: VERSION, flows };
}

function writeStore(store) {
  const file = `${serviceHome()}/new-thread-state.json`;
  const entries = Object.values(store.flows)
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)))
    .slice(-MAX_FLOWS);
  if (!entries.length) {
    rmSync(file, { force: true });
    return;
  }
  writePrivateJson(file, { version: VERSION, flows: Object.fromEntries(entries.map((flow) => [flow.id, flow])) });
  try { chmodSync(file, 0o600); } catch {}
}

export class NewThreadFlowStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
  }

  begin(action) {
    const store = readStore(this.now());
    const id = flowIdFor(action?.messageKey);
    if (store.flows[id]) return structuredClone(store.flows[id]);
    const timestamp = new Date(this.now()).toISOString();
    const flow = {
      id,
      messageKey: clean(action?.messageKey, 256),
      stage: "project",
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(this.now() + FLOW_TTL_MS).toISOString(),
      prompt: typeof action?.argument === "string" ? action.argument.trim().slice(0, 32_000) : "",
      attachments: Array.isArray(action?.attachments) ? structuredClone(action.attachments.slice(0, 5)) : [],
      guid: clean(action?.guid, 256),
      projectKey: null,
      projectLabel: null,
      cwd: null,
      otherTask: false,
      reasoning: null,
      threadSource: `imessage-handoff:new:${id}`,
      threadId: null,
      promptSetupKey: null,
      submissionKey: null,
      createAttemptedAt: null,
    };
    store.flows[id] = flow;
    writeStore(store);
    return structuredClone(flow);
  }

  get(flowId) {
    const id = clean(flowId, 64);
    const flow = id ? readStore(this.now()).flows[id] : null;
    return flow ? structuredClone(flow) : null;
  }

  update(flowId, changes = {}) {
    const id = clean(flowId, 64);
    const store = readStore(this.now());
    const flow = id ? store.flows[id] : null;
    if (!flow) return null;
    const nextStage = clean(changes.stage, 32);
    if (nextStage && !STAGES.has(nextStage)) throw new TypeError("Invalid new-task stage.");
    const next = normalizeFlow({
      ...flow,
      ...changes,
      id: flow.id,
      messageKey: flow.messageKey,
      stage: nextStage || flow.stage,
      updatedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + FLOW_TTL_MS).toISOString(),
    });
    if (!next) throw new TypeError("Invalid new-task flow update.");
    store.flows[id] = next;
    writeStore(store);
    return structuredClone(next);
  }

  remove(flowId) {
    const id = clean(flowId, 64);
    if (!id) return false;
    const store = readStore(this.now());
    const existed = Boolean(store.flows[id]);
    delete store.flows[id];
    writeStore(store);
    return existed;
  }
}

export const newThreadFlowInternals = Object.freeze({ flowIdFor, flowTtlMs: FLOW_TTL_MS });
