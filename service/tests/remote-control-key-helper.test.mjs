import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureRemoteControlKeyHelper, verifyRemoteControlKeyHelper } from "../src/remote-control-key-helper.mjs";

function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "imessage-remote-key-helper-"));
  const paths = {
    home,
    remoteControlKeyHelper: path.join(home, "bin", "remote-control-key-helper"),
    remoteControlKeyHelperManifest: path.join(home, "remote-control-key-helper.json"),
    remoteControlClient: path.join(home, "remote-control-client.json"),
  };
  mkdirSync(path.dirname(paths.remoteControlKeyHelper), { recursive: true, mode: 0o700 });
  return { home, paths, sourceFile: path.join(home, "remote-control-key-helper.swift") };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("an enrolled key helper is integrity-verified and never silently replaced", () => {
  const run = fixture();
  writeFileSync(run.paths.remoteControlKeyHelper, "changed helper", { mode: 0o500 });
  writeFileSync(run.paths.remoteControlKeyHelperManifest, JSON.stringify({
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    sha256: digest("original helper"),
  }), { mode: 0o600 });
  writeFileSync(run.paths.remoteControlClient, "{}", { mode: 0o600 });
  writeFileSync(run.sourceFile, "// source", { mode: 0o600 });
  let executions = 0;

  assert.throws(() => ensureRemoteControlKeyHelper({
    paths: run.paths,
    sourceFile: run.sourceFile,
    execFileSyncImpl: () => { executions += 1; },
  }), (error) => error?.code === "CODEX_REMOTE_KEY_HELPER_INVALID"
    && /Deauthorize Remote Control/.test(error.message));
  assert.equal(executions, 0);
  assert.equal(readFileSync(run.paths.remoteControlKeyHelper, "utf8"), "changed helper");
});

test("a valid enrolled key helper is reused without running build tools", () => {
  const run = fixture();
  const contents = "signed helper";
  writeFileSync(run.paths.remoteControlKeyHelper, contents, { mode: 0o500 });
  writeFileSync(run.paths.remoteControlKeyHelperManifest, JSON.stringify({
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    sha256: digest(contents),
  }), { mode: 0o600 });
  writeFileSync(run.paths.remoteControlClient, "{}", { mode: 0o600 });

  const result = ensureRemoteControlKeyHelper({
    paths: run.paths,
    execFileSyncImpl: () => { throw new Error("must not rebuild"); },
  });
  assert.equal(result.changed, false);
  assert.equal(verifyRemoteControlKeyHelper({ paths: run.paths }).sha256, digest(contents));
});

test("a missing unenrolled key helper is built once and pinned by hash", () => {
  const run = fixture();
  writeFileSync(run.sourceFile, "// source", { mode: 0o600 });
  const commands = [];
  const result = ensureRemoteControlKeyHelper({
    paths: run.paths,
    sourceFile: run.sourceFile,
    execFileSyncImpl: (command, args) => {
      commands.push([command, ...args]);
      if (command === "/usr/bin/xcrun") {
        const output = args[args.indexOf("-o") + 1];
        writeFileSync(output, "compiled and signed helper", { mode: 0o500 });
      }
      return "";
    },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(commands.map((command) => command.slice(0, 2)), [
    ["/usr/bin/xcrun", "swiftc"],
    ["/usr/bin/codesign", "--force"],
  ]);
  assert.equal(verifyRemoteControlKeyHelper({ paths: run.paths }).sha256, result.sha256);
});
