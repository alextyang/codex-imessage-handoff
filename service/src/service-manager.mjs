import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { servicePaths } from "./paths.mjs";

const label = "com.codex.imessage-handoff";
const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

export function removeLegacyHook() {
  const hooksPath = servicePaths().hooks;
  if (!existsSync(hooksPath)) return 0;
  const root = JSON.parse(readFileSync(hooksPath, "utf8"));
  const hooks = root.hooks && typeof root.hooks === "object" ? root.hooks : {};
  const groups = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  let removed = 0;
  hooks.Stop = groups.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group];
    const remaining = group.hooks.filter((hook) => {
      const command = typeof hook?.command === "string" ? hook.command.replaceAll("\\", "/") : "";
      const matches = command.includes("/imessage-handoff/scripts/publish-stop.js") || command.includes("/imessage-handoff/scripts/run-publish-stop.cmd");
      if (matches) removed += 1;
      return !matches;
    });
    return remaining.length ? [{ ...group, hooks: remaining }] : [];
  });
  if (hooks.Stop.length === 0) delete hooks.Stop;
  root.hooks = hooks;
  if (removed) writeJson(hooksPath, root);
  return removed;
}

function launchctl(args, tolerateFailure = false) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (tolerateFailure) return "";
    throw error;
  }
}

function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(command, env) {
  try {
    const resolved = execFileSync("/usr/bin/which", [command], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return executable(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveCodexBinary(env = process.env) {
  const override = String(env.CODEX_BIN || "").trim();
  const candidates = [
    executable(override) ? override : which(override, env),
    which("codex", env),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  const resolved = candidates.find(executable);
  if (!resolved) throw new Error("Codex executable not found. Set CODEX_BIN before installing the service.");
  return resolved;
}

export function renderLaunchAgent(paths, codexBin = resolveCodexBinary()) {
  const pathValue = [...new Set([
    path.dirname(process.execPath),
    path.dirname(codexBin),
    ...(process.env.PATH || "").split(":").filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(daemonPath)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>CODEX_HOME</key><string>${xml(path.dirname(paths.stateDb))}</string>
<key>CODEX_BIN</key><string>${xml(codexBin)}</string>
<key>PATH</key><string>${xml(pathValue)}</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(paths.stdoutLog)}</string>
<key>StandardErrorPath</key><string>${xml(paths.stderrLog)}</string>
</dict></plist>
`;
}

export function installService() {
  if (process.platform !== "darwin") throw new Error("Automatic service installation currently supports macOS only. Use `service run` elsewhere.");
  const paths = servicePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(paths.plist), { recursive: true });
  const plist = renderLaunchAgent(paths);
  writeFileSync(paths.plist, plist, "utf8");
  launchctl(["bootout", `gui/${process.getuid()}`, paths.plist], true);
  launchctl(["bootstrap", `gui/${process.getuid()}`, paths.plist]);
  launchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], true);
  return { plist: paths.plist, daemonPath, logs: [paths.stdoutLog, paths.stderrLog] };
}

export function stopService() {
  const paths = servicePaths();
  launchctl(["bootout", `gui/${process.getuid()}`, paths.plist], true);
  return { stopped: true };
}

export function uninstallService() {
  const paths = servicePaths();
  stopService();
  rmSync(paths.plist, { force: true });
  return { removed: true, plist: paths.plist };
}

export function serviceStatus() {
  const paths = servicePaths();
  const output = launchctl(["print", `gui/${process.getuid()}/${label}`], true);
  return { installed: existsSync(paths.plist), running: output.includes(`service = ${label}`) || output.includes("state = running"), logs: [paths.stdoutLog, paths.stderrLog] };
}
