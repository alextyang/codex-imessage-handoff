import { randomUUID } from "node:crypto";
import {
  approvalDisclosureIsLosslesslyRenderable,
  hasConcreteCommandDisclosure,
  hasConcreteFileChangeDisclosure,
  losslessValueText,
} from "./approval-disclosure.mjs";

const MAX_QUEUE_PER_THREAD = 8;
const MAX_DISPLAY_TEXT = 8_000;
const MAX_ANSWER_TEXT = 16_000;

function clean(value, limit = MAX_DISPLAY_TEXT) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, limit) : "";
}

function compact(value, limit = 180) {
  return clean(value, limit).replace(/\s+/g, " ");
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requestKey(descriptor) {
  const method = clean(descriptor?.method, 160);
  const requestId = clean(String(descriptor?.requestId ?? ""), 160);
  return `${method}:${requestId}:${randomUUID()}`;
}

function exactString(value) {
  return typeof value === "string" ? value : "";
}

function fileChangeText(descriptor) {
  const changes = Array.isArray(descriptor?.changes) ? descriptor.changes : [];
  return changes.map((change, index) => {
    const path = exactString(change?.path) || "Unknown file";
    const type = exactString(change?.type);
    const move = exactString(change?.movePath);
    const preview = exactString(change?.preview);
    return [
      `${index + 1}. ${path}`,
      type ? `Type\n${type}` : "",
      move ? `Move to\n${move}` : "",
      preview ? `Preview\n${preview}` : "",
    ].filter((part) => part !== "").join("\n");
  }).join("\n\n");
}

function detailSection(label, value) {
  if (value === null || value === undefined) return "";
  const rendered = losslessValueText(value);
  return rendered === null || rendered === "" ? "" : `${label}\n${rendered}`;
}

function approvalDisclosureFailure(descriptor) {
  if (descriptor?.truncated === true) {
    return "The permission details exceeded the safe display limit, so this request was denied. Review it directly in Codex on the Mac.";
  }
  if (!approvalDisclosureIsLosslesslyRenderable(descriptor)) {
    return "The permission details could not be presented completely, so this request was denied. Review it directly in Codex on the Mac.";
  }
  if (descriptor?.approval === "command" && !hasConcreteCommandDisclosure(descriptor)) {
    return "The request did not include a complete, reviewable command, so it was denied. Review it directly in Codex on the Mac.";
  }
  if (descriptor?.approval === "fileChange" && !hasConcreteFileChangeDisclosure(descriptor)) {
    return "The request did not include a complete, reviewable file list, so it was denied. Review it directly in Codex on the Mac.";
  }
  return null;
}

function approvalBody(descriptor, { denialReason = null } = {}) {
  const changes = fileChangeText(descriptor);
  const details = [
    descriptor?.approval === "fileChange" ? "Codex wants to change files." : "Codex wants to run an action.",
    denialReason || "",
    detailSection("Reason", descriptor?.reason),
    detailSection("Folder", descriptor?.cwd),
    detailSection("Grant root", descriptor?.grantRoot),
    detailSection("Command", descriptor?.command),
    detailSection("Command actions", descriptor?.commandActions),
    detailSection("Environment", descriptor?.environmentId),
    detailSection("Network approval context", descriptor?.networkApprovalContext),
    detailSection("Proposed execution-policy amendment", descriptor?.proposedExecpolicyAmendment),
    detailSection("Proposed network-policy amendments", descriptor?.proposedNetworkPolicyAmendments),
    changes ? `Changes\n${changes}` : "",
    denialReason ? "" : "Choose below, or reply “allow”, “always”, or “deny”.",
  ].filter((part) => part !== "").join("\n\n");
  return details;
}

function elicitationBody(descriptor) {
  const title = descriptor?.mode === "url" ? "A connected service needs you to continue." : "A connected service needs information.";
  return clean([
    title,
    descriptor?.serverName ? `\nService\n${clean(descriptor.serverName, 300)}` : "",
    descriptor?.message ? `\n${clean(descriptor.message, 3_000)}` : "",
    descriptor?.url ? `\n${clean(descriptor.url, 2_000)}` : "",
    descriptor?.mode === "url"
      ? "\nChoose Continue, Deny, or Cancel."
      : "\nReply with a JSON object, or reply “deny” or “cancel”.",
  ].filter(Boolean).join("\n"));
}

function dynamicToolBody(descriptor) {
  const name = [clean(descriptor?.namespace, 200), clean(descriptor?.tool, 200)].filter(Boolean).join(" · ") || "Connected tool";
  let argumentsText = "";
  try {
    argumentsText = descriptor?.arguments == null ? "" : JSON.stringify(descriptor.arguments, null, 2);
  } catch {}
  return clean([
    `${name} needs a result from you.`,
    argumentsText ? `\nInput\n${clean(argumentsText, 3_000)}` : "",
    "\nReply with the result text, or reply “fail” or “cancel”.",
  ].filter(Boolean).join("\n"));
}

function normalizedOptions(question) {
  return (Array.isArray(question?.options) ? question.options : []).flatMap((option) => {
    if (typeof option === "string") {
      const label = compact(option, 220);
      return label ? [{ label, value: label }] : [];
    }
    const label = compact(option?.label ?? option?.value ?? option?.text, 220);
    if (!label) return [];
    const value = clean(String(option?.value ?? option?.label ?? option?.text ?? label), 1_000) || label;
    const description = compact(option?.description, 320);
    return [{ label: description ? `${label} · ${description}` : label, value }];
  }).slice(0, 24);
}

function userInputBody(question, position, count) {
  const heading = clean(question?.header, 300);
  const prompt = clean(question?.question, 3_000) || "Codex needs an answer.";
  return clean([
    count > 1 ? `Question ${position + 1} of ${count}` : "Codex needs your input.",
    heading ? `\n${heading}` : "",
    `\n${prompt}`,
    normalizedOptions(question).length >= 2
      ? "\nChoose below. You can also add a choice when Other is allowed."
      : "\nReply with your answer.",
  ].filter(Boolean).join("\n"));
}

function decisionFromText(value) {
  const answer = compact(value, 120).toLowerCase();
  if (["allow", "approve", "approved", "yes", "y", "once", "accept"].includes(answer)) return "accept";
  if (["always", "allow always", "allow for session", "session", "approve for session"].includes(answer)) return "acceptForSession";
  if (["deny", "denied", "decline", "no", "n"].includes(answer)) return "decline";
  if (["cancel", "abort", "stop"].includes(answer)) return "cancel";
  return null;
}

function terminalWord(value) {
  const answer = compact(value, 120).toLowerCase();
  if (["deny", "denied", "decline", "no", "n", "fail", "failed"].includes(answer)) return "decline";
  if (["cancel", "abort", "stop"].includes(answer)) return "cancel";
  return null;
}

function choiceToken(entry, value) {
  const token = `request:${randomUUID()}`;
  entry.tokens.set(token, value);
  return token;
}

function presentationGuids(result) {
  return [...new Set([
    clean(result?.guid, 256),
    ...(Array.isArray(result?.guids) ? result.guids.map((guid) => clean(guid, 256)) : []),
  ].filter(Boolean))];
}

/**
 * Serializes app-server interaction requests per Codex task while allowing
 * independent tasks to wait concurrently. It intentionally keeps no durable
 * approval state: a process loss or Remote Control disconnect makes the RPC
 * client fail closed instead of replaying authority later.
 */
export class ServerRequestBroker {
  constructor({ sendText, sendChoices, logger = null, requireReplyMatch = false } = {}) {
    if (typeof sendText !== "function" || typeof sendChoices !== "function") {
      throw new TypeError("ServerRequestBroker requires sendText and sendChoices callbacks.");
    }
    this.sendText = sendText;
    this.sendChoices = sendChoices;
    this.logger = logger;
    this.requireReplyMatch = requireReplyMatch === true;
    this.queues = new Map();
    this.activeByThread = new Map();
    this.tokenEntries = new Map();
    this.closed = false;
  }

  pending(threadId) {
    return this.activeByThread.has(clean(threadId, 256));
  }

  request(descriptor, { signal } = {}) {
    if (this.closed) return Promise.reject(codedError("CODEX_INTERACTION_STOPPED", "The mobile interaction broker is stopped."));
    const threadId = clean(descriptor?.threadId, 256);
    if (!threadId) return Promise.reject(codedError("CODEX_INTERACTION_INVALID", "The interaction request has no task context."));
    if (descriptor?.kind === "userInput" && descriptor.questions?.some((question) => question?.isSecret === true)) {
      Promise.resolve()
        .then(() => this.sendText({
          threadId,
          deliveryId: `server-request:${requestKey(descriptor)}:secret`,
          body: "Codex requested secret input. For safety, enter it directly in Codex on the Mac; secrets are never accepted through Messages.",
          descriptor,
        }))
        .catch(() => {});
      return Promise.resolve({ answers: {} });
    }
    const disclosureFailure = descriptor?.kind === "approval"
      ? approvalDisclosureFailure(descriptor)
      : null;
    if (disclosureFailure) {
      Promise.resolve()
        .then(() => this.sendText({
          threadId,
          deliveryId: `server-request:${requestKey(descriptor)}:denied`,
          body: approvalBody(descriptor, { denialReason: disclosureFailure }),
          descriptor,
        }))
        .catch(() => {});
      return Promise.resolve({ decision: "decline" });
    }
    const queue = this.queues.get(threadId) || [];
    if (queue.length + (this.activeByThread.has(threadId) ? 1 : 0) >= MAX_QUEUE_PER_THREAD) {
      return Promise.reject(codedError("CODEX_INTERACTION_OVERFLOW", "Too many interaction requests are waiting for this task."));
    }
    const entry = {
      key: requestKey(descriptor),
      descriptor,
      threadId,
      tokens: new Map(),
      presentationGuids: new Set(),
      questionIndex: 0,
      answers: {},
      settled: false,
      signal,
      abortListener: null,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    promise.catch(() => {});
    if (signal?.aborted) {
      entry.reject(codedError("CODEX_INTERACTION_ABORTED", "The interaction request ended before it could be shown."));
      return promise;
    }
    if (signal?.addEventListener) {
      entry.abortListener = () => this.#abort(entry);
      signal.addEventListener("abort", entry.abortListener, { once: true });
    }
    queue.push(entry);
    this.queues.set(threadId, queue);
    this.#activate(threadId);
    return promise;
  }

  canHandleAction(action) {
    const threadId = clean(action?.threadId, 256);
    const entry = threadId ? this.activeByThread.get(threadId) : null;
    if (!entry) return false;
    if (action?.kind === "control" && action?.command === "respond") return true;
    if (action?.kind !== "prompt") return false;
    const originator = clean(action?.threadOriginatorGuid, 256);
    return !this.requireReplyMatch || Boolean(originator && entry.presentationGuids.has(originator));
  }

  async handleAction(action, { beforeConsume = null } = {}) {
    const threadId = clean(action?.threadId, 256);
    const entry = threadId ? this.activeByThread.get(threadId) : null;
    const isTokenAction = action?.kind === "control" && action?.command === "respond";
    if (!entry) return isTokenAction ? { handled: true, stale: true } : { handled: false };

    let value = "";
    if (isTokenAction) {
      const token = clean(action?.argument, 256);
      const addedChoiceToken = clean(action?.commandArgument, 256);
      if (addedChoiceToken) {
        if (!entry.tokens.has(addedChoiceToken) || this.tokenEntries.get(addedChoiceToken) !== entry) {
          return { handled: true, stale: true };
        }
        value = clean(action?.argument, MAX_ANSWER_TEXT);
      } else {
        if (!entry.tokens.has(token) || this.tokenEntries.get(token) !== entry) {
          return { handled: true, stale: true };
        }
        value = entry.tokens.get(token);
      }
    } else if (action?.kind === "prompt") {
      const originator = clean(action?.threadOriginatorGuid, 256);
      if (this.requireReplyMatch && (!originator || !entry.presentationGuids.has(originator))) {
        return { handled: false, mismatch: true };
      }
      value = clean(action?.body, MAX_ANSWER_TEXT);
    } else {
      return { handled: false };
    }

    if (typeof beforeConsume === "function") {
      try {
        await beforeConsume(entry);
      } catch {
        return { handled: true, accepted: false, stale: false, persistenceFailed: true };
      }
    }
    try {
      const accepted = await this.#consume(entry, value);
      return { handled: true, accepted, stale: false };
    } catch (error) {
      this.#reject(entry, codedError(
        "CODEX_INTERACTION_DELIVERY_FAILED",
        clean(error?.message, 500) || "The next interaction step could not be delivered.",
      ));
      try { this.logger?.(`Codex interaction delivery failed for ${entry.threadId}.`); } catch {}
      return { handled: true, accepted: false, stale: false, deliveryFailed: true };
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    const entries = new Set([
      ...this.activeByThread.values(),
      ...[...this.queues.values()].flat(),
    ]);
    for (const entry of entries) this.#reject(entry, codedError("CODEX_INTERACTION_STOPPED", "The mobile interaction broker stopped."));
    this.queues.clear();
    this.activeByThread.clear();
    this.tokenEntries.clear();
  }

  #activate(threadId) {
    if (this.closed || this.activeByThread.has(threadId)) return;
    const queue = this.queues.get(threadId) || [];
    const entry = queue.shift();
    if (queue.length) this.queues.set(threadId, queue);
    else this.queues.delete(threadId);
    if (!entry) return;
    this.activeByThread.set(threadId, entry);
    this.#present(entry).catch((error) => this.#reject(entry, codedError(
      "CODEX_INTERACTION_DELIVERY_FAILED",
      clean(error?.message, 500) || "The interaction request could not be delivered.",
    )));
  }

  async #present(entry) {
    if (entry.settled || this.closed) return;
    entry.tokens.clear();
    entry.presentationGuids.clear();
    for (const [token, owner] of this.tokenEntries) {
      if (owner === entry) this.tokenEntries.delete(token);
    }
    const descriptor = entry.descriptor;
    let body = "Codex needs your input.";
    let choices = [];
    let allowOther = false;

    if (descriptor.kind === "approval") {
      body = approvalBody(descriptor);
      choices = [
        { label: "Allow once", value: "accept" },
        { label: "Allow for session", value: "acceptForSession" },
        { label: "Deny", value: "decline" },
      ];
    } else if (descriptor.kind === "userInput") {
      const questions = Array.isArray(descriptor.questions) ? descriptor.questions : [];
      const question = questions[entry.questionIndex];
      if (!question) {
        this.#resolve(entry, { answers: entry.answers });
        return;
      }
      body = userInputBody(question, entry.questionIndex, questions.length);
      choices = normalizedOptions(question);
      allowOther = question?.isOther === true;
    } else if (descriptor.kind === "elicitation") {
      body = elicitationBody(descriptor);
      if (descriptor.mode === "url") {
        choices = [
          { label: "Continue", value: "accept" },
          { label: "Deny", value: "decline" },
          { label: "Cancel", value: "cancel" },
        ];
      }
    } else if (descriptor.kind === "dynamicTool") {
      body = dynamicToolBody(descriptor);
    } else {
      throw codedError("CODEX_INTERACTION_UNSUPPORTED", "This interaction request is not supported remotely.");
    }

    const textResult = await this.sendText({
      threadId: entry.threadId,
      deliveryId: `server-request:${entry.key}:step:${entry.questionIndex}:text`,
      body,
      descriptor,
    });
    this.#recordPresentation(entry, textResult);
    if (entry.settled || this.closed || this.activeByThread.get(entry.threadId) !== entry) return;
    if (choices.length >= 2) {
      const prepared = choices.map((choice) => {
        const token = choiceToken(entry, choice.value);
        this.tokenEntries.set(token, entry);
        return { label: choice.label, token };
      });
      const otherToken = allowOther ? choiceToken(entry, "") : null;
      if (otherToken) this.tokenEntries.set(otherToken, entry);
      const choiceResult = await this.sendChoices({
        threadId: entry.threadId,
        deliveryId: `server-request:${entry.key}:step:${entry.questionIndex}:choices`,
        question: descriptor.kind === "approval"
          ? "Codex permission"
          : descriptor.kind === "userInput"
            ? compact(descriptor.questions?.[entry.questionIndex]?.header, 180) || "Codex question"
            : "Continue?",
        choices: prepared,
        allowOther,
        otherToken,
        descriptor,
      });
      this.#recordPresentation(entry, choiceResult);
      if (entry.settled || this.closed || this.activeByThread.get(entry.threadId) !== entry) return;
    }
  }

  async #consume(entry, rawValue) {
    if (entry.settled || this.activeByThread.get(entry.threadId) !== entry) return false;
    const descriptor = entry.descriptor;
    if (descriptor.kind === "approval") {
      const decision = ["accept", "acceptForSession", "decline", "cancel"].includes(rawValue)
        ? rawValue
        : decisionFromText(rawValue);
      if (!decision) {
        await this.#guidance(entry, "Reply “allow”, “always”, or “deny”, or use the permission choices above.");
        return false;
      }
      this.#resolve(entry, { decision });
      return true;
    }
    if (descriptor.kind === "userInput") {
      const questions = Array.isArray(descriptor.questions) ? descriptor.questions : [];
      const question = questions[entry.questionIndex];
      if (!question) return false;
      const value = clean(rawValue, MAX_ANSWER_TEXT);
      if (!value) {
        await this.#guidance(entry, "Send an answer before continuing.");
        return false;
      }
      entry.answers[clean(question.id, 512)] = [value];
      entry.questionIndex += 1;
      if (entry.questionIndex >= questions.length) this.#resolve(entry, { answers: entry.answers });
      else await this.#present(entry);
      return true;
    }
    if (descriptor.kind === "elicitation") {
      const terminal = terminalWord(rawValue);
      if (terminal) {
        this.#resolve(entry, { action: terminal });
        return true;
      }
      if (descriptor.mode === "url" && rawValue === "accept") {
        this.#resolve(entry, { action: "accept", content: null });
        return true;
      }
      if (descriptor.mode === "url") {
        await this.#guidance(entry, "Choose Continue, Deny, or Cancel.");
        return false;
      }
      const text = clean(rawValue, MAX_ANSWER_TEXT);
      try {
        const content = text ? JSON.parse(text) : {};
        if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("not an object");
        this.#resolve(entry, { action: "accept", content });
        return true;
      } catch {
        await this.#guidance(entry, "Reply with a JSON object, or reply “deny” or “cancel”.");
        return false;
      }
    }
    if (descriptor.kind === "dynamicTool") {
      const terminal = terminalWord(rawValue);
      if (terminal) {
        this.#resolve(entry, { success: false, contentItems: [] });
        return true;
      }
      const text = clean(rawValue, MAX_ANSWER_TEXT);
      if (!text) {
        await this.#guidance(entry, "Reply with the tool result text, or reply “fail”.");
        return false;
      }
      this.#resolve(entry, { success: true, contentItems: [{ type: "text", text }] });
      return true;
    }
    return false;
  }

  async #guidance(entry, body) {
    const result = await this.sendText({
      threadId: entry.threadId,
      deliveryId: `server-request:${entry.key}:guidance:${randomUUID()}`,
      body,
      descriptor: entry.descriptor,
    });
    entry.presentationGuids.clear();
    this.#recordPresentation(entry, result);
  }

  #recordPresentation(entry, result) {
    const guids = presentationGuids(result);
    if (this.requireReplyMatch && guids.length === 0) {
      throw codedError("CODEX_INTERACTION_GUID_MISSING", "The interaction message has no safe native Reply identity.");
    }
    for (const guid of guids) entry.presentationGuids.add(guid);
  }

  #resolve(entry, result) {
    if (!this.#finish(entry)) return;
    entry.resolve(result);
  }

  #reject(entry, error) {
    if (!this.#finish(entry)) return;
    entry.reject(error);
  }

  #abort(entry) {
    this.#reject(entry, codedError("CODEX_INTERACTION_ABORTED", "The interaction request expired or disconnected."));
  }

  #finish(entry) {
    if (entry.settled) return false;
    entry.settled = true;
    if (entry.abortListener && entry.signal?.removeEventListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
    for (const [token, owner] of this.tokenEntries) {
      if (owner === entry) this.tokenEntries.delete(token);
    }
    if (this.activeByThread.get(entry.threadId) === entry) {
      this.activeByThread.delete(entry.threadId);
      queueMicrotask(() => this.#activate(entry.threadId));
    } else {
      const queue = this.queues.get(entry.threadId) || [];
      const next = queue.filter((candidate) => candidate !== entry);
      if (next.length) this.queues.set(entry.threadId, next);
      else this.queues.delete(entry.threadId);
    }
    return true;
  }
}

export const serverRequestBrokerInternals = Object.freeze({
  approvalBody,
  approvalDisclosureFailure,
  hasConcreteFileChanges: hasConcreteFileChangeDisclosure,
  elicitationBody,
  dynamicToolBody,
  normalizedOptions,
  decisionFromText,
});
