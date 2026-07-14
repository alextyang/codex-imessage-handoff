const DEFAULT_RECONCILE_DELAYS_MS = Object.freeze([0, 250, 750, 1_500]);
const AMBIGUOUS_CREATE_CODES = new Set([
  "CODEX_DISCONNECTED",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_TIMEOUT",
]);

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function clean(value, limit = 512) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= limit ? text : null;
}

function requireFlow(store, flowId, changes) {
  const updated = store.update(flowId, changes);
  if (!updated) throw codedError("NEW_THREAD_FLOW_EXPIRED", "The new-task setup expired.");
  return updated;
}

function boundedAttachments(value) {
  return Array.isArray(value) ? structuredClone(value.slice(0, 5)) : [];
}

function queueAdmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { accepted: Boolean(value), reaction: null };
  }
  return {
    accepted: value.accepted === true,
    reaction: clean(value.reaction, 16),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedReconcileDelays(value) {
  const candidate = Array.isArray(value) ? value : DEFAULT_RECONCILE_DELAYS_MS;
  return candidate
    .slice(0, 8)
    .map((delay) => Math.min(5_000, Math.max(0, Number(delay) || 0)));
}

async function reconcileAmbiguousCreation(current, findThread, wait, delays) {
  for (const delay of boundedReconcileDelays(delays)) {
    if (delay > 0) await wait(delay);
    const thread = await findThread(current);
    if (thread) return thread;
  }
  return null;
}

function persistedCreationIntent(flow, action, promptValue, attachments, store) {
  const submissionKey = clean(action?.messageKey, 256);
  if (!submissionKey) {
    throw codedError("NEW_THREAD_SUBMISSION_INVALID", "The new-task submission has no durable message key.");
  }
  if (flow.submissionKey && flow.submissionKey !== submissionKey) {
    return { status: "stale", flow };
  }

  if (flow.stage === "creating" || flow.stage === "queued") {
    // Flows written by the previous schema can be recovered by the one durable
    // inbound action that was already pending when the daemon restarted.
    const needsMigration = !flow.submissionKey;
    const prompt = needsMigration
      ? String(promptValue ?? flow.prompt ?? "").trim().slice(0, 32_000)
      : flow.prompt;
    const storedAttachments = needsMigration
      ? boundedAttachments(attachments?.length ? attachments : flow.attachments)
      : boundedAttachments(flow.attachments);
    const migrated = needsMigration
      ? requireFlow(store, flow.id, { submissionKey, prompt, attachments: storedAttachments })
      : flow;
    return {
      status: migrated.stage,
      flow: migrated,
      prompt: migrated.prompt,
      attachments: boundedAttachments(migrated.attachments),
    };
  }

  if (flow.stage !== "reasoning" && flow.stage !== "prompt") {
    return { status: "stale", flow };
  }
  const prompt = String(promptValue ?? flow.prompt ?? "").trim().slice(0, 32_000);
  const storedAttachments = boundedAttachments(attachments);
  const creating = requireFlow(store, flow.id, {
    stage: "creating",
    submissionKey,
    prompt,
    attachments: storedAttachments,
    createAttemptedAt: null,
  });
  return { status: "creating", flow: creating, prompt, attachments: storedAttachments };
}

/**
 * Move a project vote to its reasoning poll without making the durable vote
 * one-shot. If poll delivery is ambiguous, replaying the same inbound action
 * reuses the persisted project and the transport's stable operation id.
 */
export async function resumeNewProjectSelection({
  flow,
  projectKey,
  store,
  resolveProject,
  publishReasoning,
} = {}) {
  if (!flow || !store || typeof resolveProject !== "function" || typeof publishReasoning !== "function") {
    throw new TypeError("New-task project orchestration is incomplete.");
  }
  const requestedKey = clean(projectKey, 256);
  if (!requestedKey) return { status: "missing", flow };

  let selected = flow;
  if (flow.stage === "reasoning") {
    if (flow.projectKey !== requestedKey) return { status: "stale", flow };
  } else if (flow.stage === "project") {
    const selection = await resolveProject(requestedKey);
    if (!selection) return { status: "missing", flow };
    if (clean(selection.projectKey, 256) !== requestedKey) {
      throw codedError("NEW_THREAD_PROJECT_MISMATCH", "The selected project changed during new-task setup.");
    }
    selected = requireFlow(store, flow.id, { ...selection, stage: "reasoning" });
  } else {
    return { status: "stale", flow };
  }

  await publishReasoning(selected);
  return { status: "reasoning", flow: selected };
}

/**
 * Persist the reasoning vote before exposing the temporary first-message
 * lease. Replaying that same durable vote restores a missing lease and uses
 * the caller's stable local-action delivery id for an idempotent notice.
 */
export async function resumeNewPromptCollection({
  flow,
  action,
  reasoning,
  store,
  activatePrompt,
  publishPrompt,
} = {}) {
  if (!flow || !store || typeof activatePrompt !== "function" || typeof publishPrompt !== "function") {
    throw new TypeError("New-task prompt orchestration is incomplete.");
  }
  const actionKey = clean(action?.messageKey, 256);
  const selectedReasoning = clean(reasoning, 32);
  if (!actionKey || !selectedReasoning) return { status: "stale", flow };

  let waiting = flow;
  if (flow.stage === "reasoning") {
    waiting = requireFlow(store, flow.id, {
      stage: "prompt",
      reasoning: selectedReasoning,
      promptSetupKey: actionKey,
    });
  } else if (flow.stage === "prompt") {
    if ((flow.promptSetupKey && flow.promptSetupKey !== actionKey)
      || (flow.reasoning && flow.reasoning !== selectedReasoning)) {
      return { status: "stale", flow };
    }
    if (!flow.promptSetupKey) waiting = requireFlow(store, flow.id, { promptSetupKey: actionKey });
  } else {
    return { status: "stale", flow };
  }

  await activatePrompt(waiting, action);
  await publishPrompt(waiting, action);
  return { status: "prompt", flow: waiting };
}

/**
 * Replay-safe task creation and queue admission. The deterministic thread
 * source is always reconciled before thread/start. Because threadSource is a
 * lookup hint rather than an app-server idempotency key, an ambiguous start is
 * never issued again: bounded reconciliation may discover its late commit,
 * otherwise the durable flow remains explicitly unresolved for later lookup.
 */
export async function resumeNewThreadCreation({
  flow,
  action,
  promptValue = flow?.prompt,
  attachments = flow?.attachments,
  store,
  findThread,
  createThread,
  normalizeThread = (thread) => thread,
  prepareThread = async () => {},
  queuePrompt,
  now = () => Date.now(),
  wait = sleep,
  reconcileDelaysMs = DEFAULT_RECONCILE_DELAYS_MS,
} = {}) {
  if (!flow || !store || typeof findThread !== "function" || typeof createThread !== "function"
    || typeof queuePrompt !== "function") {
    throw new TypeError("New-task creation orchestration is incomplete.");
  }

  const intent = persistedCreationIntent(flow, action, promptValue, attachments, store);
  if (intent.status === "stale") return intent;
  let current = intent.flow;
  const prompt = intent.prompt ?? current.prompt ?? "";
  const storedAttachments = boundedAttachments(intent.attachments ?? current.attachments);
  if (current.stage === "queued") {
    return { status: "queued", flow: current, thread: null, replayed: true };
  }

  let thread = await findThread(current);
  if (!thread) {
    if (current.threadId || current.createAttemptedAt) {
      throw codedError(
        "NEW_THREAD_CREATION_UNRESOLVED",
        "Codex has not exposed the task created by the earlier request; refusing to create a duplicate.",
      );
    }

    const attemptedAt = Number(now());
    current = requireFlow(store, current.id, {
      createAttemptedAt: new Date(Number.isFinite(attemptedAt) ? attemptedAt : Date.now()).toISOString(),
    });
    try {
      thread = await createThread(current);
    } catch (error) {
      if (AMBIGUOUS_CREATE_CODES.has(String(error?.code || ""))) {
        thread = await reconcileAmbiguousCreation(current, findThread, wait, reconcileDelaysMs);
        if (!thread) {
          throw codedError(
            "NEW_THREAD_CREATION_UNRESOLVED",
            "Codex may have accepted the task creation request; refusing to create a duplicate.",
            error,
          );
        }
      } else {
        requireFlow(store, current.id, { createAttemptedAt: null });
        throw error;
      }
    }
  }

  const threadId = clean(thread?.id, 200);
  if (!threadId) {
    throw codedError("CODEX_PROTOCOL_ERROR", "Codex did not return a valid task identifier.");
  }
  current = requireFlow(store, current.id, { threadId, createAttemptedAt: null });
  const prepared = await normalizeThread(thread, current, prompt);
  await prepareThread(prepared, current);
  const admission = queueAdmission(await queuePrompt({
    flow: current,
    action,
    thread: prepared,
    prompt,
    attachments: storedAttachments,
  }));
  if (!admission.accepted) {
    current = requireFlow(store, current.id, {
      stage: "prompt",
      threadId,
      submissionKey: null,
      createAttemptedAt: null,
    });
    return { status: "needs-prompt", flow: current, thread: prepared };
  }

  current = requireFlow(store, current.id, { stage: "queued", threadId, createAttemptedAt: null });
  return { status: "queued", flow: current, thread: prepared, replayed: false, admission };
}

export const newThreadOrchestrationInternals = Object.freeze({
  ambiguousCreateCodes: AMBIGUOUS_CREATE_CODES,
  defaultReconcileDelaysMs: DEFAULT_RECONCILE_DELAYS_MS,
});
