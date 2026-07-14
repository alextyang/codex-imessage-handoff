export type ThreadStatus = "working" | "pending" | "idle" | "error";

export interface ThreadLabel {
  id?: string;
  title: string;
  projectKey?: string | null;
  projectLabel?: string | null;
  createdAt?: string | null;
  status?: ThreadStatus | string | null;
  activityAt?: string | null;
  stateSince?: string | null;
  reasoningEffort?: string | null;
  reasoningSource?: "task-override" | "service-default" | "codex-task" | "codex-default" | string | null;
  pendingCount?: number;
  turnCount?: number;
  turnCountLowerBound?: boolean;
  muted?: boolean;
  listening?: boolean;
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
  turnCount?: number;
  turnCountLowerBound?: boolean;
}

export interface ThreadDirectoryGroup {
  projectKey: string;
  projectLabel: string;
  startedAt?: string | null;
  status?: ThreadStatus | string | null;
  activityAt?: string | null;
  threadCount?: number;
  hiddenCount?: number;
  threads: MenuItem[];
}

export interface CollapsedProject {
  projectKey: string;
  projectLabel: string;
  startedAt?: string | null;
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
  | { kind: "thread.header"; thread: ThreadLabel; deliveryId?: string }
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
    turnCount?: number;
    turnCountLowerBound?: boolean;
    reasoningEffort?: string | null;
    requestPreview?: { body: string; at?: string | null; truncated?: boolean } | string | null;
    assistantMessages?: VisibleMessage[];
    historyTruncated?: boolean;
    deliveryId?: string;
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
  | { kind: "service.presence"; state: "online" | "offline" }
  | { kind: "service.notice"; code: NoticeCode; body: string; thread?: ThreadLabel };

export interface PresentationContext {
  activeThread?: ThreadLabel | null;
}

export interface PresentationOptions {
  context?: PresentationContext;
  part?: { index: number; total: number };
}

const MAX_LABEL_LENGTH = 120;

// The exact palette is part of the deterministic identity algorithm. Changing
// its order or length requires an explicit identity migration.
const OBJECT_EMOJIS = [
  "📚", "🧭", "🧰", "🔭", "🧩", "🎛️", "🪴", "🧵",
  "🔬", "🗂️", "📐", "🪁", "🧲", "🪜", "🧪", "📎",
  "🗝️", "🛠️", "🖇️", "📡", "🪶", "🎒", "🗺️", "📦",
  "✏️", "🖍️", "🔖", "🧯", "🪛", "🔧", "⚙️", "🗜️",
] as const;

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment: (input: string) => Iterable<{ segment: string }> } }).Segmenter;
  const segments = Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), (entry) => entry.segment)
    : Array.from(value);
  let result = "";
  for (const segment of segments) {
    if (result.length + segment.length > maxLength) break;
    result += segment;
  }
  return result;
}

function cleanLine(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return truncateText(text || fallback, MAX_LABEL_LENGTH);
}

function safeBody(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function markdownText(value: unknown, fallback: string) {
  return cleanLine(value, fallback).replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}

function bold(value: unknown, fallback: string) {
  return `**${markdownText(value, fallback)}**`;
}

function dateValue(value: string | Date | number | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedStart(value: unknown) {
  const parsed = typeof value === "string" || typeof value === "number" || value instanceof Date ? dateValue(value) : null;
  return parsed === null ? "unknown-start" : new Date(parsed).toISOString();
}

function normalizedName(value: unknown, fallback: string) {
  return cleanLine(value, fallback).normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function identityEmoji(kind: "thread" | "project", name: unknown, startedAt: unknown) {
  const seed = `${kind}\u0000${normalizedName(name, kind)}\u0000${normalizedStart(startedAt)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return OBJECT_EMOJIS[hash % OBJECT_EMOJIS.length];
}

export function threadIdentityEmoji(thread: ThreadLabel) {
  return identityEmoji("thread", thread.title, thread.createdAt);
}

export function projectIdentityEmoji(project: { projectLabel?: string | null; title?: string | null; startedAt?: string | null; createdAt?: string | null }) {
  return identityEmoji("project", project.projectLabel || project.title, project.startedAt || project.createdAt);
}

export function threadTitle(thread: ThreadLabel) {
  return `${threadIdentityEmoji(thread)} ${cleanLine(thread.title, "Untitled task")}`;
}

function styledThreadTitle(thread: ThreadLabel, selected = false) {
  const title = selected ? bold(thread.title, "Untitled task") : markdownText(thread.title, "Untitled task");
  return `${threadIdentityEmoji(thread)} ${title}`;
}

function sameThread(left?: ThreadLabel | null, right?: ThreadLabel | null) {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  return normalizedName(left.title, "") === normalizedName(right.title, "")
    && normalizedStart(left.createdAt) === normalizedStart(right.createdAt);
}

function eventActiveThread(event: OutboundEvent, options: PresentationOptions) {
  if (options.context && Object.prototype.hasOwnProperty.call(options.context, "activeThread")) {
    return options.context.activeThread ?? null;
  }
  if (event.kind === "service.directory") {
    for (const group of event.directory.groups ?? []) {
      const current = group.threads.find((thread) => thread.current);
      if (current) return current;
    }
  }
  if (event.kind === "service.menu") return event.items?.find((item) => item.current) ?? null;
  if ("thread" in event && event.thread) return event.thread;
  return null;
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

export function statusName(status: unknown) {
  if (status === "working" || status === "running") return "working";
  if (status === "pending" || status === "queued") return "pending";
  if (status === "error" || status === "failed" || status === "aborted") return "error";
  return "idle";
}

function turnCountText(item: { turnCount?: number; turnCountLowerBound?: boolean }) {
  const count = Math.max(0, Number(item.turnCount) || 0);
  if (count === 0 && item.turnCount === undefined) return null;
  return `${count}${item.turnCountLowerBound ? "+" : ""} ${count === 1 ? "turn" : "turns"}`;
}

export function statusGlyph(status: unknown) {
  const normalized = statusName(status);
  if (normalized === "working" || normalized === "pending") return "◷";
  if (normalized === "error") return "▲";
  return "○";
}

export function directoryStatus(item: MenuItem, now: string | Date | number) {
  const status = statusName(item.status);
  const pending = Math.max(0, Number(item.pendingCount) || 0);
  const turns = turnCountText(item);
  const parts: string[] = [];
  if (status === "working") parts.push(`◷ Working for ${elapsed(item.stateSince || item.activityAt, now)}`);
  else if (status === "pending") parts.push(`◷ Pending for ${elapsed(item.stateSince || item.activityAt, now)}`);
  else if (status === "error") parts.push(`▲ Needs attention${item.activityAt ? ` · ${relativeTime(item.activityAt, now)}` : ""}`);
  else parts.push(`○ ${relativeTime(item.activityAt || item.stateSince, now)}`);
  if (pending > 0) parts.push(`${pending} queued`);
  if ((status === "idle" || status === "error") && turns) parts.push(turns);
  return parts.join(" · ");
}

function keycap(index: number) {
  if (index >= 1 && index <= 9) return `${index}\uFE0F\u20E3`;
  if (index === 10) return "🔟";
  return `${index}.`;
}

function requestPreview(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length <= 160 ? text : `${truncateText(text, 159).trimEnd()}…`;
}

function projectHeading(group: ThreadDirectoryGroup) {
  const count = group.threadCount ?? group.threads.length + Math.max(0, group.hiddenCount ?? 0);
  if (group.projectLabel.trim().toLowerCase() === "other tasks") return `▾ ${statusGlyph(group.status)} ${bold("Other tasks", "Other tasks")} · ${count} ${count === 1 ? "task" : "tasks"}`;
  return `▾  ${statusGlyph(group.status)} ${projectIdentityEmoji(group)} ${bold(group.projectLabel, "Project")} · ${count} ${count === 1 ? "task" : "tasks"}`;
}

function renderThreadRow(item: MenuItem, offset: number, now: string | Date | number) {
  const index = item.index ?? offset + 1;
  const preview = requestPreview(item.requestPreview);
  return [
    `${keycap(index)}  ${statusGlyph(item.status)} ${styledThreadTitle(item, Boolean(item.current))}`,
    `   ${directoryStatus(item, now)}`,
    preview ? `   “${preview}”` : null,
  ].filter(Boolean).join("\n");
}

const DEFAULT_THREAD_DIRECTORY_NOTE = [
  "Reply with a number to open that thread. Add “1 (message)” to directly message the thread.",
  "“/projects” - See all projects",
  "“/search” - Show threads with specific text",
].join("\n");

export function renderThreadDirectory(directory: ThreadDirectory, options: { now?: string | Date | number; context?: PresentationContext; part?: { index: number; total: number } } = {}) {
  const now = options.now ?? new Date();
  const sections: string[] = [];
  for (const group of directory.groups ?? []) {
    const current = group.threads.find((item) => item.current);
    const others = group.threads.filter((item) => item !== current);
    const rows: string[] = [];
    if (current) rows.push(`**Selected**\n${renderThreadRow(current, 0, now)}`);
    rows.push(...others.map((item, index) => renderThreadRow(item, index, now)));
    const hidden = Math.max(0, Number(group.hiddenCount) || 0);
    if (hidden > 0) rows.push(`+${hidden} more ${hidden === 1 ? "task" : "tasks"}`);
    sections.push(`${projectHeading(group)}\n\n${rows.join("\n\n")}`);
  }
  for (const project of directory.collapsedProjects ?? []) {
    const statusItem: MenuItem = { title: project.projectLabel, status: project.status, activityAt: project.activityAt, stateSince: project.activityAt };
    const identity = project.projectLabel.trim().toLowerCase() === "other tasks" ? "" : `${projectIdentityEmoji(project)} `;
    sections.push(`${keycap(project.index)}  ▸  ${statusGlyph(project.status)} ${identity}${bold(project.projectLabel, "Project")} · ${project.threadCount} ${project.threadCount === 1 ? "task" : "tasks"}\n   ${directoryStatus(statusItem, now)}`);
  }
  if (sections.length === 0) sections.push("No pending or recently active threads.");
  sections.push(safeBody(directory.note, DEFAULT_THREAD_DIRECTORY_NOTE));
  return sections.filter(Boolean).join("\n\n");
}

export function renderThreadMenu(items: MenuItem[], options: { label?: "THREADS" | "PROJECTS"; note?: string; now?: string | Date | number; context?: PresentationContext; part?: { index: number; total: number } } = {}) {
  if (options.label === "PROJECTS") {
    const now = options.now ?? new Date();
    const rows = items.map((item, index) => {
      const count = Math.max(0, Number(item.threadCount) || 0);
      const state = statusName(item.status);
      const status = state === "working"
        ? `◷ Working · ${count} ${count === 1 ? "task" : "tasks"}`
        : state === "pending"
          ? `◷ Pending · ${count} ${count === 1 ? "task" : "tasks"}`
          : state === "error"
            ? `▲ Needs attention · ${count} ${count === 1 ? "task" : "tasks"}`
            : `○ ${relativeTime(item.activityAt || item.stateSince, now)} · ${count} ${count === 1 ? "task" : "tasks"}`;
      return `${keycap(item.index ?? index + 1)}  ${statusGlyph(item.status)} ${projectIdentityEmoji({ title: item.title, createdAt: item.createdAt })} ${bold(item.title, "Project")}\n   ${status}`;
    });
    return [
      "**Projects**",
      rows.join("\n\n") || "No projects found.",
      safeBody(options.note, "Reply with a number to show that project.\n“/threads” - See recent threads\n“/search” - Show threads with specific text"),
    ].join("\n\n");
  }
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) {
    const project = item.projectLabel?.trim() || "Other tasks";
    groups.set(project, [...(groups.get(project) ?? []), { ...item, index: item.index ?? items.indexOf(item) + 1 }]);
  }
  return renderThreadDirectory({
    label: "THREADS",
    groups: [...groups.entries()].map(([projectLabel, threads]) => ({
      projectKey: projectLabel,
      projectLabel,
      startedAt: threads.map((item) => item.createdAt).filter(Boolean).sort()[0] ?? null,
      threads,
    })),
    note: options.note,
  }, options);
}

export function renderHelp(_options: PresentationOptions = {}) {
  return [
    "**Browse**\n/new (message) · Start a task\n/threads · Tasks by project\n/refresh · Refresh the task list\n/search (query) · Find a task\n/projects · Browse all projects",
    "**Task controls**\n👍 add/remove · Listen for the next turn’s live updates\n👎 add/remove · Mute or unmute automatic updates\n❓ add · Show status, current turn, and recent history\n/thread · Status and latest response\n/turn · Show current or last turn\n/history (length) · Completed turn history\n/reasoning (level/none) · View or change reasoning\n/link · Show the Codex task link\n/cancel · Stop iMessage-started work in this task\n/retry · Retry failed iMessage-started work\n/dismiss · Remove failed work from the queue",
    "**Settings**\n/defaultreasoning (level/none) · View or change default reasoning",
  ].join("\n\n");
}

const REASONING_DISPLAY: Record<string, { emoji: string; label: string }> = {
  low: { emoji: "🪶", label: "Low" },
  medium: { emoji: "⚙️", label: "Medium" },
  high: { emoji: "🔍", label: "High" },
  xhigh: { emoji: "🔬", label: "Extra high" },
  max: { emoji: "🧠", label: "Max" },
  ultra: { emoji: "🚀", label: "Ultra" },
};

export function reasoningDisplay(value: unknown) {
  const text = cleanLine(value, "").toLowerCase();
  if (!text || text === "default" || text === "none") return { value: "none", emoji: "↩️", label: "Inherit" };
  return { value: text, ...(REASONING_DISPLAY[text] || { emoji: "🧠", label: text }) };
}

export function renderThreadHeader(thread: ThreadLabel, now: string | Date | number = new Date()) {
  const status = directoryStatus(thread, now);
  const reasoningValue = reasoningDisplay(thread.reasoningEffort);
  const sourceLabels: Record<string, string> = {
    "task-override": "task override",
    "service-default": "service default",
    "codex-task": "Codex task",
    "codex-default": "Codex default",
  };
  const reasoningSource = sourceLabels[String(thread.reasoningSource || "")]
    || (thread.reasoningEffort ? "" : "Codex default");
  const reasoning = thread.reasoningEffort
    ? `${reasoningValue.emoji} Reasoning: ${reasoningValue.label}${reasoningSource ? ` · ${reasoningSource}` : ""}`
    : `↩️ Reasoning: Codex default`;
  const updates = thread.muted ? "Updates: muted" : null;
  const listening = thread.listening ? "Listening: next turn" : null;
  const link = thread.id ? `codex://threads/${encodeURIComponent(thread.id)}` : null;
  return [
    styledThreadTitle(thread, true),
    [status, reasoning, updates, listening].filter(Boolean).join("\n"),
    link,
    `👍 listen · 👎 mute · ❓ status + history\n/link · /cancel`,
  ].filter(Boolean).join("\n\n");
}

function normalizeRequest(event: Extract<OutboundEvent, { kind: "thread.request" }>) {
  if (typeof event.body === "string") return event.body;
  if (typeof event.request === "string") return event.request;
  return event.request?.body || "";
}

function turnBlocks(turn: ThreadTurn | null) {
  if (!turn) return [];
  const blocks: string[] = [];
  if (turn.request) blocks.push(`👤 ${safeBody(turn.request)}`);
  for (const message of turn.assistantMessages ?? []) {
    const body = safeBody(message.body);
    if (body) blocks.push(`☁️ ${body}`);
  }
  const finalAlreadyShown = (turn.assistantMessages ?? []).some((message) => safeBody(message.body) === safeBody(turn.finalResponse));
  if (turn.finalResponse && !finalAlreadyShown) blocks.push(`☁️ ${safeBody(turn.finalResponse)}`);
  return blocks;
}

function scopedBody(thread: ThreadLabel | undefined, body: string, activeThread: ThreadLabel | null) {
  if (!thread || sameThread(thread, activeThread)) return body;
  return `${styledThreadTitle(thread, true)}\n\n${body}`;
}

function partPrefix(options: PresentationOptions) {
  return options.part && options.part.total > 1 ? `(${options.part.index}/${options.part.total})\n\n` : "";
}

export function renderOutboundMessages(event: OutboundEvent, options: PresentationOptions = {}): string[] {
  if (event.kind === "thread.header") return [renderThreadHeader(event.thread)];
  if (event.kind === "thread.progress") return [];
  if (event.kind === "thread.detail") {
    const activeThread = eventActiveThread(event, options);
    const messages: string[] = [];
    const preview = typeof event.requestPreview === "string" ? event.requestPreview : event.requestPreview?.body;
    if (preview && !/^No user request was found/i.test(preview)) {
      const truncated = typeof event.requestPreview === "object" && event.requestPreview?.truncated;
      messages.push(`👤 ${safeBody(preview)}${truncated ? "\n\nRequest shortened · /request shows it in full." : ""}`);
    }
    const assistant = (event.assistantMessages ?? []).map((message) => safeBody(message.body)).filter(Boolean);
    if (assistant.length > 0) messages.push(assistant.join("\n\n"));
    if (event.historyTruncated) messages.push("Older task context wasn’t loaded · /turn or /history 5");
    if (messages.length === 0) messages.push("No response yet.");
    if (!sameThread(event.thread, activeThread)) {
      messages[0] = scopedBody(event.thread, messages[0], activeThread);
    }
    return messages;
  }
  return [renderOutboundEvent(event, options)];
}

export function renderOutboundEvent(event: OutboundEvent, options: PresentationOptions = {}): string {
  const activeThread = eventActiveThread(event, options);
  const part = partPrefix(options);
  if (event.kind === "thread.header") return `${part}${renderThreadHeader(event.thread)}`;
  if (event.kind === "thread.output") return `${part}${scopedBody(event.thread, safeBody(event.body), activeThread)}`;
  if (event.kind === "thread.completed") return `${part}${scopedBody(event.thread, safeBody(event.body), activeThread)}`;
  if (event.kind === "thread.live-message") {
    const body = safeBody(event.body, "No text content.");
    return `${part}${event.role === "user" ? `👤 ${body}` : body}`;
  }
  if (event.kind === "thread.progress") return `${part}${safeBody(event.phase)}`;
  if (event.kind === "thread.detail") return renderOutboundMessages(event, options).join("\n\n\n");
  if (event.kind === "thread.request") {
    const body = `👤 ${safeBody(normalizeRequest(event), "No user request was found.")}`;
    return `${part}${scopedBody(event.thread, body, activeThread)}`;
  }
  if (event.kind === "thread.turn") {
    const blocks = turnBlocks(event.turn);
    const body = blocks.length ? blocks.join("\n\n\n") : "No turn found.";
    return `${part}${scopedBody(event.thread, body, activeThread)}`;
  }
  if (event.kind === "thread.history") {
    const blocks = event.turns.flatMap(turnBlocks);
    let body = blocks.length ? blocks.join("\n\n\n") : "No completed turns found.";
    if (event.hasMore) body += "\n\n\nEarlier completed turns exist · /history 5 shows the newest five.";
    return `${part}${scopedBody(event.thread, body, activeThread)}`;
  }
  if (event.kind === "service.reasoning") {
    let body: string;
    if (event.invalid) {
      body = `“${cleanLine(event.invalid, "value")}” isn’t a reasoning level.\n\n/reasoning (level/none)`;
      return `${part}${scopedBody(event.thread, body, activeThread)}`;
    }
    const optionsList = event.options.map((option) => typeof option === "string" ? { value: option } : option);
    const selected = optionsList.find((option) => option.selected);
    const selectedDisplay = reasoningDisplay(selected?.value || event.current);
    if (event.changed) {
      const message = selectedDisplay.value === "none"
        ? "Reasoning override removed."
        : `Reasoning set to ${selectedDisplay.emoji} ${bold(selectedDisplay.label, "Inherit")}.`;
      body = `${message}${event.note ? `\n\n${safeBody(event.note)}` : ""}`;
      return `${part}${scopedBody(event.thread, body, activeThread)}`;
    }
    const rows = optionsList.map((option) => {
      const display = reasoningDisplay(option.value);
      return `${option.selected ? "●" : "○"} ${display.emoji} ${display.label}${option.selected ? " · selected" : ""}`;
    });
    body = `**Reasoning**\n${rows.join("\n")}\n\n/reasoning (level/none)`;
    return `${part}${scopedBody(event.thread, body, activeThread)}`;
  }
  if (event.kind === "service.directory") return `${part}${renderThreadDirectory(event.directory, { context: options.context })}`;
  if (event.kind === "service.presence") {
    return `${part}${event.state === "online" ? "● Codex is online." : "○ Codex is offline. New messages will wait until it reconnects."}`;
  }
  if (event.kind === "service.menu") {
    if (event.label === "COMMANDS") return `${part}${event.body ? [event.body, event.note].filter(Boolean).join("\n\n") : renderHelp()}`;
    return `${part}${renderThreadMenu(event.items ?? [], { label: event.label === "PROJECTS" ? "PROJECTS" : "THREADS", note: event.note, context: options.context })}`;
  }
  const body = safeBody(event.body, "No details available.");
  return `${part}${scopedBody(event.thread, body, activeThread)}`;
}

export function parseMenuSelection(value: string) {
  const text = value.trim();
  const bare = text.match(/^([1-9]\d*)$/);
  if (bare) return { index: Number(bare[1]) - 1, prompt: null };
  const withPrompt = text.match(/^([1-9]\d*)(?:\s*:\s*|\s+)([\s\S]+)$/);
  if (!withPrompt) return null;
  let prompt = withPrompt[2].trim();
  if (prompt.startsWith("(") && prompt.endsWith(")")) prompt = prompt.slice(1, -1).trim();
  return prompt ? { index: Number(withPrompt[1]) - 1, prompt } : null;
}

export function parseSlashCommand(value: string) {
  const text = value.trim();
  const match = text.match(/^\/(new|threads|recent|refresh|projects|search|thread|request|message|turn|history|reasoning|defaultreasoning|listen|link|mute|unmute|status|retry|dismiss|cancel|help)(?:\s+([\s\S]+))?$/i);
  return match ? { command: match[1].toLowerCase(), argument: match[2]?.trim() || null } : null;
}
