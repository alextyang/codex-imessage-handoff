import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeLegacyHook } from "../src/service-manager.mjs";

test("migration removes only the iMessage Stop hook", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-migration-test-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  mkdirSync(home, { recursive: true });
  const hooks = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "node /Users/test/.codex/skills/imessage-handoff/scripts/publish-stop.js" }] },
        { hooks: [{ type: "command", command: "node /Users/test/other-stop.js" }] },
      ],
    },
  };
  writeFileSync(path.join(home, "hooks.json"), JSON.stringify(hooks));
  try {
    assert.equal(removeLegacyHook(), 1);
    const updated = JSON.parse(readFileSync(path.join(home, "hooks.json"), "utf8"));
    assert.deepEqual(updated.hooks.Stop, [{ hooks: [{ type: "command", command: "node /Users/test/other-stop.js" }] }]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
