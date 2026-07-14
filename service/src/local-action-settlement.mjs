function clean(value, limit = 256) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= limit ? text : null;
}

function normalizedNewThreadCompletion(value) {
  const flowId = clean(value?.flowId, 64);
  const threadId = clean(value?.threadId, 200);
  if (!flowId || !threadId) return null;
  return {
    flowId,
    threadId,
    updatedAt: clean(value?.updatedAt, 64),
  };
}

export function inboundAcceptanceOptions(outcome) {
  const newThreadCompletion = normalizedNewThreadCompletion(outcome?.newThreadCompletion);
  return {
    ...(clean(outcome?.reaction, 16) ? { reaction: clean(outcome.reaction, 16) } : {}),
    ...(newThreadCompletion ? { newThreadCompletion } : {}),
  };
}

// The router clears setup routing atomically with pending -> seen acceptance.
// Only the now-inert flow tombstone is removed afterward; a crash before this
// function therefore cannot replay a task or leave new-task routing active.
export function finalizeAcceptedLocalOutcome(outcome, {
  newThreadFlows,
  router,
  scheduleSynchronize = () => {},
} = {}) {
  const completion = normalizedNewThreadCompletion(outcome?.newThreadCompletion);
  if (!completion) return false;
  if (!newThreadFlows || !router) throw new TypeError("New-task acceptance cleanup is incomplete.");
  router.clearAwaitingNewPrompt(completion.flowId);
  router.clearActiveNewFlow(completion.flowId);
  newThreadFlows.remove(completion.flowId);
  scheduleSynchronize();
  return true;
}

export async function settleLocalActionOutcome(action, outcome, {
  acceptInbound,
  newThreadFlows,
  router,
  scheduleSynchronize = () => {},
} = {}) {
  if (typeof acceptInbound !== "function") throw new TypeError("Local action acceptance is unavailable.");
  const accepted = await acceptInbound(action, inboundAcceptanceOptions(outcome));
  if (!accepted) {
    throw Object.assign(new Error("The local action could not be durably accepted."), {
      code: "INBOUND_ACCEPTANCE_PENDING",
    });
  }
  finalizeAcceptedLocalOutcome(outcome, { newThreadFlows, router, scheduleSynchronize });
  return true;
}
