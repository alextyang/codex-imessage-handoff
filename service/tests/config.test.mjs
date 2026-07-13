import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureImsg, normalizeConfig, readConfig, transportStatus } from "../src/config.mjs";

function withHome(callback) {
  const previousHome = process.env.IMESSAGE_HANDOFF_HOME;
  const previousCodex = process.env.CODEX_HOME;
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-config-"));
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.IMESSAGE_HANDOFF_HOME = path.join(root, "service");
  mkdirSync(process.env.IMESSAGE_HANDOFF_HOME, { recursive: true });
  const clientConfig = path.join(root, "controller-client.json");
  writeFileSync(clientConfig, JSON.stringify({ private: true }), { mode: 0o600 });
  try {
    return callback({ root, home: process.env.IMESSAGE_HANDOFF_HOME, clientConfig });
  } finally {
    if (previousHome === undefined) delete process.env.IMESSAGE_HANDOFF_HOME;
    else process.env.IMESSAGE_HANDOFF_HOME = previousHome;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
}

function profile(clientConfig, overrides = {}) {
  return {
    mode: "helper",
    clientConfig,
    chatId: 17,
    chatGuid: "iMessage;-;+15550000017",
    expectedSender: "+15550000017",
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
    ...overrides,
  };
}

test("configureImsg writes one private local-only v4 profile", () => withHome(({ home, clientConfig }) => {
  const config = configureImsg(profile(clientConfig));
  assert.deepEqual(config, { version: 4, imsg: profile(clientConfig) });
  const file = path.join(home, "config.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), config);
  assert.equal(statSync(file).mode & 0o777, 0o600);
}));

test("only authenticated helper, bridge, rich, polls, and reactions are accepted", () => withHome(({ clientConfig }) => {
  const valid = profile(clientConfig);
  for (const invalid of [
    { ...valid, mode: "local", binary: "/opt/homebrew/bin/imsg" },
    { ...valid, featureMode: "basic" },
    { ...valid, featureMode: "auto" },
    { ...valid, presentation: "plain" },
    { ...valid, polls: false },
    { ...valid, reactions: false },
    { ...valid, expectedSender: "" },
  ]) {
    assert.throws(() => normalizeConfig({ version: 4, imsg: invalid }));
  }
  assert.throws(() => normalizeConfig({ version: 4, imsg: valid, transportSwitch: true }), /Unsupported/);
  assert.throws(() => normalizeConfig({ version: 4, imsg: { ...valid, binary: "/tmp/imsg" } }), /Unsupported/);
}));

test("outdated and direct imsg configurations fail closed", () => withHome(({ root }) => {
  assert.throws(
    () => normalizeConfig({
      version: 3,
      imsg: profile(path.join(root, "missing-client.json")),
    }),
    /current authenticated local imsg helper/,
  );
}));

test("helper client configuration must be an existing private regular file", () => withHome(({ root, clientConfig }) => {
  chmodSync(clientConfig, 0o644);
  assert.throws(() => configureImsg(profile(clientConfig)), /must not be accessible/);
  assert.throws(() => configureImsg(profile(path.join(root, "missing.json"))), /does not exist/);
  assert.throws(() => configureImsg(profile(root)), /regular file/);
  assert.throws(() => configureImsg(profile("relative.json")), /absolute path/);
}));

test("transportStatus exposes capabilities but redacts conversation identity", () => withHome(({ clientConfig }) => {
  const status = transportStatus({ version: 4, imsg: profile(clientConfig) });
  const serialized = JSON.stringify(status);
  assert.deepEqual(status, {
    transport: "imsg",
    configured: true,
    mode: "helper",
    clientConfig: "<redacted>",
    chatId: 17,
    chatGuid: "<redacted>",
    expectedSender: "<redacted>",
    featureMode: "bridge",
    presentation: "rich",
    polls: true,
    reactions: true,
  });
  assert.equal(serialized.includes(clientConfig), false);
  assert.equal(serialized.includes("+15550000017"), false);
}));
