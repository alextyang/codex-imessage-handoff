#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_SPLIT_USER_GROUP_NAME, HELPER_FORBIDDEN_GROUP_IDS } from "../src/split-user-staging.mjs";
import { inspectMacGroup } from "../src/split-user-helper-installer.mjs";

const removableGroups = [
  "admin",
  "_appserverusr",
  "_appserveradm",
  "_appstore",
  "_lpadmin",
  "_lpoperator",
  "_developer",
  "_analyticsusers",
  "com.apple.access_ftp",
  "com.apple.access_screensharing",
  "com.apple.access_ssh",
  "com.apple.access_remote_ae",
];
// `_lpoperator` (gid 100) includes every local account indirectly through
// `localaccounts` on current macOS releases. Direct `_lpadmin` membership is
// removable; inherited `_lpoperator` membership is a platform baseline rather
// than an elevated helper grant.
const forbiddenGroupIds = new Set(HELPER_FORBIDDEN_GROUP_IDS);

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function argument(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function accountName(value, label) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
    throw codedError("HELPER_HARDEN_ARGUMENT", `The ${label} macOS account name is invalid.`);
  }
  return name;
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function userUid(username) {
  const uid = Number(run("/usr/bin/id", ["-u", username]).trim());
  if (!Number.isSafeInteger(uid) || uid < 500) {
    throw codedError("HELPER_HARDEN_ACCOUNT", "The Messages helper must be a non-system macOS GUI account.");
  }
  return uid;
}

function groupIds(username) {
  return [...new Set(run("/usr/bin/id", ["-G", username]).trim().split(/\s+/).map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 0))].sort((a, b) => a - b);
}

export function whoHasConsoleSession(value, username) {
  return String(value || "").split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[0] === username && fields[1] === "console";
  });
}

export function hasGuiSession(username, uid) {
  try {
    run("/bin/launchctl", ["print", `gui/${uid}`], { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
    return true;
  } catch {
    // launchctl deliberately denies one GUI user permission to inspect another
    // user's domain. `who` still exposes logged-in console sessions without
    // crossing that boundary.
  }
  try {
    return whoHasConsoleSession(run("/usr/bin/who", []), username);
  } catch {
    return false;
  }
}

function allGroupNames() {
  return run("/usr/bin/dscl", [".", "-list", "/Groups"]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function groupExists(name) {
  try { inspectMacGroup(name); return true; } catch { return false; }
}

function nextDedicatedGid() {
  const used = new Set(allGroupNames().flatMap((name) => {
    try { return [inspectMacGroup(name).gid]; } catch { return []; }
  }));
  for (let gid = 700; gid < 2_000; gid += 1) if (!used.has(gid)) return gid;
  throw codedError("HELPER_HARDEN_GROUP", "No safe local group id is available for the helper exchange.");
}

function editGroup(args, tolerateFailure = false) {
  try { return run("/usr/sbin/dseditgroup", args); } catch (error) {
    if (tolerateFailure) return "";
    throw error;
  }
}

export function applyHelperAccountHardening({ controllerUser, helperUser, groupName } = {}) {
  if (process.getuid?.() !== 0) throw codedError("HELPER_HARDEN_ROOT_REQUIRED", "Administrator authorization is required.");
  const controller = accountName(controllerUser, "controller");
  const helper = accountName(helperUser, "helper");
  if (controller === helper) throw codedError("HELPER_HARDEN_ACCOUNT", "The controller and helper must be separate macOS accounts.");
  userUid(controller);
  const helperUid = userUid(helper);

  const sharepointGroups = allGroupNames().filter((name) => name.startsWith("com.apple.sharepoint.group."));
  for (const name of [...new Set([...removableGroups, ...sharepointGroups])]) {
    editGroup(["-o", "edit", "-d", helper, "-t", "user", name], true);
  }

  const dedicatedName = accountName(groupName, "dedicated group");
  if (!groupExists(dedicatedName)) {
    editGroup(["-o", "create", "-i", String(nextDedicatedGid()), "-r", "Codex Messages two-account IPC", dedicatedName]);
  }
  let dedicated = inspectMacGroup(dedicatedName);
  if (dedicated.gid < 500) throw codedError("HELPER_HARDEN_GROUP", "The existing helper exchange group uses a system group id.");
  for (const member of dedicated.members) {
    if (member !== controller && member !== helper) {
      editGroup(["-o", "edit", "-d", member, "-t", "user", dedicatedName]);
    }
  }
  editGroup(["-o", "edit", "-a", controller, "-t", "user", dedicatedName]);
  editGroup(["-o", "edit", "-a", helper, "-t", "user", dedicatedName]);
  dedicated = inspectMacGroup(dedicatedName);
  const expectedMembers = [controller, helper].sort();
  dedicated.members.sort();
  if (dedicated.members.length !== 2 || dedicated.members.some((value, index) => value !== expectedMembers[index])) {
    throw codedError("HELPER_HARDEN_GROUP", "The helper exchange group could not be reduced to exactly two accounts.");
  }
  const remainingForbidden = groupIds(helper).filter((gid) => forbiddenGroupIds.has(gid));
  if (remainingForbidden.length) {
    throw codedError("HELPER_HARDEN_PRIVILEGE", `The helper account still inherits forbidden groups: ${remainingForbidden.join(", ")}.`);
  }
  return {
    hardened: true,
    helperUser: helper,
    helperUid,
    sharedGroup: dedicated,
    messagesDataChanged: false,
    secureTokenChanged: false,
    reloginRequired: true,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function requestHelperAccountHardening({ controllerUser, helperUser, groupName } = {}) {
  const controller = accountName(controllerUser || os.userInfo().username, "controller");
  const helper = accountName(helperUser || "codex", "helper");
  const group = accountName(groupName || DEFAULT_SPLIT_USER_GROUP_NAME, "dedicated group");
  const uid = userUid(helper);
  if (!hasGuiSession(helper, uid)) {
    throw codedError("HELPER_GUI_SESSION_REQUIRED", "Log in to the dedicated Messages account before hardening it.");
  }
  const script = realpathSync(fileURLToPath(import.meta.url));
  const command = [
    process.execPath,
    script,
    "--apply",
    `--controller-user=${controller}`,
    `--helper-user=${helper}`,
    `--group=${group}`,
  ].map(shellQuote).join(" ");
  const output = run("/usr/bin/osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`], {
    timeout: 5 * 60_000,
  });
  try { return JSON.parse(output); } catch (error) {
    throw codedError("HELPER_HARDEN_OUTPUT", "The administrator hardening step returned invalid output.", error);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const options = {
    controllerUser: argument(argv, "controller-user", process.getuid?.() === 0 ? "" : os.userInfo().username),
    helperUser: argument(argv, "helper-user", "codex"),
    groupName: argument(argv, "group", DEFAULT_SPLIT_USER_GROUP_NAME),
  };
  const result = argv.includes("--apply")
    ? applyHelperAccountHardening(options)
    : requestHelperAccountHardening(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code || "HELPER_HARDEN_FAILED"}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
