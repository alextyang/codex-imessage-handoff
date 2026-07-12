import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getReasoningOverride,
  listReasoningOptions,
  setReasoningOverride,
} from "../src/thread-settings.mjs";

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
    assert.deepEqual(stored, { version: 1, reasoning: { "thread-a": "xhigh", "thread-b": "low" } });

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

test("malformed settings are not silently overwritten", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-thread-settings-invalid-"));
  const previous = process.env.IMESSAGE_HANDOFF_HOME;
  process.env.IMESSAGE_HANDOFF_HOME = home;
  const file = path.join(home, "thread-settings.json");
  writeFileSync(file, "{broken", "utf8");
  try {
    assert.throws(() => getReasoningOverride("thread-a"), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.throws(() => setReasoningOverride("thread-a", "high"), (error) => error.code === "INVALID_THREAD_SETTINGS");
    assert.equal(readFileSync(file, "utf8"), "{broken");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previous;
  }
});
