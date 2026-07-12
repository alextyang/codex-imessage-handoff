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
  const historyFor = typeof options.historyFor === "function" ? options.historyFor : null;
  const latestRequest = typeof options.latestRequest === "function" ? options.latestRequest : async () => "";
  const activeThreadId = String(options.activeThreadId || "");
  const seen = new Set();
  const eligible = [];
  const projectStartedAtMs = new Map();

  // Project identity is seeded from the project's true catalog lifetime, not
  // just whichever recent rows survive the 48-hour directory filter.
  for (const thread of threads || []) {
    if (thread?.groupKind === "other" || !thread?.projectKey || !thread?.projectLabel) continue;
    const createdAtMs = dateMs(thread.projectStartedAt) ?? dateMs(thread.createdAt);
    if (createdAtMs === null) continue;
    const key = String(thread.projectKey);
    projectStartedAtMs.set(key, Math.min(projectStartedAtMs.get(key) ?? Number.POSITIVE_INFINITY, createdAtMs));
  }

  for (const thread of threads || []) {
    const id = String(thread?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = stateForThread(thread, stateFor);
    const pendingCount = Math.max(0, Number(state.pendingCount) || 0);
    const pending = state.status === "pending" || pendingCount > 0;
    const lastTurnMs = dateMs(thread.lastTurnAtMs) ?? dateMs(thread.lastTurnAt);
    if (!pending && (lastTurnMs === null || lastTurnMs < cutoff)) continue;
    // Directory commands make one complete history read per visible thread and
    // reuse it for both the preview and the turn count.
    const history = historyFor ? await historyFor(thread) : null;
    const historyTurn = history?.currentTurn || history?.latestTurn || null;
    const rolloutRequest = requestCandidate(
      historyFor
        ? { body: historyTurn?.request || "", at: historyTurn?.startedAt || thread.lastTurnAt }
        : await latestRequest(thread),
      thread.lastTurnAt,
    );
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
      turnCount: Math.max(0, Number(history?.turnCount ?? history?.turns?.length) || 0),
      turnCountLowerBound: Boolean(history?.turnCountLowerBound ?? history?.truncated),
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
    ...(group.other || !projectStartedAtMs.has(group.projectKey)
      ? {}
      : { startedAt: new Date(projectStartedAtMs.get(group.projectKey)).toISOString() }),
    threadCount: group.rows.length,
    hiddenCount: 0,
    threads: group.rows.map((row) => {
      references.push(`thread:${row.thread.id}`);
      return {
        id: row.thread.id,
        index: index++,
        title: row.thread.title,
        createdAt: row.thread.createdAt || null,
        current: row.thread.id === activeThreadId,
        status: row.state.status,
        activityAt: row.thread.lastTurnAt,
        stateSince: row.state.stateSince,
        pendingCount: row.pendingCount,
        requestPreview: row.preview,
        turnCount: row.turnCount,
        turnCountLowerBound: row.turnCountLowerBound,
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
        ? "Reply with a number to open that thread. Add “1 (message)” to directly message the thread.\n“/projects” - See all projects\n“/search” - Show threads with specific text"
        : "“/projects” - See all projects\n“/search” - Show threads with specific text",
    },
    references,
  };
}

export const directoryConstants = {
  recentWindowMs: RECENT_WINDOW_MS,
  requestPreviewLength: REQUEST_PREVIEW_LENGTH,
  otherProjectKey: OTHER_PROJECT_KEY,
};
