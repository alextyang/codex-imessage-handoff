/**
 * Authorize Remote Control without taking the local Messages service down
 * during an interactive authorization attempt. Once the enrollment identity
 * changes, however, the existing process must be replaced before any network
 * status request so it cannot retain authority through an older live socket.
 */
export async function authorizeRemoteControlAndActivate(options = {}) {
  const controller = options.controller;
  const hasVerifiedHelperConfig = options.hasVerifiedHelperConfig;
  const installService = options.installService;
  const rotateServiceProcess = options.rotateServiceProcess;
  if (!controller || typeof controller.authorize !== "function" || typeof controller.status !== "function") {
    throw new TypeError("Remote Control authorization requires a controller.");
  }
  if (typeof hasVerifiedHelperConfig !== "function" || typeof installService !== "function"
    || typeof rotateServiceProcess !== "function") {
    throw new TypeError("Remote Control authorization requires service lifecycle callbacks.");
  }

  const result = await controller.authorize();
  // This rotation operates on the already-installed deployment and therefore
  // cannot be bypassed by a later config, staging, or preflight failure.
  if (result.changed === true) await rotateServiceProcess();
  const configured = hasVerifiedHelperConfig();
  let installed = null;

  // Upgrade the newly rotated process transactionally when a service config is
  // available. This also runs before network status so an unpaired replacement
  // still receives the current deployment.
  if (result.changed === true && configured) {
    installed = installService({ forceRestart: true });
  }

  const status = await controller.status({ network: true });
  const paired = status.paired === true;
  if (!installed && paired && configured) {
    installed = installService({ forceRestart: true });
  }

  return { result, status, paired, configured, installed };
}
