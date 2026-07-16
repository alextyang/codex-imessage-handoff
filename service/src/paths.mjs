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
    stateDb: process.env.IMESSAGE_HANDOFF_STATE_DB || path.join(codexHome(), "state_5.sqlite"),
    sessionIndex: process.env.IMESSAGE_HANDOFF_SESSION_INDEX || path.join(codexHome(), "session_index.jsonl"),
    sessions: path.join(codexHome(), "sessions"),
    globalState: process.env.IMESSAGE_HANDOFF_GLOBAL_STATE || path.join(codexHome(), ".codex-global-state.json"),
    attachments: path.join(home, "attachments"),
    serviceReadinessState: path.join(home, "service-readiness.json"),
    presenceState: path.join(home, "presence-state.json"),
    runState: path.join(home, "run-state.json"),
    completionState: path.join(home, "completion-state.json"),
    multiLiveMirrorState: path.join(home, "live-mirrors"),
    imsgState: path.join(home, "imsg-state.json"),
    localUserMirrorState: path.join(home, "local-user-mirror.json"),
    hiddenControllerState: path.join(home, "hidden-controller.json"),
    hiddenControllerWorkspace: path.join(home, "controller-workspace"),
    remoteControlClient: path.join(home, "remote-control-client.json"),
    remoteControlStatus: path.join(home, "remote-control-status.json"),
    remoteControlKeyHelper: path.join(home, "bin", "remote-control-key-helper"),
    remoteControlKeyHelperManifest: path.join(home, "remote-control-key-helper.json"),
    deployments: path.join(home, "deployments"),
    serviceDeploymentState: path.join(home, "service-deployment.json"),
    stdoutLog: path.join(home, "service.log"),
    stderrLog: path.join(home, "service-error.log"),
    plist: path.join(os.homedir(), "Library", "LaunchAgents", "com.codex.imessage-handoff.plist"),
  };
}
