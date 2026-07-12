import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorkspaceState, resetWorkspaceStateCache } from "../src/workspace-state.mjs";

test("Codex project metadata identifies projectless tasks and preserves the last valid snapshot", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-workspace-state-"));
  const file = path.join(directory, "global-state.json");
  const previous = process.env.IMESSAGE_HANDOFF_GLOBAL_STATE;
  process.env.IMESSAGE_HANDOFF_GLOBAL_STATE = file;
  resetWorkspaceStateCache();
  try {
    writeFileSync(file, JSON.stringify({
      "projectless-thread-ids": ["other-1"],
      "thread-workspace-root-hints": { "project-1": "/tmp/project" },
    }));
    const valid = readWorkspaceState();
    assert.equal(valid.projectlessThreadIds.has("other-1"), true);
    assert.equal(valid.workspaceRootHints.get("project-1"), "/tmp/project");

    writeFileSync(file, "{ malformed and deliberately longer than the valid cache key }");
    const fallback = readWorkspaceState();
    assert.equal(fallback.projectlessThreadIds.has("other-1"), true);
    assert.equal(fallback.workspaceRootHints.get("project-1"), "/tmp/project");
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_HANDOFF_GLOBAL_STATE;
    else process.env.IMESSAGE_HANDOFF_GLOBAL_STATE = previous;
    resetWorkspaceStateCache();
  }
});
