import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { servicePaths } from "./paths.mjs";
import { readConfig } from "./config.mjs";
import { inspectDesktopSharedConnection } from "./desktop-connection.mjs";
import { readSharedBackendLease } from "./shared-backend-lease.mjs";
import { inspectServiceLaunchdReadiness, removeServiceReadinessState } from "./service-readiness.mjs";
import { stageServiceDeployment } from "./service-deployment.mjs";

const label = "com.codex.imessage-handoff";
const sharedBackendSupervisorLabel = "com.codex.imessage-handoff.shared-backend";
const localDaemonEnvironment = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";
const serviceBackendEnvironment = "IMESSAGE_HANDOFF_CODEX_BACKEND";
const sharedBackendSupervisorImplementationVersion = 7;
const sharedBackendSupervisorBuildFiles = [
  "shared-backend-supervisor.mjs",
  "shared-backend-policy.mjs",
  "desktop-sync.mjs",
  "desktop-connection.mjs",
  "shared-backend-lease.mjs",
  "paths.mjs",
].map((name) => path.join(path.dirname(fileURLToPath(import.meta.url)), name));

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
  try { return readFileSync(file); } catch (error) {
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

function which(command, env) {
  try {
    const resolved = execFileSync("/usr/bin/which", [command], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return executable(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveCodexBinary(env = process.env) {
  const override = String(env.CODEX_BIN || "").trim();
  const candidates = [
    executable(override) ? override : which(override, env),
    which("codex", env),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  const resolved = candidates.find(executable);
  if (!resolved) throw new Error("Codex executable not found. Set CODEX_BIN before installing the service.");
  return resolved;
}

function requireAppServerBackend(value = "app-server") {
  if (value !== "app-server") throw new Error("The messaging service only supports the supervised shared app-server backend.");
  return "app-server";
}

function installedCodexBackend(paths) {
  if (!existsSync(paths.plist)) return null;
  try {
    const plist = readFileSync(paths.plist, "utf8");
    const match = plist.match(new RegExp(`<key>${serviceBackendEnvironment}<\\/key><string>([^<]+)<\\/string>`));
    return match?.[1] === "app-server" ? "app-server" : "unsupported";
  } catch {
    return "unsupported";
  }
}

export function renderLaunchAgent(paths, codexBin = resolveCodexBinary(), options = {}) {
  const codexBackend = requireAppServerBackend(options.codexBackend || "app-server");
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
    path.dirname(codexBin),
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
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>--experimental-strip-types</string><string>${xml(deployedDaemonPath)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>CODEX_HOME</key><string>${xml(path.dirname(paths.stateDb))}</string>
<key>CODEX_BIN</key><string>${xml(codexBin)}</string>
<key>${localDaemonEnvironment}</key><string>0</string>
<key>${serviceBackendEnvironment}</key><string>${codexBackend}</string>
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

export function sharedBackendSupervisorBuildFingerprint(files = sharedBackendSupervisorBuildFiles) {
  const digest = createHash("sha256");
  for (const file of [...files].map((value) => path.resolve(value)).sort()) {
    digest.update(path.basename(file));
    digest.update("\0");
    digest.update(readFileSync(file));
    digest.update("\0");
  }
  digest.update(`implementation:${sharedBackendSupervisorImplementationVersion}`);
  return digest.digest("hex");
}

export function renderSharedBackendSupervisorLaunchAgent(
  paths,
  codexBin = resolveCodexBinary(),
  instanceId = "test-instance",
  buildFingerprint = sharedBackendSupervisorBuildFingerprint(),
  options = {},
) {
  if (!/^[a-f0-9]{64}$/.test(String(buildFingerprint))) {
    throw new Error("The shared app-server supervisor build fingerprint is invalid.");
  }
  const nodePath = String(options.nodePath || "");
  const deployedSupervisorPath = String(options.supervisorPath || "");
  const deploymentFingerprint = String(options.deploymentFingerprint || "");
  if (!executable(nodePath) || !regularFile(deployedSupervisorPath)
    || !/^[a-f0-9]{64}$/.test(deploymentFingerprint)) {
    throw new Error("The shared backend LaunchAgent requires a preflighted deployed runtime.");
  }
  const pathValue = [...new Set([
    path.dirname(nodePath),
    path.dirname(codexBin),
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
<key>Label</key><string>${sharedBackendSupervisorLabel}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>--experimental-strip-types</string><string>${xml(deployedSupervisorPath)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>CODEX_HOME</key><string>${xml(path.dirname(paths.stateDb))}</string>
<key>CODEX_BIN</key><string>${xml(codexBin)}</string>
<key>${localDaemonEnvironment}</key><string>0</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE</key><string>${xml(instanceId)}</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT</key><string>${xml(buildFingerprint)}</string>
<key>IMESSAGE_HANDOFF_SUPERVISOR_DEPLOYMENT_FINGERPRINT</key><string>${xml(deploymentFingerprint)}</string>
<key>PATH</key><string>${xml(pathValue)}</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>60</integer>
<key>StandardOutPath</key><string>${xml(paths.sharedBackendSupervisorStdoutLog)}</string>
<key>StandardErrorPath</key><string>${xml(paths.sharedBackendSupervisorStderrLog)}</string>
</dict></plist>
`;
}

function ownedSupervisorConfig(paths) {
  try {
    const value = JSON.parse(readFileSync(paths.sharedBackendSupervisorConfig, "utf8"));
    return value?.owner === "codex-imessage-handoff" && value?.schemaVersion === 1 && typeof value?.instanceId === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

function writeSupervisorConfig(paths, value) {
  writeJson(paths.sharedBackendSupervisorConfig, {
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    ...value,
    updatedAt: new Date().toISOString(),
  });
}

function ownedSupervisorState(paths) {
  try {
    const value = JSON.parse(readFileSync(paths.sharedBackendSupervisorState, "utf8"));
    return value?.owner === "codex-imessage-handoff" && value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
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

function serviceRuntime(paths, runLaunchctl = launchctl) {
  const output = runLaunchctl(["print", `gui/${process.getuid()}/${label}`], true);
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

function waitForSupervisorReady(paths, expected, options = {}) {
  const waitImpl = options.waitImpl || wait;
  const attempts = options.supervisorReadinessAttempts ?? 60;
  const intervalMs = options.supervisorReadinessIntervalMs ?? 500;
  let status;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    status = sharedBackendSupervisorStatus({
      paths,
      launchctlImpl: options.launchctlImpl,
      desiredBuildFingerprint: expected.buildFingerprint,
    });
    const expectedHealthy = expected.deploymentFingerprint ? status.healthy : status.rawHealthy;
    if (expectedHealthy
      && status.config?.instanceId === expected.instanceId
      && status.config?.buildFingerprint === expected.buildFingerprint
      && (!expected.deploymentFingerprint || status.config?.deploymentFingerprint === expected.deploymentFingerprint)) return status;
    if (attempt < attempts) waitImpl(intervalMs);
  }
  return status;
}

export function installSharedBackendSupervisor(options = {}) {
  if ((options.platform || process.platform) !== "darwin") throw new Error("Shared app-server supervision currently supports macOS only.");
  const paths = options.paths || servicePaths();
  const codexBin = options.codexBin || resolveCodexBinary(options.env || process.env);
  const buildFingerprint = sharedBackendSupervisorBuildFingerprint();
  const runLaunchctl = options.launchctlImpl || launchctl;
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(paths.sharedBackendSupervisorPlist), { recursive: true });
  const existing = sharedBackendSupervisorStatus({ paths, launchctlImpl: runLaunchctl });
  const currentDesktopRouting = runLaunchctl(["getenv", localDaemonEnvironment], true).trim();
  if (currentDesktopRouting === "1" && existing.state?.activationOwned !== true) {
    throw new Error(`${localDaemonEnvironment}=1 is already set outside iMessage Handoff; it was left untouched.`);
  }
  const inspectDesktop = options.inspectDesktopImpl || inspectDesktopSharedConnection;
  const inspectLease = options.readLeaseImpl || readSharedBackendLease;
  if (existing.jobRunning && (existing.activationEnabled || inspectDesktop().shared || inspectLease(paths.sharedBackendTurnLease))) {
    throw new Error("Refusing to replace the shared app-server supervisor while Desktop or iMessage is using it.");
  }
  const deployment = prepareDeployment(paths, options);
  if (
    existing.running
    && existing.healthy
    && existing.config?.implementationVersion === sharedBackendSupervisorImplementationVersion
    && existing.config?.buildFingerprint === buildFingerprint
    && existing.state?.buildFingerprint === buildFingerprint
    && existing.config?.deploymentFingerprint === deployment.fingerprint
    && existing.currentDeployment
    && path.resolve(existing.state?.binary || "") === path.resolve(codexBin)
  ) {
    return {
      installed: true,
      changed: false,
      plist: paths.sharedBackendSupervisorPlist,
      supervisorPath: deployment.supervisorPath,
      deployment: deployment.root,
      deploymentFingerprint: deployment.fingerprint,
      logs: [paths.sharedBackendSupervisorStdoutLog, paths.sharedBackendSupervisorStderrLog],
    };
  }
  if (
    existing.running
    && existing.fresh
    && existing.config?.implementationVersion === sharedBackendSupervisorImplementationVersion
    && existing.config?.buildFingerprint === buildFingerprint
    && existing.state?.buildFingerprint === buildFingerprint
    && existing.config?.deploymentFingerprint === deployment.fingerprint
  ) {
    throw new Error("The shared app-server supervisor is already starting. Wait for its health check instead of replacing it.");
  }
  if (existing.running && existing.activationEnabled) {
    throw new Error("Refusing to replace the shared app-server supervisor while Desktop routing is active.");
  }
  if (existing.state?.activationOwned === true && runLaunchctl(["getenv", localDaemonEnvironment], true).trim() === "1") {
    runLaunchctl(["unsetenv", localDaemonEnvironment], true);
  }
  const instanceId = randomUUID();
  const nextConfig = {
    instanceId,
    implementationVersion: sharedBackendSupervisorImplementationVersion,
    buildFingerprint,
    deploymentFingerprint: deployment.fingerprint,
    activationRequested: false,
    failOpenLatched: false,
  };
  const plist = renderSharedBackendSupervisorLaunchAgent(paths, codexBin, instanceId, buildFingerprint, {
    nodePath: deployment.nodePath,
    supervisorPath: deployment.supervisorPath,
    deploymentFingerprint: deployment.fingerprint,
  });
  preflightLaunchAgent(paths, plist, options);

  const previous = {
    plist: snapshot(paths.sharedBackendSupervisorPlist),
    config: snapshot(paths.sharedBackendSupervisorConfig),
    state: snapshot(paths.sharedBackendSupervisorState),
    deploymentState: snapshot(paths.sharedBackendDeploymentState),
    jobRunning: existing.jobRunning,
    healthy: existing.rawHealthy,
    configValue: existing.config,
    deploymentFingerprint: existing.installedDeployment,
  };
  try {
    runLaunchctl(["bootout", `gui/${process.getuid()}`, paths.sharedBackendSupervisorPlist], true);
    writeSupervisorConfig(paths, nextConfig);
    writeText(paths.sharedBackendSupervisorPlist, plist);
    rmSync(paths.sharedBackendSupervisorState, { force: true });
    runLaunchctl(["bootstrap", `gui/${process.getuid()}`, paths.sharedBackendSupervisorPlist]);
    runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/${sharedBackendSupervisorLabel}`], true);
    const ready = waitForSupervisorReady(paths, { ...nextConfig }, { ...options, launchctlImpl: runLaunchctl });
    if (!ready?.healthy) throw new Error("The deployed shared app-server supervisor did not become healthy.");
    markDeploymentActive(paths.sharedBackendDeploymentState, deployment.fingerprint, previous.deploymentFingerprint);
  } catch (candidateError) {
    runLaunchctl(["bootout", `gui/${process.getuid()}`, paths.sharedBackendSupervisorPlist], true);
    restoreSnapshot(paths.sharedBackendSupervisorPlist, previous.plist);
    restoreSnapshot(paths.sharedBackendSupervisorConfig, previous.config);
    rmSync(paths.sharedBackendSupervisorState, { force: true });
    restoreSnapshot(paths.sharedBackendDeploymentState, previous.deploymentState);
    let rollbackError = null;
    if (previous.plist && previous.jobRunning) {
      try {
        runLaunchctl(["bootstrap", `gui/${process.getuid()}`, paths.sharedBackendSupervisorPlist]);
        runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/${sharedBackendSupervisorLabel}`], true);
        if (previous.healthy && previous.configValue) {
          const restored = waitForSupervisorReady(paths, {
            instanceId: previous.configValue.instanceId,
            buildFingerprint: previous.configValue.buildFingerprint,
            deploymentFingerprint: previous.configValue.deploymentFingerprint,
          }, { ...options, launchctlImpl: runLaunchctl });
          if (!restored?.rawHealthy) throw new Error("The previous shared backend did not recover after rollback.");
        }
      } catch (error) {
        rollbackError = error;
      }
    } else if (previous.state) {
      restoreSnapshot(paths.sharedBackendSupervisorState, previous.state);
    }
    const detail = rollbackError ? ` Rollback also failed: ${rollbackError.message}` : " The previous installation was restored.";
    throw Object.assign(new Error(`Shared backend installation failed.${detail}`, { cause: candidateError }), {
      code: rollbackError ? "SUPERVISOR_INSTALL_AND_ROLLBACK_FAILED" : "SUPERVISOR_INSTALL_ROLLED_BACK",
    });
  }
  return {
    installed: true,
    changed: true,
    plist: paths.sharedBackendSupervisorPlist,
    supervisorPath: deployment.supervisorPath,
    deployment: deployment.root,
    deploymentFingerprint: deployment.fingerprint,
    logs: [paths.sharedBackendSupervisorStdoutLog, paths.sharedBackendSupervisorStderrLog],
  };
}

export function requestSharedBackendActivation() {
  const paths = servicePaths();
  const status = sharedBackendSupervisorStatus();
  if (!status.running || !status.fresh || !status.healthy) throw new Error("The shared app-server supervisor is not healthy.");
  const config = ownedSupervisorConfig(paths);
  if (!config || config.instanceId !== status.state?.instanceId) throw new Error("The shared app-server supervisor configuration is stale.");
  const buildFingerprint = sharedBackendSupervisorBuildFingerprint();
  if (config.buildFingerprint !== buildFingerprint || status.state?.buildFingerprint !== buildFingerprint) {
    throw new Error("The shared app-server supervisor must be safely reloaded before Desktop activation.");
  }
  writeSupervisorConfig(paths, { ...config, activationRequested: true, failOpenLatched: false, requestedAt: new Date().toISOString() });
  return { requested: true, activationEnabled: status.activationEnabled };
}

export function disableSharedBackendActivation(reason = "manual") {
  const paths = servicePaths();
  const config = ownedSupervisorConfig(paths);
  if (config) writeSupervisorConfig(paths, { ...config, activationRequested: false, failOpenLatched: reason === "failure", disabledAt: new Date().toISOString(), disabledReason: reason });
  const state = ownedSupervisorState(paths);
  const current = launchctl(["getenv", localDaemonEnvironment], true).trim();
  if (state?.activationOwned === true && current === "1") launchctl(["unsetenv", localDaemonEnvironment], true);
  return { disabled: current === "1" && state?.activationOwned === true, reason };
}

export function stopSharedBackendSupervisor(options = {}) {
  const paths = servicePaths();
  const state = ownedSupervisorState(paths);
  if (options.disableActivation !== false) disableSharedBackendActivation("supervisor-stopped");
  launchctl(["bootout", `gui/${process.getuid()}`, paths.sharedBackendSupervisorPlist], true);
  return { stopped: true, activationDisabled: options.disableActivation !== false && state?.activationOwned === true };
}

export function uninstallSharedBackendSupervisor() {
  const paths = servicePaths();
  const stopped = stopSharedBackendSupervisor();
  rmSync(paths.sharedBackendSupervisorPlist, { force: true });
  rmSync(paths.sharedBackendSupervisorConfig, { force: true });
  rmSync(paths.sharedBackendSupervisorState, { force: true });
  rmSync(paths.sharedBackendDeploymentState, { force: true });
  return { ...stopped, removed: true, plist: paths.sharedBackendSupervisorPlist };
}

export function sharedBackendSupervisorStatus(options = {}) {
  const paths = options.paths || servicePaths();
  const runLaunchctl = options.launchctlImpl || launchctl;
  const output = runLaunchctl(["print", `gui/${process.getuid()}/${sharedBackendSupervisorLabel}`], true);
  const state = ownedSupervisorState(paths);
  const config = ownedSupervisorConfig(paths);
  const pid = Number(output.match(/\bpid = (\d+)/)?.[1] || 0) || null;
  const updatedAt = Date.parse(String(state?.updatedAt || ""));
  const fresh = Number.isFinite(updatedAt) && Date.now() - updatedAt < 45_000;
  const desiredBuildFingerprint = options.desiredBuildFingerprint || sharedBackendSupervisorBuildFingerprint();
  const currentInstance = Boolean(config?.instanceId && state?.instanceId === config.instanceId);
  const currentPid = Boolean(pid && state?.pid === pid);
  const installedDeployment = plistDeploymentFingerprint(
    paths.sharedBackendSupervisorPlist,
    "IMESSAGE_HANDOFF_SUPERVISOR_DEPLOYMENT_FINGERPRINT",
  );
  const currentDeployment = Boolean(config?.deploymentFingerprint
    && installedDeployment === config.deploymentFingerprint);
  const currentBuild = Boolean(config?.buildFingerprint
    && state?.buildFingerprint === config.buildFingerprint
    && config.buildFingerprint === desiredBuildFingerprint
    && currentDeployment);
  const jobRunning = /\bstate = running\b/.test(output);
  const running = jobRunning && currentInstance && currentPid && currentBuild && fresh;
  const rawHealthy = jobRunning && currentInstance && currentPid && fresh && state?.healthy === true;
  const activationEnabled = runLaunchctl(["getenv", localDaemonEnvironment], true).trim() === "1";
  return {
    installed: existsSync(paths.sharedBackendSupervisorPlist),
    running,
    jobRunning,
    healthy: running && state?.healthy === true,
    fresh,
    currentBuild,
    currentDeployment,
    installedDeployment,
    rawHealthy,
    desiredBuildFingerprint,
    pid,
    activationEnabled,
    state,
    config,
    logs: [paths.sharedBackendSupervisorStdoutLog, paths.sharedBackendSupervisorStderrLog],
  };
}

export function installService(options = {}) {
  if ((options.platform || process.platform) !== "darwin") throw new Error("Automatic service installation currently supports macOS only.");
  const paths = options.paths || servicePaths();
  const config = options.config || readConfig();
  const imsgProfile = config.imsg;
  if (!imsgProfile || imsgProfile.mode !== "helper") {
    throw new Error("The local service requires a verified split-user Messages helper configuration.");
  }
  const codexBackend = requireAppServerBackend(options.codexBackend || "app-server");
  if (codexBackend !== "app-server") {
    throw new Error("The split-user Messages helper requires the supervised shared Codex app-server.");
  }
  const supervisor = options.supervisor || sharedBackendSupervisorStatus({ paths, launchctlImpl: options.launchctlImpl });
  const desktop = options.desktop || (options.inspectDesktopImpl || inspectDesktopSharedConnection)();
  if (!supervisor.running || !supervisor.healthy || !supervisor.activationEnabled
    || supervisor.config?.activationRequested !== true || supervisor.config?.failOpenLatched === true
    || !desktop.shared) {
    throw new Error("The split-user Messages helper will not start until Codex Desktop and the service share the healthy supervised app-server.");
  }
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(paths.plist), { recursive: true });
  const deployment = prepareDeployment(paths, options);
  const codexBin = options.codexBin || resolveCodexBinary(options.env || process.env);
  const plist = renderLaunchAgent(paths, codexBin, {
    codexBackend,
    nodePath: deployment.nodePath,
    daemonPath: deployment.daemonPath,
    deploymentFingerprint: deployment.fingerprint,
  });
  preflightLaunchAgent(paths, plist, options);

  const runLaunchctl = options.launchctlImpl || launchctl;
  const existing = serviceRuntime(paths, runLaunchctl);
  const previousFingerprint = plistDeploymentFingerprint(paths.plist, "IMESSAGE_HANDOFF_SERVICE_DEPLOYMENT_FINGERPRINT");
  if (options.forceRestart !== true && existing.running && previousFingerprint === deployment.fingerprint) {
    return {
      installed: true,
      changed: false,
      plist: paths.plist,
      daemonPath: deployment.daemonPath,
      deployment: deployment.root,
      deploymentFingerprint: deployment.fingerprint,
      logs: [paths.stdoutLog, paths.stderrLog],
      codexBackend,
    };
  }
  const previous = {
    plist: snapshot(paths.plist),
    deploymentState: snapshot(paths.serviceDeploymentState),
    jobRunning: existing.jobRunning,
    ready: existing.running,
    deploymentFingerprint: previousFingerprint,
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
    if (previous.plist && previous.jobRunning) {
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
  return {
    installed: true,
    changed: true,
    plist: paths.plist,
    daemonPath: deployment.daemonPath,
    deployment: deployment.root,
    deploymentFingerprint: deployment.fingerprint,
    logs: [paths.stdoutLog, paths.stderrLog],
    codexBackend,
  };
}

export function stopService() {
  const paths = servicePaths();
  launchctl(["bootout", `gui/${process.getuid()}`, paths.plist], true);
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
  const output = launchctl(["print", `gui/${process.getuid()}/${label}`], true);
  const runtime = inspectServiceLaunchdReadiness(output, paths.serviceReadinessState);
  const sharedBackendSupervisor = sharedBackendSupervisorStatus();
  const deploymentFingerprint = plistDeploymentFingerprint(paths.plist, "IMESSAGE_HANDOFF_SERVICE_DEPLOYMENT_FINGERPRINT");
  const deploymentState = readDeploymentState(paths.serviceDeploymentState);
  return {
    installed: existsSync(paths.plist),
    running: runtime.running,
    jobRunning: runtime.jobRunning,
    pid: runtime.pid,
    readiness: runtime.readiness,
    logs: [paths.stdoutLog, paths.stderrLog],
    codexBackend: installedCodexBackend(paths),
    deployment: {
      fingerprint: deploymentFingerprint,
      active: Boolean(deploymentFingerprint && deploymentState?.activeFingerprint === deploymentFingerprint),
      previousFingerprint: deploymentState?.previousFingerprint || null,
    },
    sharedBackend: {
      running: sharedBackendSupervisor.healthy,
      binary: sharedBackendSupervisor.state?.binary || null,
      versions: null,
    },
    sharedBackendSupervisor,
  };
}
