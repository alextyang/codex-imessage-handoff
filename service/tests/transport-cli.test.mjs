import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "bin", "imessage-handoff.mjs");

function fixture({ configured = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-transport-cli-"));
  const codexHome = path.join(root, "codex");
  const home = path.join(codexHome, "imessage-handoff");
  mkdirSync(home, { recursive: true });
  const clientConfig = path.join(root, "controller-client.json");
  writeFileSync(clientConfig, JSON.stringify({ private: "ipc-material" }), { mode: 0o600 });
  if (configured) {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({
      version: 4,
      imsg: {
        mode: "helper",
        clientConfig,
        chatId: 42,
        chatGuid: "private-chat-guid",
        expectedSender: "private-sender",
        featureMode: "bridge",
        presentation: "rich",
        polls: true,
        reactions: true,
      },
    }), { mode: 0o600 });
  }
  const run = (args) => spawnSync(process.execPath, [cli, ...args, `--codex-home=${codexHome}`], {
    cwd: repo,
    encoding: "utf8",
  });
  return { home, run };
}

test("transport status reports only the authenticated rich local helper", () => {
  const { run } = fixture();
  const result = run(["transport", "status"]);
  assert.equal(result.status, 0, result.stderr);
  for (const secret of ["private-chat-guid", "private-sender", "ipc-material", "controller-client.json"]) {
    assert.equal(result.stdout.includes(secret), false);
  }
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    ok: true,
    transport: "imsg",
    configured: true,
    mode: "helper",
    clientConfig: "<redacted>",
    chatId: 42,
    chatGuid: "<redacted>",
    expectedSender: "<redacted>",
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
  });
});

test("remote, direct-cli, and transport-switch commands no longer exist", () => {
  const { home, run } = fixture();
  const before = readFileSync(path.join(home, "config.json"), "utf8");
  for (const command of ["use-sendblue", "use-imsg", "chats"]) {
    const result = run(["transport", command]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /transport harden-helper\|status\|check\|finish-helper/);
  }
  assert.equal(readFileSync(path.join(home, "config.json"), "utf8"), before);
});

test("service commands fail closed when the authenticated helper is not configured", () => {
  const { run } = fixture({ configured: false });
  const result = run(["service", "run", "--relay=https://relay.example"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local iMessage helper is not configured/);
});
