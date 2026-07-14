import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_DEPLOYMENT_SCHEMA_VERSION = 1;
export const DEFAULT_APP_NODE = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(sourceDirectory, "..", "..");
const applicationResources = "/Applications/ChatGPT.app/Contents/Resources";

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    const metadata = lstatSync(file);
    accessSync(file, constants.X_OK);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveServiceNodeRuntime(value = "", options = {}) {
  const candidate = String(value || DEFAULT_APP_NODE).trim();
  if (!executable(candidate)) {
    throw codedError("SERVICE_NODE_UNAVAILABLE", "The ChatGPT app-owned Node runtime is unavailable or is not a regular executable.");
  }
  const resolved = realpathSync(candidate);
  if (options.allowUntrustedRuntime !== true
    && resolved !== applicationResources
    && !resolved.startsWith(`${applicationResources}${path.sep}`)) {
    throw codedError("SERVICE_NODE_UNTRUSTED", "The persistent service requires the Node runtime bundled with the ChatGPT app.");
  }
  return resolved;
}

function sha256File(file) {
  const digest = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function packageRoot(specifier = "ws") {
  let current = path.dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (;;) {
    const packageFile = path.join(current, "package.json");
    if (existsSync(packageFile)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw codedError("SERVICE_DEPENDENCY_UNAVAILABLE", `The ${specifier} runtime dependency is unavailable.`);
}

function filesBelow(root, targetPrefix) {
  const result = [];
  const visit = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = path.join(directory, entry.name);
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) visit(source, child);
      else if (entry.isFile()) result.push({ source, relative: path.join(targetPrefix, child) });
      else throw codedError("SERVICE_DEPLOYMENT_SOURCE_UNSAFE", `Runtime source contains a non-regular entry: ${source}`);
    }
  };
  visit(root);
  return result;
}

function deploymentInputs(options = {}) {
  const { projectRoot = defaultProjectRoot, nodePath, wsRoot } = options;
  const root = realpathSync(projectRoot);
  const runtime = resolveServiceNodeRuntime(nodePath, { allowUntrustedRuntime: options.allowUntrustedRuntime === true });
  const dependency = realpathSync(wsRoot || packageRoot("ws"));
  const inputs = [
    { source: path.join(root, "package.json"), relative: "package.json" },
    ...filesBelow(path.join(root, "service", "src"), path.join("service", "src")),
    ...filesBelow(path.join(root, "protocol"), "protocol"),
    ...filesBelow(dependency, path.join("node_modules", "ws")),
    { source: runtime, relative: path.join("runtime", "node"), executable: true },
  ].sort((a, b) => a.relative.localeCompare(b.relative));
  return { projectRoot: root, nodeSource: runtime, inputs };
}

function buildManifest(options = {}) {
  const source = deploymentInputs(options);
  const files = source.inputs.map((entry) => ({
    relative: entry.relative.split(path.sep).join("/"),
    sha256: sha256File(entry.source),
    executable: entry.executable === true,
  }));
  const digest = createHash("sha256");
  digest.update(`schema:${SERVICE_DEPLOYMENT_SCHEMA_VERSION}\0`);
  for (const file of files) digest.update(`${file.relative}\0${file.sha256}\0${file.executable ? "x" : "-"}\0`);
  return {
    source,
    manifest: {
      schemaVersion: SERVICE_DEPLOYMENT_SCHEMA_VERSION,
      owner: "codex-imessage-handoff",
      fingerprint: digest.digest("hex"),
      files,
    },
  };
}

function deployedFiles(root) {
  return filesBelow(root, "").map((entry) => entry.relative.split(path.sep).join("/")).sort();
}

export function verifyServiceDeployment(root, expectedFingerprint = "") {
  const resolved = path.resolve(root);
  const rootMetadata = lstatSync(resolved);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service bundle is not a regular directory.");
  }
  const manifestFile = path.join(resolved, "deployment-manifest.json");
  if ((rootMetadata.mode & 0o222) !== 0 || (lstatSync(manifestFile).mode & 0o222) !== 0) {
    throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service bundle is writable.");
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest?.schemaVersion !== SERVICE_DEPLOYMENT_SCHEMA_VERSION
    || manifest?.owner !== "codex-imessage-handoff"
    || !/^[a-f0-9]{64}$/.test(String(manifest?.fingerprint || ""))
    || (expectedFingerprint && manifest.fingerprint !== expectedFingerprint)
    || !Array.isArray(manifest.files)) {
    throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service manifest is invalid.");
  }
  const expected = ["deployment-manifest.json", ...manifest.files.map((item) => item.relative)].sort();
  const actual = deployedFiles(resolved);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service bundle contains unexpected or missing files.");
  }
  const checkDirectories = (directory) => {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
      throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service bundle contains a writable or unsafe directory.");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) checkDirectories(path.join(directory, entry.name));
    }
  };
  checkDirectories(resolved);
  const fingerprint = createHash("sha256");
  fingerprint.update(`schema:${SERVICE_DEPLOYMENT_SCHEMA_VERSION}\0`);
  for (const item of manifest.files) {
    if (!item || typeof item.relative !== "string" || item.relative.startsWith("/") || item.relative.includes("..")) {
      throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service manifest contains an unsafe path.");
    }
    const file = path.join(resolved, item.relative);
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0
      || (item.executable === true && (metadata.mode & 0o111) === 0)
      || sha256File(file) !== item.sha256) {
      throw codedError("SERVICE_DEPLOYMENT_INVALID", `The deployed service file failed integrity verification: ${item.relative}`);
    }
    fingerprint.update(`${item.relative}\0${item.sha256}\0${item.executable === true ? "x" : "-"}\0`);
  }
  if (fingerprint.digest("hex") !== manifest.fingerprint) {
    throw codedError("SERVICE_DEPLOYMENT_INVALID", "The deployed service fingerprint does not match its contents.");
  }
  return {
    root: resolved,
    fingerprint: manifest.fingerprint,
    nodePath: path.join(resolved, "runtime", "node"),
    daemonPath: path.join(resolved, "service", "src", "daemon.mjs"),
    supervisorPath: path.join(resolved, "service", "src", "shared-backend-supervisor.mjs"),
    manifest,
  };
}

function preflightDeployment(root, nodePath, options = {}) {
  const run = options.run || execFileSync;
  for (const relative of deployedFiles(root)) {
    if (!/\.(?:mjs|ts)$/.test(relative)) continue;
    run(nodePath, ["--experimental-strip-types", "--check", path.join(root, relative)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  }
  run(nodePath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    "await import('./service/src/app-server-runner.mjs'); await import('./service/src/imsg-transport.mjs');",
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function makeReadOnly(root, manifest) {
  for (const item of manifest.files) chmodSync(path.join(root, item.relative), item.executable ? 0o555 : 0o444);
  chmodSync(path.join(root, "deployment-manifest.json"), 0o444);
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  for (const directory of directories.sort((a, b) => b.length - a.length)) chmodSync(directory, 0o555);
}

export function stageServiceDeployment(deploymentsRoot, options = {}) {
  if (!path.isAbsolute(deploymentsRoot)) {
    throw codedError("SERVICE_DEPLOYMENT_PATH_INVALID", "The service deployments path must be absolute.");
  }
  const { source, manifest } = buildManifest(options);
  const destination = path.join(deploymentsRoot, manifest.fingerprint);
  if (existsSync(destination)) return { ...verifyServiceDeployment(destination, manifest.fingerprint), changed: false };

  mkdirSync(deploymentsRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(deploymentsRoot, `.staging-${manifest.fingerprint}-${process.pid}-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (let index = 0; index < source.inputs.length; index += 1) {
      const input = source.inputs[index];
      const item = manifest.files[index];
      const target = path.join(temporary, input.relative);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(input.source, target, constants.COPYFILE_FICLONE);
      if (sha256File(target) !== item.sha256) {
        throw codedError("SERVICE_DEPLOYMENT_COPY_FAILED", `The deployed copy failed verification: ${item.relative}`);
      }
      chmodSync(target, input.executable ? 0o500 : 0o400);
    }
    writeFileSync(path.join(temporary, "deployment-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    preflightDeployment(temporary, path.join(temporary, "runtime", "node"), options);
    makeReadOnly(temporary, manifest);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw codedError("SERVICE_DEPLOYMENT_PREFLIGHT_FAILED", "The versioned service bundle failed preflight and was not activated.", error);
  }
  return { ...verifyServiceDeployment(destination, manifest.fingerprint), changed: true };
}
