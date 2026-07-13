import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const supervisor = fileURLToPath(new URL("../src/shared-backend-supervisor.mjs", import.meta.url));
const wsModule = import.meta.resolve("ws");
const buildFingerprint = "a".repeat(64);

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error("condition did not become true");
}

function fixture() {
  const root = mkdtempSync("/tmp/imsg-sup-");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const serviceHome = path.join(codexHome, "imessage-handoff");
  const instanceId = "lifecycle-test-instance";
  const configFile = path.join(serviceHome, "shared-backend-supervisor-config.json");
  const stateFile = path.join(serviceHome, "shared-backend-supervisor-state.json");
  const launchState = path.join(root, "launch-env");
  const fakeLaunchctl = path.join(root, "launchctl");
  const fakePs = path.join(root, "ps");
  const fakeCodex = path.join(root, "codex");
  mkdirSync(serviceHome, { recursive: true });
  writeFileSync(fakeLaunchctl, `#!/bin/sh
case "$1" in
  getenv) test -f "$FAKE_LAUNCHCTL_STATE" && cat "$FAKE_LAUNCHCTL_STATE" || exit 1 ;;
  setenv) printf '%s' "$3" > "$FAKE_LAUNCHCTL_STATE" ;;
  unsetenv) rm -f "$FAKE_LAUNCHCTL_STATE" ;;
  *) exit 2 ;;
esac
`, "utf8");
  chmodSync(fakeLaunchctl, 0o700);
  // Keep this lifecycle fixture independent of a real Codex Desktop session
  // running on the test Mac. The supervisor must see its fake backend, but no
  // external Desktop client that would correctly trigger preserve/fail-open.
  writeFileSync(fakePs, `#!/bin/sh
if test -n "$FAKE_EXTERNAL_PID" && /bin/kill -0 "$FAKE_EXTERNAL_PID" 2>/dev/null; then
  printf '%s %s app-server --listen unix://\\n' "$FAKE_EXTERNAL_PID" "$FAKE_EXTERNAL_BINARY"
fi
/bin/ps "$@" | /usr/bin/grep -v '^ *[0-9][0-9]* .*\/Applications\/ChatGPT.app\/Contents\/MacOS\/ChatGPT$'
`, "utf8");
  chmodSync(fakePs, 0o700);
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from ${JSON.stringify(wsModule)};
const socketPath = path.join(process.env.CODEX_HOME, "app-server-control", "app-server-control.sock");
mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
rmSync(socketPath, { force: true });
let wedged = false;
const server = http.createServer();
const webSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client)));
webSockets.on("connection", (client) => client.on("message", (raw) => {
  if (wedged) return;
  const message = JSON.parse(String(raw));
  if (message.method === "initialize") client.send(JSON.stringify({ id: message.id, result: { codexHome: process.env.CODEX_HOME, userAgent: "fake", platformFamily: "unix", platformOs: "macos" } }));
}));
process.on("SIGUSR1", () => { wedged = true; });
process.on("SIGTERM", () => {
  for (const client of webSockets.clients) client.terminate();
  server.close(() => { rmSync(socketPath, { force: true }); process.exit(0); });
  setTimeout(() => process.exit(0), 250).unref();
});
server.listen(socketPath, () => process.stdout.write("ready\\n"));
`, "utf8");
  chmodSync(fakeCodex, 0o700);
  writeJson(configFile, {
    schemaVersion: 1,
    owner: "codex-imessage-handoff",
    instanceId,
    implementationVersion: 7,
    buildFingerprint,
    activationRequested: false,
    failOpenLatched: false,
  });
  return { root, home, codexHome, serviceHome, instanceId, configFile, stateFile, launchState, fakeLaunchctl, fakeCodex };
}

test("supervisor separates preparation from activation and latches a wedged-server failure", async (t) => {
  const run = fixture();
  const child = spawn(process.execPath, ["--experimental-strip-types", supervisor], {
    env: {
      ...process.env,
      PATH: `${run.root}:${process.env.PATH || ""}`,
      HOME: run.home,
      CODEX_HOME: run.codexHome,
      IMESSAGE_HANDOFF_HOME: run.serviceHome,
      CODEX_BIN: run.fakeCodex,
      IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE: run.instanceId,
      IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT: buildFingerprint,
      IMESSAGE_HANDOFF_LAUNCHCTL_BIN: run.fakeLaunchctl,
      FAKE_LAUNCHCTL_STATE: run.launchState,
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_PROBE_MS: "25",
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_TIMEOUT_MS: "2000",
      IMESSAGE_HANDOFF_SUPERVISOR_HEALTH_INTERVAL_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_PROBE_TIMEOUT_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_ACTIVATION_SOAK_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
  child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const prepared = await waitFor(() => {
    const state = readJson(run.stateFile);
    return state.healthy === true ? state : null;
  });
  assert.equal(prepared.phase, "healthy-standby", diagnostics);
  assert.equal(existsSync(run.launchState), false, diagnostics);

  writeJson(run.configFile, {
    ...readJson(run.configFile),
    activationRequested: true,
    failOpenLatched: false,
  });
  await waitFor(() => {
    if (!existsSync(run.launchState) || readFileSync(run.launchState, "utf8") !== "1") return null;
    return readJson(run.stateFile).activationOwned === true;
  });
  const activated = readJson(run.stateFile);
  assert.equal(activated.activationOwned, true, diagnostics);

  const originalBackendPid = activated.childPid;
  process.kill(originalBackendPid, "SIGUSR1");
  await waitFor(() => {
    const config = readJson(run.configFile);
    return config.failOpenLatched === true && !existsSync(run.launchState) ? config : null;
  }, 8_000);
  assert.equal(readJson(run.configFile).activationRequested, false, diagnostics);
  await waitFor(() => {
    const state = readJson(run.stateFile);
    return state.healthy === true && state.childPid !== originalBackendPid ? state : null;
  }, 8_000);
});

test("a spawn error schedules recovery instead of wedging the supervisor", async (t) => {
  const run = fixture();
  rmSync(run.fakeCodex);
  const child = spawn(process.execPath, ["--experimental-strip-types", supervisor], {
    env: {
      ...process.env,
      PATH: `${run.root}:${process.env.PATH || ""}`,
      HOME: run.home,
      CODEX_HOME: run.codexHome,
      IMESSAGE_HANDOFF_HOME: run.serviceHome,
      CODEX_BIN: run.fakeCodex,
      IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE: run.instanceId,
      IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT: buildFingerprint,
      IMESSAGE_HANDOFF_LAUNCHCTL_BIN: run.fakeLaunchctl,
      FAKE_LAUNCHCTL_STATE: run.launchState,
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_PROBE_MS: "25",
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_TIMEOUT_MS: "500",
      IMESSAGE_HANDOFF_SUPERVISOR_HEALTH_INTERVAL_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_PROBE_TIMEOUT_MS: "100",
    },
    stdio: "ignore",
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const state = await waitFor(() => {
    if (!existsSync(run.stateFile)) return null;
    const value = readJson(run.stateFile);
    return value.consecutiveFailures > 0 && value.nextRestartAt ? value : null;
  });
  assert.equal(state.healthy, false);
  assert.equal(child.exitCode, null);
  assert.equal(existsSync(run.launchState), false);
});

test("a healthy external app server is adopted and continuously supervised", async (t) => {
  const run = fixture();
  const external = spawn(run.fakeCodex, ["app-server", "--listen", "unix://"], {
    env: { ...process.env, CODEX_HOME: run.codexHome },
    stdio: "ignore",
  });
  t.after(() => { if (external.exitCode === null) external.kill("SIGTERM"); });
  await waitFor(() => existsSync(path.join(run.codexHome, "app-server-control", "app-server-control.sock")));

  const supervisorProcess = spawn(process.execPath, ["--experimental-strip-types", supervisor], {
    env: {
      ...process.env,
      PATH: `${run.root}:${process.env.PATH || ""}`,
      HOME: run.home,
      CODEX_HOME: run.codexHome,
      IMESSAGE_HANDOFF_HOME: run.serviceHome,
      CODEX_BIN: run.fakeCodex,
      IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE: run.instanceId,
      IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT: buildFingerprint,
      IMESSAGE_HANDOFF_LAUNCHCTL_BIN: run.fakeLaunchctl,
      FAKE_LAUNCHCTL_STATE: run.launchState,
      FAKE_EXTERNAL_PID: String(external.pid),
      FAKE_EXTERNAL_BINARY: run.fakeCodex,
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_PROBE_MS: "25",
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_TIMEOUT_MS: "2000",
      IMESSAGE_HANDOFF_SUPERVISOR_HEALTH_INTERVAL_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_PROBE_TIMEOUT_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_ACTIVATION_SOAK_MS: "200",
    },
    stdio: "ignore",
  });
  t.after(() => { if (supervisorProcess.exitCode === null) supervisorProcess.kill("SIGTERM"); });

  const adopted = await waitFor(() => {
    if (!existsSync(run.stateFile)) return null;
    const state = readJson(run.stateFile);
    return state.healthy === true && state.childPid === external.pid ? state : null;
  }, 8_000);
  assert.equal(adopted.phase, "healthy-standby");

  external.kill("SIGKILL");
  await waitFor(() => external.exitCode !== null || external.signalCode !== null);
  await waitFor(() => {
    const state = readJson(run.stateFile);
    return state.healthy === true && Number.isSafeInteger(state.childPid) && state.childPid !== external.pid
      ? state
      : null;
  }, 8_000);
});

test("an activated child exit immediately protects future Desktop launches and self-recovers", async (t) => {
  const run = fixture();
  writeJson(run.configFile, { ...readJson(run.configFile), activationRequested: true });
  const supervisorProcess = spawn(process.execPath, ["--experimental-strip-types", supervisor], {
    env: {
      ...process.env,
      PATH: `${run.root}:${process.env.PATH || ""}`,
      HOME: run.home,
      CODEX_HOME: run.codexHome,
      IMESSAGE_HANDOFF_HOME: run.serviceHome,
      CODEX_BIN: run.fakeCodex,
      IMESSAGE_HANDOFF_SUPERVISOR_INSTANCE: run.instanceId,
      IMESSAGE_HANDOFF_SUPERVISOR_BUILD_FINGERPRINT: buildFingerprint,
      IMESSAGE_HANDOFF_LAUNCHCTL_BIN: run.fakeLaunchctl,
      FAKE_LAUNCHCTL_STATE: run.launchState,
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_PROBE_MS: "25",
      IMESSAGE_HANDOFF_SUPERVISOR_STARTUP_TIMEOUT_MS: "2000",
      IMESSAGE_HANDOFF_SUPERVISOR_HEALTH_INTERVAL_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_PROBE_TIMEOUT_MS: "100",
      IMESSAGE_HANDOFF_SUPERVISOR_ACTIVATION_SOAK_MS: "200",
    },
    stdio: "ignore",
  });
  t.after(() => { if (supervisorProcess.exitCode === null) supervisorProcess.kill("SIGTERM"); });
  const activated = await waitFor(() => {
    if (!existsSync(run.stateFile) || !existsSync(run.launchState)) return null;
    const state = readJson(run.stateFile);
    return state.activationOwned === true && state.healthy === true ? state : null;
  }, 8_000);
  const originalPid = activated.childPid;
  process.kill(originalPid, "SIGKILL");
  const protectedState = await waitFor(() => {
    const state = readJson(run.stateFile);
    return state.routingProtectionReason === "app-server-child-exited" && !existsSync(run.launchState) ? state : null;
  }, 3_000);
  assert.equal(protectedState.activationOwned, false);
  assert.equal(readJson(run.configFile).activationRequested, true);
  assert.equal(readJson(run.configFile).failOpenLatched, false);
  await waitFor(() => {
    if (!existsSync(run.launchState)) return null;
    const state = readJson(run.stateFile);
    return state.healthy === true && state.activationOwned === true && state.childPid !== originalPid ? state : null;
  }, 8_000);
});
