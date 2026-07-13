import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the distributable contains no hosted relay or hook-skill runtime", () => {
  for (const relative of [
    "relay",
    "imessage-handoff",
    "tests/skill",
    "service/src/relay-client.mjs",
    "service/src/codex-runner.mjs",
    "service/src/local-message-guard.mjs",
  ]) {
    assert.equal(existsSync(path.join(repo, relative)), false, `${relative} must not ship`);
  }
});

test("runtime entry points expose only the authenticated local helper", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const cli = readFileSync(path.join(repo, "bin/imessage-handoff.mjs"), "utf8");
  const workspace = readFileSync(path.join(repo, "pnpm-workspace.yaml"), "utf8");
  const forbidden = [
    "RelayClient",
    "activeTransport",
    "use-sendblue",
    "use-imsg",
    "configureRelay",
  ];
  for (const marker of forbidden) {
    assert.equal(daemon.includes(marker), false, `daemon contains ${marker}`);
    assert.equal(cli.includes(marker), false, `CLI contains ${marker}`);
  }
  assert.equal(workspace.includes('"relay"'), false);
  assert.match(daemon, /new ImsgTransport\(\{ profile: config\.imsg/);
  assert.match(daemon, /requires the supervised shared Codex app-server/);
});
