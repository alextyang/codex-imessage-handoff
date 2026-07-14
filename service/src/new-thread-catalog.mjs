import { normalizeAppServerTimestamp } from "./app-server-timestamp.mjs";

/**
 * Shape a newly created app-server task for the local catalog before Codex has
 * generated its sidebar name. The first request is deliberately not accepted
 * here: it is message content, never a task title.
 */
export function normalizeCreatedThread(thread, flow) {
  const fallback = new Date().toISOString();
  const createdAt = normalizeAppServerTimestamp(thread.createdAt, fallback);
  const updatedAt = normalizeAppServerTimestamp(thread.updatedAt, createdAt);
  return {
    ...thread,
    id: String(thread.id),
    title: "Untitled task",
    sidebarTitle: null,
    cwd: flow.cwd,
    workspaceRoot: flow.otherTask ? null : flow.cwd,
    groupKind: flow.otherTask ? "other" : "project",
    projectKey: flow.otherTask ? null : flow.projectKey,
    projectLabel: flow.otherTask ? null : flow.projectLabel,
    projectStartedAt: flow.otherTask ? null : flow.projectStartedAt || createdAt,
    createdAt,
    updatedAt,
    recencyAt: normalizeAppServerTimestamp(thread.recencyAt, updatedAt),
    activityAt: normalizeAppServerTimestamp(thread.activityAt, updatedAt),
    stateSince: normalizeAppServerTimestamp(thread.stateSince, updatedAt),
    state: thread.state || "idle",
    visible: true,
    threadSource: flow.threadSource,
  };
}
