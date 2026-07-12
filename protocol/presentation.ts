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
  pendingCount?: number;
  requestPreview?: string | null;
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
  criteria?: string;
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
  | { kind: "thread.completed"; completionId: string; thread: ThreadLabel; body: string; completedAt?: string | null }
  | {
    kind: "thread.live-message";
    messageId: string;
    thread: ThreadLabel;
    role: "user" | "assistant";
    phase?: string | null;
    body: string;
    at?: string | null;
  }
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
    deliveryId?: string;
    reason?: "fork" | null;
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
  | { kind: "service.directory"; directory: ThreadDirectory }
  | { kind: "service.switched"; thread: ThreadLabel; reason?: "fork" | null }
  | { kind: "service.presence"; state: "online" | "offline" }
  | { kind: "service.notice"; code: NoticeCode; body: string; thread?: ThreadLabel };

const CONTROL_PREFIX = "CODEX CONTROL · ";
const THREAD_PREFIX = "CODEX THREAD · ";
const LIVE_PREFIX = "CODEX LIVE · ";
const HEADER_RULE = "────────────────────────";
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
  const chip = `[${label.toUpperCase()}]`;
  const time = label === "Working"
    ? elapsed(stateSince || activityAt, now)
    : relativeTime(label === "Pending" ? stateSince || activityAt : activityAt || stateSince, now);
  return time === "unknown" ? chip : `${chip} ${time}`;
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
  return `${CONTROL_PREFIX}${cleanLine(label, "CODEX").toUpperCase()}\n${HEADER_RULE}`;
}

function threadProject(thread: ThreadLabel) {
  return cleanLine(thread.projectLabel, "CODEX").toUpperCase();
}

export function threadHeader(thread: ThreadLabel, part?: { index: number; total: number }) {
  const suffix = part && part.total > 1 ? ` · ${part.index}/${part.total}` : "";
  return `${THREAD_PREFIX}${threadProject(thread)}${suffix}\n${HEADER_RULE}`;
}

function threadContext(thread: ThreadLabel) {
  return [threadHeader(thread), threadTitle(thread)].join("\n\n");
}

function menuMetadata(item: MenuItem, now: string | Date | number) {
  const state = `${item.current ? "[SELECTED] " : ""}${statusLine(item.status, item.activityAt, item.stateSince, now)}`;
  const parts = [state];
  const pending = Math.max(0, Number(item.pendingCount) || 0);
  if (pending > 0 && (statusName(item.status) !== "Pending" || pending > 1)) {
    parts.push(`${pending} QUEUED`);
  }
  return parts.join(" · ");
}

function requestPreview(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length <= 160 ? text : `${text.slice(0, 159).trimEnd()}…`;
}

function sentenceCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function directoryGroupLabel(group: ThreadDirectoryGroup) {
  const label = cleanLine(group.projectLabel, "Other tasks");
  const count = group.threadCount ?? group.threads.length + Math.max(0, group.hiddenCount ?? 0);
  const namespace = label.toLowerCase() === "other tasks" ? "OTHER TASKS" : `PROJECT · ${label.toUpperCase()}`;
  return `${namespace} · ${plural(count, "task").toUpperCase()}`;
}

function renderDirectoryFooter(note: string) {
  const blocks = safeBody(note).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return "";
  const optionIndex = blocks.findIndex((block) => block.startsWith("/"));
  if (optionIndex > 0) {
    const reply = blocks.slice(0, optionIndex).join("\n\n");
    const options = blocks.slice(optionIndex).join("\n");
    return `REPLY\n${reply}\n\nOPTIONS\n${options}`;
  }
  return `${blocks[0].startsWith("/") ? "OPTIONS" : "REPLY"}\n${blocks.join("\n\n")}`;
}

function renderLabeledBody(label: string, value: unknown) {
  const blocks = safeBody(value).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return `${label}\nNo details available.`;
  const actionIndex = blocks.findIndex((block) => block.startsWith("/"));
  if (actionIndex === 0) return `ACTIONS\n${blocks.join("\n")}`;
  if (actionIndex > 0) {
    return `${label}\n${blocks.slice(0, actionIndex).join("\n\n")}\n\nACTIONS\n${blocks.slice(actionIndex).join("\n")}`;
  }
  return `${label}\n${blocks.join("\n\n")}`;
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
    [
      `${plural(total, "task").toUpperCase()} · UPDATED NOW`,
      sentenceCase(cleanLine(directory.criteria, "")),
    ].filter(Boolean).join("\n"),
  ];

  for (const group of groups) {
    const rows = group.threads.map((item, offset) => {
      const index = item.index ?? offset + 1;
      const preview = requestPreview(item.requestPreview);
      return [`${index}. ${threadTitle(item)}`, `   ${menuMetadata(item, now)}`, preview ? `   › ${preview}` : null].filter(Boolean).join("\n");
    });
    const hidden = group.hiddenCount && group.hiddenCount > 0 ? `\n   +${plural(group.hiddenCount, "more task")}` : "";
    sections.push(`${directoryGroupLabel(group)}\n\n${rows.join("\n\n")}${hidden}`);
  }

  if (collapsed.length > 0) {
    const rows = collapsed.map((project) => {
      return `${project.index}. ${cleanLine(project.projectLabel, "Other")}\n   ${plural(project.threadCount, "task")} · ${statusLine(project.status, project.activityAt, project.activityAt, now)}`;
    });
    sections.push(`RECENT PROJECTS\n\n${rows.join("\n\n")}`);
  }

  if (groups.length === 0 && collapsed.length === 0) sections.push("No pending or recently active tasks.");
  if (directory.note) sections.push(renderDirectoryFooter(directory.note));
  return sections.filter(Boolean).join("\n\n");
}

export function renderThreadMenu(items: MenuItem[], options: { label?: "THREADS" | "PROJECTS"; note?: string; now?: string | Date | number } = {}) {
  const label = options.label ?? "THREADS";
  if (label === "PROJECTS") {
    const rows = items.map((item, index) => {
      const count = item.threadCount ? `${plural(item.threadCount, "task")} · ` : "";
      return `${item.index ?? index + 1}. ${threadTitle(item)}\n   ${count}${statusLine(item.status, item.activityAt, item.stateSince, options.now)}`;
    });
    return [
      header("PROJECTS"),
      rows.join("\n\n") || "No available projects.",
      options.note ? renderDirectoryFooter(options.note) : null,
    ].filter(Boolean).join("\n\n");
  }
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) {
    const project = item.projectLabel?.trim() || "Other tasks";
    groups.set(project, [...(groups.get(project) ?? []), { ...item, index: item.index ?? items.indexOf(item) + 1 }]);
  }
  return renderThreadDirectory({
    label: "THREADS",
    groups: [...groups.entries()].map(([projectLabel, threads]) => ({ projectKey: projectLabel, projectLabel, threads })),
    note: options.note ?? (items.length ? "Reply with a number to open.\n\n/threads · /search · /help" : undefined),
  }, { now: options.now });
}

export function renderHelp() {
  return [
    header("COMMANDS"),
    "BROWSE\n/threads · Tasks by project\n/refresh · Refresh the task list\n/search words · Find a task\n/projects · Browse all projects",
    "CURRENT TASK\n/thread · Status and latest response\n/request · Full latest request\n/turn · Current or last turn\n/history 3 · Completed turn history\n/reasoning · View or change reasoning",
    "WORK\n/cancel · Stop iMessage-started work\n/retry · Retry the oldest failed request\n/dismiss · Clear the oldest failed request",
    "MENU REPLIES\n1 · Open item 1\n2: message · Open item 2 and send",
  ].join("\n\n");
}

function commandLines(state: unknown) {
  const primary = "/request · /turn · /history · /reasoning";
  if (statusName(state) === "Error") return `ACTIONS\n${primary}\n/retry · /dismiss · /threads`;
  return statusName(state) === "Working" || statusName(state) === "Pending"
    ? `ACTIONS\n${primary}\n/cancel · /threads`
    : `ACTIONS\n${primary}\n/threads`;
}

function renderThreadDetail(event: Extract<OutboundEvent, { kind: "thread.detail" }>) {
  const state = statusLine(event.state, event.activityAt, event.stateSince);
  const reasoning = reasoningName(event.reasoningEffort);
  const pending = event.pendingCount && event.pendingCount > 0 ? `${event.pendingCount} QUEUED` : null;
  const metadata = [state, pending, reasoning ? `REASONING ${reasoning.toUpperCase()}` : null].filter(Boolean).join(" · ");
  const preview = typeof event.requestPreview === "string"
    ? { body: event.requestPreview, at: null, truncated: false }
    : event.requestPreview;
  const context = event.reason === "fork"
    ? `${header("FOLLOWING FORK")}\n\nPROJECT · ${cleanLine(event.thread.projectLabel, "Codex").toUpperCase()}\n${threadTitle(event.thread)}\n[SELECTED] Following the active fork of this task.\n${metadata}`
    : `${threadContext(event.thread)}\n${metadata}`;
  const sections = [context, commandLines(event.state)];
  if (preview?.body) {
    sections.push(`YOU · ${relativeTime(preview.at)}\n${preview.body}${preview.truncated ? "\n\nTIP · /request shows the full message." : ""}`);
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
    sections.push(`NOTE\n${note}`);
  }
  if (event.historyTruncated) sections.push("NOTE\nOlder content is outside the local history window. /history may show less than requested.");
  return sections.filter(Boolean).join("\n\n");
}

function normalizeRequest(event: Extract<OutboundEvent, { kind: "thread.request" }>) {
  if (typeof event.body === "string") return { body: event.body, at: event.at };
  if (typeof event.request === "string") return { body: event.request, at: event.at };
  return { body: event.request?.body || "", at: event.request?.at || event.at };
}

function renderTurn(thread: ThreadLabel, turn: ThreadTurn | null, label = "TURN") {
  const sections = [`${threadContext(thread)}\n${label}`, "ACTIONS\n/thread · /request · /history · /reasoning"];
  if (!turn) return [...sections, "NOTE\nNo turn was found in the available history."].join("\n\n");
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
    return [threadContext(event.thread), `RESULT\n${safeBody(event.body)}`].filter(Boolean).join("\n\n");
  }
  if (event.kind === "thread.completed") {
    return [
      `${threadContext(event.thread)}\n[COMPLETED] ${relativeTime(event.completedAt)}`,
      `RESULT\n${safeBody(event.body)}`,
    ].filter(Boolean).join("\n\n");
  }
  if (event.kind === "thread.live-message") {
    const speaker = event.role === "user" ? "YOU" : "CODEX";
    const phase = event.role === "user"
      ? "MESSAGE"
      : cleanLine(event.phase, "UPDATE").replace(/[_-]+/g, " ").toUpperCase();
    const when = event.at ? relativeTime(event.at) : "now";
    return [
      `${LIVE_PREFIX}${speaker}\n${HEADER_RULE}`,
      `${threadProject(event.thread)} · ${threadTitle(event.thread)}\n[${phase}] ${when}`,
      safeBody(event.body, "No text content."),
    ].join("\n\n");
  }
  if (event.kind === "thread.progress") {
    return [`${threadContext(event.thread)}\n[WORKING]`, `PROGRESS\n${safeBody(event.phase)}`].join("\n\n");
  }
  if (event.kind === "service.directory") return renderThreadDirectory(event.directory);
  if (event.kind === "thread.detail") return renderThreadDetail(event);
  if (event.kind === "thread.request") {
    const request = normalizeRequest(event);
    return [`${threadContext(event.thread)}\nLATEST REQUEST`, "ACTIONS\n/thread · /turn · /history · /reasoning", `YOU · ${relativeTime(request.at)}\n${request.body || "No user request was found."}`].join("\n\n");
  }
  if (event.kind === "thread.turn") return renderTurn(event.thread, event.turn, "CURRENT / LAST TURN");
  if (event.kind === "thread.history") {
    const turns = event.turns.filter((turn): turn is ThreadTurn => Boolean(turn));
    const sections = [`${threadContext(event.thread)}\n${plural(turns.length, "COMPLETED TURN")} · NEWEST FIRST`, "ACTIONS\n/thread · /request · /turn · /reasoning"];
    turns.forEach((turn, index) => {
      const response = turn.finalResponse || turn.assistantMessages?.at(-1)?.body || "No final text response.";
      sections.push(`TURN ${index + 1} · ${relativeTime(turn.completedAt || turn.requestAt)}\nYOU\n${turn.request || "No request text found."}\n\nCODEX\n${response}`);
    });
    if (turns.length === 0) sections.push("NOTE\nNo completed turns were found in the available history.");
    if (event.hasMore) sections.push("NOTE\nMore completed turns are available. Try /history 5.");
    return sections.join("\n\n");
  }
  if (event.kind === "service.reasoning") {
    const options = event.options.map((option) => typeof option === "string" ? { value: option, label: reasoningName(option) || option } : option);
    const rows = options.map((option) => `${option.selected ? "[SELECTED]" : "[ ]"} ${option.label || reasoningName(option.value) || option.value} · /reasoning ${option.value}`);
    const selected = options.find((option) => option.selected);
    const current = reasoningName(event.current);
    const selection = selected?.value === "default"
      ? `Task default${current ? ` · ${current}` : ""}`
      : selected?.label || reasoningName(selected?.value) || current || "Task default";
    const status = event.invalid
      ? `[ERROR] “${cleanLine(event.invalid, "value")}” is not available.`
      : event.changed
        ? `[UPDATED] ${selection}`
        : `CURRENT · ${selection}`;
    return [
      header("REASONING"),
      `PROJECT · ${cleanLine(event.thread.projectLabel, "Codex").toUpperCase()}\n${threadTitle(event.thread)}`,
      status,
      `OPTIONS\n${rows.join("\n")}`,
      event.note ? `NOTE\n${event.note}` : null,
    ].filter(Boolean).join("\n\n");
  }
  if (event.kind === "service.switched") {
    const followingFork = event.reason === "fork";
    return [
      header(followingFork ? "FOLLOWING FORK" : "SWITCHED"),
      `PROJECT · ${cleanLine(event.thread.projectLabel, "Codex").toUpperCase()}\n${threadTitle(event.thread)}`,
      followingFork ? "[SELECTED] Following the active fork of this task." : "[SELECTED] Context is active.",
      "ACTIONS\n/thread · /threads",
    ].join("\n\n");
  }
  if (event.kind === "service.presence") {
    return event.state === "online"
      ? [header("ONLINE"), "[ONLINE] MAC CONNECTED", "Ready for new task messages."].join("\n\n")
      : [header("OFFLINE"), "[OFFLINE] MAC DISCONNECTED", "New task messages will wait until it reconnects."].join("\n\n");
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
  return [
    header(labels[event.code]),
    event.thread ? `PROJECT · ${cleanLine(event.thread.projectLabel, "Codex").toUpperCase()}\n${threadTitle(event.thread)}` : null,
    renderLabeledBody("DETAILS", event.body),
  ].filter(Boolean).join("\n\n");
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
