function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function manualSelectionLease(action, currentLease) {
  const threadId = clean(action?.threadId);
  const selectedAt = clean(action?.createdAt);
  if (!threadId || !selectedAt) return null;
  if (clean(currentLease?.threadId) !== threadId) return null;
  if (clean(currentLease?.selectedAt) !== selectedAt) return null;
  const expiresAt = clean(currentLease?.expiresAt);
  if (!expiresAt) return null;
  return Object.freeze({ threadId, selectedAt, expiresAt });
}

export function isManualSelectionLeaseCurrent(expected, current) {
  return Boolean(expected
    && clean(current?.threadId) === expected.threadId
    && clean(current?.selectedAt) === expected.selectedAt
    && clean(current?.expiresAt) === expected.expiresAt);
}

export function manualSelectionCancellationNotice({
  selectionCleared = false,
  active = false,
  pending = 0,
  claiming = 0,
} = {}) {
  if (active === true) return null;
  const removed = Math.max(0, Number(pending) || 0) + Math.max(0, Number(claiming) || 0);
  if (removed > 0) {
    return {
      code: "cancelled",
      body: `Removed ${removed} pending message${removed === 1 ? "" : "s"}.`,
    };
  }
  if (selectionCleared === true) {
    return { code: "cancelled", body: "Task selection cancelled." };
  }
  return { code: "needs-attention", body: "There is no iMessage-started work to cancel." };
}

// Manual selection intentionally runs concurrently with an immediate stop
// reaction.
// Treat the persisted awaiting-prompt lease as a generation token and check it
// again before every outbound message, so an older selection cannot continue
// presenting after cancellation, prompt consumption, or a newer selection.
export async function presentManualSelection({
  lease,
  currentLease,
  buildDetail,
  sendHeader,
  buildTurn,
  sendTurn,
  sendPrompt,
}) {
  const isCurrent = () => isManualSelectionLeaseCurrent(lease, currentLease());
  const stale = (stage) => ({ status: "stale", stage });

  if (!isCurrent()) return stale("before-detail");
  const detail = await buildDetail();
  if (!isCurrent()) return stale("before-header");
  await sendHeader(detail);

  if (!isCurrent()) return stale("before-turn-build");
  const turn = await buildTurn(detail);
  if (!isCurrent()) return stale("before-turn");
  await sendTurn(detail, turn);

  if (!isCurrent()) return stale("before-prompt");
  await sendPrompt(detail);
  return { status: "sent", stage: "complete" };
}
