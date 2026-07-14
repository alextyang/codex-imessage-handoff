import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codexHome, serviceHome } from "./paths.mjs";

export const REASONING_OPTIONS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CONSERVATIVE_OPTIONS = Object.freeze(["low", "medium", "high", "xhigh"]);

export const REASONING_PRESENTATION = Object.freeze({
  inherit: Object.freeze({ emoji: "↩️", label: "Inherit" }),
  low: Object.freeze({ emoji: "🪶", label: "Low" }),
  medium: Object.freeze({ emoji: "⚙️", label: "Medium" }),
  high: Object.freeze({ emoji: "🔍", label: "High" }),
  xhigh: Object.freeze({ emoji: "🔬", label: "Extra high" }),
  max: Object.freeze({ emoji: "🧠", label: "Max" }),
  ultra: Object.freeze({ emoji: "🚀", label: "Ultra" }),
});

function settingsPath() {
  return process.env.IMESSAGE_HANDOFF_THREAD_SETTINGS || path.join(serviceHome(), "thread-settings.json");
}

function supportedOptions(model) {
  if (typeof model !== "string" || !model.trim()) return [...CONSERVATIVE_OPTIONS];
  try {
    const cache = JSON.parse(readFileSync(path.join(codexHome(), "models_cache.json"), "utf8"));
    const entry = Array.isArray(cache?.models) ? cache.models.find((item) => item?.slug === model) : null;
    const values = Array.isArray(entry?.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((item) => item?.effort).filter((value) => REASONING_OPTIONS.includes(value))
      : [];
    return values.length ? [...new Set(values)] : [...CONSERVATIVE_OPTIONS];
  } catch {
    return [...CONSERVATIVE_OPTIONS];
  }
}

function normalizeThreadId(threadId) {
  const value = String(threadId || "").trim();
  if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new TypeError("A valid thread id is required.");
  return value;
}

function normalizeLevel(level) {
  const value = String(level || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = { xhigh: "xhigh", extrahigh: "xhigh" };
  const normalized = aliases[value] || value;
  if (!REASONING_OPTIONS.includes(normalized)) {
    throw new RangeError(`Unsupported reasoning effort: ${String(level)}.`);
  }
  return normalized;
}

function clearsLevel(level) {
  if (level === null || level === undefined) return true;
  return ["default", "none", "inherit"].includes(String(level).trim().toLowerCase());
}

function emptyStore() {
  return { version: 2, defaultReasoning: null, reasoning: Object.create(null) };
}

function readStore() {
  const file = settingsPath();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return emptyStore();
    const wrapped = new Error("Thread settings could not be read safely.", { cause: error });
    wrapped.code = "INVALID_THREAD_SETTINGS";
    throw wrapped;
  }
  const supportedVersion = parsed?.version === 1 || parsed?.version === 2;
  const validReasoning = parsed?.reasoning && typeof parsed.reasoning === "object" && !Array.isArray(parsed.reasoning);
  const validDefault = parsed?.version === 1
    || parsed?.defaultReasoning === null
    || parsed?.defaultReasoning === undefined
    || (typeof parsed?.defaultReasoning === "string" && REASONING_OPTIONS.includes(parsed.defaultReasoning));
  if (!parsed || typeof parsed !== "object" || !supportedVersion || !validReasoning || !validDefault) {
    const error = new Error("Thread settings have an unsupported format.");
    error.code = "INVALID_THREAD_SETTINGS";
    throw error;
  }
  const reasoning = Object.create(null);
  for (const [threadId, level] of Object.entries(parsed.reasoning)) {
    if (typeof level === "string" && REASONING_OPTIONS.includes(level)) reasoning[threadId] = level;
  }
  return {
    version: 2,
    defaultReasoning: parsed.version === 2 && typeof parsed.defaultReasoning === "string"
      ? parsed.defaultReasoning
      : null,
    reasoning,
  };
}

function writeStore(store) {
  const file = settingsPath();
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch {}
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const body = `${JSON.stringify({
      version: 2,
      defaultReasoning: store.defaultReasoning || null,
      reasoning: store.reasoning,
    }, null, 2)}\n`;
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    try { chmodSync(file, 0o600); } catch {}
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function getReasoningOverride(threadId) {
  const id = normalizeThreadId(threadId);
  return readStore().reasoning[id] || null;
}

export function setReasoningOverride(threadId, level) {
  const id = normalizeThreadId(threadId);
  const store = readStore();
  if (clearsLevel(level)) {
    delete store.reasoning[id];
    writeStore(store);
    return null;
  }
  const normalized = normalizeLevel(level);
  store.reasoning[id] = normalized;
  writeStore(store);
  return normalized;
}

export function getDefaultReasoning() {
  return readStore().defaultReasoning || null;
}

export function setDefaultReasoning(level) {
  const store = readStore();
  if (clearsLevel(level)) {
    store.defaultReasoning = null;
    writeStore(store);
    return null;
  }
  const normalized = normalizeLevel(level);
  store.defaultReasoning = normalized;
  writeStore(store);
  return normalized;
}

export function listDefaultReasoningOptions() {
  const selected = getDefaultReasoning();
  return [
    {
      value: "default",
      label: `${REASONING_PRESENTATION.inherit.emoji} ${REASONING_PRESENTATION.inherit.label}`,
      selected: !selected,
      overridden: false,
    },
    ...REASONING_OPTIONS.map((value) => ({
      value,
      label: `${REASONING_PRESENTATION[value].emoji} ${REASONING_PRESENTATION[value].label}`,
      selected: value === selected,
      overridden: value === selected,
    })),
  ];
}

export function listReasoningOptions(thread) {
  const id = normalizeThreadId(typeof thread === "string" ? thread : thread?.id);
  const override = getReasoningOverride(id);
  const levels = supportedOptions(typeof thread === "object" ? thread?.model : null);
  return [
    { value: "default", label: "Use task default", selected: !override, overridden: false },
    ...levels.map((value) => ({
      value,
      label: REASONING_PRESENTATION[value].label,
      selected: value === override,
      overridden: value === override,
    })),
  ];
}
