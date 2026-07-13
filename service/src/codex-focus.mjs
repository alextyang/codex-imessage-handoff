import { execFile as nodeExecFile } from "node:child_process";
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_BUNDLE_ID = "com.openai.codex";
const OWNER_SYNC_MARKER = "IAB_LIFECYCLE received browser sidebar owner sync";
const OWNER_ROUTE_PATTERN = /(?:^|\s)ownerRoutePath=(\/\S*)/;
const LOCAL_THREAD_PATTERN = /^\/local\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const DESKTOP_LOG_PATTERN_PREFIX = "codex-desktop-";
const DEFAULT_CACHE_TTL_MS = 750;
const DEFAULT_COMMAND_TIMEOUT_MS = 750;
const DEFAULT_LOG_SCAN_BYTES = 32 * 1024 * 1024;
const DEFAULT_INCREMENTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LOG_FILES = 32;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 10_000;
const DEFAULT_MAX_DIRECTORY_DEPTH = 6;
const LOG_LAUNCH_SLOP_MS = 2 * 60 * 1000;
const APPEND_OVERLAP_BYTES = 512;
const FRONTMOST_SCRIPT = String.raw`ObjC.import("AppKit"); const app=$.NSWorkspace.sharedWorkspace.frontmostApplication; const launchDate=app&&app.launchDate; JSON.stringify({bundleId:app&&app.bundleIdentifier?ObjC.unwrap(app.bundleIdentifier):null,pid:app?Number(app.processIdentifier):null,launchedAtMs:launchDate?Number(launchDate.timeIntervalSince1970)*1000:null})`;

function unknownStatus(observedAtMs, frontmost = null) {
  return Object.freeze({
    observedAtMs,
    focusKnown: false,
    appFocused: false,
    frontmostBundleId: frontmost?.bundleId ?? null,
    frontmostPid: frontmost?.pid ?? null,
    routeKnown: false,
    openThreadId: null,
  });
}

function execFilePromise(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    };
    try {
      execFileImpl(file, args, options, finish);
    } catch (error) {
      finish(error, "", "");
    }
  });
}

function normalizeFrontmost(value) {
  if (!value || typeof value !== "object") return null;
  const bundleId = typeof value.bundleId === "string" ? value.bundleId.trim() : "";
  const pid = Number(value.pid);
  const launchedAtMs = Number(value.launchedAtMs);
  if (!bundleId || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    bundleId,
    pid,
    launchedAtMs: Number.isFinite(launchedAtMs) && launchedAtMs > 0
      ? Math.floor(launchedAtMs)
      : null,
  };
}

/**
 * Read the foreground macOS application without Accessibility or Automation
 * access. The subprocess has both a time limit and a small output limit.
 */
export async function observeFrontmostApplication(options = {}) {
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS);
  const result = await execFilePromise(execFileImpl, options.osascriptPath || "/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    FRONTMOST_SCRIPT,
  ], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
  return normalizeFrontmost(parsed);
}

function routeFromText(text, { startsMidLine = false } = {}) {
  let input = String(text || "");
  if (startsMidLine) {
    const newline = input.indexOf("\n");
    if (newline === -1) return null;
    input = input.slice(newline + 1);
  }
  let newest = null;
  for (const line of input.split(/\r?\n/)) {
    if (!line.includes(OWNER_SYNC_MARKER)) continue;
    const match = line.match(OWNER_ROUTE_PATTERN);
    if (match) newest = match[1];
  }
  return newest;
}

function threadFromRoute(routePath) {
  if (typeof routePath !== "string") return null;
  const match = routePath.match(LOCAL_THREAD_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function readSlice(file, start, length) {
  if (length <= 0) return "";
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(descriptor, buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function walkLogFiles(root, pid, options = {}) {
  const maxEntries = options.maxDirectoryEntries || DEFAULT_MAX_DIRECTORY_ENTRIES;
  const maxDepth = options.maxDirectoryDepth || DEFAULT_MAX_DIRECTORY_DEPTH;
  const expectedPid = `-${pid}-t0-`;
  const stack = [{ directory: root, depth: 0 }];
  const files = [];
  let entriesSeen = 0;

  try {
    while (stack.length) {
      const current = stack.pop();
      const entries = readdirSync(current.directory, { withFileTypes: true });
      for (const entry of entries) {
        entriesSeen += 1;
        if (entriesSeen > maxEntries) return { complete: false, files: [] };
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < maxDepth) stack.push({ directory: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()
          || !entry.name.startsWith(DESKTOP_LOG_PATTERN_PREFIX)
          || !entry.name.includes(expectedPid)
          || !entry.name.endsWith(".log")) continue;
        const stat = statSync(entryPath);
        files.push({
          path: entryPath,
          ino: String(stat.ino),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  } catch {
    return { complete: false, files: [] };
  }

  return { complete: true, files };
}

function candidateLogs(root, frontmost, options = {}) {
  const discovered = walkLogFiles(root, frontmost.pid, options);
  if (!discovered.complete) return discovered;
  const earliestMtime = frontmost.launchedAtMs == null
    ? -Infinity
    : frontmost.launchedAtMs - LOG_LAUNCH_SLOP_MS;
  const files = discovered.files
    .filter((entry) => entry.mtimeMs >= earliestMtime)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path))
    .slice(0, options.maxLogFiles || DEFAULT_MAX_LOG_FILES);
  return { complete: true, files };
}

function snapshots(files) {
  return new Map(files.map((file) => [file.path, {
    ino: file.ino,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }]));
}

function routeStateKey(frontmost) {
  return `${frontmost.pid}:${frontmost.launchedAtMs ?? "unknown"}`;
}

function initialRouteState(key, files, maxBytes) {
  let remaining = maxBytes;
  let routePath = null;
  let routeKnown = false;

  for (const file of files) {
    if (remaining <= 0) break;
    const bytes = Math.min(file.size, remaining);
    const start = Math.max(0, file.size - bytes);
    const route = routeFromText(readSlice(file.path, start, bytes), { startsMidLine: start > 0 });
    remaining -= bytes;
    if (route !== null) {
      routePath = route;
      routeKnown = true;
      break;
    }
    // An unread prefix may contain a newer route than anything in an older
    // rotated file. Do not use stale evidence in that case.
    if (start > 0) break;
  }

  return {
    key,
    files: snapshots(files),
    routeKnown,
    routePath,
  };
}

function updatedRouteState(previous, key, files, maxIncrementalBytes, maxScanBytes) {
  let remaining = maxIncrementalBytes;
  let routeKnown = previous.routeKnown;
  let routePath = previous.routePath;

  for (const file of [...files].reverse()) {
    const prior = previous.files.get(file.path);
    if (!prior) {
      if (file.size > remaining) return initialRouteState(key, files, maxScanBytes);
      const route = routeFromText(readSlice(file.path, 0, file.size));
      remaining -= file.size;
      if (route !== null) {
        routeKnown = true;
        routePath = route;
      }
      continue;
    }
    if (prior.ino !== file.ino || file.size < prior.size) {
      return initialRouteState(key, files, maxScanBytes);
    }
    const appended = file.size - prior.size;
    if (appended <= 0) continue;
    if (appended > remaining) return initialRouteState(key, files, maxScanBytes);
    const start = Math.max(0, prior.size - APPEND_OVERLAP_BYTES);
    const route = routeFromText(readSlice(file.path, start, file.size - start), { startsMidLine: start > 0 });
    remaining -= appended;
    if (route !== null) {
      routeKnown = true;
      routePath = route;
    }
  }

  return {
    key,
    files: snapshots(files),
    routeKnown,
    routePath,
  };
}

/**
 * Conservative detector used to avoid mirroring content the user is already
 * looking at. All observation failures resolve to a non-suppressing status.
 */
export class CodexFocusDetector {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.execFileImpl = options.execFileImpl || nodeExecFile;
    this.osascriptPath = options.osascriptPath || "/usr/bin/osascript";
    this.commandTimeoutMs = Math.max(100, Number(options.commandTimeoutMs) || DEFAULT_COMMAND_TIMEOUT_MS);
    this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
    this.logsRoot = options.logsRoot || path.join(os.homedir(), "Library", "Logs", "com.openai.codex");
    this.maxLogScanBytes = Math.max(1024, Number(options.maxLogScanBytes) || DEFAULT_LOG_SCAN_BYTES);
    this.maxIncrementalBytes = Math.max(1024, Number(options.maxIncrementalBytes) || DEFAULT_INCREMENTAL_BYTES);
    this.maxLogFiles = Math.max(1, Number(options.maxLogFiles) || DEFAULT_MAX_LOG_FILES);
    this.maxDirectoryEntries = Math.max(1, Number(options.maxDirectoryEntries) || DEFAULT_MAX_DIRECTORY_ENTRIES);
    this.maxDirectoryDepth = Math.max(0, Number(options.maxDirectoryDepth) || DEFAULT_MAX_DIRECTORY_DEPTH);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.cached = null;
    this.pending = null;
    this.routeState = null;
  }

  invalidate() {
    this.cached = null;
  }

  async getStatus({ force = false } = {}) {
    const currentTime = this.now();
    if (!force && this.cached && currentTime < this.cached.expiresAtMs) return this.cached.status;
    if (this.pending) return this.pending;
    const observation = this.#observe(currentTime)
      .catch(() => unknownStatus(currentTime))
      .then((status) => {
        this.cached = { expiresAtMs: this.now() + this.cacheTtlMs, status };
        return status;
      })
      .finally(() => {
        this.pending = null;
      });
    this.pending = observation;
    return observation;
  }

  async shouldSuppressUserMirror(options = {}) {
    const status = await this.getStatus(options);
    return status.focusKnown && status.appFocused;
  }

  async shouldSuppressResult(threadId, options = {}) {
    const expected = String(threadId || "").trim().toLowerCase();
    if (!expected) return false;
    const status = await this.getStatus(options);
    return status.focusKnown
      && status.appFocused
      && status.routeKnown
      && status.openThreadId === expected;
  }

  async #observe(observedAtMs) {
    if (this.platform !== "darwin") return unknownStatus(observedAtMs);
    const frontmost = await observeFrontmostApplication({
      execFileImpl: this.execFileImpl,
      osascriptPath: this.osascriptPath,
      timeoutMs: this.commandTimeoutMs,
    });
    if (!frontmost) return unknownStatus(observedAtMs);
    if (frontmost.bundleId !== CODEX_BUNDLE_ID) {
      return Object.freeze({
        observedAtMs,
        focusKnown: true,
        appFocused: false,
        frontmostBundleId: frontmost.bundleId,
        frontmostPid: frontmost.pid,
        routeKnown: false,
        openThreadId: null,
      });
    }

    const found = candidateLogs(this.logsRoot, frontmost, {
      maxLogFiles: this.maxLogFiles,
      maxDirectoryEntries: this.maxDirectoryEntries,
      maxDirectoryDepth: this.maxDirectoryDepth,
    });
    let routeKnown = false;
    let routePath = null;
    // The launch timestamp prevents a recycled PID from inheriting an older
    // app session's route. If AppKit ever omits it, keep focus detection but
    // deliberately decline exact-task suppression.
    if (frontmost.launchedAtMs != null && found.complete && found.files.length) {
      const key = routeStateKey(frontmost);
      this.routeState = this.routeState?.key === key
        ? updatedRouteState(this.routeState, key, found.files, this.maxIncrementalBytes, this.maxLogScanBytes)
        : initialRouteState(key, found.files, this.maxLogScanBytes);
      routeKnown = this.routeState.routeKnown;
      routePath = this.routeState.routePath;
    } else {
      this.routeState = null;
    }

    return Object.freeze({
      observedAtMs,
      focusKnown: true,
      appFocused: true,
      frontmostBundleId: frontmost.bundleId,
      frontmostPid: frontmost.pid,
      routeKnown,
      openThreadId: routeKnown ? threadFromRoute(routePath) : null,
    });
  }
}

export const codexFocusValues = Object.freeze({
  bundleId: CODEX_BUNDLE_ID,
  ownerSyncMarker: OWNER_SYNC_MARKER,
});
