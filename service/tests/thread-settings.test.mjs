import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDefaultReasoning,
  getReasoningOverride,
  listDefaultReasoningOptions,
  listReasoningOptions,
  reasoningAwarenessReaction,
  REASONING_PRESENTATION,
  setDefaultReasoning,
  setReasoningOverride,
} from "../src/thread-settings.mjs";

test("reasoning presentation metadata is complete, deterministic, and immutable", () => {
  assert.deepEqual(REASONING_PRESENTATION, {
    inherit: { emoji: "↩️", label: "Inherit" },
    low: { emoji: "🪶", label: "Low" },
    medium: { emoji: "⚙️", label: "Medium" },
    high: { emoji: "🔍", label: "High" },
    xhigh: { emoji: "🔬", label: "Extra high" },
    max: { emoji: "🧠", label: "Max" },
    ultra: { emoji: "🚀", label: "Ultra" },
  });
  assert.equal(Object.isFrozen(REASONING_PRESENTATION), true);
  assert.ok(Object.values(REASONING_PRESENTATION).every(Object.isFrozen));
});

test("reasoning overrides persist privately per canonical thread", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-settings-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  process.env.CODEX_HOME = home;
  writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-test", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }] }],
  }));
  try {
    assert.equal(getReasoningOverride("thread-a"), null);
    assert.equal(setReasoningOverride("thread-a", "Extra High"), "xhigh");
    assert.equal(setReasoningOverride("thread-b", "low"), "low");
    assert.equal(getReasoningOverride("thread-a"), "xhigh");
    assert.equal(getReasoningOverride("thread-b"), "low");

    const options = listReasoningOptions({ id: "thread-a", model: "gpt-test", reasoningEffort: "medium" });
    assert.deepEqual(options.map((option) => option.value), ["default", "low", "high", "xhigh"]);
    assert.equal(options.find((option) => option.value === "xhigh").selected, true);
    assert.equal(options.find((option) => option.value === "xhigh").overridden, true);

    const file = path.join(home, "thread-settings.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored, {
      version: 2,
      defaultReasoning: null,
      reasoning: { "thread-a": "xhigh", "thread-b": "low" },
    });

    assert.equal(setReasoningOverride("thread-a", "default"), null);
    assert.equal(getReasoningOverride("thread-a"), null);
    const defaults = listReasoningOptions({ id: "thread-a", model: "gpt-test", reasoningEffort: "medium" });
    assert.equal(defaults.find((option) => option.value === "default").selected, true);
    assert.deepEqual(defaults.filter((option) => option.selected).map((option) => option.value), ["default"]);
    assert.throws(() => setReasoningOverride("thread-a", "impossible"), /Unsupported reasoning effort/);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("global default reasoning persists privately and exposes every canonical option", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-default-reasoning-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  try {
    assert.equal(getDefaultReasoning(), null);
    assert.equal(setReasoningOverride("thread-a", "low"), "low");
    assert.equal(setDefaultReasoning("Extra High"), "xhigh");
    assert.equal(getDefaultReasoning(), "xhigh");
    assert.equal(getReasoningOverride("thread-a"), "low");
    assert.equal(reasoningAwarenessReaction("xhigh"), null);
    assert.equal(reasoningAwarenessReaction("low"), "🪶");
    assert.equal(reasoningAwarenessReaction("high"), "🔍");
    assert.equal(reasoningAwarenessReaction(null), null);
    assert.equal(reasoningAwarenessReaction("future"), null);

    const options = listDefaultReasoningOptions();
    assert.deepEqual(options.map((option) => option.value), [
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    assert.deepEqual(options.map((option) => option.label), [
      "↩️ Inherit",
      "🪶 Low",
      "⚙️ Medium",
      "🔍 High",
      "🔬 Extra high",
      "🧠 Max",
      "🚀 Ultra",
    ]);
    assert.deepEqual(options.filter((option) => option.selected).map((option) => option.value), ["xhigh"]);

    const file = path.join(home, "thread-settings.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      version: 2,
      defaultReasoning: "xhigh",
      reasoning: { "thread-a": "low" },
    });

    assert.equal(setDefaultReasoning("none"), null);
    assert.equal(getDefaultReasoning(), null);
    assert.equal(reasoningAwarenessReaction("low"), null);
    assert.deepEqual(listDefaultReasoningOptions().filter((option) => option.selected).map((option) => option.value), ["default"]);
    assert.equal(getReasoningOverride("thread-a"), "low");
    assert.throws(() => setDefaultReasoning("impossible"), /Unsupported reasoning effort/);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("version 1 settings remain readable and migrate only on mutation", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-settings-v1-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  const file = path.join(home, "thread-settings.json");
  const legacy = { version: 1, reasoning: { "thread-a": "high", "thread-b": "low" } };
  writeFileSync(file, `${JSON.stringify(legacy)}\n`, "utf8");
  try {
    assert.equal(getReasoningOverride("thread-a"), "high");
    assert.equal(getDefaultReasoning(), null);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), legacy);

    assert.equal(setDefaultReasoning("medium"), "medium");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      version: 2,
      defaultReasoning: "medium",
      reasoning: { "thread-a": "high", "thread-b": "low" },
    });
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("malformed settings are not silently overwritten", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-settings-invalid-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  const file = path.join(home, "thread-settings.json");
  writeFileSync(file, "{broken", "utf8");
  try {
    assert.equal(reasoningAwarenessReaction("high"), null, "presentation awareness must fail soft");
    assert.throws(() => getReasoningOverride("thread-a"), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.throws(() => setReasoningOverride("thread-a", "high"), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.equal(readFileSync(file, "utf8"), "{broken");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});

test("invalid version 2 defaults are rejected without overwriting the store", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-settings-invalid-v2-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  const file = path.join(home, "thread-settings.json");
  const malformed = '{"version":2,"defaultReasoning":"future","reasoning":{"thread-a":"high"}}\n';
  writeFileSync(file, malformed, "utf8");
  try {
    assert.throws(() => getDefaultReasoning(), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.throws(() => setDefaultReasoning("low"), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.throws(() => setReasoningOverride("thread-a", "low"), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.equal(readFileSync(file, "utf8"), malformed);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});
