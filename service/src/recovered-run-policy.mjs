export const RECOVERED_RUN_OBSERVATION_MS = 30_000;

function validTimestamp(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

// A persisted "running" claim can briefly precede the canonical rollout
// becoming observable. Wait for that evidence, but never resubmit an
// ambiguous prompt automatically: doing so can create a duplicate Codex turn.
export function unconfirmedRecoveryDisposition(
  missingSinceValue,
  { nowMs = Date.now(), observationMs = RECOVERED_RUN_OBSERVATION_MS } = {},
) {
  const duration = Math.max(1_000, Number(observationMs) || RECOVERED_RUN_OBSERVATION_MS);
  const parsed = validTimestamp(missingSinceValue);
  const parsedMs = parsed ? Date.parse(parsed) : NaN;
  const missingSince = Number.isFinite(parsedMs) && parsedMs <= nowMs
    ? parsed
    : new Date(nowMs).toISOString();
  const elapsedMs = Math.max(0, nowMs - Date.parse(missingSince));
  if (elapsedMs < duration) {
    return {
      status: "observe",
      missingSince,
      retryAfterMs: Math.max(1_000, Math.min(2_000, duration - elapsedMs)),
    };
  }
  return { status: "unconfirmed", missingSince, retryAfterMs: 0 };
}
