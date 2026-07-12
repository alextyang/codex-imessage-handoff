import assert from "node:assert/strict";
import test from "node:test";
import { parseMenuSelection, parseSlashCommand, renderHelp, renderOutboundEvent, renderThreadMenu } from "../../protocol/presentation.ts";

test("thread output is labeled without modifying its body", () => {
  const body = "The tests pass.\n\nNext: deploy.";
  assert.equal(renderOutboundEvent({ kind: "thread.output", thread: { title: "Music crawler" }, body }), `CODEX · Music crawler\n\n${body}`);
});

test("thread menus distinguish current context and project", () => {
  assert.equal(renderThreadMenu([
    { title: "Service redesign", projectLabel: "imessage", current: true },
    { title: "Music crawler", projectLabel: "al-music-crawler" },
  ]), [
    "CODEX · THREADS",
    "1  Service redesign  · imessage  • current\n2  Music crawler  · al-music-crawler",
    "Reply with a number to switch.",
  ].join("\n\n"));
});

test("selection syntax is active-menu friendly", () => {
  assert.deepEqual(parseMenuSelection("2"), { index: 1, prompt: null });
  assert.deepEqual(parseMenuSelection("2: run the tests"), { index: 1, prompt: "run the tests" });
  assert.equal(parseMenuSelection("status"), null);
});

test("slash commands do not consume ordinary words", () => {
  assert.deepEqual(parseSlashCommand("/search music crawler"), { command: "search", argument: "music crawler" });
  assert.equal(parseSlashCommand("threads"), null);
  assert.equal(parseSlashCommand("status"), null);
  assert.match(renderHelp(), /^CODEX · COMMANDS/);
});
