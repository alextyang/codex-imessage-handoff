import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  beginDesktopSyncActivation,
  desktopSyncPaths,
  desktopSyncStatus,
  markDesktopSyncActive,
  prepareDesktopSync,
  readDesktopSyncState,
  rollbackDesktopSyncActivation,
  rollbackDesktopSyncPreparation,
  verifyDesktopSyncProxy,
} from "../src/desktop-sync.mjs";

function executable(file) {
  writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(file, 0o700);
  return file;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-desktop-sync-"));
  const homeDir = path.join(root, "home");
  const stateFile = path.join(root, "state", "desktop-sync.json");
  const codexBin = executable(path.join(root, "bundled-codex"));
  const calls = [];
  let daemonRunning = false;
  let launchValue = "";
  const execFileSyncImpl = (file, args, options) => {
    calls.push({ file, args: [...args], codexHome: options?.env?.CODEX_HOME });
    if (file === "launchctl") {
      if (args[0] === "getenv") {
        if (!launchValue) throw Object.assign(new Error("not set"), { status: 1 });
        return `${launchValue}\n`;
      }
      if (args[0] === "setenv") {
        launchValue = args[2];
        return "";
      }
      if (args[0] === "unsetenv") {
        launchValue = "";
        return "";
      }
    }
    const command = args[2];
    if (command === "bootstrap") return "bootstrapped\n";
    if (command === "start") {
      daemonRunning = true;
      return "started\n";
    }
    if (command === "version") {
      if (!daemonRunning) throw Object.assign(new Error("not running"), { status: 1 });
      return '{"cliVersion":"test-cli","serverVersion":"test-server"}\n';
    }
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  };
  const proxyProbeImpl = async ({ paths, env }) => {
    assert.equal(env.CODEX_HOME, paths.codexHome);
    return { userAgent: "test", platformFamily: "unix", platformOs: "macos", codexHome: paths.codexHome };
  };
  const options = { homeDir, stateFile, codexBin, execFileSyncImpl, proxyProbeImpl, nowImpl: () => 1_700_000_000_000 };
  return {
    root,
    options,
    calls,
    get daemonRunning() { return daemonRunning; },
    set daemonRunning(value) { daemonRunning = value; },
    get launchValue() { return launchValue; },
    set launchValue(value) { launchValue = value; },
  };
}

test("prepare uses only the canonical ~/.codex tree and records ownership before activation", async () => {
  const run = fixture();
  const result = await prepareDesktopSync({ ...run.options, env: { CODEX_HOME: path.join(run.root, "wrong-home") } });
  const paths = desktopSyncPaths(run.options);
  const state = readDesktopSyncState(run.options);

  assert.equal(paths.codexHome, path.join(run.options.homeDir, ".codex"));
  assert.equal(result.prepared, true);
  assert.equal(lstatSync(paths.standalone).isSymbolicLink(), true);
  assert.equal(path.resolve(path.dirname(paths.standalone), readlinkSync(paths.standalone)), realpathSync(run.options.codexBin));
  assert.equal(state.preparation.standalone.owned, true);
  assert.equal(state.preparation.codexHome, paths.codexHome);
  assert.equal(state.preparation.daemon.running, true);
  assert.equal(state.activation, undefined);
  assert.deepEqual(
    run.calls.filter((call) => call.file !== "launchctl").map((call) => call.args[2]),
    ["bootstrap", "start", "version"],
  );
  assert.equal(run.calls.filter((call) => call.file !== "launchctl").every((call) => call.codexHome === paths.codexHome), true);
});

test("prepare preserves an executable unowned standalone link", async () => {
  const run = fixture();
  const paths = desktopSyncPaths(run.options);
  const other = executable(path.join(run.root, "official-codex"));
  mkdirSync(path.dirname(paths.standalone), { recursive: true });
  symlinkSync(other, paths.standalone, "file");
  const result = await prepareDesktopSync(run.options);
  assert.equal(result.standalone.owned, false);
  assert.equal(path.resolve(path.dirname(paths.standalone), readlinkSync(paths.standalone)), other);
  assert.equal(readDesktopSyncState(run.options).preparation.standalone.owned, false);
});

test("begin activation refuses conflicting launchctl state and owns only values it sets", async () => {
  const run = fixture();
  await prepareDesktopSync(run.options);
  run.launchValue = "0";
  await assert.rejects(beginDesktopSyncActivation(run.options), (error) => error.code === "DESKTOP_SYNC_ENV_CONFLICT");
  assert.equal(run.launchValue, "0");

  run.launchValue = "";
  assert.deepEqual(await beginDesktopSyncActivation(run.options), {
    changed: true,
    enabled: true,
    owned: true,
    desktopRestartRequired: true,
  });
  assert.equal(run.launchValue, "1");
  assert.equal(readDesktopSyncState(run.options).activation.owned, true);

  run.launchValue = "someone-else-changed-this";
  assert.deepEqual(rollbackDesktopSyncActivation(run.options), { changed: false, reason: "environment-changed" });
  assert.equal(run.launchValue, "someone-else-changed-this");
  assert.equal(readDesktopSyncState(run.options).activation.owned, true);

  run.launchValue = "1";
  assert.deepEqual(rollbackDesktopSyncActivation(run.options), { changed: true, reason: "removed" });
  assert.equal(run.launchValue, "");
  assert.equal(readDesktopSyncState(run.options).activation, undefined);
});

test("rollback removes only an owned unchanged link while the daemon and activation are inactive", async () => {
  const run = fixture();
  await prepareDesktopSync(run.options);
  const standalone = desktopSyncPaths(run.options).standalone;
  assert.deepEqual(rollbackDesktopSyncPreparation(run.options), { changed: false, reason: "daemon-running" });
  assert.equal(existsSync(standalone), true);

  run.daemonRunning = false;
  assert.deepEqual(rollbackDesktopSyncPreparation(run.options), { changed: true, reason: "removed", daemonStopped: false });
  assert.equal(existsSync(standalone), false);
  assert.equal(readDesktopSyncState(run.options).preparation.standalone.owned, false);
});

test("rollback leaves an externally changed standalone path untouched", async () => {
  const run = fixture();
  await prepareDesktopSync(run.options);
  run.daemonRunning = false;
  const standalone = desktopSyncPaths(run.options).standalone;
  const replacement = executable(path.join(run.root, "replacement"));
  // Replacing a symlink does not follow or alter its original target.
  rmSync(standalone);
  symlinkSync(replacement, standalone, "file");
  assert.deepEqual(rollbackDesktopSyncPreparation(run.options), { changed: false, reason: "standalone-changed" });
  assert.equal(path.resolve(path.dirname(standalone), readlinkSync(standalone)), replacement);
});

test("status reports backend, activation ownership, and readiness without mutating them", async () => {
  const run = fixture();
  await prepareDesktopSync(run.options);
  await beginDesktopSyncActivation(run.options);
  const before = readFileSync(run.options.stateFile, "utf8");
  const status = await desktopSyncStatus(run.options);
  assert.equal(status.ready, true);
  assert.equal(status.standalone.owned, true);
  assert.equal(status.standalone.unchanged, true);
  assert.equal(status.daemon.running, true);
  assert.equal(status.proxy.ready, true);
  assert.deepEqual(status.activation, {
    currentValue: "1",
    enabled: true,
    owned: true,
    conflict: false,
    desktopRestartRequired: true,
  });
  assert.equal(readFileSync(run.options.stateFile, "utf8"), before);
});

test("only an injected Desktop verifier can finish activation", async () => {
  const run = fixture();
  await prepareDesktopSync(run.options);
  await beginDesktopSyncActivation(run.options);
  await assert.rejects(markDesktopSyncActive(run.options), (error) => error.code === "DESKTOP_SYNC_VERIFIER_REQUIRED");
  await assert.rejects(
    markDesktopSyncActive({ ...run.options, desktopVerifierImpl: async () => ({ shared: false }) }),
    (error) => error.code === "DESKTOP_SYNC_DESKTOP_NOT_SHARED",
  );
  const result = await markDesktopSyncActive({ ...run.options, desktopVerifierImpl: async () => ({ shared: true }) });
  assert.equal(result.desktopRestartRequired, false);
  assert.equal((await desktopSyncStatus(run.options)).activation.desktopRestartRequired, false);
});

test("proxy probe performs initialize/initialized and rejects a non-canonical home", async () => {
  const run = fixture();
  const received = [];
  function spawnImpl() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk).trim());
        received.push(message);
        if (message.method === "initialize") {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({
            id: message.id,
            result: { userAgent: "fake", codexHome: desktopSyncPaths(run.options).codexHome, platformFamily: "unix", platformOs: "macos" },
          })}\n`));
        }
        callback();
      },
    });
    child.kill = () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("close", 0));
      return true;
    };
    return child;
  }
  const result = await verifyDesktopSyncProxy({ ...run.options, binary: run.options.codexBin, spawnImpl });
  assert.equal(result.codexHome, desktopSyncPaths(run.options).codexHome);
  assert.equal(received[0].method, "initialize");
  assert.equal(received[1].method, "initialized");
});
