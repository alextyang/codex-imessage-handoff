import assert from "node:assert/strict";
import test from "node:test";
import { imsgHelperEntryInternals } from "../src/imsg-helper-entry.mjs";
import {
  extractImsgAccountIdentities,
  imsgAccountFingerprint,
} from "../src/imsg-ipc-protocol.mjs";

const { healthMonitor, writeHealthDiagnostic } = imsgHelperEntryInternals;
const binary = "/private/fake/imsg";
const account = { accounts: [{ login: "E:helper@example.com", aliases: ["tel:+14155550100"] }] };
const accountFingerprint = imsgAccountFingerprint(extractImsgAccountIdentities(account));
const readyStatus = {
  advanced_features: true,
  v2_ready: true,
  rpc_methods: ["watch.subscribe"],
};

function pendingFatalServer() {
  const fatal = new Promise(() => {});
  return { waitForFatal: () => fatal };
}

async function monitorSequence(sequence, options = {}) {
  const abort = new AbortController();
  const diagnostics = [];
  let sample = -1;
  let current = null;
  const run = (_binary, args) => {
    if (args[0] === "status") {
      sample += 1;
      current = sequence[sample];
      if (!current) throw new Error("test sequence exhausted");
      if (current === "status-error") throw new Error("sensitive status detail");
      if (current === "bridge-lost") return `${JSON.stringify({ advanced_features: false })}\n`;
      return `${JSON.stringify(readyStatus)}\n`;
    }
    assert.deepEqual(args, ["account", "--json"]);
    if (current === "account-error") throw new Error("sensitive account detail");
    const result = current === "account-changed"
      ? { account: { login: "E:changed@example.com" } }
      : account;
    return `${JSON.stringify(result)}\n`;
  };
  await healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, pendingFatalServer(), {
    run,
    wait: async () => {},
    signal: abort.signal,
    failureThreshold: options.failureThreshold,
    onDiagnostic: (value) => {
      diagnostics.push(value);
      if (value.status === "recovered" && sample === sequence.length - 1
        && options.abortAfterSequence !== false) abort.abort();
    },
  });
  return diagnostics;
}

test("periodic helper health tolerates two transient status/account failures and resets on recovery", async () => {
  const diagnostics = await monitorSequence(["status-error", "account-error", "healthy"]);
  assert.deepEqual(diagnostics, [
    {
      status: "retrying",
      code: "IMSG_HELPER_RUNTIME_UNAVAILABLE",
      consecutiveFailures: 1,
      failureThreshold: 3,
    },
    {
      status: "retrying",
      code: "IMSG_ACCOUNT_UNAVAILABLE",
      consecutiveFailures: 2,
      failureThreshold: 3,
    },
    {
      status: "recovered",
      code: null,
      consecutiveFailures: 0,
      failureThreshold: 3,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive|example\.com/i);
});

test("periodic helper health exits at the consecutive failure threshold with sanitized diagnostics", async () => {
  const diagnostics = [];
  let samples = 0;
  await assert.rejects(
    healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, pendingFatalServer(), {
      run: () => {
        samples += 1;
        throw new Error("sensitive runtime output");
      },
      wait: async () => {},
      onDiagnostic: (value) => diagnostics.push(value),
    }),
    (error) => {
      assert.equal(error?.code, "IMSG_HELPER_RUNTIME_UNAVAILABLE");
      assert.equal(error?.message, "The private Messages runtime health check failed.");
      assert.doesNotMatch(String(error?.message), /sensitive/i);
      return true;
    },
  );
  assert.equal(samples, 3);
  assert.deepEqual(diagnostics.map(({ status, consecutiveFailures }) => ({ status, consecutiveFailures })), [
    { status: "retrying", consecutiveFailures: 1 },
    { status: "retrying", consecutiveFailures: 2 },
    { status: "failed", consecutiveFailures: 3 },
  ]);
});

test("a successful periodic sample resets the consecutive failure counter", async () => {
  const diagnostics = await monitorSequence([
    "bridge-lost",
    "healthy",
    "status-error",
    "account-error",
    "healthy",
  ]);
  assert.deepEqual(diagnostics.map(({ status, consecutiveFailures }) => ({ status, consecutiveFailures })), [
    { status: "retrying", consecutiveFailures: 1 },
    { status: "recovered", consecutiveFailures: 0 },
    { status: "retrying", consecutiveFailures: 1 },
    { status: "retrying", consecutiveFailures: 2 },
    { status: "recovered", consecutiveFailures: 0 },
  ]);
});

test("a long-lived helper subscribes to the fatal channel exactly once", async () => {
  const abort = new AbortController();
  const fatal = new Promise(() => {});
  let fatalSubscriptions = 0;
  let ticks = 0;
  let probes = 0;
  await healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, {
    waitForFatal() {
      fatalSubscriptions += 1;
      return fatal;
    },
  }, {
    run: (_binary, args) => {
      probes += 1;
      return args[0] === "status"
        ? `${JSON.stringify(readyStatus)}\n`
        : `${JSON.stringify(account)}\n`;
    },
    wait: async () => {
      ticks += 1;
      if (ticks > 100) abort.abort();
    },
    signal: abort.signal,
  });
  assert.equal(fatalSubscriptions, 1);
  assert.equal(probes, 200);
});

test("an authoritative account fingerprint mismatch fails closed immediately", async () => {
  const diagnostics = [];
  let statusSamples = 0;
  await assert.rejects(
    healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, pendingFatalServer(), {
      run: (_binary, args) => {
        if (args[0] === "status") {
          statusSamples += 1;
          return `${JSON.stringify(readyStatus)}\n`;
        }
        return `${JSON.stringify({ account: { login: "E:changed@example.com" } })}\n`;
      },
      wait: async () => {},
      onDiagnostic: (value) => diagnostics.push(value),
    }),
    (error) => error?.code === "IMSG_HELPER_ACCOUNT_CHANGED"
      && error?.message === "The live Messages account changed.",
  );
  assert.equal(statusSamples, 1);
  assert.deepEqual(diagnostics, [{
    status: "failed",
    code: "IMSG_HELPER_ACCOUNT_CHANGED",
    consecutiveFailures: 1,
    failureThreshold: 3,
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /changed@example\.com/i);
});

test("aborting while the periodic health monitor sleeps exits without probing", async () => {
  const abort = new AbortController();
  let probes = 0;
  const monitor = healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, pendingFatalServer(), {
    run: () => { probes += 1; },
    intervalMs: 60_000,
    signal: abort.signal,
  });
  abort.abort();
  await monitor;
  assert.equal(probes, 0);
});

test("an explicit server fatal bypasses the periodic failure grace", async () => {
  const fatal = Object.assign(new Error("Pinned RPC session exited."), { code: "IMSG_RPC_CLOSED" });
  let probes = 0;
  await assert.rejects(
    healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, {
      waitForFatal: () => Promise.resolve(fatal),
    }, {
      run: () => { probes += 1; },
      wait: () => new Promise(() => {}),
    }),
    (error) => error === fatal,
  );
  assert.equal(probes, 0);
});

test("a delayed periodic probe is asynchronous and never overlaps another sample", async () => {
  const abort = new AbortController();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  let eventLoopResponsive = false;
  const run = async (_binary, args, { signal } = {}) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 15);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      if (args[0] === "status") return `${JSON.stringify(readyStatus)}\n`;
      if (calls >= 4) abort.abort();
      return `${JSON.stringify(account)}\n`;
    } finally {
      active -= 1;
    }
  };
  const monitor = healthMonitor(
    { imsgBinary: binary, profile: { accountFingerprint } },
    pendingFatalServer(),
    { run, wait: async () => {}, signal: abort.signal },
  );
  setImmediate(() => { eventLoopResponsive = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(eventLoopResponsive, true, "the helper event loop must remain responsive during a probe");
  await monitor;
  assert.equal(calls, 4);
  assert.equal(maximumActive, 1);
});

test("a server fatal interrupts an in-flight periodic probe immediately", async () => {
  let resolveFatal;
  const fatal = new Promise((resolve) => { resolveFatal = resolve; });
  const expected = Object.assign(new Error("Pinned RPC session exited."), { code: "IMSG_RPC_CLOSED" });
  let probeStarted = false;
  let probeAborted = false;
  const monitor = healthMonitor({ imsgBinary: binary, profile: { accountFingerprint } }, {
    waitForFatal: () => fatal,
  }, {
    run: async (_binary, _args, { signal } = {}) => {
      probeStarted = true;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => {
        probeAborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true }));
    },
    wait: async () => {},
  });
  while (!probeStarted) await new Promise((resolve) => setImmediate(resolve));
  resolveFatal(expected);
  await assert.rejects(monitor, (error) => error === expected);
  assert.equal(probeAborted, true);
});

test("abort returns during a delayed probe and ignores its late result", async () => {
  const abort = new AbortController();
  const diagnostics = [];
  let releaseProbe;
  const monitor = healthMonitor(
    { imsgBinary: binary, profile: { accountFingerprint } },
    pendingFatalServer(),
    {
      run: () => new Promise((resolve) => { releaseProbe = resolve; }),
      wait: async () => {},
      signal: abort.signal,
      onDiagnostic: (value) => diagnostics.push(value),
    },
  );
  while (!releaseProbe) await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await monitor;
  releaseProbe(`${JSON.stringify({ advanced_features: false })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(diagnostics, []);
});

test("production helper health diagnostics contain only bounded status metadata", () => {
  let output = "";
  writeHealthDiagnostic({
    status: "retrying\nsecret message",
    code: "IMSG_ACCOUNT_UNAVAILABLE secret-account@example.com",
    consecutiveFailures: -99,
    failureThreshold: Number.MAX_SAFE_INTEGER + 1,
  }, (line) => { output += line; });
  assert.equal(output, "IMSG_HELPER_HEALTH_FAILED: code=none consecutive=0 threshold=3\n");
  assert.doesNotMatch(output, /secret|example\.com/i);
});
