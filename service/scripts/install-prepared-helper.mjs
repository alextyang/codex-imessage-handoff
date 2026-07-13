#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants, accessSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SPLIT_USER_BUNDLE_NAME,
  DEFAULT_SPLIT_USER_SHARED_BASE,
} from "../src/split-user-staging.mjs";
import { hasGuiSession } from "./harden-split-user-helper.mjs";

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function accountName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
    throw codedError("HELPER_INSTALL_ARGUMENT", "The dedicated Messages account name is invalid.");
  }
  return name;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function regularExecutable(file) {
  try {
    const metadata = lstatSync(file);
    accessSync(file, constants.X_OK);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function preparedHelperInstallCommand({ uid, helperUser, bundleRoot } = {}) {
  const numericUid = Number(uid);
  const username = accountName(helperUser);
  const root = realpathSync(String(bundleRoot || ""));
  const node = path.join(root, "payload", "runtime", "node", "node");
  const installer = path.join(root, "install-helper.mjs");
  if (!Number.isSafeInteger(numericUid) || numericUid < 500 || !regularExecutable(node) || !regularExecutable(installer)) {
    throw codedError("HELPER_INSTALL_BUNDLE_INVALID", "The prepared helper bundle is incomplete or unsafe.");
  }
  return [
    "/bin/launchctl",
    "asuser",
    String(numericUid),
    "/usr/bin/sudo",
    "-H",
    "-u",
    username,
    node,
    installer,
    `--bundle=${root}`,
  ].map(shellQuote).join(" ");
}

export function requestPreparedHelperInstall({
  helperUser = "codex",
  bundleRoot = path.join(DEFAULT_SPLIT_USER_SHARED_BASE, DEFAULT_SPLIT_USER_BUNDLE_NAME),
  run = execFileSync,
} = {}) {
  const username = accountName(helperUser);
  let uid;
  try {
    uid = Number(String(run("/usr/bin/id", ["-u", username], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })).trim());
  } catch (error) {
    throw codedError("HELPER_INSTALL_ACCOUNT_UNAVAILABLE", "The dedicated Messages account could not be inspected.", error);
  }
  if (!Number.isSafeInteger(uid) || uid < 500 || !hasGuiSession(username, uid)) {
    throw codedError("HELPER_GUI_SESSION_REQUIRED", "Log in to the dedicated Messages account and leave that GUI session signed in.");
  }
  const command = preparedHelperInstallCommand({ uid, helperUser: username, bundleRoot });
  let output;
  try {
    output = run("/usr/bin/osascript", [
      "-e",
      `do shell script ${JSON.stringify(command)} with administrator privileges`,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw codedError("HELPER_INSTALL_FAILED", "The dedicated Messages helper could not be installed.", error);
  }
  try {
    const result = JSON.parse(String(output || "").trim());
    if (result?.installed !== true) throw new Error("not installed");
    return { installed: true, helperUser: username, helperUid: uid };
  } catch (error) {
    throw codedError("HELPER_INSTALL_OUTPUT", "The dedicated helper installer returned invalid output.", error);
  }
}

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function main() {
  const result = requestPreparedHelperInstall({
    helperUser: argument("helper-user", "codex"),
    bundleRoot: argument("bundle", path.join(DEFAULT_SPLIT_USER_SHARED_BASE, DEFAULT_SPLIT_USER_BUNDLE_NAME)),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code || "HELPER_INSTALL_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export const installPreparedHelperInternals = Object.freeze({ accountName, shellQuote, regularExecutable });
