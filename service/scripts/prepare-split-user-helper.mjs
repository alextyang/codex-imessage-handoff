#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_SPLIT_USER_BUNDLE_NAME,
  DEFAULT_SPLIT_USER_GROUP_NAME,
  DEFAULT_SPLIT_USER_SHARED_BASE,
  stageSplitUserHelperBundle,
} from "../src/split-user-staging.mjs";
import { inspectMacGroup } from "../src/split-user-helper-installer.mjs";

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requiredValue(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw codedError("SPLIT_USER_PREPARE_ARGUMENT", `--${name} is required.`);
  }
  return value.trim();
}

export function parsePrepareArguments(argv = []) {
  const options = {};
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/i.exec(argument);
    if (!match || Object.hasOwn(options, match[1])) {
      throw codedError("SPLIT_USER_PREPARE_ARGUMENT", "Preparation accepts unique --name=value arguments only.");
    }
    options[match[1]] = match[2];
  }
  return options;
}

export function readPrivateRecipientFile(file, {
  uid = process.getuid?.(),
  home = os.homedir(),
} = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw codedError("SPLIT_USER_RECIPIENT_FILE_UNSAFE", "The recipient file must use an absolute private path.");
  }
  const homeRoot = realpathSync(home);
  const original = lstatSync(file);
  if (!original.isFile() || original.isSymbolicLink() || original.size > 4096
    || (original.mode & 0o077) !== 0 || (Number.isSafeInteger(uid) && original.uid !== uid)) {
    throw codedError("SPLIT_USER_RECIPIENT_FILE_UNSAFE", "The recipient file must be an owner-only regular file.");
  }
  const resolved = realpathSync(file);
  if (!inside(homeRoot, resolved)) {
    throw codedError("SPLIT_USER_RECIPIENT_FILE_UNSAFE", "The recipient file must stay inside the controller home.");
  }
  const value = readFileSync(resolved, "utf8").trim();
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw codedError("SPLIT_USER_RECIPIENT_FILE_INVALID", "The recipient file must contain exactly one identity.");
  }
  return value;
}

export function readPrivateRecipientConfig(file, {
  uid = process.getuid?.(),
  home = os.homedir(),
} = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw codedError("SPLIT_USER_RECIPIENT_CONFIG_UNSAFE", "The service config must use an absolute private path.");
  }
  const homeRoot = realpathSync(home);
  const original = lstatSync(file);
  if (!original.isFile() || original.isSymbolicLink() || original.size > 64 * 1024
    || (original.mode & 0o077) !== 0 || (Number.isSafeInteger(uid) && original.uid !== uid)) {
    throw codedError("SPLIT_USER_RECIPIENT_CONFIG_UNSAFE", "The service config must be an owner-only regular file.");
  }
  const resolved = realpathSync(file);
  if (!inside(homeRoot, resolved)) {
    throw codedError("SPLIT_USER_RECIPIENT_CONFIG_UNSAFE", "The service config must stay inside the controller home.");
  }
  let config;
  try {
    config = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw codedError("SPLIT_USER_RECIPIENT_CONFIG_INVALID", "The service config is not valid JSON.", error);
  }
  const value = config?.version === 4 && config?.imsg?.mode === "helper"
    ? config.imsg.expectedSender
    : "";
  if (typeof value !== "string" || !value.trim() || value.includes("\n") || value.includes("\r")) {
    throw codedError("SPLIT_USER_RECIPIENT_CONFIG_INVALID", "The service config does not contain a valid helper recipient.");
  }
  return value.trim();
}

function positiveUid(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw codedError("SPLIT_USER_PREPARE_ARGUMENT", "The dedicated uid is invalid.");
  }
  return parsed;
}

function accountGroupIds(username, run = execFileSync) {
  try {
    const output = run("/usr/bin/id", ["-G", username], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const groups = [...new Set(String(output).trim().split(/\s+/).map(Number)
      .filter((value) => Number.isSafeInteger(value) && value >= 0))];
    if (!groups.length) throw new Error("no groups");
    return groups;
  } catch (error) {
    throw codedError("SPLIT_USER_ACCOUNT_UNAVAILABLE", `The macOS account ${username} could not be inspected.`, error);
  }
}

function accountUid(username, run = execFileSync) {
  try {
    const uid = Number(String(run("/usr/bin/id", ["-u", username], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })).trim());
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("invalid uid");
    return uid;
  } catch (error) {
    throw codedError("SPLIT_USER_ACCOUNT_UNAVAILABLE", `The macOS account ${username} could not be inspected.`, error);
  }
}

export function prepareSplitUserHelper(argv = process.argv.slice(2), overrides = {}) {
  const args = parsePrepareArguments(argv);
  if (args.help) return { help: true };
  const user = overrides.user || os.userInfo();
  const controllerHome = path.resolve(args["controller-home"] || user.homedir);
  const controllerUsername = args["controller-user"] || user.username;
  const dedicatedUsername = args["dedicated-user"] || "codex";
  const run = overrides.execFileSync || execFileSync;
  const dedicatedUid = positiveUid(args["dedicated-uid"], accountUid(dedicatedUsername, run));
  const controllerGroupIds = overrides.controllerGroupIds || accountGroupIds(controllerUsername, run);
  const dedicatedGroupIds = overrides.dedicatedGroupIds || accountGroupIds(dedicatedUsername, run);
  const sharedGroupName = args["shared-group"] || DEFAULT_SPLIT_USER_GROUP_NAME;
  const sharedGroup = overrides.sharedGroup || inspectMacGroup(sharedGroupName, { run });
  const sharedBase = path.resolve(args["shared-base"] || DEFAULT_SPLIT_USER_SHARED_BASE);
  const sharedRoot = path.resolve(args["shared-root"] || path.join(sharedBase, DEFAULT_SPLIT_USER_BUNDLE_NAME));
  const recipientFile = args["recipient-file"];
  const recipientConfig = args["recipient-config"];
  if (Boolean(recipientFile) === Boolean(recipientConfig)) {
    throw codedError(
      "SPLIT_USER_PREPARE_ARGUMENT",
      "Provide exactly one of --recipient-file or --recipient-config.",
    );
  }
  const recipientReaderOptions = {
    uid: Number.isSafeInteger(overrides.uid) ? overrides.uid : process.getuid?.(),
    home: controllerHome,
  };
  const expectedRecipient = recipientConfig
    ? readPrivateRecipientConfig(recipientConfig, recipientReaderOptions)
    : readPrivateRecipientFile(recipientFile, recipientReaderOptions);
  return stageSplitUserHelperBundle({
    expectedRecipient,
    daemonSafeImsgBinary: requiredValue(args, "daemon-safe-imsg"),
    imsgRuntimeRoot: args["imsg-runtime"] || "/opt/homebrew/libexec/imsg",
    sharedBase,
    sharedRoot,
    projectRoot: args["project-root"],
    nodePath: args.node,
    controllerKeyDirectory: args["controller-key-directory"],
    controller: {
      uid: Number.isSafeInteger(overrides.uid) ? overrides.uid : process.getuid?.(),
      username: controllerUsername,
      home: controllerHome,
      codexHome: path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(controllerHome, ".codex")),
      groupIds: controllerGroupIds,
    },
    dedicatedUser: {
      uid: dedicatedUid,
      username: dedicatedUsername,
      home: path.resolve(args["dedicated-home"] || "/Users/codex"),
      groupIds: dedicatedGroupIds,
    },
    sharedGroup,
    ...overrides.stageOptions,
  });
}

function usage() {
  return [
    "Prepare the public Codex Messages helper handoff bundle.",
    "",
    "Required:",
    "  --recipient-file=/private/owner-only/file",
    "    or --recipient-config=/private/owner-only/config.json",
    "  --daemon-safe-imsg=/absolute/path/to/patched/imsg",
    `  --shared-group=${DEFAULT_SPLIT_USER_GROUP_NAME} (dedicated group with exactly two members)`,
    "",
    "The recipient value is read only from the private file and is never printed or staged.",
    "The dedicated helper account must be non-admin and logged in to a persistent GUI session.",
    "After preparation, double-click 'Install Codex Messages.command' from that dedicated GUI session.",
    "",
  ].join("\n");
}

function main() {
  const result = prepareSplitUserHelper();
  if (result.help) {
    process.stdout.write(usage());
    return;
  }
  process.stdout.write(`${JSON.stringify({
    prepared: true,
    sharedRoot: result.sharedRoot,
    launcherPath: result.launcherPath,
    bundleManifestHash: result.bundleManifestHash,
    controllerPublicKeyFingerprint: result.controllerPublicKeyFingerprint,
    controllerIdentityHash: result.controllerIdentityHash,
    dedicatedIdentityHash: result.dedicatedIdentityHash,
    expectedRecipientHash: result.expectedRecipientHash,
  }, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code || "SPLIT_USER_PREPARE_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export const splitUserPrepareInternals = Object.freeze({ inside, positiveUid, accountGroupIds, accountUid, usage });
