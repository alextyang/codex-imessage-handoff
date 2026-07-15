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
    "service/src/desktop-connection.mjs",
    "service/src/desktop-sync.mjs",
    "service/src/shared-backend-lease.mjs",
    "service/src/shared-backend-policy.mjs",
    "service/src/shared-backend-supervisor.mjs",
  ]) {
    assert.equal(existsSync(path.join(repo, relative)), false, `${relative} must not ship`);
  }
});

test("runtime entry points expose only the authenticated local helper", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const cli = readFileSync(path.join(repo, "bin/imessage-handoff.mjs"), "utf8");
  const manager = readFileSync(path.join(repo, "service/src/service-manager.mjs"), "utf8");
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
  assert.doesNotMatch(cli, /desktop-sync|sharedBackendSupervisor|inspectDesktopSharedConnection/);
  assert.doesNotMatch(manager, /installSharedBackendSupervisor|requestSharedBackendActivation|inspectDesktopSharedConnection/);
  assert.match(manager, /<string>\/usr\/bin\/env<\/string><string>-u<\/string><string>\$\{retiredLocalDaemonEnvironment\}<\/string>/);
  assert.doesNotMatch(manager, /<key>\$\{retiredLocalDaemonEnvironment\}<\/key>/);
});

test("normal-profile user mirrors cannot be disabled by Codex window or task focus", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const start = daemon.indexOf("async function deliverLiveMessage(message)");
  const end = daemon.indexOf("\nasync function scanLiveMirror()", start);
  assert.ok(start >= 0 && end > start, "live user-mirror flow must remain inspectable");
  const flow = daemon.slice(start, end);

  assert.match(flow, /localUserMirrorSender\.sendMirror\(\{/);
  assert.doesNotMatch(flow, /codexFocus|shouldSuppressUserMirror|frontmost|activeThreadId|activeThread\.id/);
  assert.equal(existsSync(path.join(repo, "service/src/codex-focus.mjs")), false,
    "the retired focus detector must not be restored");
});

test("the main service can only reach Codex through an injected Remote Control stream", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const manager = readFileSync(path.join(repo, "service/src/service-manager.mjs"), "utf8");
  const deployment = readFileSync(path.join(repo, "service/src/service-deployment.mjs"), "utf8");
  const paths = readFileSync(path.join(repo, "service/src/paths.mjs"), "utf8");
  const protocolClient = readFileSync(path.join(repo, "service/src/app-server-runner.mjs"), "utf8");

  assert.match(daemon, /RemoteControlCodexRuntime/);
  assert.doesNotMatch(daemon, /AppServerCodexRunner|SharedBackendTurnLease|inspectDesktopSharedConnection/);
  assert.doesNotMatch(manager, /CODEX_BIN|resolveCodexBinary|installSharedBackendSupervisor|requestSharedBackendActivation/);
  assert.match(manager, /cleanupRetiredSharedBackendArtifacts/);
  assert.doesNotMatch(paths, /sharedBackend|desktopSync|shared-backend|desktop-sync/);
  assert.match(deployment, /await import\('\.\/service\/src\/remote-control-runner\.mjs'\)/);
  assert.doesNotMatch(deployment, /await import\('\.\/service\/src\/app-server-runner\.mjs'\)/);
  assert.doesNotMatch(protocolClient, /node:child_process|node:net|from "ws"|spawnImpl|codexPath|socketPath|CODEX_APP_SERVER_SOCKET|app-server-control|\.kill\s*\(/);
  assert.match(protocolClient, /CODEX_REMOTE_TRANSPORT_REQUIRED/);
  assert.match(protocolClient, /this\.webSocketFactory\(\)/);
});
