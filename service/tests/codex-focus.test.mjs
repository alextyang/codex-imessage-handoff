import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexFocusDetector, observeFrontmostApplication } from "../src/codex-focus.mjs";

const THREAD_A = "019f57fb-9c0c-7950-935f-597a4e236897";
const THREAD_B = "019f579f-af05-7dd1-8bda-b3d4be384507";

function ownerSync(route, timestamp = "2026-07-13T03:39:32.498Z") {
  return `${timestamp} info [electron-message-handler] IAB_LIFECYCLE received browser sidebar owner sync browserTabId=null conversationId=test originWebContentsId=1 ownerRoutePath=${route} windowId=1\n`;
}

function execSequence(values) {
  const calls = [];
  let index = 0;
  const implementation = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    queueMicrotask(() => {
      if (value instanceof Error) callback(value, "", "");
      else callback(null, typeof value === "string" ? value : JSON.stringify(value), "");
    });
    return { kill() {} };
  };
  return { calls, implementation };
}

function logFixture(pid, contents, { mtimeMs = Date.now(), suffix = "0" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-focus-"));
  const directory = path.join(root, "2026", "07", "13");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `codex-desktop-session-${pid}-t0-i1-000000-${suffix}.log`);
  writeFileSync(file, contents);
  const time = new Date(mtimeMs);
  utimesSync(file, time, time);
  return { file, root };
}

function frontmost(pid, launchedAtMs = Date.now() - 60_000) {
  return { bundleId: "com.openai.codex", pid, launchedAtMs };
}

test("observeFrontmostApplication uses a bounded JXA subprocess and validates output", async () => {
  const exec = execSequence([{ bundleId: "com.openai.codex", pid: 42, launchedAtMs: 1_700_000_000_123.9 }]);
  const observed = await observeFrontmostApplication({ execFileImpl: exec.implementation, timeoutMs: 321 });
  assert.deepEqual(observed, {
    bundleId: "com.openai.codex",
    pid: 42,
    launchedAtMs: 1_700_000_000_123,
  });
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, "/usr/bin/osascript");
  assert.deepEqual(exec.calls[0].args.slice(0, 2), ["-l", "JavaScript"]);
  assert.equal(exec.calls[0].options.timeout, 321);
  assert.equal(exec.calls[0].options.maxBuffer, 8 * 1024);

  const invalid = execSequence(["not-json"]);
  assert.equal(await observeFrontmostApplication({ execFileImpl: invalid.implementation }), null);
});

test("focused Codex resolves the newest live Desktop route and suppresses only its result", async () => {
  const pid = 4242;
  const { root } = logFixture(pid, [
    ownerSync(`/local/${THREAD_B}`, "2026-07-13T03:39:31.000Z"),
    "ordinary log noise\n",
    ownerSync(`/local/${THREAD_A}`, "2026-07-13T03:39:32.000Z"),
  ].join(""));
  const exec = execSequence([frontmost(pid)]);
  const detector = new CodexFocusDetector({
    execFileImpl: exec.implementation,
    logsRoot: root,
    platform: "darwin",
  });

  const status = await detector.getStatus();
  assert.deepEqual(status, {
    observedAtMs: status.observedAtMs,
    focusKnown: true,
    appFocused: true,
    frontmostBundleId: "com.openai.codex",
    frontmostPid: pid,
    routeKnown: true,
    openThreadId: THREAD_A,
  });
  assert.equal(await detector.shouldSuppressUserMirror(), true);
  assert.equal(await detector.shouldSuppressResult(THREAD_A), true);
  assert.equal(await detector.shouldSuppressResult(THREAD_B), false);
  assert.equal(exec.calls.length, 1, "helpers share the short status cache");
});

test("root route is known to have no open task", async () => {
  const pid = 4343;
  const { root } = logFixture(pid, ownerSync(`/local/${THREAD_A}`) + ownerSync("/"));
  const detector = new CodexFocusDetector({
    execFileImpl: execSequence([frontmost(pid)]).implementation,
    logsRoot: root,
    platform: "darwin",
  });
  const status = await detector.getStatus();
  assert.equal(status.appFocused, true);
  assert.equal(status.routeKnown, true);
  assert.equal(status.openThreadId, null);
  assert.equal(await detector.shouldSuppressResult(THREAD_A), false);
});

test("non-Codex foreground app never reads a route or suppresses a mirror", async () => {
  const missingRoot = path.join(os.tmpdir(), `missing-codex-logs-${process.pid}-${Date.now()}`);
  const exec = execSequence([{ bundleId: "com.apple.finder", pid: 99, launchedAtMs: Date.now() }]);
  const detector = new CodexFocusDetector({
    execFileImpl: exec.implementation,
    logsRoot: missingRoot,
    platform: "darwin",
  });
  const status = await detector.getStatus();
  assert.equal(status.focusKnown, true);
  assert.equal(status.appFocused, false);
  assert.equal(status.routeKnown, false);
  assert.equal(await detector.shouldSuppressUserMirror(), false);
  assert.equal(await detector.shouldSuppressResult(THREAD_A), false);
});

test("subprocess and log uncertainty fail open without throwing", async () => {
  const failed = new CodexFocusDetector({
    execFileImpl: execSequence([Object.assign(new Error("timed out"), { killed: true })]).implementation,
    platform: "darwin",
  });
  const failedStatus = await failed.getStatus();
  assert.equal(failedStatus.focusKnown, false);
  assert.equal(failedStatus.appFocused, false);
  assert.equal(await failed.shouldSuppressUserMirror(), false);

  const focused = new CodexFocusDetector({
    execFileImpl: execSequence([frontmost(4444)]).implementation,
    logsRoot: path.join(os.tmpdir(), `missing-codex-route-${process.pid}-${Date.now()}`),
    platform: "darwin",
  });
  const focusedStatus = await focused.getStatus();
  assert.equal(focusedStatus.focusKnown, true);
  assert.equal(focusedStatus.appFocused, true);
  assert.equal(focusedStatus.routeKnown, false);
  assert.equal(await focused.shouldSuppressResult(THREAD_A), false);
});

test("cache coalesces observations and refreshes after its TTL", async () => {
  const pid = 4545;
  const { root } = logFixture(pid, ownerSync(`/local/${THREAD_A}`));
  let time = 10_000;
  const exec = execSequence([frontmost(pid, 1), frontmost(pid, 1)]);
  const detector = new CodexFocusDetector({
    cacheTtlMs: 100,
    execFileImpl: exec.implementation,
    logsRoot: root,
    now: () => time,
    platform: "darwin",
  });
  const [first, second] = await Promise.all([detector.getStatus(), detector.getStatus()]);
  assert.strictEqual(first, second);
  assert.equal(exec.calls.length, 1);
  time += 99;
  await detector.getStatus();
  assert.equal(exec.calls.length, 1);
  time += 1;
  await detector.getStatus();
  assert.equal(exec.calls.length, 2);
});

test("incremental appends and log rotation update the open task", async () => {
  const pid = 4646;
  const baseTime = Date.now();
  const fixture = logFixture(pid, ownerSync(`/local/${THREAD_A}`), { mtimeMs: baseTime, suffix: "0" });
  const exec = execSequence([frontmost(pid, baseTime - 1_000)]);
  const detector = new CodexFocusDetector({
    cacheTtlMs: 1,
    execFileImpl: exec.implementation,
    logsRoot: fixture.root,
    now: (() => {
      let value = 0;
      return () => ++value;
    })(),
    platform: "darwin",
  });
  assert.equal((await detector.getStatus({ force: true })).openThreadId, THREAD_A);

  appendFileSync(fixture.file, ownerSync(`/local/${THREAD_B}`));
  utimesSync(fixture.file, new Date(baseTime + 1_000), new Date(baseTime + 1_000));
  assert.equal((await detector.getStatus({ force: true })).openThreadId, THREAD_B);

  const rotated = path.join(path.dirname(fixture.file), `codex-desktop-session-${pid}-t0-i1-000000-1.log`);
  writeFileSync(rotated, "new segment noise\n" + ownerSync("/"));
  utimesSync(rotated, new Date(baseTime + 2_000), new Date(baseTime + 2_000));
  const status = await detector.getStatus({ force: true });
  assert.equal(status.routeKnown, true);
  assert.equal(status.openThreadId, null);
});

test("PID changes cannot reuse a prior process route", async () => {
  const firstPid = 4747;
  const secondPid = 4848;
  const fixture = logFixture(firstPid, ownerSync(`/local/${THREAD_A}`));
  const exec = execSequence([frontmost(firstPid, 1), frontmost(secondPid, 1)]);
  const detector = new CodexFocusDetector({
    cacheTtlMs: 1,
    execFileImpl: exec.implementation,
    logsRoot: fixture.root,
    platform: "darwin",
  });
  assert.equal((await detector.getStatus({ force: true })).openThreadId, THREAD_A);
  const restarted = await detector.getStatus({ force: true });
  assert.equal(restarted.appFocused, true);
  assert.equal(restarted.frontmostPid, secondPid);
  assert.equal(restarted.routeKnown, false);
  assert.equal(restarted.openThreadId, null);
  assert.equal(await detector.shouldSuppressResult(THREAD_A), false);
});

test("missing process launch time cannot inherit a recycled PID route", async () => {
  const pid = 4898;
  const fixture = logFixture(pid, ownerSync(`/local/${THREAD_A}`));
  const detector = new CodexFocusDetector({
    execFileImpl: execSequence([{ bundleId: "com.openai.codex", pid, launchedAtMs: null }]).implementation,
    logsRoot: fixture.root,
    platform: "darwin",
  });
  const status = await detector.getStatus();
  assert.equal(status.appFocused, true);
  assert.equal(status.routeKnown, false);
  assert.equal(await detector.shouldSuppressResult(THREAD_A), false);
});

test("bounded scan does not trust an older route hidden behind unread log bytes", async () => {
  const pid = 4949;
  const contents = ownerSync(`/local/${THREAD_A}`) + "x".repeat(16 * 1024);
  const { root } = logFixture(pid, contents);
  const detector = new CodexFocusDetector({
    execFileImpl: execSequence([frontmost(pid)]).implementation,
    logsRoot: root,
    maxLogScanBytes: 1024,
    platform: "darwin",
  });
  const status = await detector.getStatus();
  assert.equal(status.appFocused, true);
  assert.equal(status.routeKnown, false);
  assert.equal(await detector.shouldSuppressResult(THREAD_A), false);
});

test("non-macOS platforms always fail open without spawning osascript", async () => {
  const exec = execSequence([frontmost(1)]);
  const detector = new CodexFocusDetector({ execFileImpl: exec.implementation, platform: "linux" });
  const status = await detector.getStatus();
  assert.equal(status.focusKnown, false);
  assert.equal(status.appFocused, false);
  assert.equal(exec.calls.length, 0);
});
