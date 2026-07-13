#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { configureImsg, readConfig, transportStatus } from "../service/src/config.mjs";
import { disableSharedBackendActivation, installService, installSharedBackendSupervisor, requestSharedBackendActivation, serviceStatus, sharedBackendSupervisorStatus, stopService, uninstallService, uninstallSharedBackendSupervisor } from "../service/src/service-manager.mjs";
import { loadClaimedJobs } from "../service/src/claimed-store.mjs";
import { inspectDesktopSharedConnection } from "../service/src/desktop-connection.mjs";
import { createImsgIpcClientFromConfig } from "../service/src/imsg-ipc-client.mjs";
import { finishSplitUserHelper } from "../service/src/split-user-controller.mjs";
import { requestHelperAccountHardening } from "../service/scripts/harden-split-user-helper.mjs";

function arg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function dedicatedHelperUser() {
  const username = arg("helper-user") || "codex";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(username)) throw new Error("The dedicated Messages macOS username is invalid.");
  const uid = Number.parseInt(execFileSync("/usr/bin/id", ["-u", username], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim(), 10);
  const record = execFileSync("/usr/bin/dscl", [".", "-read", `/Users/${username}`, "NFSHomeDirectory"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  const home = arg("helper-home") || record.match(/NFSHomeDirectory:\s*(.+?)\s*$/m)?.[1]?.trim();
  if (!Number.isSafeInteger(uid) || uid < 0 || !home?.startsWith("/")) {
    throw new Error("The dedicated Messages macOS account could not be resolved.");
  }
  return { uid, username, home };
}

async function inspectConfiguredHelper(profile) {
  const runtime = serviceStatus();
  const liveServiceProof = runtime.jobRunning === true
    && runtime.running === true
    && runtime.readiness?.pidMatches === true
    && runtime.readiness?.fresh === true
    && runtime.readiness?.healthHealthy === true
    && runtime.readiness?.health?.activeWatch === true
    && runtime.readiness?.health?.mode === "helper";
  if (liveServiceProof) {
    // The helper permits exactly one authenticated controller. A ready daemon
    // has already authenticated the pinned profile, required every advanced
    // capability, and established the live watch, so a second diagnostic
    // connection would only contend with the service it is trying to verify.
    return {
      serviceRunning: true,
      serviceReady: true,
      activeWatch: true,
      helperAuthenticated: true,
      bridgeAvailable: true,
      watchReady: true,
      richText: true,
      replies: true,
      polls: true,
      chatAccess: true,
      verification: "active-service",
    };
  }
  const client = createImsgIpcClientFromConfig(profile.clientConfig);
  try {
    await client.connect();
    const helper = await client.helperStatus();
    if (Number(helper.profile?.chatId) !== Number(profile.chatId)
      || helper.profile?.chatGuid !== profile.chatGuid
      || helper.profile?.expectedSender !== profile.expectedSender
      || helper.settings?.featureMode !== profile.featureMode
      || helper.settings?.presentation !== profile.presentation
      || helper.settings?.polls !== profile.polls
      || helper.settings?.reactions !== profile.reactions) {
      throw new Error("The authenticated Messages helper profile no longer matches the service configuration.");
    }
    const status = await client.status({ refresh: true });
    const inspected = {
      serviceRunning: runtime.jobRunning === true,
      serviceReady: runtime.running === true,
      activeWatch: runtime.readiness?.health?.activeWatch === true,
      helperAuthenticated: true,
      bridgeAvailable: status.advanced === true,
      watchReady: status.capabilities?.watch === true,
      richText: status.capabilities?.richText === true,
      replies: status.capabilities?.replies === true,
      polls: status.capabilities?.polls === true,
      chatAccess: true,
      verification: "direct-helper",
    };
    if (!inspected.bridgeAvailable || !inspected.watchReady || !inspected.richText || !inspected.replies || !inspected.polls) {
      throw new Error("The local Messages helper is authenticated but its full bridge capabilities are unavailable.");
    }
    return inspected;
  } finally {
    await client.close().catch(() => {});
  }
}

async function handleTransport(action) {
  if (action === "harden-helper") {
    const stopped = stopService();
    const hardened = requestHelperAccountHardening({ helperUser: arg("helper-user") || "codex" });
    print({ ok: true, ...stopped, ...hardened, next: "Log out of and back into the dedicated Messages account before continuing setup." });
    return;
  }
  if (action === "status") {
    print({ ok: true, ...transportStatus() });
    return;
  }
  if (action === "check") {
    const config = readConfig();
    print({ ok: true, transport: "imsg", mode: "helper", ...(await inspectConfiguredHelper(config.imsg)) });
    return;
  }
  if (action === "finish-helper") {
    const desktop = inspectDesktopSharedConnection();
    const supervisor = sharedBackendSupervisorStatus();
    if (!desktop.shared || !supervisor.running || !supervisor.healthy || !supervisor.activationReady) {
      throw new Error("Codex Desktop must be connected to the healthy supervised shared app-server before enabling the split-user Messages helper.");
    }
    const finished = await finishSplitUserHelper({ dedicatedUser: dedicatedHelperUser() });
    const config = configureImsg({
      mode: "helper",
      clientConfig: finished.clientConfigPath,
      ...finished.profile,
    });
    const installed = installService({ codexBackend: "app-server" });
    const runtime = serviceStatus();
    print({
      ok: true,
      active: true,
      transport: "imsg",
      mode: "helper",
      helperAuthenticated: true,
      advanced: finished.capabilities?.advanced === true,
      watchVerified: finished.watchVerified,
      sharedCodexBackend: installed.codexBackend === "app-server",
      serviceReady: runtime.running,
      ...transportStatus(config),
    });
    return;
  }
  throw new Error("Usage: imessage-handoff transport harden-helper|status|check|finish-helper [--helper-user=codex]");
}

function requireIdleMessagingService() {
  const active = loadClaimedJobs().filter((job) => job.state === "running" || job.state === "delivering");
  if (active.length) throw new Error("The iMessage service still has active work. Wait for it to finish before switching the Codex Desktop backend.");
}

async function handleDesktopSync(action) {
  if (action === "status") {
    const supervisor = sharedBackendSupervisorStatus();
    print({
      ok: true,
      prepared: supervisor.healthy,
      daemonRunning: supervisor.healthy,
      proxyReady: supervisor.healthy,
      activation: {
        requested: supervisor.config?.activationRequested === true,
        enabled: supervisor.activationEnabled,
        owned: supervisor.activationOwned,
        conflict: supervisor.activationConflict,
        ready: supervisor.activationReady,
        failOpenLatched: supervisor.config?.failOpenLatched === true,
      },
      service: serviceStatus(),
      supervisor,
      desktop: inspectDesktopSharedConnection(),
    });
    return;
  }
  if (action === "prepare") {
    const installed = installSharedBackendSupervisor();
    const supervisor = sharedBackendSupervisorStatus();
    if (!supervisor.running || !supervisor.healthy) {
      throw new Error("The shared app-server supervisor did not become healthy; Codex Desktop was left on its current backend.");
    }
    print({
      ok: true,
      prepared: true,
      daemonRunning: true,
      proxyReady: true,
      desktopChanged: false,
      serviceChanged: false,
      supervisor: { ...installed, status: supervisor },
      next: "Run `desktop-sync activate` after current iMessage work is idle.",
    });
    return;
  }
  if (action === "activate") {
    requireIdleMessagingService();
    const supervisor = sharedBackendSupervisorStatus();
    if (!supervisor.running || !supervisor.healthy) {
      throw new Error("The shared app-server supervisor is not healthy. Run `desktop-sync prepare` and try again.");
    }
    const stopped = stopService();
    try {
      requestSharedBackendActivation();
      let activated = sharedBackendSupervisorStatus();
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (activated.running && activated.healthy && activated.activationReady) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        activated = sharedBackendSupervisorStatus();
      }
      if (!activated.activationReady) {
        disableSharedBackendActivation("activation-timeout");
        throw new Error("Shared mode did not pass its activation soak.");
      }
      print({ ok: true, enabled: true, supervised: true, ...stopped, supervisor: activated, next: "Quit and reopen Codex Desktop once, then run `desktop-sync finish`." });
    } catch (error) {
      disableSharedBackendActivation("activation-failed");
      throw error;
    }
    return;
  }
  if (action === "finish") {
    requireIdleMessagingService();
    const desktop = inspectDesktopSharedConnection();
    if (!desktop.shared) throw new Error("Codex Desktop is not connected to the managed shared server yet. Quit and reopen Codex, then try again.");
    const supervisor = sharedBackendSupervisorStatus();
    if (
      !supervisor.running
      || !supervisor.healthy
      || !supervisor.activationReady
    ) {
      throw new Error("The shared app-server supervisor is not healthy; the iMessage service remains stopped.");
    }
    const installed = installService({ codexBackend: "app-server" });
    print({ ok: true, active: true, supervised: true, ...installed, desktop: { shared: true, pid: desktop.desktopPid }, supervisor });
    return;
  }
  if (action === "rollback") {
    requireIdleMessagingService();
    const stopped = uninstallService();
    const rollback = disableSharedBackendActivation("rollback");
    print({
      ok: true,
      ...stopped,
      rollback,
      desktopRestartRequired: true,
      next: "Quit and reopen Codex Desktop, then run `desktop-sync finish-rollback`.",
    });
    return;
  }
  if (action === "finish-rollback") {
    requireIdleMessagingService();
    const desktop = inspectDesktopSharedConnection();
    if (!desktop.desktopRunning || !desktop.stdioHandshake || !desktop.privateAppServerChild) {
      throw new Error("Codex Desktop is not verified back on its private stdio server yet. Quit and reopen Codex, then try again.");
    }
    const supervisor = uninstallSharedBackendSupervisor();
    const service = uninstallService();
    print({ ok: true, service, supervisor, desktop: { shared: false, pid: desktop.desktopPid }, rollbackComplete: true });
    return;
  }
  throw new Error("Usage: imessage-handoff desktop-sync prepare|status|activate|finish|rollback|finish-rollback");
}

async function main() {
  const codexHomeOverride = arg("codex-home");
  if (codexHomeOverride) process.env.CODEX_HOME = codexHomeOverride;
  const first = process.argv[2] || "install";
  if (first === "transport") {
    await handleTransport(process.argv[3] || "status");
    return;
  }
  if (first === "desktop-sync") {
    await handleDesktopSync(process.argv[3] || "status");
    return;
  }
  const action = first === "service" ? process.argv[3] || "status" : first;
  if (action === "install" || action === "start") {
    readConfig();
    const installed = installService();
    print({ ok: true, ...installed, healthy: true });
    return;
  }
  if (action === "stop" || action === "pause") {
    print({ ok: true, ...stopService() });
    return;
  }
  if (action === "restart") {
    const installed = installService({ forceRestart: true });
    print({ ok: true, ...installed, healthy: true });
    return;
  }
  if (action === "status") {
    print({ ok: true, ...serviceStatus() });
    return;
  }
  if (action === "uninstall") {
    const removed = codexHomeOverride ? { removed: false } : uninstallService();
    print({ ok: true, ...removed });
    return;
  }
  if (action === "run") {
    readConfig();
    const child = spawn(process.execPath, ["--experimental-strip-types", new URL("../service/src/daemon.mjs", import.meta.url).pathname], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  throw new Error("Usage: imessage-handoff [service] install|start|stop|restart|status|pause|run|uninstall | desktop-sync prepare|status|activate|finish|rollback|finish-rollback | transport harden-helper|status|check|finish-helper");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
