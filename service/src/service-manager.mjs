import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { servicePaths } from "./paths.mjs";
import { readConfig } from "./config.mjs";
import { inspectServiceLaunchdReadiness, removeServiceReadinessState } from "./service-readiness.mjs";
import { stageServiceDeployment } from "./service-deployment.mjs";

const label = "com.codex.imessage-handoff";
const retiredSupervisorLabel = "com.codex.imessage-handoff.shared-backend";
const retiredOwner = "codex-imessage-handoff";
const retiredLocalDaemonEnvironment = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeText(file, value, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function snapshot(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function restoreSnapshot(file, value, mode = 0o600) {
  if (value === null) rmSync(file, { force: true });
  else writeText(file, value, mode);
}

function launchctl(args, tolerateFailure = false) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (tolerateFailure) return "";
    throw error;
  }
}

function launchctlServiceMissing(error) {
  const stderr = String(error?.stderr || "");
  return Number(error?.status) === 113
    && stderr.includes(`Could not find service "${label}"`)
    && stderr.includes(`in domain for user gui: ${process.getuid()}`);
}

function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    const metadata = lstatSync(file);
    accessSync(file, constants.X_OK);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularFile(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function renderLaunchAgent(paths, options = {}) {
  const nodePath = String(options.nodePath || "");
  const deployedDaemonPath = String(options.daemonPath || "");
  const deploymentFingerprint = String(options.deploymentFingerprint || "");
  if (!executable(nodePath) || !regularFile(deployedDaemonPath)
    || !/^[a-f0-9]{64}$/.test(deploymentFingerprint)) {
    throw new Error("The service LaunchAgent requires a preflighted deployed runtime.");
  }
  // The helper reads its private client profile from the service config. Do
  // not copy IPC key material into launchd's inspectable environment.
  const pathValue = [...new Set([
    path.dirname(nodePath),
    ...(process.env.PATH || "").split(":").filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>-u</string><string>${retiredLocalDaemonEnvironment}</string><string>${xml(nodePath)}</string><string>--experimental-strip-types</string><string>${xml(deployedDaemonPath)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>CODEX_HOME</key><string>${xml(path.dirname(paths.stateDb))}</string>
<key>IMESSAGE_HANDOFF_SERVICE_DEPLOYMENT_FINGERPRINT</key><string>${xml(deploymentFingerprint)}</string>
<key>PATH</key><string>${xml(pathValue)}</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(paths.stdoutLog)}</string>
<key>StandardErrorPath</key><string>${xml(paths.stderrLog)}</string>
</dict></plist>
`;
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function deploymentOptions(options = {}) {
  return {
    projectRoot: options.projectRoot,
    nodePath: options.nodePath,
    wsRoot: options.wsRoot,
    allowUntrustedRuntime: options.allowUntrustedRuntime === true,
    run: options.deploymentRun,
  };
}

function prepareDeployment(paths, options = {}) {
  const stage = options.stageDeploymentImpl || stageServiceDeployment;
  return stage(paths.deployments, deploymentOptions(options));
}

function preflightLaunchAgent(paths, contents, options = {}) {
  if (typeof options.plistLintImpl === "function") {
    options.plistLintImpl(contents);
    return;
  }
  const temporary = path.join(paths.home, `.launch-agent-preflight-${process.pid}-${randomUUID()}.plist`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    execFileSync("/usr/bin/plutil", ["-lint", temporary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  } finally {
    rmSync(temporary, { force: true });
  }
}

function plistDeploymentFingerprint(file, environmentName) {
  try {
    const contents = readFileSync(file, "utf8");
    return contents.match(new RegExp(`<key>${environmentName}<\\/key><string>([a-f0-9]{64})<\\/string>`))?.[1] || null;
  } catch {
    return null;
  }
}

function readDeploymentState(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value?.owner === "codex-imessage-handoff" && value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function markDeploymentActive(file, fingerprint, previousFingerprint) {
  writeJson(file, {
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    activeFingerprint: fingerprint,
    previousFingerprint: previousFingerprint && previousFingerprint !== fingerprint ? previousFingerprint : null,
    activatedAt: new Date().toISOString(),
  });
}

function managedDeployment(directory, fingerprint) {
  try {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const manifestFile = path.join(directory, "deployment-manifest.json");
    const manifestMetadata = lstatSync(manifestFile);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    return manifest?.schemaVersion === 1
      && manifest?.owner === "codex-imessage-handoff"
      && manifest?.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

function makeManagedTreeRemovable(directory) {
  const visit = (candidate) => {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink()) throw new Error("A managed deployment contains a symbolic link.");
    if (!metadata.isDirectory()) {
      if (!metadata.isFile()) throw new Error("A managed deployment contains a non-regular entry.");
      return;
    }
    chmodSync(candidate, 0o700);
    for (const entry of readdirSync(candidate)) visit(path.join(candidate, entry));
  };
  visit(directory);
}

export function pruneInactiveServiceDeployments(deploymentsRoot, activeFingerprint) {
  const removed = [];
  if (!existsSync(deploymentsRoot)) return removed;
  for (const entry of readdirSync(deploymentsRoot, { withFileTypes: true })) {
    if (entry.name === activeFingerprint || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const candidate = path.join(deploymentsRoot, entry.name);
    if (!managedDeployment(candidate, entry.name)) continue;
    try {
      makeManagedTreeRemovable(candidate);
      rmSync(candidate, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Cleanup is best-effort after a new deployment is already healthy. A
      // stale read-only bundle must never make activation or rollback fail.
    }
  }
  return removed;
}

function retiredArtifactPaths(paths) {
  const codexHome = path.dirname(paths.stateDb);
  return {
    supervisorPlist: path.join(path.dirname(paths.plist), `${retiredSupervisorLabel}.plist`),
    supervisorConfig: path.join(paths.home, "shared-backend-supervisor-config.json"),
    supervisorState: path.join(paths.home, "shared-backend-supervisor-state.json"),
    supervisorDeploymentState: path.join(paths.home, "shared-backend-deployment.json"),
    turnLease: path.join(paths.home, "shared-backend-turn-lease.json"),
    desktopSyncState: path.join(paths.home, "desktop-sync-state.json"),
    stdoutLog: path.join(paths.home, "shared-backend-supervisor.log"),
    stderrLog: path.join(paths.home, "shared-backend-supervisor-error.log"),
    socket: path.join(codexHome, "app-server-control", "app-server-control.sock"),
    codexHome,
  };
}

function ownerRegularFile(file) {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && (typeof process.getuid !== "function" || metadata.uid === process.getuid());
  } catch {
    return false;
  }
}

function retiredOwnedRecord(file) {
  if (!ownerRegularFile(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value?.owner === retiredOwner && value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function retiredSupervisorPlistOwned(file, hasSupervisorMarker) {
  if (!hasSupervisorMarker || !ownerRegularFile(file)) return false;
  try {
    const contents = readFileSync(file, "utf8");
    return contents.includes(`<key>Label</key><string>${retiredSupervisorLabel}</string>`)
      && contents.includes("<key>IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE</key>")
      && contents.includes("<key>IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT</key>");
  } catch {
    return false;
  }
}

function removeOwnedRegularFile(file, removed) {
  if (!ownerRegularFile(file)) return false;
  try {
    rmSync(file, { force: true });
    removed.push(path.basename(file));
    return true;
  } catch {
    return false;
  }
}

function removeRetiredOwnedRecord(file, removed) {
  if (!retiredOwnedRecord(file)) return false;
  return removeOwnedRegularFile(file, removed);
}

function retiredJobLoaded(runLaunchctl, target) {
  try {
    return Boolean(String(runLaunchctl(["print", target]) || "").trim());
  } catch (error) {
    const detail = `${error?.message || ""}\n${error?.stderr || ""}`;
    if (/could not find service|service not found|no such process/i.test(detail)) return false;
    throw error;
  }
}

/**
 * Retire only artifacts carrying this service's old ownership records. This is
 * deliberately narrow: no LaunchAgent directory scan, Desktop preference
 * write, process search, or account-wide socket guess is permitted.
 */
export function cleanupRetiredSharedBackendArtifacts(paths, options = {}) {
  const artifacts = retiredArtifactPaths(paths);
  const runLaunchctl = options.launchctlImpl || launchctl;
  const removed = [];
  const failed = [];
  const supervisorConfig = retiredOwnedRecord(artifacts.supervisorConfig);
  const supervisorState = retiredOwnedRecord(artifacts.supervisorState);
  const supervisorDeploymentState = retiredOwnedRecord(artifacts.supervisorDeploymentState);
  const desktopSyncState = retiredOwnedRecord(artifacts.desktopSyncState);
  const supervisorMarker = Boolean(supervisorConfig || supervisorState || supervisorDeploymentState);
  const supervisorPlistPresent = existsSync(artifacts.supervisorPlist);
  const ownedPlist = retiredSupervisorPlistOwned(artifacts.supervisorPlist, supervisorMarker);
  const supervisorPlistConflict = supervisorPlistPresent && !ownedPlist;
  let supervisorStopped = !supervisorMarker;
  let supervisorWasLoaded = false;

  if (supervisorPlistConflict) {
    failed.push("retired-supervisor-plist-ownership");
    supervisorStopped = false;
  } else if (supervisorMarker) {
    const target = `gui/${process.getuid()}/${retiredSupervisorLabel}`;
    try {
      const loaded = retiredJobLoaded(runLaunchctl, target);
      supervisorWasLoaded = loaded;
      if (loaded) runLaunchctl(["bootout", target]);
      supervisorStopped = true;
    } catch {
      failed.push("retired-supervisor-bootout");
      supervisorStopped = false;
    }
  }

  const desktopActivationOwned = desktopSyncState?.activation?.owned === true
    && desktopSyncState.activation.environment === retiredLocalDaemonEnvironment
    && desktopSyncState.activation.value === "1";
  const supervisorActivationOwned = supervisorState?.activationOwned === true;
  let environmentSettled = !(desktopActivationOwned || supervisorActivationOwned);
  let desktopRoutingCleared = false;
  if (supervisorStopped && !environmentSettled) {
    try {
      const current = String(runLaunchctl(["getenv", retiredLocalDaemonEnvironment], true) || "").trim();
      if (current === "1") {
        runLaunchctl(["unsetenv", retiredLocalDaemonEnvironment]);
        desktopRoutingCleared = true;
      }
      environmentSettled = true;
    } catch {
      failed.push("retired-desktop-routing");
    }
  }

  if (!supervisorStopped || !environmentSettled) {
    return {
      cleaned: false,
      supervisorStopped,
      desktopRoutingCleared,
      removed,
      failed,
    };
  }

  if (ownedPlist && !removeOwnedRegularFile(artifacts.supervisorPlist, removed)) {
    failed.push(path.basename(artifacts.supervisorPlist));
  }

  const recordedSocket = typeof supervisorState?.socket === "string"
    ? path.resolve(supervisorState.socket)
    : null;
  const supervisorOwnedDaemon = recordedSocket === path.resolve(artifacts.socket)
    && supervisorWasLoaded
    && Number.isSafeInteger(supervisorState?.childPid)
    && supervisorState.childPid > 0
    && !supervisorState?.adoptedChildPid;
  if (supervisorOwnedDaemon) {
    try {
      const metadata = lstatSync(artifacts.socket);
      if (metadata.isSocket()
        && (typeof process.getuid !== "function" || metadata.uid === process.getuid())) {
        rmSync(artifacts.socket, { force: true });
        removed.push(path.basename(artifacts.socket));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") failed.push(path.basename(artifacts.socket));
    }
  }

  for (const file of [
    artifacts.supervisorConfig,
    artifacts.supervisorState,
    artifacts.supervisorDeploymentState,
    artifacts.turnLease,
    artifacts.desktopSyncState,
  ]) {
    if (retiredOwnedRecord(file) && !removeRetiredOwnedRecord(file, removed)) {
      failed.push(path.basename(file));
    }
  }
  if (supervisorMarker) {
    for (const file of [
      artifacts.stdoutLog,
      `${artifacts.stdoutLog}.1`,
      artifacts.stderrLog,
      `${artifacts.stderrLog}.1`,
    ]) {
      if (existsSync(file) && !removeOwnedRegularFile(file, removed)) failed.push(path.basename(file));
    }
  }

  return {
    cleaned: removed.length > 0,
    supervisorStopped,
    desktopRoutingCleared,
    removed,
    failed,
  };
}

function postActivationCleanup(paths, deploymentFingerprint, options, runLaunchctl) {
  let retiredArtifacts;
  try {
    const cleanup = options.cleanupRetiredImpl || cleanupRetiredSharedBackendArtifacts;
    retiredArtifacts = cleanup(paths, { launchctlImpl: runLaunchctl });
  } catch {
    retiredArtifacts = {
      cleaned: false,
      supervisorStopped: false,
      desktopRoutingCleared: false,
      removed: [],
      failed: ["retired-artifact-cleanup"],
    };
  }
  const prunedDeployments = retiredArtifacts.supervisorStopped === false
    ? []
    : pruneInactiveServiceDeployments(paths.deployments, deploymentFingerprint);
  return { retiredArtifacts, prunedDeployments };
}

function serviceRuntime(paths, runLaunchctl = launchctl) {
  let output;
  try {
    output = runLaunchctl(["print", `gui/${process.getuid()}/${label}`]);
  } catch (error) {
    if (!launchctlServiceMissing(error)) throw error;
    output = "";
  }
  return inspectServiceLaunchdReadiness(output, paths.serviceReadinessState);
}

function waitForServiceReady(paths, options = {}) {
  const runLaunchctl = options.launchctlImpl || launchctl;
  const waitImpl = options.waitImpl || wait;
  const attempts = options.readinessAttempts ?? 80;
  const intervalMs = options.readinessIntervalMs ?? 250;
  let runtime = serviceRuntime(paths, runLaunchctl);
  for (let attempt = 0; attempt < attempts && !runtime.running; attempt += 1) {
    waitImpl(intervalMs);
    runtime = serviceRuntime(paths, runLaunchctl);
  }
  return runtime;
}

/**
 * Replace the process for an already-loaded service without staging or
 * preflighting a new deployment. Success proves the prior PID is gone and its
 * replacement is locally ready; failure verifies the job is fully unloaded.
 */
export function rotateServiceProcess(options = {}) {
  const paths = options.paths || servicePaths();
  const runLaunchctl = options.launchctlImpl || launchctl;
  const waitImpl = options.waitImpl || wait;
  const attempts = options.rotationAttempts ?? 80;
  const intervalMs = options.rotationIntervalMs ?? 250;
  try {
    const before = serviceRuntime(paths, runLaunchctl);
    if (!before.jobLoaded) return { rotated: false, previousPid: null, pid: null };
    const previousPid = before.pid;
    runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`]);
    let runtime = serviceRuntime(paths, runLaunchctl);
    const replaced = () => runtime.running && (!previousPid || runtime.pid !== previousPid);
    for (let attempt = 0; attempt < attempts && !replaced(); attempt += 1) {
      waitImpl(intervalMs);
      runtime = serviceRuntime(paths, runLaunchctl);
    }
    if (!replaced()) throw new Error("The replacement service process did not become ready.");
    return { rotated: true, previousPid, pid: runtime.pid };
  } catch (rotationError) {
    try {
      stopService({
        paths,
        launchctlImpl: runLaunchctl,
        waitImpl,
        stopAttempts: options.stopAttempts,
        stopIntervalMs: options.stopIntervalMs,
      });
    } catch (stopError) {
      throw Object.assign(new Error(
        `The Remote Control service could neither rotate nor stop safely: ${rotationError.message}; ${stopError.message}`,
        { cause: rotationError },
      ), { code: "SERVICE_ROTATION_AND_STOP_FAILED" });
    }
    throw Object.assign(new Error(
      `The Remote Control service rotation failed and the old service was stopped safely: ${rotationError.message}`,
      { cause: rotationError },
    ), { code: "SERVICE_ROTATION_FAILED_STOPPED" });
  }
}

export function installService(options = {}) {
  if ((options.platform || process.platform) !== "darwin") throw new Error("Automatic service installation currently supports macOS only.");
  const paths = options.paths || servicePaths();
  const config = options.config || readConfig();
  const imsgProfile = config.imsg;
  if (!imsgProfile || imsgProfile.mode !== "helper") {
    throw new Error("The local service requires a verified split-user Messages helper configuration.");
  }
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(paths.plist), { recursive: true });
  const deployment = prepareDeployment(paths, options);
  const plist = renderLaunchAgent(paths, {
    nodePath: deployment.nodePath,
    daemonPath: deployment.daemonPath,
    deploymentFingerprint: deployment.fingerprint,
  });
  preflightLaunchAgent(paths, plist, options);

  const runLaunchctl = options.launchctlImpl || launchctl;
  const existing = serviceRuntime(paths, runLaunchctl);
  const previousFingerprint = plistDeploymentFingerprint(paths.plist, "IMESSAGE_HANDOFF_SERVICE_DEPLOYMENT_FINGERPRINT");
  if (options.forceRestart !== true && existing.running && previousFingerprint === deployment.fingerprint) {
    const cleanup = postActivationCleanup(paths, deployment.fingerprint, options, runLaunchctl);
    return {
      installed: true,
      changed: false,
      plist: paths.plist,
      daemonPath: deployment.daemonPath,
      deployment: deployment.root,
      deploymentFingerprint: deployment.fingerprint,
      logs: [paths.stdoutLog, paths.stderrLog],
      ...cleanup,
    };
  }
  const previous = {
    plist: snapshot(paths.plist),
    deploymentState: snapshot(paths.serviceDeploymentState),
    jobLoaded: existing.jobLoaded,
    ready: existing.running,
  };
  try {
    runLaunchctl(["bootout", `gui/${process.getuid()}`, paths.plist], true);
    writeText(paths.plist, plist);
    removeServiceReadinessState(paths.serviceReadinessState);
    runLaunchctl(["bootstrap", `gui/${process.getuid()}`, paths.plist]);
    runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], true);
    const ready = waitForServiceReady(paths, { ...options, launchctlImpl: runLaunchctl });
    if (!ready.running) throw new Error("The deployed iMessage service did not become ready.");
    markDeploymentActive(paths.serviceDeploymentState, deployment.fingerprint, previousFingerprint);
  } catch (candidateError) {
    runLaunchctl(["bootout", `gui/${process.getuid()}`, paths.plist], true);
    restoreSnapshot(paths.plist, previous.plist);
    restoreSnapshot(paths.serviceDeploymentState, previous.deploymentState);
    removeServiceReadinessState(paths.serviceReadinessState);
    let rollbackError = null;
    if (previous.plist && previous.jobLoaded) {
      try {
        runLaunchctl(["bootstrap", `gui/${process.getuid()}`, paths.plist]);
        runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], true);
        if (previous.ready && !waitForServiceReady(paths, { ...options, launchctlImpl: runLaunchctl }).running) {
          throw new Error("The previous iMessage service did not recover after rollback.");
        }
      } catch (error) {
        rollbackError = error;
      }
    }
    const detail = rollbackError ? ` Rollback also failed: ${rollbackError.message}` : " The previous installation was restored.";
    throw Object.assign(new Error(`iMessage service installation failed: ${candidateError.message}.${detail}`, { cause: candidateError }), {
      code: rollbackError ? "SERVICE_INSTALL_AND_ROLLBACK_FAILED" : "SERVICE_INSTALL_ROLLED_BACK",
    });
  }
  const cleanup = postActivationCleanup(paths, deployment.fingerprint, options, runLaunchctl);
  return {
    installed: true,
    changed: true,
    plist: paths.plist,
    daemonPath: deployment.daemonPath,
    deployment: deployment.root,
    deploymentFingerprint: deployment.fingerprint,
    logs: [paths.stdoutLog, paths.stderrLog],
    ...cleanup,
  };
}

export function stopService(options = {}) {
  const paths = options.paths || servicePaths();
  const runLaunchctl = options.launchctlImpl || launchctl;
  const waitImpl = options.waitImpl || wait;
  const attempts = options.stopAttempts ?? 40;
  const intervalMs = options.stopIntervalMs ?? 100;
  runLaunchctl(["bootout", `gui/${process.getuid()}`, paths.plist], true);
  let runtime = serviceRuntime(paths, runLaunchctl);
  for (let attempt = 0; attempt < attempts && runtime.jobLoaded; attempt += 1) {
    waitImpl(intervalMs);
    runtime = serviceRuntime(paths, runLaunchctl);
  }
  if (runtime.jobLoaded) {
    throw Object.assign(new Error("The iMessage service could not be stopped safely."), {
      code: "SERVICE_STOP_FAILED",
    });
  }
  removeServiceReadinessState(paths.serviceReadinessState);
  return { stopped: true };
}

export function uninstallService() {
  const paths = servicePaths();
  stopService();
  rmSync(paths.plist, { force: true });
  rmSync(paths.serviceDeploymentState, { force: true });
  return { removed: true, plist: paths.plist };
}

export function serviceStatus() {
  const paths = servicePaths();
  const runtime = serviceRuntime(paths);
  const deploymentFingerprint = plistDeploymentFingerprint(paths.plist, "IMESSAGE_HANDOFF_SERVICE_DEPLOYMENT_FINGERPRINT");
  const deploymentState = readDeploymentState(paths.serviceDeploymentState);
  return {
    installed: existsSync(paths.plist),
    running: runtime.running,
    jobLoaded: runtime.jobLoaded,
    jobRunning: runtime.jobRunning,
    pid: runtime.pid,
    readiness: runtime.readiness,
    logs: [paths.stdoutLog, paths.stderrLog],
    deployment: {
      fingerprint: deploymentFingerprint,
      active: Boolean(deploymentFingerprint && deploymentState?.activeFingerprint === deploymentFingerprint),
      previousFingerprint: deploymentState?.previousFingerprint || null,
    },
  };
}
