const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
const REQUEST_PREVIEW_LENGTH = 140;
const OTHER_PROJECT_KEY = "other-tasks";

function dateMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function requestPreview(value, limit = REQUEST_PREVIEW_LENGTH) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "No text in the latest request.";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function stateForThread(thread, stateFor) {
  const state = typeof stateFor === "function" ? stateFor(thread) : null;
  return state || {
    status: thread.state === "running" ? "working" : thread.state === "aborted" ? "error" : "idle",
    stateSince: thread.stateSince || thread.lastTurnAt,
    pendingCount: 0,
    latestRequest: null,
    latestRequestAt: null,
  };
}

function requestCandidate(value, fallbackAt = null) {
  if (value && typeof value === "object") {
    return { body: value.body ?? value.request ?? "", at: value.at ?? value.requestAt ?? fallbackAt };
  }
  return { body: value ?? "", at: fallbackAt };
}

function rowActivity(row) {
  return Math.max(
    dateMs(row.lastTurnAt) || 0,
    dateMs(row.state.latestRequestAt) || 0,
    dateMs(row.state.stateSince) || 0,
  );
}

function compareRows(left, right) {
  return Number(right.pending) - Number(left.pending)
    || rowActivity(right) - rowActivity(left)
    || left.thread.id.localeCompare(right.thread.id);
}

function compareGroups(left, right) {
  if (left.other !== right.other) return left.other ? 1 : -1;
  return Number(right.hasPending) - Number(left.hasPending)
    || right.activityMs - left.activityMs
    || left.projectLabel.localeCompare(right.projectLabel);
}

export async function buildThreadDirectory(threads, options = {}) {
  const nowMs = dateMs(options.now) ?? Date.now();
  const cutoff = nowMs - RECENT_WINDOW_MS;
  const stateFor = options.stateFor;
  const latestRequest = typeof options.latestRequest === "function" ? options.latestRequest : async () => "";
  const activeThreadId = String(options.activeThreadId || "");
  const seen = new Set();
  const eligible = [];

  for (const thread of threads || []) {
    const id = String(thread?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = stateForThread(thread, stateFor);
    const pendingCount = Math.max(0, Number(state.pendingCount) || 0);
    const pending = state.status === "pending" || pendingCount > 0;
    const lastTurnMs = dateMs(thread.lastTurnAtMs) ?? dateMs(thread.lastTurnAt);
    if (!pending && (lastTurnMs === null || lastTurnMs < cutoff)) continue;
    const rolloutRequest = requestCandidate(await latestRequest(thread), thread.lastTurnAt);
    const hasServiceRequest = state.latestRequest !== null && state.latestRequest !== undefined;
    const serviceRequest = hasServiceRequest
      ? requestCandidate({ body: state.latestRequest, at: state.latestRequestAt })
      : null;
    const request = serviceRequest && (
      dateMs(serviceRequest.at) === null
      || dateMs(rolloutRequest.at) === null
      || dateMs(serviceRequest.at) >= dateMs(rolloutRequest.at)
    ) ? serviceRequest.body : rolloutRequest.body;
    eligible.push({
      thread,
      state,
      pending,
      pendingCount,
      preview: requestPreview(request),
    });
  }

  const byProject = new Map();
  for (const row of eligible) {
    const other = row.thread.groupKind === "other" || !row.thread.projectKey || !row.thread.projectLabel;
    const projectKey = other ? OTHER_PROJECT_KEY : String(row.thread.projectKey);
    const projectLabel = other ? "Other tasks" : String(row.thread.projectLabel);
    const group = byProject.get(projectKey) || { projectKey, projectLabel, other, rows: [] };
    group.rows.push(row);
    byProject.set(projectKey, group);
  }

  const groups = [...byProject.values()].map((group) => {
    group.rows.sort(compareRows);
    group.hasPending = group.rows.some((row) => row.pending);
    group.activityMs = group.rows.reduce((latest, row) => Math.max(latest, rowActivity(row)), 0);
    return group;
  }).sort(compareGroups);

  let index = 1;
  const references = [];
  const renderedGroups = groups.map((group) => ({
    projectKey: group.projectKey,
    projectLabel: group.projectLabel,
    threadCount: group.rows.length,
    hiddenCount: 0,
    threads: group.rows.map((row) => {
      references.push(`thread:${row.thread.id}`);
      return {
        id: row.thread.id,
        index: index++,
        title: row.thread.title,
        current: row.thread.id === activeThreadId,
        status: row.state.status,
        activityAt: row.thread.lastTurnAt,
        stateSince: row.state.stateSince,
        pendingCount: row.pendingCount,
        requestPreview: row.preview,
      };
    }),
  }));

  return {
    directory: {
      label: "THREADS",
      totalTasks: eligible.length,
      criteria: "pending + activity in last 48h",
      groups: renderedGroups,
      collapsedProjects: [],
      note: eligible.length
        ? "Reply with a number to open.\nUse “2: message” to open and send.\n\n/refresh · /search · /projects · /help"
        : "/refresh · /search · /projects · /help",
    },
    references,
  };
}

export const directoryConstants = {
  recentWindowMs: RECENT_WINDOW_MS,
  requestPreviewLength: REQUEST_PREVIEW_LENGTH,
  otherProjectKey: OTHER_PROJECT_KEY,
};
