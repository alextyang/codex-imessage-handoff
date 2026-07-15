import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  cleanupRetiredSharedBackendArtifacts,
  installService,
  pruneInactiveServiceDeployments,
  renderLaunchAgent,
  rotateServiceProcess,
  stopService,
} from "../src/service-manager.mjs";

const fingerprint = "a".repeat(64);

function deployedRuntime(directory, node = path.join(directory, "node")) {
  const daemon = path.join(directory, "deployment", "service", "src", "daemon.mjs");
  mkdirSync(path.dirname(daemon), { recursive: true });
  writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(daemon, "");
  return { nodePath: node, daemonPath: daemon, deploymentFingerprint: fingerprint };
}

function transactionFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-transaction-"));
  const home = path.join(directory, "home");
  const launchAgents = path.join(directory, "LaunchAgents");
  mkdirSync(home, { recursive: true });
  mkdirSync(launchAgents, { recursive: true });
  const runtime = deployedRuntime(directory);
  const paths = {
    home,
    deployments: path.join(home, "deployments"),
    stateDb: path.join(directory, ".codex", "state.sqlite"),
    serviceReadinessState: path.join(home, "service-readiness.json"),
    runState: path.join(home, "run-state.json"),
    serviceDeploymentState: path.join(home, "service-deployment.json"),
    stdoutLog: path.join(home, "service.log"),
    stderrLog: path.join(home, "service-error.log"),
    plist: path.join(launchAgents, "service.plist"),
  };
  return {
    paths,
    runtime,
    deployment: {
      root: path.join(directory, "deployment"),
      fingerprint,
      nodePath: runtime.nodePath,
      daemonPath: runtime.daemonPath,
      changed: true,
    },
  };
}

function writeReadiness(file, pid) {
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    status: "ready",
    pid,
    heartbeatAt: new Date().toISOString(),
    health: { healthy: true, activeWatch: true },
  }));
}

test("deployment cleanup removes only inactive service-owned bundles", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-service-prune-"));
  const active = "a".repeat(64);
  const stale = "b".repeat(64);
  const foreign = "c".repeat(64);
  for (const fingerprint of [active, stale]) {
    const directory = path.join(root, fingerprint);
    mkdirSync(path.join(directory, "runtime"), { recursive: true });
    writeFileSync(path.join(directory, "runtime", "node"), "runtime");
    writeFileSync(path.join(directory, "deployment-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      owner: "codex-imessage-handoff",
      fingerprint,
    }));
    chmodSync(path.join(directory, "runtime"), 0o555);
    chmodSync(directory, 0o555);
  }
  mkdirSync(path.join(root, foreign));
  writeFileSync(path.join(root, foreign, "deployment-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    owner: "someone-else",
    fingerprint: foreign,
  }));

  assert.deepEqual(pruneInactiveServiceDeployments(root, active), [stale]);
  assert.equal(existsSync(path.join(root, active)), true);
  assert.equal(existsSync(path.join(root, stale)), false);
  assert.equal(existsSync(path.join(root, foreign)), true);
});

test("deployment cleanup is deferred when a retired supervisor cannot be stopped", () => {
  const run = transactionFixture();
  const stale = "b".repeat(64);
  const staleRoot = path.join(run.paths.deployments, stale);
  mkdirSync(staleRoot, { recursive: true });
  writeFileSync(path.join(staleRoot, "deployment-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    fingerprint: stale,
  }));
  let running = false;
  const result = installService({
    platform: "darwin",
    paths: run.paths,
    config: { imsg: { mode: "helper" } },
    stageDeploymentImpl: () => run.deployment,
    cleanupRetiredImpl: () => ({
      cleaned: false,
      supervisorStopped: false,
      removed: [],
      failed: ["retired-supervisor-bootout"],
    }),
    plistLintImpl: () => {},
    launchctlImpl(args) {
      if (args[0] === "print") return running ? "state = running\npid = 42\n" : "";
      if (args[0] === "bootstrap") {
        running = true;
        writeReadiness(run.paths.serviceReadinessState, 42);
      }
      return "";
    },
    readinessAttempts: 0,
  });
  assert.deepEqual(result.prunedDeployments, []);
  assert.equal(existsSync(staleRoot), true);
});

test("LaunchAgent uses the independent controller without exposing a Codex process command", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-manager-"));
  const deployment = deployedRuntime(directory);

  const plist = renderLaunchAgent({
    stateDb: path.join(directory, "state.sqlite"),
    stdoutLog: path.join(directory, "service.log"),
    stderrLog: path.join(directory, "service-error.log"),
  }, { ...deployment, codexBackend: "app-server", codexBin: "/tmp/must-not-appear" });
  assert.doesNotMatch(plist, /<key>CODEX_BIN<\/key>/);
  assert.match(plist, /<key>PATH<\/key><string>[^<]*\/usr\/bin/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.doesNotMatch(plist, /IMESSAGE_HANDOFF_CODEX_BACKEND/);
  assert.match(plist, /<string>\/usr\/bin\/env<\/string><string>-u<\/string><string>CODEX_APP_SERVER_USE_LOCAL_DAEMON<\/string>/);
  assert.doesNotMatch(plist, /<key>CODEX_APP_SERVER_USE_LOCAL_DAEMON<\/key>/);
  assert.doesNotMatch(plist, /shared-backend|app-server-control/);
});

test("retired cleanup removes only ownership-proven service artifacts", async () => {
  const run = transactionFixture();
  run.paths.stateDb = path.join(mkdtempSync("/tmp/imessage-retired-"), "state.sqlite");
  const codexHome = path.dirname(run.paths.stateDb);
  const retiredPlist = path.join(path.dirname(run.paths.plist), "com.codex.imessage-handoff.shared-backend.plist");
  const unrelatedPlist = path.join(path.dirname(run.paths.plist), "com.alexyang.chatgpt-handoff.plist");
  const socket = path.join(codexHome, "app-server-control", "app-server-control.sock");
  mkdirSync(path.dirname(socket), { recursive: true });
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });

  const owned = (value = {}) => JSON.stringify({ schemaVersion: 1, owner: "codex-imessage-handoff", ...value });
  writeFileSync(retiredPlist, `
<plist><dict>
<key>Label</key><string>com.codex.imessage-handoff.shared-backend</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE</key><string>instance</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT</key><string>${"b".repeat(64)}</string>
</dict></plist>`);
  writeFileSync(unrelatedPlist, "unrelated");
  writeFileSync(path.join(run.paths.home, "shared-backend-supervisor-config.json"), JSON.stringify({
    schemaVersion: 1,
    owner: "another-service",
  }));
  writeFileSync(path.join(run.paths.home, "shared-backend-supervisor-state.json"), owned({
    activationOwned: true,
    socket,
    childPid: 456,
  }));
  writeFileSync(path.join(run.paths.home, "shared-backend-deployment.json"), owned({ activeFingerprint: "b".repeat(64) }));
  writeFileSync(path.join(run.paths.home, "shared-backend-turn-lease.json"), owned({ pid: 123 }));
  writeFileSync(path.join(run.paths.home, "desktop-sync-state.json"), owned({
    activation: {
      owned: true,
      environment: "CODEX_APP_SERVER_USE_LOCAL_DAEMON",
      value: "1",
    },
    preparation: { codexHome, daemon: { startedByUs: true } },
  }));
  writeFileSync(path.join(run.paths.home, "shared-backend-supervisor.log"), "old log");
  writeFileSync(path.join(run.paths.home, "shared-backend-supervisor-error.log"), "old error");

  let retiredLoaded = true;
  let routing = "1";
  const calls = [];
  const launchctlImpl = (args) => {
    calls.push(args);
    if (args[0] === "print") return retiredLoaded ? "state = running\n" : "";
    if (args[0] === "bootout") { retiredLoaded = false; return ""; }
    if (args[0] === "getenv") return routing;
    if (args[0] === "unsetenv") { routing = ""; return ""; }
    throw new Error(`Unexpected launchctl call: ${args.join(" ")}`);
  };

  try {
    const result = cleanupRetiredSharedBackendArtifacts(run.paths, { launchctlImpl });
    assert.equal(result.supervisorStopped, true);
    assert.equal(result.desktopRoutingCleared, true);
    assert.deepEqual(result.failed, []);
    assert.equal(existsSync(retiredPlist), false);
    assert.equal(existsSync(socket), false);
    assert.equal(existsSync(path.join(run.paths.home, "shared-backend-supervisor-state.json")), false);
    assert.equal(existsSync(path.join(run.paths.home, "shared-backend-deployment.json")), false);
    assert.equal(existsSync(path.join(run.paths.home, "shared-backend-turn-lease.json")), false);
    assert.equal(existsSync(path.join(run.paths.home, "desktop-sync-state.json")), false);
    assert.equal(existsSync(path.join(run.paths.home, "shared-backend-supervisor.log")), false);
    assert.equal(existsSync(path.join(run.paths.home, "shared-backend-supervisor-error.log")), false);
    assert.equal(existsSync(path.join(run.paths.home, "shared-backend-supervisor-config.json")), true, "foreign JSON must remain");
    assert.equal(existsSync(unrelatedPlist), true);
    assert.equal(routing, "");
    assert.deepEqual(calls.filter((call) => call[0] === "bootout"), [
      ["bootout", `gui/${process.getuid()}/com.codex.imessage-handoff.shared-backend`],
    ]);
    assert.equal(calls.some((call) => call.join(" ").includes("com.alexyang.chatgpt-handoff")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("retired cleanup leaves unowned lookalikes and Desktop routing untouched", () => {
  const run = transactionFixture();
  const retiredPlist = path.join(path.dirname(run.paths.plist), "com.codex.imessage-handoff.shared-backend.plist");
  writeFileSync(retiredPlist, `
<plist><dict>
<key>Label</key><string>com.codex.imessage-handoff.shared-backend</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE</key><string>foreign</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT</key><string>${"b".repeat(64)}</string>
</dict></plist>`);
  writeFileSync(path.join(run.paths.home, "shared-backend-supervisor-state.json"), JSON.stringify({
    schemaVersion: 1,
    owner: "another-service",
    activationOwned: true,
  }));
  const calls = [];
  const result = cleanupRetiredSharedBackendArtifacts(run.paths, {
    launchctlImpl(args) { calls.push(args); return "1"; },
  });
  assert.equal(result.cleaned, false);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(retiredPlist), true);
  assert.equal(existsSync(path.join(run.paths.home, "shared-backend-supervisor-state.json")), true);
});

test("retired cleanup preserves ownership evidence when the old job cannot stop", () => {
  const run = transactionFixture();
  const retiredPlist = path.join(path.dirname(run.paths.plist), "com.codex.imessage-handoff.shared-backend.plist");
  const state = path.join(run.paths.home, "shared-backend-supervisor-state.json");
  writeFileSync(retiredPlist, `
<plist><dict>
<key>Label</key><string>com.codex.imessage-handoff.shared-backend</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE</key><string>owned</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT</key><string>${"b".repeat(64)}</string>
</dict></plist>`);
  writeFileSync(state, JSON.stringify({
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    activationOwned: true,
  }));
  const calls = [];
  const result = cleanupRetiredSharedBackendArtifacts(run.paths, {
    launchctlImpl(args) {
      calls.push(args);
      if (args[0] === "print") return "state = running\n";
      if (args[0] === "bootout") throw new Error("bootout denied");
      throw new Error("routing must not be changed while the retired job is live");
    },
  });
  assert.equal(result.cleaned, false);
  assert.equal(result.supervisorStopped, false);
  assert.deepEqual(result.failed, ["retired-supervisor-bootout"]);
  assert.equal(existsSync(retiredPlist), true);
  assert.equal(existsSync(state), true);
  assert.equal(calls.some((call) => call[0] === "getenv" || call[0] === "unsetenv"), false);
});

test("helper-mode LaunchAgent omits local imsg and private IPC configuration", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-manager-helper-"));
  const clientConfig = path.join(directory, "private-controller-client.json");
  const deployment = deployedRuntime(directory, path.join(directory, "deployed-node"));
  const plist = renderLaunchAgent({
    stateDb: path.join(directory, "state.sqlite"),
    stdoutLog: path.join(directory, "service.log"),
    stderrLog: path.join(directory, "service-error.log"),
  }, {
    ...deployment,
    clientConfig,
    ipcSecret: "private-ipc-secret",
    privateKey: "private-key-material",
  });
  assert.doesNotMatch(plist, /<key>IMSG_BIN<\/key>/);
  assert.equal(plist.includes(clientConfig), false);
  assert.equal(plist.includes("private-ipc-secret"), false);
  assert.equal(plist.includes("private-key-material"), false);
});

test("service installation has no shared-backend or Desktop readiness prerequisite", () => {
  const run = transactionFixture();
  let running = false;
  const launchctlImpl = (args) => {
    if (args[0] === "print") return running ? "state = running\npid = 42\n" : "";
    if (args[0] === "bootstrap") {
      running = true;
      writeReadiness(run.paths.serviceReadinessState, 42);
    }
    return "";
  };
  const result = installService({
    platform: "darwin",
    paths: run.paths,
    codexBin: "/tmp/must-be-ignored",
    config: { imsg: { mode: "helper" } },
    supervisor: { activationConflict: true, running: false },
    desktop: { shared: false },
    inspectDesktopImpl: () => { throw new Error("must not inspect Desktop"); },
    stageDeploymentImpl: () => run.deployment,
    plistLintImpl: () => {},
    launchctlImpl,
    readinessAttempts: 0,
  });
  assert.equal(result.changed, true);
  assert.equal("codexBackend" in result, false);
});

test("service installation tolerates a healthy candidate that needs more than twenty seconds to publish readiness", () => {
  const run = transactionFixture();
  let running = false;
  let waits = 0;
  const result = installService({
    platform: "darwin",
    paths: run.paths,
    config: { imsg: { mode: "helper" } },
    stageDeploymentImpl: () => run.deployment,
    cleanupRetiredImpl: () => ({ cleaned: false, removed: [], failed: [] }),
    plistLintImpl: () => {},
    launchctlImpl(args) {
      if (args[0] === "print") return running ? "state = running\npid = 42\n" : "";
      if (args[0] === "bootout") running = false;
      if (args[0] === "bootstrap") running = true;
      return "";
    },
    waitImpl() {
      waits += 1;
      if (waits === 100) writeReadiness(run.paths.serviceReadinessState, 42);
    },
  });
  assert.equal(result.changed, true);
  assert.equal(waits, 100, "the default readiness window exceeds the former eighty-poll limit");
});

test("service installation activates only a ready versioned deployment", () => {
  const run = transactionFixture();
  const previousFingerprint = "b".repeat(64);
  writeFileSync(run.paths.plist, renderLaunchAgent(run.paths, {
    ...run.runtime,
    deploymentFingerprint: previousFingerprint,
  }));
  writeReadiness(run.paths.serviceReadinessState, 41);
  let running = true;
  let pid = 41;
  const calls = [];
  let cleanupCalls = 0;
  const launchctlImpl = (args) => {
    calls.push(args);
    if (args[0] === "print") return running ? `state = running\npid = ${pid}\n` : "";
    if (args[0] === "bootout") { running = false; return ""; }
    if (args[0] === "bootstrap") {
      running = true;
      pid = 42;
      writeReadiness(run.paths.serviceReadinessState, pid);
    }
    return "";
  };
  const result = installService({
    platform: "darwin",
    paths: run.paths,
    config: { imsg: { mode: "helper" } },
    stageDeploymentImpl: () => run.deployment,
    cleanupRetiredImpl: () => {
      cleanupCalls += 1;
      return { cleaned: false, removed: [], failed: [] };
    },
    plistLintImpl: () => {},
    launchctlImpl,
    readinessAttempts: 0,
  });
  assert.equal(result.changed, true);
  assert.equal(result.deploymentFingerprint, fingerprint);
  const installed = readFileSync(run.paths.plist, "utf8");
  assert.match(installed, new RegExp(run.runtime.nodePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(installed, new RegExp(fingerprint));
  assert.deepEqual(JSON.parse(readFileSync(run.paths.serviceDeploymentState, "utf8")).previousFingerprint, previousFingerprint);
  assert.equal(calls.filter((call) => call[0] === "bootstrap").length, 1);
  assert.equal(cleanupCalls, 1, "migration cleanup runs only after readiness succeeds");
});

test("service installation restores the prior ready LaunchAgent when candidate readiness fails", () => {
  const run = transactionFixture();
  const previousFingerprint = "b".repeat(64);
  const oldPlist = renderLaunchAgent(run.paths, { ...run.runtime, deploymentFingerprint: previousFingerprint });
  writeFileSync(run.paths.plist, oldPlist);
  writeReadiness(run.paths.serviceReadinessState, 41);
  let running = true;
  let pid = 41;
  let bootstraps = 0;
  let cleanupCalls = 0;
  const launchctlImpl = (args) => {
    if (args[0] === "print") return running ? `state = running\npid = ${pid}\n` : "";
    if (args[0] === "bootout") { running = false; return ""; }
    if (args[0] === "bootstrap") {
      bootstraps += 1;
      running = true;
      pid = bootstraps === 1 ? 42 : 43;
      if (bootstraps === 2) writeReadiness(run.paths.serviceReadinessState, pid);
    }
    return "";
  };
  assert.throws(() => installService({
    platform: "darwin",
    paths: run.paths,
    config: { imsg: { mode: "helper" } },
    stageDeploymentImpl: () => run.deployment,
    cleanupRetiredImpl: () => {
      cleanupCalls += 1;
      return { cleaned: false, removed: [], failed: [] };
    },
    plistLintImpl: () => {},
    launchctlImpl,
    readinessAttempts: 0,
  }), (error) => error?.code === "SERVICE_INSTALL_ROLLED_BACK");
  assert.equal(readFileSync(run.paths.plist, "utf8"), oldPlist);
  assert.equal(bootstraps, 2);
  assert.equal(pid, 43);
  assert.equal(cleanupCalls, 0, "failed activation and rollback must preserve migration evidence");
});

test("forced restart leaves durable active-run claims intact", () => {
  const run = transactionFixture();
  writeFileSync(run.paths.plist, renderLaunchAgent(run.paths, { ...run.runtime, deploymentFingerprint: fingerprint }));
  writeReadiness(run.paths.serviceReadinessState, 41);
  const activeRunState = JSON.stringify({ version: 2, jobs: { active: { state: "running" } } });
  writeFileSync(run.paths.runState, activeRunState);
  let pid = 41;
  let bootstraps = 0;
  const launchctlImpl = (args) => {
    if (args[0] === "print") return `state = running\npid = ${pid}\n`;
    if (args[0] === "bootstrap") {
      bootstraps += 1;
      pid = 42;
      writeReadiness(run.paths.serviceReadinessState, pid);
    }
    return "";
  };
  const result = installService({
    forceRestart: true,
    platform: "darwin",
    paths: run.paths,
    config: { imsg: { mode: "helper" } },
    stageDeploymentImpl: () => run.deployment,
    plistLintImpl: () => {},
    launchctlImpl,
    readinessAttempts: 0,
  });
  assert.equal(result.changed, true);
  assert.equal(bootstraps, 1);
  assert.equal(readFileSync(run.paths.runState, "utf8"), activeRunState);
});

test("enrollment rotation proves a new ready service PID before succeeding", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let pid = 41;
  let probes = 0;
  const result = rotateServiceProcess({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "kickstart") {
        pid = 42;
        writeReadiness(run.paths.serviceReadinessState, pid);
      }
      if (args[0] === "print") {
        probes += 1;
        return `state = running\npid = ${pid}\n`;
      }
      return "";
    },
    rotationAttempts: 0,
  });
  assert.deepEqual(result, { rotated: true, previousPid: 41, pid: 42 });
  assert.equal(probes, 2);
});

test("enrollment rotation tolerates a healthy replacement that needs more than twenty seconds", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let pid = 41;
  let waits = 0;
  const result = rotateServiceProcess({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "kickstart") pid = 42;
      if (args[0] === "print") return `state = running\npid = ${pid}\n`;
      return "";
    },
    waitImpl() {
      waits += 1;
      if (waits === 100) writeReadiness(run.paths.serviceReadinessState, 42);
    },
  });
  assert.deepEqual(result, { rotated: true, previousPid: 41, pid: 42 });
  assert.equal(waits, 100, "rotation shares the extended transactional readiness window");
});

test("failed enrollment rotation unloads the old LaunchAgent and retains no readiness", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let loaded = true;
  assert.throws(() => rotateServiceProcess({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "kickstart") throw new Error("kickstart failed");
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "print") return loaded ? "state = running\npid = 41\n" : "";
      return "";
    },
    stopAttempts: 0,
  }), (error) => error?.code === "SERVICE_ROTATION_FAILED_STOPPED");
  assert.equal(loaded, false);
  assert.equal(existsSync(run.paths.serviceReadinessState), false);
});

test("rotation failure is critical when the old LaunchAgent cannot be unloaded", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  assert.throws(() => rotateServiceProcess({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "kickstart") throw new Error("kickstart failed");
      if (args[0] === "print") return "state = waiting\n";
      return "";
    },
    waitImpl() {},
    stopAttempts: 1,
  }), (error) => error?.code === "SERVICE_ROTATION_AND_STOP_FAILED");
  assert.equal(existsSync(run.paths.serviceReadinessState), true);
});

test("an inspection failure before rotation triggers verified stop and cannot report absence", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let bootoutAttempted = false;
  const inspectionFailure = Object.assign(new Error("launchctl inspection denied"), {
    status: 1,
    stderr: "Not privileged to inspect this service\n",
  });
  assert.throws(() => rotateServiceProcess({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "bootout") bootoutAttempted = true;
      if (args[0] === "print") throw inspectionFailure;
      return "";
    },
    stopAttempts: 0,
  }), (error) => error?.code === "SERVICE_ROTATION_AND_STOP_FAILED");
  assert.equal(bootoutAttempted, true);
  assert.equal(existsSync(run.paths.serviceReadinessState), true);
});

test("service stop verifies launchd termination before removing readiness", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let waits = 0;
  assert.throws(() => stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "print") return "state = running\npid = 41\n";
      return "";
    },
    waitImpl() { waits += 1; },
    stopAttempts: 2,
  }), (error) => error?.code === "SERVICE_STOP_FAILED");
  assert.equal(waits, 2);
  assert.equal(existsSync(run.paths.serviceReadinessState), true);
});

test("service stop rejects a LaunchAgent that remains loaded but waiting", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let waits = 0;
  assert.throws(() => stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "print") return "state = waiting\nlast exit code = 0\n";
      return "";
    },
    waitImpl() { waits += 1; },
    stopAttempts: 2,
  }), (error) => error?.code === "SERVICE_STOP_FAILED");
  assert.equal(waits, 2);
  assert.equal(existsSync(run.paths.serviceReadinessState), true);
});

test("service stop fails closed when launchd inspection fails after bootout", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let bootoutAttempted = false;
  const inspectionFailure = Object.assign(new Error("launchctl inspection denied"), {
    status: 1,
    stderr: "Not privileged to inspect this service\n",
  });
  assert.throws(() => stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "bootout") bootoutAttempted = true;
      if (args[0] === "print") throw inspectionFailure;
      return "";
    },
    stopAttempts: 0,
  }), inspectionFailure);
  assert.equal(bootoutAttempted, true);
  assert.equal(existsSync(run.paths.serviceReadinessState), true);
});

test("service stop accepts only launchd's exact missing-service result as absent", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  const missing = Object.assign(new Error("missing"), {
    status: 113,
    stderr: `Bad request.\nCould not find service "com.codex.imessage-handoff" in domain for user gui: ${process.getuid()}\n`,
  });
  const result = stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "print") throw missing;
      return "";
    },
    stopAttempts: 0,
  });
  assert.deepEqual(result, { stopped: true });
  assert.equal(existsSync(run.paths.serviceReadinessState), false);
});

test("service stop waits through running and waiting states until the job is absent", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  const states = [
    "state = running\npid = 41\n",
    "state = waiting\nlast exit code = 0\n",
    "",
  ];
  let probes = 0;
  const result = stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "print") return states[Math.min(probes++, states.length - 1)];
      return "";
    },
    waitImpl() {},
    stopAttempts: 3,
  });
  assert.deepEqual(result, { stopped: true });
  assert.equal(probes, 3);
  assert.equal(existsSync(run.paths.serviceReadinessState), false);
});

test("service stop succeeds immediately when the LaunchAgent is already absent", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let waits = 0;
  const result = stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "print") return "";
      return "";
    },
    waitImpl() { waits += 1; },
    stopAttempts: 3,
  });
  assert.deepEqual(result, { stopped: true });
  assert.equal(waits, 0);
  assert.equal(existsSync(run.paths.serviceReadinessState), false);
});

test("service stop clears readiness only after launchd reports the job gone", () => {
  const run = transactionFixture();
  writeReadiness(run.paths.serviceReadinessState, 41);
  let running = true;
  const result = stopService({
    paths: run.paths,
    launchctlImpl(args) {
      if (args[0] === "bootout") running = false;
      if (args[0] === "print") return running ? "state = running\npid = 41\n" : "";
      return "";
    },
    stopAttempts: 0,
  });
  assert.deepEqual(result, { stopped: true });
  assert.equal(existsSync(run.paths.serviceReadinessState), false);
});
