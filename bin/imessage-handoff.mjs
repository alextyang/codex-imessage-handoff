#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { configureImsg, readConfig, transportStatus } from "../service/src/config.mjs";
import { installService, rotateServiceProcess, serviceStatus, stopService, uninstallService } from "../service/src/service-manager.mjs";
import { createImsgIpcClientFromConfig } from "../service/src/imsg-ipc-client.mjs";
import { finishSplitUserHelper } from "../service/src/split-user-controller.mjs";
import { requestHelperAccountHardening } from "../service/scripts/harden-split-user-helper.mjs";
import {
  RemoteControlController,
  normalizeManualPairingCode,
} from "../service/src/remote-control-controller.mjs";
import { ensureRemoteControlKeyHelper } from "../service/src/remote-control-key-helper.mjs";
import { authorizeRemoteControlAndActivate } from "../service/src/remote-control-setup.mjs";
import { servicePaths } from "../service/src/paths.mjs";

function arg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function requireRemoteControlAuthorization({ requirePaired = false } = {}) {
  ensureRemoteControlKeyHelper();
  const status = await new RemoteControlController().status({ network: requirePaired });
  if (status.enrolled !== true) {
    const code = typeof status.code === "string" ? status.code : "CODEX_REMOTE_ENROLLMENT_REQUIRED";
    throw Object.assign(
      new Error(`Codex Remote Control is not authorized (${code}). Run \`imessage-handoff remote-control authorize\` first.`),
      { code },
    );
  }
  if (requirePaired && status.paired !== true) {
    const code = typeof status.code === "string" ? status.code : "CODEX_REMOTE_PAIRING_REQUIRED";
    throw Object.assign(
      new Error(`Codex Remote Control is not paired (${code}). Get a code from Codex Desktop and run \`imessage-handoff remote-control pair <code>\`.`),
      { code },
    );
  }
  return status;
}

function hasVerifiedHelperConfig() {
  if (!existsSync(servicePaths().config)) return false;
  readConfig();
  return true;
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
    await requireRemoteControlAuthorization({ requirePaired: true });
    const finished = await finishSplitUserHelper({ dedicatedUser: dedicatedHelperUser() });
    const config = configureImsg({
      mode: "helper",
      clientConfig: finished.clientConfigPath,
      ...finished.profile,
    });
    installService();
    const runtime = serviceStatus();
    print({
      ok: true,
      active: true,
      transport: "imsg",
      mode: "helper",
      helperAuthenticated: true,
      advanced: finished.capabilities?.advanced === true,
      watchVerified: finished.watchVerified,
      serviceReady: runtime.running,
      ...transportStatus(config),
    });
    return;
  }
  throw new Error("Usage: imessage-handoff transport harden-helper|status|check|finish-helper [--helper-user=codex]");
}

async function handleRemoteControl(action, actionArgument = "") {
  ensureRemoteControlKeyHelper();
  const controller = new RemoteControlController();
  if (action === "status") {
    print({ ok: true, remoteControl: await controller.status({ network: true }) });
    return;
  }
  if (action === "authorize") {
    const { result, status, paired, configured, installed } = await authorizeRemoteControlAndActivate({
      controller,
      hasVerifiedHelperConfig,
      installService,
      rotateServiceProcess,
    });
    print({
      ok: true,
      remoteControl: {
        authorized: true,
        changed: result.changed,
        paired,
        pairingRequired: !paired,
        ...(paired || !status.code ? {} : { code: status.code }),
      },
      service: installed
        ? { installed: installed.installed, changed: installed.changed }
        : {
          installed: false,
          changed: false,
          ...(paired && !configured ? { configurationRequired: true } : { pairingRequired: true }),
        },
    });
    return;
  }
  if (action === "pair") {
    const pairingCode = normalizeManualPairingCode(actionArgument);
    const result = await controller.pairEnvironment(pairingCode);
    const installed = hasVerifiedHelperConfig()
      ? installService({ forceRestart: true })
      : null;
    print({
      ok: true,
      remoteControl: result,
      service: installed
        ? { installed: installed.installed, changed: installed.changed }
        : { installed: false, changed: false, configurationRequired: true },
    });
    return;
  }
  if (action === "deauthorize") {
    const stopped = stopService();
    const result = await controller.deauthorize();
    print({
      ok: true,
      remoteControl: result,
      service: { ...stopped, installed: false },
    });
    return;
  }
  throw new Error("Usage: imessage-handoff remote-control authorize|pair <8-character-code>|status|deauthorize");
}

async function main() {
  const codexHomeOverride = arg("codex-home");
  if (codexHomeOverride) process.env.CODEX_HOME = codexHomeOverride;
  const first = process.argv[2] || "install";
  if (first === "transport") {
    await handleTransport(process.argv[3] || "status");
    return;
  }
  if (first === "remote-control") {
    await handleRemoteControl(process.argv[3] || "status", process.argv[4] || "");
    return;
  }
  const action = first === "service" ? process.argv[3] || "status" : first;
  if (action === "install" || action === "start") {
    readConfig();
    await requireRemoteControlAuthorization();
    const installed = installService();
    print({ ok: true, ...installed, healthy: true });
    return;
  }
  if (action === "stop" || action === "pause") {
    print({ ok: true, ...stopService() });
    return;
  }
  if (action === "restart") {
    readConfig();
    await requireRemoteControlAuthorization();
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
  throw new Error("Usage: imessage-handoff [service] install|start|stop|restart|status|pause|run|uninstall | remote-control authorize|pair <8-character-code>|status|deauthorize | transport harden-helper|status|check|finish-helper");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
