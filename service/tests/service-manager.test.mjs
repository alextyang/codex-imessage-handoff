import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installService,
  installSharedBackendSupervisor,
  renderLaunchAgent,
  renderSharedBackendSupervisorLaunchAgent,
  resolveCodexBinary,
  sharedBackendSupervisorBuildFingerprint,
} from "../src/service-manager.mjs";

const fingerprint = "a".repeat(64);

function deployedRuntime(directory, node = path.join(directory, "node")) {
  const daemon = path.join(directory, "deployment", "service", "src", "daemon.mjs");
  const supervisor = path.join(directory, "deployment", "service", "src", "shared-backend-supervisor.mjs");
  mkdirSync(path.dirname(daemon), { recursive: true });
  writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(daemon, "");
  writeFileSync(supervisor, "");
  return { nodePath: node, daemonPath: daemon, supervisorPath: supervisor, deploymentFingerprint: fingerprint };
}

function transactionFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-transaction-"));
  const home = path.join(directory, "home");
  const launchAgents = path.join(directory, "LaunchAgents");
  mkdirSync(home, { recursive: true });
  mkdirSync(launchAgents, { recursive: true });
  const runtime = deployedRuntime(directory);
  const codex = path.join(directory, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const paths = {
    home,
    deployments: path.join(home, "deployments"),
    stateDb: path.join(directory, ".codex", "state.sqlite"),
    serviceReadinessState: path.join(home, "service-readiness.json"),
    serviceDeploymentState: path.join(home, "service-deployment.json"),
    sharedBackendDeploymentState: path.join(home, "shared-backend-deployment.json"),
    sharedBackendSupervisorState: path.join(home, "shared-backend-supervisor-state.json"),
    sharedBackendSupervisorConfig: path.join(home, "shared-backend-supervisor-config.json"),
    sharedBackendTurnLease: path.join(home, "turn-lease.json"),
    stdoutLog: path.join(home, "service.log"),
    stderrLog: path.join(home, "service-error.log"),
    sharedBackendSupervisorStdoutLog: path.join(home, "supervisor.log"),
    sharedBackendSupervisorStderrLog: path.join(home, "supervisor-error.log"),
    plist: path.join(launchAgents, "service.plist"),
    sharedBackendSupervisorPlist: path.join(launchAgents, "supervisor.plist"),
  };
  return {
    directory,
    paths,
    runtime,
    codex,
    deployment: {
      root: path.join(directory, "deployment"),
      fingerprint,
      nodePath: runtime.nodePath,
      daemonPath: runtime.daemonPath,
      supervisorPath: runtime.supervisorPath,
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

test("LaunchAgent pins an executable Codex binary and the shared app-server backend", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-manager-"));
  const codex = path.join(directory, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codex, 0o700);
  const deployment = deployedRuntime(directory);
  assert.equal(resolveCodexBinary({ CODEX_BIN: codex, PATH: "/usr/bin:/bin" }), codex);

  const plist = renderLaunchAgent({
    stateDb: path.join(directory, "state.sqlite"),
    stdoutLog: path.join(directory, "service.log"),
    stderrLog: path.join(directory, "service-error.log"),
  }, codex, deployment);
  assert.match(plist, new RegExp(`<key>CODEX_BIN</key><string>${codex}</string>`));
  assert.match(plist, /<key>IMESSAGE_HANDOFF_CODEX_BACKEND<\/key><string>app-server<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>[^<]*\/usr\/bin/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
});

test("LaunchAgent can require the shared app-server backend without configuring Desktop in the child", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-manager-shared-"));
  const codex = path.join(directory, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codex, 0o700);
  const deployment = deployedRuntime(directory);
  const plist = renderLaunchAgent({
    stateDb: path.join(directory, "state.sqlite"),
    stdoutLog: path.join(directory, "service.log"),
    stderrLog: path.join(directory, "service-error.log"),
  }, codex, { ...deployment, codexBackend: "app-server" });
  assert.match(plist, /<key>IMESSAGE_HANDOFF_CODEX_BACKEND<\/key><string>app-server<\/string>/);
  assert.match(plist, /<key>CODEX_APP_SERVER_USE_LOCAL_DAEMON<\/key><string>0<\/string>/);
});

test("shared backend LaunchAgent supervises one foreground owner without enabling Desktop in its child", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-shared-supervisor-"));
  const codex = path.join(directory, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codex, 0o700);
  const deployment = deployedRuntime(directory);
  const plist = renderSharedBackendSupervisorLaunchAgent({
    stateDb: path.join(directory, ".codex", "state.sqlite"),
    sharedBackendSupervisorStdoutLog: path.join(directory, "supervisor.log"),
    sharedBackendSupervisorStderrLog: path.join(directory, "supervisor-error.log"),
  }, codex, "test-instance", sharedBackendSupervisorBuildFingerprint(), deployment);
  assert.match(plist, /com\.codex\.imessage-handoff\.shared-backend/);
  assert.match(plist, /shared-backend-supervisor\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
  assert.match(plist, new RegExp(`<key>CODEX_BIN</key><string>${codex}</string>`));
  assert.match(plist, /<key>CODEX_APP_SERVER_USE_LOCAL_DAEMON<\/key><string>0<\/string>/);
  assert.match(plist, new RegExp(`<key>IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT</key><string>${sharedBackendSupervisorBuildFingerprint()}</string>`));
});

test("shared backend build fingerprint changes with deployed source content", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-supervisor-build-"));
  const first = path.join(directory, "first.mjs");
  const second = path.join(directory, "second.mjs");
  writeFileSync(first, "export const value = 1;\n", "utf8");
  writeFileSync(second, "export const value = 2;\n", "utf8");
  const before = sharedBackendSupervisorBuildFingerprint([first, second]);
  writeFileSync(second, "export const value = 3;\n", "utf8");
  const after = sharedBackendSupervisorBuildFingerprint([first, second]);
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.notEqual(after, before);
});

test("helper-mode LaunchAgent omits local imsg and private IPC configuration", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-manager-helper-"));
  const codex = path.join(directory, "codex");
  const imsg = path.join(directory, "imsg-should-not-run");
  const clientConfig = path.join(directory, "private-controller-client.json");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o700 });
  writeFileSync(imsg, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o700 });
  chmodSync(codex, 0o700);
  chmodSync(imsg, 0o700);
  const deployment = deployedRuntime(directory, path.join(directory, "deployed-node"));

  const plist = renderLaunchAgent({
    stateDb: path.join(directory, "state.sqlite"),
    stdoutLog: path.join(directory, "service.log"),
    stderrLog: path.join(directory, "service-error.log"),
  }, codex, {
    ...deployment,
    clientConfig,
    ipcSecret: "private-ipc-secret",
    privateKey: "private-key-material",
  });
  assert.doesNotMatch(plist, /<key>IMSG_BIN<\/key>/);
  assert.equal(plist.includes(imsg), false);
  assert.equal(plist.includes(clientConfig), false);
  assert.equal(plist.includes("private-ipc-secret"), false);
  assert.equal(plist.includes("private-key-material"), false);
});

test("service installation activates only a ready versioned deployment", () => {
  const run = transactionFixture();
  const previousFingerprint = "b".repeat(64);
  writeFileSync(run.paths.plist, renderLaunchAgent(run.paths, run.codex, {
    ...run.runtime,
    deploymentFingerprint: previousFingerprint,
  }));
  writeReadiness(run.paths.serviceReadinessState, 41);
  let running = true;
  let pid = 41;
  const calls = [];
  const launchctlImpl = (args) => {
    calls.push(args);
    if (args[0] === "print") return running ? `state = running\npid = ${pid}\n` : "";
    if (args[0] === "bootout") { running = false; return ""; }
    if (args[0] === "bootstrap") {
      running = true;
      pid = 42;
      writeReadiness(run.paths.serviceReadinessState, pid);
      return "";
    }
    return "";
  };
  const result = installService({
    platform: "darwin",
    paths: run.paths,
    codexBin: run.codex,
    config: { imsg: { mode: "helper" } },
    supervisor: { running: true, healthy: true, activationEnabled: true, config: { activationRequested: true, failOpenLatched: false } },
    desktop: { shared: true },
    stageDeploymentImpl: () => run.deployment,
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
});

test("service installation restores the prior ready LaunchAgent when candidate readiness fails", () => {
  const run = transactionFixture();
  const previousFingerprint = "b".repeat(64);
  const oldPlist = renderLaunchAgent(run.paths, run.codex, { ...run.runtime, deploymentFingerprint: previousFingerprint });
  writeFileSync(run.paths.plist, oldPlist);
  writeReadiness(run.paths.serviceReadinessState, 41);
  let running = true;
  let pid = 41;
  let bootstraps = 0;
  const launchctlImpl = (args) => {
    if (args[0] === "print") return running ? `state = running\npid = ${pid}\n` : "";
    if (args[0] === "bootout") { running = false; return ""; }
    if (args[0] === "bootstrap") {
      bootstraps += 1;
      running = true;
      pid = bootstraps === 1 ? 42 : 43;
      if (bootstraps === 2) writeReadiness(run.paths.serviceReadinessState, pid);
      return "";
    }
    return "";
  };
  assert.throws(() => installService({
    platform: "darwin",
    paths: run.paths,
    codexBin: run.codex,
    config: { imsg: { mode: "helper" } },
    supervisor: { running: true, healthy: true, activationEnabled: true, config: { activationRequested: true, failOpenLatched: false } },
    desktop: { shared: true },
    stageDeploymentImpl: () => run.deployment,
    plistLintImpl: () => {},
    launchctlImpl,
    readinessAttempts: 0,
  }), (error) => error?.code === "SERVICE_INSTALL_ROLLED_BACK");
  assert.equal(readFileSync(run.paths.plist, "utf8"), oldPlist);
  assert.equal(bootstraps, 2);
  assert.equal(pid, 43);
});

test("forced restart transaction replaces an already-ready matching deployment", () => {
  const run = transactionFixture();
  writeFileSync(run.paths.plist, renderLaunchAgent(run.paths, run.codex, { ...run.runtime, deploymentFingerprint: fingerprint }));
  writeReadiness(run.paths.serviceReadinessState, 41);
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
    codexBin: run.codex,
    config: { imsg: { mode: "helper" } },
    supervisor: { running: true, healthy: true, activationEnabled: true, config: { activationRequested: true, failOpenLatched: false } },
    desktop: { shared: true },
    stageDeploymentImpl: () => run.deployment,
    plistLintImpl: () => {},
    launchctlImpl,
    readinessAttempts: 0,
  });
  assert.equal(result.changed, true);
  assert.equal(bootstraps, 1);
});

test("shared backend installation rolls back its plist and config after candidate health failure", () => {
  const run = transactionFixture();
  const oldFingerprint = "b".repeat(64);
  const buildFingerprint = sharedBackendSupervisorBuildFingerprint();
  const oldConfig = {
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    instanceId: "old-instance",
    implementationVersion: 7,
    buildFingerprint,
    deploymentFingerprint: oldFingerprint,
    activationRequested: false,
    failOpenLatched: false,
  };
  const oldPlist = renderSharedBackendSupervisorLaunchAgent(
    run.paths,
    run.codex,
    oldConfig.instanceId,
    buildFingerprint,
    { ...run.runtime, deploymentFingerprint: oldFingerprint },
  );
  writeFileSync(run.paths.plist, "");
  writeFileSync(run.paths.sharedBackendSupervisorPlist, oldPlist);
  writeFileSync(run.paths.sharedBackendSupervisorConfig, JSON.stringify(oldConfig));
  writeFileSync(run.paths.sharedBackendSupervisorState, JSON.stringify({
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    pid: 41,
    instanceId: oldConfig.instanceId,
    buildFingerprint,
    binary: run.codex,
    healthy: true,
    updatedAt: new Date().toISOString(),
  }));
  let running = true;
  let pid = 41;
  let bootstraps = 0;
  const launchctlImpl = (args) => {
    if (args[0] === "getenv") return "";
    if (args[0] === "print") return running ? `state = running\npid = ${pid}\n` : "";
    if (args[0] === "bootout") { running = false; return ""; }
    if (args[0] === "bootstrap") {
      bootstraps += 1;
      running = true;
      pid = bootstraps === 1 ? 42 : 43;
      if (bootstraps === 2) writeFileSync(run.paths.sharedBackendSupervisorState, JSON.stringify({
        schemaVersion: 1,
        owner: "codex-imessage-handoff",
        pid,
        instanceId: oldConfig.instanceId,
        buildFingerprint,
        binary: run.codex,
        healthy: true,
        updatedAt: new Date().toISOString(),
      }));
      return "";
    }
    return "";
  };
  assert.throws(() => installSharedBackendSupervisor({
    platform: "darwin",
    paths: run.paths,
    codexBin: run.codex,
    stageDeploymentImpl: () => run.deployment,
    plistLintImpl: () => {},
    launchctlImpl,
    inspectDesktopImpl: () => ({ shared: false }),
    readLeaseImpl: () => null,
    supervisorReadinessAttempts: 0,
  }), (error) => error?.code === "SUPERVISOR_INSTALL_ROLLED_BACK");
  assert.equal(readFileSync(run.paths.sharedBackendSupervisorPlist, "utf8"), oldPlist);
  assert.equal(JSON.parse(readFileSync(run.paths.sharedBackendSupervisorConfig, "utf8")).instanceId, oldConfig.instanceId);
  assert.equal(bootstraps, 2);
});
