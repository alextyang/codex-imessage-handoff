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
  assert.match(daemon, /function scheduleLiveMirrorScan\(activity = null\) \{[\s\S]{0,500}if \(stopped \|\| !startupWorkReleased\) return;\s*liveMirrorScheduler\.schedule\(activity \|\| \{ source: "full" \}\);/);
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

test("daemon gates task ordering on receiver-observed primary mirrors and has no service-profile fallback", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const start = daemon.indexOf("async function deliverLiveMessage(message)");
  const end = daemon.indexOf("\nfunction liveMirrorBackoffFor", start);
  assert.ok(start >= 0 && end > start);
  const delivery = daemon.slice(start, end);
  assert.match(delivery, /const ordered = orderedUserMirrorDelivery\(local\);/);
  assert.match(delivery, /if \(ordered\.sent\) return ordered;/);
  assert.match(delivery, /return ordered;\s*\} else if/);
  assert.doesNotMatch(delivery, /fallbackSafe\s*!==\s*true|retain the prior service-side mirror/);
});

test("daemon proves the primary mirror account differs from the authenticated service account", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /new LocalUserMirrorSender\(\{[\s\S]*verifyReceiverMirror: \(proof\) => imsgTransport\.verifyUserMirrorReceipt\(proof\),/);
  assert.match(daemon, /localUserMirrorSender\.initialize\(\{[\s\S]*expectedLocalSender: profile\.expectedSender,[\s\S]*serviceAccountFingerprint: helper\.helperAttestation\?\.accountHash,/);
});

test("daemon holds one private service lease without locking Codex", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /new ExclusiveProcessLease\(\{ lockPath: `\$\{paths\.home\}\/daemon\.lease` \}\)/);
  const acquire = daemon.indexOf("await daemonLease.acquire({ timeoutMs: 30_000 })");
  const configRead = daemon.indexOf("const config = readConfig()");
  const transportConstruction = daemon.indexOf("const imsgTransport = new ImsgTransport");
  assert.ok(acquire >= 0 && acquire < configRead && acquire < transportConstruction,
    "the lease must be acquired before any durable state or transport is read");
  assert.doesNotMatch(daemon.slice(daemon.indexOf("async function main()")), /await daemonLease\.acquire/,
    "main must not reacquire after stateful objects were constructed");
  assert.match(daemon, /daemonLease\.release\(\);\s*process\.exit\(0\);/);
  assert.doesNotMatch(daemon, /stateDb.*(?:lock|lease)|sessions.*(?:lock|lease)|codexRuntime.*(?:lock|lease)/i,
    "the singleton boundary must remain confined to the handoff service home");
});

test("daemon publishes core readiness before backlog work and gates live mirrors on initialized startup", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /function scheduleLiveMirrorScan\(activity = null\) \{\s*[^}]*if \(stopped \|\| !startupWorkReleased\) return;/);
  const mainStart = daemon.indexOf("async function main()");
  const mainEnd = daemon.indexOf("async function stop()", mainStart);
  const main = daemon.slice(mainStart, mainEnd);
  const initialize = main.indexOf("const localUserMirrorInitialization = localUserMirrorSender.initialize");
  const ready = main.indexOf("serviceReadiness.markReady()");
  const reconcile = main.indexOf("await completions.reconcile");
  const initialized = main.indexOf("await localUserMirrorInitialization");
  const release = main.indexOf("allowStartupWork()");
  const scan = main.lastIndexOf("scheduleLiveMirrorScan()");
  assert.ok(initialize >= 0 && initialize < ready);
  assert.ok(ready < reconcile && reconcile < initialized);
  assert.ok(initialized < release && release < scan);
});

test("the hidden controller shares scheduler capacity and safely replaces expired ephemeral sessions", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  assert.match(daemon, /const controllerRunner = codexRuntime\.createPersistentRunner\(\);/);
  assert.match(daemon, /new HiddenControllerConversation\(\{[\s\S]*cwd: paths\.hiddenControllerWorkspace,[\s\S]*runner: controllerRunner,/);
  assert.match(daemon, /for \(const event of hiddenController\.pendingEvents\(\)\) runs\.enqueue\(event\);/);
  assert.match(daemon, /if \(\["THREAD_NOT_FOUND", "CODEX_THREAD_NOT_FOUND"\]\.includes\(error\?\.code\)\) \{\s*context\.defer\(1_000\);/);
  assert.match(daemon, /error\?\.controllerDeliveryPending === true[\s\S]{0,180}context\.defer\(15_000\);/);
  assert.doesNotMatch(daemon, /new RunManager\([^)]*controller/i,
    "the controller must not create capacity outside the global task scheduler");
});

test("controller task stops require a service-issued task-bound confirmation", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const controller = readFileSync(path.join(repo, "service/src/hidden-controller-conversation.mjs"), "utf8");
  assert.match(controller, /name: "stop_task",[\s\S]{0,500}inputSchema: objectSchema\(\{\s*id: stringId,?\s*\}, \["id"\]\)/);
  assert.doesNotMatch(controller, /confirmed:\s*\{\s*type:\s*"boolean"/);
  assert.match(daemon, /async function confirmControllerStop\([\s\S]{0,1600}controllerServerRequests\.request\(\{[\s\S]{0,800}Stop Codex task[\s\S]{0,800}Stop task/);
  assert.match(daemon, /const confirmed = await confirmControllerStop\(\{ job, operationId, thread, signal \}\);[\s\S]{0,500}await stopTask\(thread\.id, \{ notify: false \}\)/);
});

test("controller cancellation cannot cross a dynamic mutation commit boundary", () => {
  const daemon = readFileSync(path.join(repo, "service/src/daemon.mjs"), "utf8");
  const controller = readFileSync(path.join(repo, "service/src/hidden-controller-conversation.mjs"), "utf8");
  assert.match(controller, /get cancellationSafe\(\) \{\s*return this\.activeMutations === 0;/);
  assert.match(controller, /combinedRequestContext\(requestContext, signal\)/);
  assert.match(daemon, /if \(!hiddenController\.cancellationSafe\) \{\s*receipt = hiddenController\.recordControlReceipt\(action\.messageKey, \{ outcome: "blocked" \}\);/);
  assert.match(daemon, /outcome: "authorized",\s*replyIds: hiddenController\.pendingEvents\(\)\.map\(\(event\) => event\.replyId\)/);
  assert.match(daemon, /runs\.cancel\(CONTROLLER_RUN_THREAD_ID, \{\s*replyIds: receipt\.replyIds,\s*onRequested: \(cancelled\) => \{\s*receipt = hiddenController\.applyControlCancellation/);
  assert.match(daemon, /queueLocalPrompt\([\s\S]{0,500}\{ signal \}\)/);
});
