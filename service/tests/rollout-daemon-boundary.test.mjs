import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("daemon routes filesystem rollout paths through bounded dirty-task reconciliation", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /new RolloutReconcileScheduler\(\{\s*maxConcurrent: 4,\s*runThread: scanLiveMirrorThread,/);
  assert.match(daemon, /onActivity: \(activity\) => \{\s*scheduleLiveMirrorScan\(activity\);\s*scheduleCompletionScan\(\);/);
  assert.match(daemon, /function scheduleLiveMirrorScan\(activity = null\) \{\s*if \(stopped\) return;\s*liveMirrorScheduler\.schedule\(activity \|\| \{ source: "full" \}\);/);
  assert.match(daemon, /multiLiveMirror\.reconcile\(current, \{ deliver: deliverLiveMessage \}\)/);
  assert.doesNotMatch(daemon, /multiLiveMirror\.reconcileAll\(/,
    "normal daemon activity must not serialize every task through a catalog-wide call");
});

test("daemon retries live mirrors per task without gating unrelated dirty work", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /const liveMirrorBackoffs = new Map\(\);/);
  assert.match(daemon, /const liveMirrorRetryTimers = new Map\(\);/);
  assert.match(daemon, /function liveMirrorBackoffFor\(threadIdValue\)/);
  assert.match(daemon, /function scheduleLiveMirrorRetry\(threadIdValue\)[\s\S]*liveMirrorScheduler\.scheduleThread\(threadId\);/);
  assert.match(daemon, /async function scanLiveMirrorThread\(thread\)[\s\S]*const backoff = liveMirrorBackoffFor\(threadId\);[\s\S]*recordLiveMirrorFailure\(threadId\);/);
  assert.doesNotMatch(daemon, /const liveMirrorBackoff = new LiveMirrorRetryBackoff\(\);/);
  assert.doesNotMatch(daemon, /liveMirrorWaveActive|liveMirrorWaveRetryable/);
});

test("catalog refresh, task creation, and shutdown keep dirty reconciliation lifecycle aligned", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /catalogById = new Map\(threads\.map[\s\S]{0,240}pruneLiveMirrorRetryState\(threads\);[\s\S]{0,160}liveMirrorScheduler\.replaceCatalog\(threads\);[\s\S]{0,160}multiLiveMirror\.activateCatalog/);
  assert.match(daemon, /prepareThread: async \(thread, current\) => \{\s*catalogById\.set\(thread\.id, thread\);\s*multiLiveMirror\.activate\(thread, \{ resume: true \}\);\s*liveMirrorScheduler\.replaceCatalog\(\[\.\.\.catalogById\.values\(\)\]\);/);
  assert.match(daemon, /for \(const threadId of \[\.\.\.liveMirrorRetryTimers\.keys\(\)\]\) clearLiveMirrorRetryTimer\(threadId\);[\s\S]{0,180}rolloutActivity\.stop\(\);\s*liveMirrorScheduler\.stop\(\);[\s\S]{0,180}liveMirrorScheduler\.whenIdle\(\)/);
});

test("daemon immediately dispatches genuine actions released by mirror GUID resolution", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const start = daemon.indexOf("async function deliverLiveMessage(message)");
  const end = daemon.indexOf("\nfunction liveMirrorBackoffFor", start);
  assert.ok(start >= 0 && end > start);
  const delivery = daemon.slice(start, end);
  assert.match(delivery, /try \{[\s\S]*localUserMirrorSender\.sendMirror\([\s\S]*\} finally \{[\s\S]*drainReleasedUserMirrorActions\(\)[\s\S]*queueLocalAction\(action\)/);
});

test("daemon holds one private service lease without locking Codex", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /new ExclusiveProcessLease\(\{ lockPath: `\$\{paths\.home\}\/daemon\.lease` \}\)/);
  assert.match(daemon, /async function main\(\) \{\s*[\s\S]{0,500}await daemonLease\.acquire\(\{ timeoutMs: 30_000 \}\);\s*serviceReadiness\.markStarting\(\);/);
  assert.match(daemon, /daemonLease\.release\(\);\s*process\.exit\(0\);/);
  assert.doesNotMatch(daemon, /stateDb.*(?:lock|lease)|sessions.*(?:lock|lease)|codexRuntime.*(?:lock|lease)/i,
    "the singleton boundary must remain confined to the handoff service home");
});
