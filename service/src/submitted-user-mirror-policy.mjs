function nativeReplyOriginator(action) {
  return typeof action?.threadOriginatorGuid === "string"
    ? action.threadOriginatorGuid.trim()
    : "";
}

/**
 * A prompt already sent inside a native Messages Reply thread is visible in
 * the right task context and must not be echoed. A top-level prompt is only
 * assigned to a task by the router, so its canonical Codex user record needs
 * to be mirrored into that task's native Reply thread.
 */
export function submittedUserMirrorMode(action) {
  return nativeReplyOriginator(action) ? "suppress" : "mirror";
}

/**
 * Legacy claimed jobs predate the persisted mode. Preserve their original
 * one-shot suppression behavior; every newly claimed prompt records a mode.
 */
export function shouldSuppressSubmittedUserMirror(claim) {
  return claim?.userMirrorMode !== "mirror";
}
