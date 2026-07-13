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
    globalState: process.env.IMESSAGE_HANDOFF_GLOBAL_STATE || path.join(codexHome(), ".codex-global-state.json"),
    attachments: path.join(home, "attachments"),
    serviceReadinessState: path.join(home, "service-readiness.json"),
    presenceState: path.join(home, "presence-state.json"),
    runState: path.join(home, "run-state.json"),
    completionState: path.join(home, "completion-state.json"),
    multiLiveMirrorState: path.join(home, "live-mirrors"),
    imsgState: path.join(home, "imsg-state.json"),
    desktopSyncState: path.join(home, "desktop-sync-state.json"),
    sharedBackendSupervisorState: path.join(home, "shared-backend-supervisor-state.json"),
    sharedBackendSupervisorConfig: path.join(home, "shared-backend-supervisor-config.json"),
    sharedBackendTurnLease: path.join(home, "shared-backend-turn-lease.json"),
    deployments: path.join(home, "deployments"),
    serviceDeploymentState: path.join(home, "service-deployment.json"),
    sharedBackendDeploymentState: path.join(home, "shared-backend-deployment.json"),
    stdoutLog: path.join(home, "service.log"),
    stderrLog: path.join(home, "service-error.log"),
    sharedBackendSupervisorStdoutLog: path.join(home, "shared-backend-supervisor.log"),
    sharedBackendSupervisorStderrLog: path.join(home, "shared-backend-supervisor-error.log"),
    plist: path.join(os.homedir(), "Library", "LaunchAgents", "com.codex.imessage-handoff.plist"),
    sharedBackendSupervisorPlist: path.join(os.homedir(), "Library", "LaunchAgents", "com.codex.imessage-handoff.shared-backend.plist"),
  };
}
