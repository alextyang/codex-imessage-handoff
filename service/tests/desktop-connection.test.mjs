import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopConnectionValues, inspectDesktopSharedConnection } from "../src/desktop-connection.mjs";

function fixture(transport, { privateChild = false, socket = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-desktop-connection-"));
  const logRoot = path.join(root, "logs", "2026", "07", "12");
  const socketPath = path.join(root, "app-server-control.sock");
  mkdirSync(logRoot, { recursive: true });
  if (socket) writeFileSync(socketPath, "socket placeholder");
  const pid = 4242;
  writeFileSync(path.join(logRoot, `codex-desktop-test-${pid}-t0-i1-000001-0.log`), [
    "info [AppServerConnection] Starting app-server connection hostId=local",
    `info [AppServerConnection] initialize_handshake_result durationMs=10 outcome=success transportKind=${transport}`,
  ].join("\n"));
  const processes = [
    { pid, ppid: 1, command: desktopConnectionValues.desktopCommand },
    ...(privateChild ? [{
      pid: 4243,
      ppid: pid,
      command: `${desktopConnectionValues.privateAppServerCommand} app-server --analytics-default-enabled`,
    }] : []),
  ];
  return { logRoot: path.join(root, "logs"), socketPath, processes };
}

test("verifies a Desktop websocket connection with no private app-server child", () => {
  const status = inspectDesktopSharedConnection(fixture("websocket"));
  assert.equal(status.shared, true);
  assert.equal(status.websocketHandshake, true);
  assert.equal(status.privateAppServerChild, false);
});

test("rejects the current private stdio Desktop process", () => {
  const status = inspectDesktopSharedConnection(fixture("stdio", { privateChild: true }));
  assert.equal(status.shared, false);
  assert.equal(status.stdioHandshake, true);
  assert.equal(status.privateAppServerChild, true);
});

test("requires the managed socket even after a websocket handshake", () => {
  const status = inspectDesktopSharedConnection(fixture("websocket", { socket: false }));
  assert.equal(status.shared, false);
  assert.equal(status.socketPresent, false);
});
