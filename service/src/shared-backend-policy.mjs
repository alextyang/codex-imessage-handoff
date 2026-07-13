export function sharedBackendRecoveryDisposition({
  activeTurnLease = false,
  socketAccepts = false,
  desktopRunning = false,
  privateDesktopBackend = false,
} = {}) {
  if (activeTurnLease) return "defer-active-turn";
  if (socketAccepts && desktopRunning && !privateDesktopBackend) return "fail-open-preserve-desktop";
  return "restart";
}
