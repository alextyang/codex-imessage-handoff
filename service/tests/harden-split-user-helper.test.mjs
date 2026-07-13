import assert from "node:assert/strict";
import test from "node:test";
import { whoHasConsoleSession } from "../scripts/harden-split-user-helper.mjs";

test("a logged-in helper GUI session is recognized without cross-user launchctl access", () => {
  const sessions = [
    "alexyang         console      Jul 12 19:31",
    "codex            console      Jul 12 23:14",
    "codex            ttys002      Jul 13 00:48",
  ].join("\n");
  assert.equal(whoHasConsoleSession(sessions, "codex"), true);
  assert.equal(whoHasConsoleSession(sessions, "missing"), false);
  assert.equal(whoHasConsoleSession("codex ttys002 Jul 13", "codex"), false);
});
