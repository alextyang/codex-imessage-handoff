import os from "node:os";
import path from "node:path";

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function serviceHome() {
  return process.env.IMESSAGE_HANDOFF_HOME || path.join(codexHome(), "imessage-handoff");
}

export function servicePaths() {
  const home = serviceHome();
  return {
    home,
    config: path.join(home, "config.json"),
    legacyConfig: path.join(codexHome(), "skills", "imessage-handoff", ".state", "config.json"),
    stateDb: process.env.IMESSAGE_HANDOFF_STATE_DB || path.join(codexHome(), "state_5.sqlite"),
    globalState: process.env.IMESSAGE_HANDOFF_GLOBAL_STATE || path.join(codexHome(), ".codex-global-state.json"),
    attachments: path.join(home, "attachments"),
    runState: path.join(home, "run-state.json"),
    stdoutLog: path.join(home, "service.log"),
    stderrLog: path.join(home, "service-error.log"),
    plist: path.join(os.homedir(), "Library", "LaunchAgents", "com.codex.imessage-handoff.plist"),
    hooks: path.join(codexHome(), "hooks.json"),
  };
}
