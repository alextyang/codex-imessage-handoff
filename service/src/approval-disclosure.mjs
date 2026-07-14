function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value) {
  return value === null || value === undefined || typeof value === "string";
}

export function losslessJsonText(value) {
  try {
    const rendered = JSON.stringify(value, null, 2);
    return typeof rendered === "string" ? rendered : null;
  } catch {
    return null;
  }
}

export function losslessValueText(value) {
  if (typeof value === "string") return value;
  return losslessJsonText(value);
}

function hasNonEmptyCommandValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value)
    && value.length > 0
    && value.every((part) => typeof part === "string")
    && value.some((part) => part.trim().length > 0);
}

function hasUsableCommandAction(action) {
  if (typeof action === "string") return action.trim().length > 0;
  if (!isRecord(action)) return false;
  return hasNonEmptyCommandValue(action.command)
    || hasNonEmptyCommandValue(action.cmd)
    || hasNonEmptyCommandValue(action.text);
}

export function hasConcreteCommandDisclosure(descriptor) {
  if (hasNonEmptyCommandValue(descriptor?.command)) return true;
  return Array.isArray(descriptor?.commandActions)
    && descriptor.commandActions.length > 0
    && descriptor.commandActions.every(hasUsableCommandAction);
}

export function hasConcreteFileChangeDisclosure(descriptor) {
  return Array.isArray(descriptor?.changes)
    && descriptor.changes.length > 0
    && descriptor.changes.every((change) => (
      isRecord(change) && typeof change.path === "string" && change.path.trim().length > 0
    ));
}

function optionalJsonIsRenderable(value) {
  return value === null || value === undefined || losslessJsonText(value) !== null;
}

/**
 * Every field checked here is rendered by the Messages approval body without
 * slicing. Keep this shared predicate at both the presentation and app-server
 * response boundaries so a custom handler cannot grant authority for details
 * the mobile approval surface could not reproduce losslessly.
 */
export function approvalDisclosureIsLosslesslyRenderable(descriptor) {
  if (!isRecord(descriptor)
    || !isOptionalString(descriptor.reason)
    || !isOptionalString(descriptor.cwd)) return false;

  if (descriptor.approval === "command") {
    return isOptionalString(descriptor.environmentId)
      && optionalJsonIsRenderable(descriptor.command)
      && optionalJsonIsRenderable(descriptor.commandActions)
      && optionalJsonIsRenderable(descriptor.networkApprovalContext)
      && optionalJsonIsRenderable(descriptor.proposedExecpolicyAmendment)
      && optionalJsonIsRenderable(descriptor.proposedNetworkPolicyAmendments);
  }

  if (descriptor.approval === "fileChange") {
    if (!isOptionalString(descriptor.grantRoot)) return false;
    if (descriptor.changes === null || descriptor.changes === undefined) return true;
    return Array.isArray(descriptor.changes) && descriptor.changes.every((change) => (
      isRecord(change)
      && isOptionalString(change.path)
      && isOptionalString(change.type)
      && isOptionalString(change.preview)
      && isOptionalString(change.movePath)
    ));
  }

  return false;
}
