function persistenceFailure(error) {
  return Object.assign(
    new Error("The durable iMessage run queue could not be updated.", { cause: error }),
    { code: "CLAIMED_STORE_UNAVAILABLE" },
  );
}

// Admission deliberately performs one durable-store attempt. The caller's
// bounded action retry owns backoff, allowing unrelated actions to continue
// instead of waiting behind a prompt that cannot currently be persisted.
export async function admitClaimedJob({
  persist,
  cancelled = () => false,
  discard = async () => {},
  threadExists = () => true,
  missingThread = async () => {},
  enqueue,
} = {}) {
  if (typeof persist !== "function" || typeof enqueue !== "function") {
    throw new TypeError("Claimed-job admission requires persistence and enqueue callbacks.");
  }
  try {
    await persist();
  } catch (error) {
    throw persistenceFailure(error);
  }
  if (cancelled()) {
    await discard();
    return "cancelled";
  }
  if (!threadExists()) {
    await missingThread();
    await discard();
    return "missing-thread";
  }
  return await enqueue() ? "queued" : "duplicate";
}
