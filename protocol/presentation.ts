export type ThreadStatus = "working" | "pending" | "idle" | "error";

export interface ThreadLabel {
  id?: string;
  title: string;
  projectKey?: string | null;
  projectLabel?: string | null;
}

export interface MenuItem extends ThreadLabel {
  index?: number;
  current?: boolean;
  status?: ThreadStatus | string | null;
  activityAt?: string | null;
  stateSince?: string | null;
  reasoningEffort?: string | null;
  threadCount?: number;
}

export interface ThreadDirectoryGroup {
  projectKey: string;
  projectLabel: string;
  status?: ThreadStatus | string | null;
  activityAt?: string | null;
  threadCount?: number;
  hiddenCount?: number;
  threads: MenuItem[];
}

export interface CollapsedProject {
  projectKey: string;
  projectLabel: string;
  index: number;
  status?: ThreadStatus | string | null;
  activityAt?: string | null;
  threadCount: number;
}

export interface ThreadDirectory {
  label?: "THREADS" | "PROJECTS";
  totalTasks?: number;
  groups: ThreadDirectoryGroup[];
  collapsedProjects?: CollapsedProject[];
  note?: string;
}

export interface VisibleMessage {
  body: string;
  at?: string | null;
  phase?: string | null;
}

export interface ThreadTurn {
  id?: string | null;
  state?: string | null;
  request?: string | null;
  requestAt?: string | null;
  assistantMessages?: VisibleMessage[];
  finalResponse?: string | null;
  completedAt?: string | null;
}

export type NoticeCode = "connected" | "queued" | "cancelled" | "needs-attention" | "updated";

export type OutboundEvent =
  | { kind: "thread.output"; thread: ThreadLabel; body: string }
  | { kind: "thread.progress"; thread: ThreadLabel; phase: string }
  | {
    kind: "thread.detail";
    thread: ThreadLabel;
    state: ThreadStatus | string;
    activityAt?: string | null;
    stateSince?: string | null;
    pendingCount?: number;
    reasoningEffort?: string | null;
    requestPreview?: { body: string; at?: string | null; truncated?: boolean } | string | null;
    assistantMessages?: VisibleMessage[];
    historyTruncated?: boolean;
  }
  | { kind: "thread.request"; thread: ThreadLabel; body?: string; request?: string | { body?: string; at?: string | null }; at?: string | null }
  | { kind: "thread.turn"; thread: ThreadLabel; turn: ThreadTurn | null; reasoningEffort?: string | null }
  | { kind: "thread.history"; thread: ThreadLabel; turns: Array<ThreadTurn | null>; hasMore?: boolean }
  | {
    kind: "service.reasoning";
    thread: ThreadLabel;
    current?: string | null;
    options: Array<string | { value: string; label?: string; selected?: boolean }>;
    changed?: boolean;
    invalid?: string;
    note?: string;
  }
  | { kind: "service.menu"; label?: "THREADS" | "PROJECTS" | "COMMANDS"; items?: MenuItem[]; body?: string; note?: string }
  | { kind: "service.switched"; thread: ThreadLabel }
  | { kind: "service.notice"; code: NoticeCode; body: string; thread?: ThreadLabel };

const CONTROL_PREFIX = "CODEX CONTROL · ";
const THREAD_PREFIX = "CODEX THREAD · ";
const MAX_LABEL_LENGTH = 80;

function cleanLine(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, MAX_LABEL_LENGTH);
}

function safeBody(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function dateValue(value: string | Date | number | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plural(value: number, singular: string, pluralValue = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralValue}`;
}

export function relativeTime(value: string | Date | number | null | undefined, now: string | Date | number = new Date()) {
  const thenMs = dateValue(value);
  const nowMs = dateValue(now) ?? Date.now();
  if (thenMs === null) return "unknown";
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function elapsed(value: string | null | undefined, now: string | Date | number = new Date()) {
  const ago = relativeTime(value, now);
  return ago === "now" || ago === "unknown" ? ago : ago.replace(/ ago$/, "");
}

function statusName(status: unknown) {
  if (status === "working" || status === "running") return "Working";
  if (status === "pending" || status === "queued") return "Pending";
  if (status === "error" || status === "failed" || status === "aborted") return "Error";
  return "Idle";
}

function statusLine(status: unknown, activityAt?: string | null, stateSince?: string | null, now: string | Date | number = new Date()) {
  const label = statusName(status);
  if (label === "Working") return `${label} · ${elapsed(stateSince || activityAt, now)}`;
  if (label === "Pending") return `${label} · ${relativeTime(stateSince || activityAt, now)}`;
  return `${label} · ${relativeTime(activityAt || stateSince, now)}`;
}

function reasoningName(value: unknown) {
  const text = cleanLine(value, "");
  if (!text) return null;
  if (text.toLowerCase() === "xhigh") return "Extra high";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function threadTitle(thread: ThreadLabel) {
  return cleanLine(thread.title, "Untitled task");
}

export function header(label: string) {
  return `${CONTROL_PREFIX}${cleanLine(label, "CODEX").toUpperCase()}`;
}

function threadProject(thread: ThreadLabel) {
  return cleanLine(thread.projectLabel, "CODEX").toUpperCase();
}

export function threadHeader(thread: ThreadLabel, part?: { index: number; total: number }) {
  const suffix = part && part.total > 1 ? ` · ${part.index}/${part.total}` : "";
  return `${THREAD_PREFIX}${threadProject(thread)}${suffix}`;
}

function threadContext(thread: ThreadLabel) {
  return [threadHeader(thread), threadTitle(thread)].join("\n");
}

function menuMetadata(item: MenuItem, now: string | Date | number) {
  const parts = [];
  if (item.current) parts.push("Selected");
  parts.push(statusLine(item.status, item.activityAt, item.stateSince, now));
  return parts.join(" · ");
}

export function renderThreadDirectory(directory: ThreadDirectory, options: { now?: string | Date | number } = {}) {
  const now = options.now ?? new Date();
  const groups = directory.groups ?? [];
  const collapsed = directory.collapsedProjects ?? [];
  const total = directory.totalTasks ?? (
    groups.reduce((sum, group) => sum + (group.threadCount ?? group.threads.length), 0)
    + collapsed.reduce((sum, project) => sum + project.threadCount, 0)
  );
  const sections: string[] = [
    header(directory.label === "PROJECTS" ? "PROJECTS" : "THREADS"),
    `${plural(total, "task")} · refreshed now`,
  ];

  for (const group of groups) {
    const rows = group.threads.map((item, offset) => {
      const index = item.index ?? offset + 1;
      return `${index}. ${threadTitle(item)}\n   ${menuMetadata(item, now)}`;
    });
    if (group.hiddenCount && group.hiddenCount > 0) rows.push(`   +${plural(group.hiddenCount, "more task")}`);
    sections.push(`${cleanLine(group.projectLabel, "OTHER").toUpperCase()}\n${rows.join("\n")}`);
  }

  if (collapsed.length > 0) {
    const rows = collapsed.map((project) => {
      const recency = relativeTime(project.activityAt, now);
      const active = statusName(project.status);
      const state = active === "Idle" ? recency : `${active} · ${recency}`;
      return `${project.index}. ${cleanLine(project.projectLabel, "Other")}\n   ${plural(project.threadCount, "task")} · ${state}`;
    });
    sections.push(`RECENT PROJECTS\n${rows.join("\n")}`);
  }

  if (groups.length === 0 && collapsed.length === 0) sections.push("No available tasks.");
  if (directory.note) sections.push(directory.note);
  return sections.filter(Boolean).join("\n\n");
}

export function renderThreadMenu(items: MenuItem[], options: { label?: "THREADS" | "PROJECTS"; note?: string; now?: string | Date | number } = {}) {
  const label = options.label ?? "THREADS";
  if (label === "PROJECTS") {
    const rows = items.map((item, index) => {
      const count = item.threadCount ? `${plural(item.threadCount, "task")} · ` : "";
      return `${item.index ?? index + 1}. ${threadTitle(item)}\n   ${count}${statusLine(item.status, item.activityAt, item.stateSince, options.now)}`;
    });
    return [header("PROJECTS"), rows.join("\n") || "No available projects.", options.note].filter(Boolean).join("\n\n");
  }
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) {
    const project = item.projectLabel?.trim() || "Other";
    groups.set(project, [...(groups.get(project) ?? []), { ...item, index: item.index ?? items.indexOf(item) + 1 }]);
  }
  return renderThreadDirectory({
    label: "THREADS",
    groups: [...groups.entries()].map(([projectLabel, threads]) => ({ projectKey: projectLabel, projectLabel, threads })),
    note: options.note ?? (items.length ? "Reply with a number to open." : undefined),
  }, { now: options.now });
}

export function renderHelp() {
  return [
    header("COMMANDS"),
    [
      "/threads          Browse tasks by project",
      "/search words     Find a task",
      "/projects         Browse all projects",
      "/thread           Show the selected task",
      "/request          Show its full latest request",
      "/turn             Show its current or last turn",
      "/history 3        Show completed turn history",
      "/reasoning        Show or change reasoning",
      "/cancel           Stop iMessage-started work",
      "/dismiss          Dismiss the oldest failed request",
    ].join("\n"),
    "In a menu, reply with a number to open.\nUse “2: your message” to open and continue in one step.",
  ].join("\n\n");
}

function commandLines(state: unknown) {
  const primary = "/request · /turn · /history · /reasoning";
  if (statusName(state) === "Error") return `${primary}\n/retry · /dismiss · /threads`;
  return statusName(state) === "Working" || statusName(state) === "Pending"
    ? `${primary}\n/cancel · /threads`
    : `${primary}\n/threads`;
}

function renderThreadDetail(event: Extract<OutboundEvent, { kind: "thread.detail" }>) {
  const state = statusLine(event.state, event.activityAt, event.stateSince);
  const reasoning = reasoningName(event.reasoningEffort);
  const pending = event.pendingCount && event.pendingCount > 0 ? `${event.pendingCount} pending` : null;
  const metadata = [state, pending, reasoning ? `Reasoning ${reasoning}` : null].filter(Boolean).join(" · ");
  const preview = typeof event.requestPreview === "string"
    ? { body: event.requestPreview, at: null, truncated: false }
    : event.requestPreview;
  const sections = [threadContext(event.thread), metadata, commandLines(event.state)];
  if (preview?.body) {
    sections.push(`YOU · ${relativeTime(preview.at)}\n${preview.body}${preview.truncated ? "\n/request shows the full message" : ""}`);
  }
  const messages = event.assistantMessages ?? [];
  for (const message of messages) {
    sections.push(`CODEX · ${relativeTime(message.at)}\n${safeBody(message.body, "No text response.")}`);
  }
  if (messages.length === 0) {
    const note = statusName(event.state) === "Pending"
      ? "This request is waiting for a run slot."
      : statusName(event.state) === "Working"
        ? "Codex is working; no user-visible update has arrived yet."
        : statusName(event.state) === "Error"
          ? "This request did not produce a final response. Use /retry to try it again."
          : "No assistant response was found in the available history.";
    sections.push(note);
  }
  if (event.historyTruncated) sections.push("Older content is outside the local history window. /history may show less than requested.");
  return sections.filter(Boolean).join("\n\n");
}

function normalizeRequest(event: Extract<OutboundEvent, { kind: "thread.request" }>) {
  if (typeof event.body === "string") return { body: event.body, at: event.at };
  if (typeof event.request === "string") return { body: event.request, at: event.at };
  return { body: event.request?.body || "", at: event.request?.at || event.at };
}

function renderTurn(thread: ThreadLabel, turn: ThreadTurn | null, label = "TURN") {
  const sections = [threadContext(thread), label, "/thread · /request · /history · /reasoning"];
  if (!turn) return [...sections, "No turn was found in the available history."].join("\n\n");
  if (turn.request) sections.push(`YOU · ${relativeTime(turn.requestAt)}\n${turn.request}`);
  for (const message of turn.assistantMessages ?? []) {
    sections.push(`CODEX · ${relativeTime(message.at)}\n${safeBody(message.body)}`);
  }
  const finalAlreadyShown = (turn.assistantMessages ?? []).some((message) => safeBody(message.body) === safeBody(turn.finalResponse));
  if (turn.finalResponse && !finalAlreadyShown) {
    sections.push(`CODEX · ${relativeTime(turn.completedAt)}\n${turn.finalResponse}`);
  }
  return sections.filter(Boolean).join("\n\n");
}

export function renderOutboundEvent(event: OutboundEvent) {
  if (event.kind === "thread.output") {
    return [threadContext(event.thread), safeBody(event.body)].filter(Boolean).join("\n\n");
  }
  if (event.kind === "thread.progress") {
    return [header("WORKING"), `${event.thread.projectLabel || "Codex"}\n${threadTitle(event.thread)}`, safeBody(event.phase)].join("\n\n");
  }
  if (event.kind === "thread.detail") return renderThreadDetail(event);
  if (event.kind === "thread.request") {
    const request = normalizeRequest(event);
    return [threadContext(event.thread), "LATEST REQUEST", "/thread · /turn · /history · /reasoning", `YOU · ${relativeTime(request.at)}\n${request.body || "No user request was found."}`].join("\n\n");
  }
  if (event.kind === "thread.turn") return renderTurn(event.thread, event.turn, "CURRENT / LAST TURN");
  if (event.kind === "thread.history") {
    const turns = event.turns.filter((turn): turn is ThreadTurn => Boolean(turn));
    const sections = [threadContext(event.thread), `${plural(turns.length, "COMPLETED TURN")} · newest first`, "/thread · /request · /turn · /reasoning"];
    turns.forEach((turn, index) => {
      const response = turn.finalResponse || turn.assistantMessages?.at(-1)?.body || "No final text response.";
      sections.push(`TURN ${index + 1} · ${relativeTime(turn.completedAt || turn.requestAt)}\nYOU\n${turn.request || "No request text found."}\n\nCODEX\n${response}`);
    });
    if (turns.length === 0) sections.push("No completed turns were found in the available history.");
    if (event.hasMore) sections.push("More completed turns are available. Try /history 5.");
    return sections.join("\n\n");
  }
  if (event.kind === "service.reasoning") {
    const options = event.options.map((option) => typeof option === "string" ? { value: option, label: reasoningName(option) || option } : option);
    const rows = options.map((option) => `${option.selected ? "•" : " "} ${option.label || reasoningName(option.value) || option.value}  · /reasoning ${option.value}`);
    const selected = options.find((option) => option.selected);
    const current = reasoningName(event.current);
    const selection = selected?.value === "default"
      ? `Task default${current ? ` · ${current}` : ""}`
      : selected?.label || reasoningName(selected?.value) || current || "Task default";
    const status = event.invalid
      ? `“${cleanLine(event.invalid, "value")}” is not available.`
      : event.changed
        ? `Changed: ${selection}.`
        : `Current: ${selection}`;
    return [header("REASONING"), `${event.thread.projectLabel || "Codex"}\n${threadTitle(event.thread)}`, status, rows.join("\n"), event.note].filter(Boolean).join("\n\n");
  }
  if (event.kind === "service.switched") {
    return [header("SWITCHED"), `${event.thread.projectLabel || "Codex"}\n${threadTitle(event.thread)}`, "Context selected."].join("\n\n");
  }
  if (event.kind === "service.menu") {
    if (event.label === "COMMANDS") return event.body ? [header("COMMANDS"), event.body, event.note].filter(Boolean).join("\n\n") : renderHelp();
    return renderThreadMenu(event.items ?? [], { label: event.label === "PROJECTS" ? "PROJECTS" : "THREADS", note: event.note });
  }
  const labels: Record<NoticeCode, string> = {
    connected: "CONNECTED",
    queued: "PENDING",
    cancelled: "CANCELLED",
    "needs-attention": "NEEDS ATTENTION",
    updated: "UPDATED",
  };
  return [header(labels[event.code]), event.thread ? `${event.thread.projectLabel || "Codex"}\n${threadTitle(event.thread)}` : null, safeBody(event.body)].filter(Boolean).join("\n\n");
}

export function parseMenuSelection(value: string) {
  const match = value.trim().match(/^([1-9]\d*)(?:\s*:\s*([\s\S]+))?$/);
  return match ? { index: Number(match[1]) - 1, prompt: match[2]?.trim() || null } : null;
}

export function parseSlashCommand(value: string) {
  const text = value.trim();
  const match = text.match(/^\/(threads|recent|refresh|projects|search|thread|request|message|turn|history|reasoning|status|retry|dismiss|cancel|help)(?:\s+([\s\S]+))?$/i);
  return match ? { command: match[1].toLowerCase(), argument: match[2]?.trim() || null } : null;
}
