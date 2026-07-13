import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveServiceNodeRuntime, stageServiceDeployment, verifyServiceDeployment } from "../src/service-deployment.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "imessage-service-deployment-"));
  const projectRoot = path.join(root, "project");
  const source = path.join(projectRoot, "service", "src");
  const protocol = path.join(projectRoot, "protocol");
  const wsRoot = path.join(root, "ws");
  mkdirSync(source, { recursive: true });
  mkdirSync(protocol, { recursive: true });
  mkdirSync(wsRoot, { recursive: true });
  for (const name of ["daemon.mjs", "shared-backend-supervisor.mjs", "app-server-runner.mjs", "imsg-transport.mjs"]) {
    writeFileSync(path.join(source, name), "export const ready = true;\n");
  }
  writeFileSync(path.join(protocol, "presentation.ts"), "export const ready: boolean = true;\n");
  writeFileSync(path.join(wsRoot, "package.json"), JSON.stringify({ name: "ws", type: "module", exports: "./wrapper.mjs" }));
  writeFileSync(path.join(wsRoot, "wrapper.mjs"), "export default class WebSocket {}\n");
  const nodeRuntime = path.join(root, "node");
  writeFileSync(nodeRuntime, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
  const makeWritable = (directory) => {
    try { chmodSync(directory, 0o700); } catch {}
    try {
      for (const item of Object.values(requireDirectoryEntries(directory))) {
        if (item.directory) makeWritable(item.path);
        else chmodSync(item.path, 0o600);
      }
    } catch {}
  };
  t.after(() => {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, projectRoot, source, wsRoot, nodeRuntime, deployments: path.join(root, "deployments") };
}

function requireDirectoryEntries(directory) {
  const entries = {};
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    entries[name.name] = { path: path.join(directory, name.name), directory: name.isDirectory() };
  }
  return entries;
}

test("staging creates a content-addressed immutable bundle with its own Node runtime", (t) => {
  const run = fixture(t);
  const options = {
    projectRoot: run.projectRoot,
    wsRoot: run.wsRoot,
    nodePath: run.nodeRuntime,
    allowUntrustedRuntime: true,
  };
  const deployed = stageServiceDeployment(run.deployments, options);
  assert.equal(deployed.changed, true);
  assert.match(deployed.fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => resolveServiceNodeRuntime(run.nodeRuntime), (error) => error?.code === "SERVICE_NODE_UNTRUSTED");
  assert.equal(resolveServiceNodeRuntime(run.nodeRuntime, { allowUntrustedRuntime: true }), realpathSync(run.nodeRuntime));
  assert.notEqual(deployed.nodePath, run.nodeRuntime);
  assert.equal(statSync(deployed.nodePath).size, statSync(run.nodeRuntime).size);
  assert.equal(lstatSync(deployed.nodePath).mode & 0o222, 0);
  assert.equal(lstatSync(deployed.daemonPath).mode & 0o222, 0);
  assert.equal(stageServiceDeployment(run.deployments, options).changed, false);
  assert.equal(verifyServiceDeployment(deployed.root, deployed.fingerprint).fingerprint, deployed.fingerprint);

  chmodSync(deployed.daemonPath, 0o600);
  writeFileSync(deployed.daemonPath, "tampered\n");
  assert.throws(() => verifyServiceDeployment(deployed.root), /integrity verification/);
});

test("a source change produces a separate version and preserves the prior bundle", (t) => {
  const run = fixture(t);
  const options = { projectRoot: run.projectRoot, wsRoot: run.wsRoot, nodePath: run.nodeRuntime, allowUntrustedRuntime: true };
  const first = stageServiceDeployment(run.deployments, options);
  chmodSync(run.source, 0o700);
  writeFileSync(path.join(run.source, "daemon.mjs"), "export const ready = 'next';\n");
  const second = stageServiceDeployment(run.deployments, options);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(verifyServiceDeployment(first.root, first.fingerprint).fingerprint, first.fingerprint);
  assert.equal(verifyServiceDeployment(second.root, second.fingerprint).fingerprint, second.fingerprint);
});
