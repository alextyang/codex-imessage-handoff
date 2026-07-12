#!/usr/bin/env node
import { spawn } from "node:child_process";
import { configureRelay, importLegacyConfig, readConfig } from "../service/src/config.mjs";
import { installService, removeLegacyHook, serviceStatus, stopService, uninstallService } from "../service/src/service-manager.mjs";
import { RelayClient } from "../service/src/relay-client.mjs";

function arg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function ensureConfig() {
  if (importLegacyConfig()) return readConfig();
  const relay = arg("relay");
  if (!relay) throw new Error("No existing relay config found. Pass --relay=https://your-relay when installing.");
  return configureRelay(relay);
}

async function main() {
  const codexHomeOverride = arg("codex-home");
  if (codexHomeOverride) process.env.CODEX_HOME = codexHomeOverride;
  const first = process.argv[2] || "install";
  const action = first === "service" ? process.argv[3] || "status" : first;
  if (action === "install" || action === "start") {
    const config = await ensureConfig();
    const relay = new RelayClient(config);
    const installStartedAt = Date.now();
    const installed = installService();
    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const status = await relay.serviceStatus();
        const lastSeenAt = Date.parse(String(status.lastSeenAt || ""));
        if (
          status.connected
          && status.clientId === config.clientId
          && Number.isFinite(lastSeenAt)
          && lastSeenAt >= installStartedAt - 1000
        ) { healthy = true; break; }
      } catch {
        // The daemon may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const hooksRemoved = healthy ? removeLegacyHook() : 0;
    if (!healthy) throw new Error("The service did not become healthy; the existing Stop hook was preserved.");
    print({ ok: true, ...installed, healthy, hooksRemoved });
    return;
  }
  if (action === "stop" || action === "pause") {
    print({ ok: true, ...stopService() });
    return;
  }
  if (action === "restart") {
    stopService();
    print({ ok: true, ...installService() });
    return;
  }
  if (action === "status") {
    print({ ok: true, ...serviceStatus() });
    return;
  }
  if (action === "uninstall") {
    const removed = codexHomeOverride ? { removed: false } : uninstallService();
    let relayDeregistered = false;
    try {
      const relay = new RelayClient(readConfig());
      await relay.unregister();
      relayDeregistered = true;
    } catch {
      // Local uninstall must remain possible while offline. Re-running
      // uninstall after connectivity returns completes relay cleanup.
    }
    const hooksRemoved = removeLegacyHook();
    print({ ok: true, ...removed, relayDeregistered, hooksRemoved });
    return;
  }
  if (action === "run") {
    await ensureConfig();
    const child = spawn(process.execPath, [new URL("../service/src/daemon.mjs", import.meta.url).pathname], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  throw new Error("Usage: imessage-handoff [service] install|start|stop|restart|status|pause|run|uninstall [--relay=https://...]");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
