import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DESKTOP_COMMAND = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const PRIVATE_APP_SERVER = "/Applications/ChatGPT.app/Contents/Resources/codex";
const MAX_LOG_PREFIX_BYTES = 512 * 1024;

function processRows(value) {
  return String(value || "").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function listProcesses(options) {
  if (Array.isArray(options.processes)) return options.processes;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  return processRows(execFileSyncImpl("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.commandTimeoutMs || 10_000,
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function collectLogs(directory, depth = 0, result = []) {
  if (depth > 5 || !existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectLogs(file, depth + 1, result);
    else if (entry.isFile() && entry.name.endsWith(".log")) result.push(file);
  }
  return result;
}

function readPrefix(file, limit = MAX_LOG_PREFIX_BYTES) {
  const descriptor = openSync(file, "r");
  try {
    const length = Math.min(limit, statSync(file).size);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function desktopLogsForPid(root, pid) {
  const marker = `-${pid}-t0-`;
  return collectLogs(root)
    .filter((file) => path.basename(file).includes(marker))
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.file);
}

function hasSuccessfulTransport(log, transport) {
  return String(log || "").split(/\r?\n/).some((line) => (
    line.includes("[AppServerConnection] initialize_handshake_result")
    && line.includes("outcome=success")
    && line.includes(`transportKind=${transport}`)
  ));
}

/**
 * Verify the connection selected by Codex Desktop itself. A daemon socket or
 * successful proxy probe is insufficient because Desktop can silently fall
 * back to its private stdio child. The Desktop startup log is authoritative;
 * the socket and process tree are independent corroboration.
 */
export function inspectDesktopSharedConnection(options = {}) {
  const processes = listProcesses(options);
  const desktop = processes
    .filter((entry) => entry.command === DESKTOP_COMMAND)
    .sort((left, right) => right.pid - left.pid)[0] || null;
  const socketPath = options.socketPath || path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
  const logRoot = options.logRoot || path.join(os.homedir(), "Library", "Logs", "com.openai.codex");

  if (!desktop) {
    return {
      shared: false,
      desktopRunning: false,
      desktopPid: null,
      socketPresent: existsSync(socketPath),
      websocketHandshake: false,
      privateAppServerChild: false,
      logFile: null,
    };
  }

  const privateAppServerChild = processes.some((entry) => (
    entry.ppid === desktop.pid
    && entry.command.startsWith(PRIVATE_APP_SERVER)
    && /(?:^|\s)app-server(?:\s|$)/.test(entry.command)
  ));
  const handshake = desktopLogsForPid(logRoot, desktop.pid).map((file) => {
    const log = readPrefix(file);
    return {
      file,
      websocket: hasSuccessfulTransport(log, "websocket"),
      stdio: hasSuccessfulTransport(log, "stdio"),
    };
  }).find((entry) => entry.websocket || entry.stdio) || null;
  const logFile = handshake?.file || null;
  const websocketHandshake = Boolean(handshake?.websocket);
  const stdioHandshake = Boolean(handshake?.stdio);
  const socketPresent = existsSync(socketPath);

  return {
    shared: socketPresent && websocketHandshake && !privateAppServerChild,
    desktopRunning: true,
    desktopPid: desktop.pid,
    socketPresent,
    websocketHandshake,
    stdioHandshake,
    privateAppServerChild,
    logFile,
  };
}

export const desktopConnectionValues = Object.freeze({
  desktopCommand: DESKTOP_COMMAND,
  privateAppServerCommand: PRIVATE_APP_SERVER,
});
