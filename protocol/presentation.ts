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

export interface PresentationContext {
  activeThread?: ThreadLabel | null;
}

export interface PresentationOptions {
  context?: PresentationContext;
  part?: { index: number; total: number };
}

const CONTEXT_RULE = "────────────";
const MAX_LABEL_LENGTH = 80;

// Thread identities use objects rather than faces or state-like symbols so the
// marker remains useful even when a task changes from pending to working to
// complete. This exact palette is part of the identity algorithm: changing its
// order or length requires an explicit identity migration.
const THREAD_OBJECT_EMOJIS = [
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
  const symbol = label === "Working" ? "●" : label === "Pending" ? "◷" : label === "Error" ? "▲" : "○";
  const time = label === "Working" || label === "Pending"
    ? elapsed(stateSince || activityAt, now)
    : relativeTime(activityAt || stateSince, now);
  if (time === "unknown") return `${symbol} ${label}`;
  if (label === "Pending") return `${symbol} ${label} · waiting ${time}`;
  if (label === "Working") return `${symbol} ${label} · for ${time}`;
  return `${symbol} ${label} · ${time}`;
}

function reasoningName(value: unknown) {
  const text = cleanLine(value, "");
  if (!text) return null;
  if (text.toLowerCase() === "xhigh") return "Extra high";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function threadIdentitySeed(thread: ThreadLabel) {
  const id = typeof thread.id === "string" ? thread.id.trim() : "";
  if (id) return `id:${id}`;
  const fallback = [thread.projectKey, thread.projectLabel, thread.title]
    .map((value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "")
    .filter(Boolean)
    .join("\u0000");
  return `fallback:${fallback || "untitled-task"}`;
}

/** Returns the stable, non-status object marker used to identify a thread. */
export function threadIdentityEmoji(thread: ThreadLabel) {
  const seed = threadIdentitySeed(thread);
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return THREAD_OBJECT_EMOJIS[hash % THREAD_OBJECT_EMOJIS.length];
}

export function threadTitle(thread: ThreadLabel) {
  return `${threadIdentityEmoji(thread)} ${cleanLine(thread.title, "Untitled task")}`;
}

function titleCase(value: unknown, fallback: string) {
  return cleanLine(value, fallback)
    .toLowerCase()
    .replace(/(^|[\s/-])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

export function header(label: string, options: { symbol?: string; part?: { index: number; total: number } } = {}) {
  const part = options.part && options.part.total > 1 ? ` · ${options.part.index}/${options.part.total}` : "";
  return `${options.symbol ?? "◆"} CODEX · ${titleCase(label, "Codex")}${part}`;
}

function partSuffix(part?: { index: number; total: number }) {
  return part && part.total > 1 ? ` · ${part.index}/${part.total}` : "";
}

function threadProject(thread: ThreadLabel) {
  return cleanLine(thread.projectLabel, "Other tasks");
}

function threadSubject(thread: ThreadLabel) {
  return `${threadTitle(thread)}\n${threadProject(thread)}`;
}

function sameThread(left?: ThreadLabel | null, right?: ThreadLabel | null) {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  return cleanLine(left.projectLabel, "").toLowerCase() === cleanLine(right.projectLabel, "").toLowerCase()
    && cleanLine(left.title, "").toLowerCase() === cleanLine(right.title, "").toLowerCase();
}

function directoryActiveThread(directory: ThreadDirectory) {
  for (const group of directory.groups ?? []) {
    const current = group.threads.find((thread) => thread.current);
    if (current) return { ...current, projectKey: current.projectKey ?? group.projectKey, projectLabel: current.projectLabel ?? group.projectLabel };
  }
  return null;
}

function eventActiveThread(event: OutboundEvent, options: PresentationOptions) {
  // A switch event is the transition itself. Its target is authoritative even
  // when the caller's pre-switch binding context is still in scope.
  if (event.kind === "service.switched") return event.thread;
  if (options.context && Object.prototype.hasOwnProperty.call(options.context, "activeThread")) {
    return options.context.activeThread ?? null;
  }
  if (event.kind === "service.directory") return directoryActiveThread(event.directory);
  if (event.kind === "service.menu") return event.items?.find((item) => item.current) ?? null;
  if ("thread" in event && event.thread) return event.thread;
  return null;
}

export function renderContextFooter(activeThread?: ThreadLabel | null, label = "Active context") {
  if (!activeThread) return `${CONTEXT_RULE}\n⌁ No active task · /threads`;
  return `${CONTEXT_RULE}\n⌁ ${label}\n${threadProject(activeThread)} › ${threadTitle(activeThread)}`;
}

function withContext(body: string, activeThread: ThreadLabel | null, label = "Active context") {
  return `${body.trim()}\n\n${renderContextFooter(activeThread, label)}`;
}

function menuMetadata(item: MenuItem, now: string | Date | number) {
  const state = `${item.current ? "⌁ Active · " : ""}${statusLine(item.status, item.activityAt, item.stateSince, now)}`;
  const parts = [state];
  const pending = Math.max(0, Number(item.pendingCount) || 0);
  if (pending > 0 && (statusName(item.status) !== "Pending" || pending > 1)) {
    parts.push(`${pending} queued`);
  }
  return parts.join(" · ");
}

function requestPreview(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.length <= 160 ? text : `${truncateText(text, 159).trimEnd()}…`;
}

function directoryGroupLabel(group: ThreadDirectoryGroup) {
  const label = cleanLine(group.projectLabel, "Other tasks");
  const count = group.threadCount ?? group.threads.length + Math.max(0, group.hiddenCount ?? 0);
  return `▾ ${label} · ${plural(count, "task")}`;
}

function renderDirectoryFooter(note: string) {
  const blocks = safeBody(note).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return "";
  const optionIndex = blocks.findIndex((block) => block.startsWith("/"));
  if (optionIndex > 0) {
    const reply = blocks.slice(0, optionIndex).join("\n\n");
    const options = blocks.slice(optionIndex).join("\n");
    return `Reply\n${reply}\n\nCommands\n${options}`;
  }
  return `${blocks[0].startsWith("/") ? "Commands" : "Reply"}\n${blocks.join("\n\n")}`;
}

function renderLabeledBody(label: string, value: unknown) {
  const blocks = safeBody(value).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return `${label}\nNo details available.`;
  const actionIndex = blocks.findIndex((block) => block.startsWith("/"));
  if (actionIndex === 0) return `Commands\n${blocks.join("\n")}`;
  if (actionIndex > 0) {
    return `${label}\n${blocks.slice(0, actionIndex).join("\n\n")}\n\nCommands\n${blocks.slice(actionIndex).join("\n")}`;
  }
  return `${label}\n${blocks.join("\n\n")}`;
}

export function renderThreadDirectory(directory: ThreadDirectory, options: { now?: string | Date | number; context?: PresentationContext; part?: { index: number; total: number } } = {}) {
  const now = options.now ?? new Date();
  const groups = directory.groups ?? [];
  const collapsed = directory.collapsedProjects ?? [];
  const total = directory.totalTasks ?? (
    groups.reduce((sum, group) => sum + (group.threadCount ?? group.threads.length), 0)
    + collapsed.reduce((sum, project) => sum + project.threadCount, 0)
  );
  const selected = options.context && Object.prototype.hasOwnProperty.call(options.context, "activeThread")
    ? options.context.activeThread ?? null
    : directoryActiveThread(directory);
  const sections: string[] = [
    header(directory.label === "PROJECTS" ? "Projects" : "Threads", { part: options.part }),
    [
      plural(total, "task"),
      cleanLine(directory.criteria, ""),
      "updated now",
    ].filter(Boolean).join(" · "),
  ];

  for (const group of groups) {
    const rows = group.threads.map((item, offset) => {
      const resolvedItem = { ...item, projectKey: item.projectKey ?? group.projectKey, projectLabel: item.projectLabel ?? group.projectLabel };
      const index = item.index ?? offset + 1;
      const preview = requestPreview(item.requestPreview);
      return [`${index}  ${threadTitle(resolvedItem)}`, `   ${menuMetadata(resolvedItem, now)}`, preview ? `   “${preview}”` : null].filter(Boolean).join("\n");
    });
    const hidden = group.hiddenCount && group.hiddenCount > 0 ? `\n\n   + ${plural(group.hiddenCount, "more task")}` : "";
    sections.push(`${directoryGroupLabel(group)}\n\n${rows.join("\n\n")}${hidden}`);
  }

  if (collapsed.length > 0) {
    const rows = collapsed.map((project) => {
      return `${project.index}  ▸ ${cleanLine(project.projectLabel, "Other")} · ${plural(project.threadCount, "task")}\n   ${statusLine(project.status, project.activityAt, project.activityAt, now)}`;
    });
    sections.push(`Recent projects\n\n${rows.join("\n\n")}`);
  }

  if (groups.length === 0 && collapsed.length === 0) sections.push("No pending or recently active tasks.");
  if (directory.note) sections.push(renderDirectoryFooter(directory.note));
  return withContext(sections.filter(Boolean).join("\n\n"), selected);
}

export function renderThreadMenu(items: MenuItem[], options: { label?: "THREADS" | "PROJECTS"; note?: string; now?: string | Date | number; context?: PresentationContext; part?: { index: number; total: number } } = {}) {
  const label = options.label ?? "THREADS";
  if (label === "PROJECTS") {
    const rows = items.map((item, index) => {
      const count = item.threadCount ? `${plural(item.threadCount, "task")} · ` : "";
      return `${item.index ?? index + 1}  ▸ Browse ${cleanLine(item.title, "Other")}\n   ${count}${statusLine(item.status, item.activityAt, item.stateSince, options.now)}`;
    });
    return withContext([
      header("Projects", { part: options.part }),
      rows.join("\n\n") || "No available projects.",
      options.note ? renderDirectoryFooter(options.note) : null,
    ].filter(Boolean).join("\n\n"), options.context?.activeThread ?? null);
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
  }, { now: options.now, context: options.context, part: options.part });
}

export function renderHelp(options: PresentationOptions = {}) {
  return withContext([
    header("Commands", { part: options.part }),
    "Browse\n/threads · Tasks by project\n/refresh · Refresh the task list\n/search words · Find a task\n/projects · Browse all projects",
    "Active task\n/thread · Status and latest response\n/request · Full latest request\n/turn · Current or last turn\n/history 3 · Completed turn history\n/reasoning · View or change reasoning",
    "Work\n/cancel · Stop iMessage-started work\n/retry · Retry the oldest failed request\n/dismiss · Clear the oldest failed request",
    "Menu replies\n1 · Open item 1\n2: message · Open item 2 and send",
  ].join("\n\n"), options.context?.activeThread ?? null);
}

function commandLines(state: unknown) {
  const primary = "/request · /turn · /history · /reasoning";
  if (statusName(state) === "Error") return `Commands\n${primary}\n/retry · /dismiss · /threads`;
  return statusName(state) === "Working" || statusName(state) === "Pending"
    ? `Commands\n${primary}\n/cancel · /threads`
    : `Commands\n${primary}\n/threads`;
}

function speakerLine(role: "user" | "assistant", at?: string | null, phase?: string | null) {
  const when = at ? relativeTime(at) : "now";
  if (role === "user") return `You · ${when}`;
  const normalized = cleanLine(phase, "update").replace(/[_-]+/g, " ").toLowerCase();
  const label = normalized === "final answer" ? "Result" : normalized === "commentary" ? "Update" : titleCase(normalized, "Update");
  return `Codex · ${label} · ${when}`;
}

function renderThreadDetail(event: Extract<OutboundEvent, { kind: "thread.detail" }>, part?: { index: number; total: number }) {
  const state = statusLine(event.state, event.activityAt, event.stateSince);
  const reasoning = reasoningName(event.reasoningEffort);
  const pending = event.pendingCount && event.pendingCount > 0 ? `${event.pendingCount} queued` : null;
  const metadata = [state, pending, reasoning ? `Reasoning: ${reasoning}` : null].filter(Boolean).join(" · ");
  const preview = typeof event.requestPreview === "string"
    ? { body: event.requestPreview, at: null, truncated: false }
    : event.requestPreview;
  const context = [
    header(event.reason === "fork" ? "Following fork" : "Thread", { symbol: event.reason === "fork" ? "↪" : "◆", part }),
    threadSubject(event.thread),
    event.reason === "fork" ? `${metadata}\nFollowing the active fork of this task.` : metadata,
  ].filter(Boolean).join("\n\n");
  const sections = [context, commandLines(event.state)];
  if (preview?.body) {
    sections.push(`${speakerLine("user", preview.at)}\n${preview.body}${preview.truncated ? "\n\nNote · /request shows the full message." : ""}`);
  }
  const messages = event.assistantMessages ?? [];
  for (const message of messages) {
    sections.push(`${speakerLine("assistant", message.at, message.phase)}\n${safeBody(message.body, "No text response.")}`);
  }
  if (messages.length === 0) {
    const note = statusName(event.state) === "Pending"
      ? "This request is waiting for a run slot."
      : statusName(event.state) === "Working"
        ? "Codex is working; no user-visible update has arrived yet."
        : statusName(event.state) === "Error"
          ? "This request did not produce a final response. Use /retry to try it again."
          : "No assistant response was found in the available history.";
    sections.push(`Note\n${note}`);
  }
  if (event.historyTruncated) sections.push("Note\nOlder content is outside the local history window. /history may show less than requested.");
  return sections.filter(Boolean).join("\n\n");
}

function normalizeRequest(event: Extract<OutboundEvent, { kind: "thread.request" }>) {
  if (typeof event.body === "string") return { body: event.body, at: event.at };
  if (typeof event.request === "string") return { body: event.request, at: event.at };
  return { body: event.request?.body || "", at: event.request?.at || event.at };
}

function renderTurn(thread: ThreadLabel, turn: ThreadTurn | null, label = "Turn", part?: { index: number; total: number }) {
  const sections = [header(label, { part }), threadSubject(thread), "Commands\n/thread · /request · /history · /reasoning"];
  if (!turn) return [...sections, "Note\nNo turn was found in the available history."].join("\n\n");
  if (turn.request) sections.push(`${speakerLine("user", turn.requestAt)}\n${turn.request}`);
  for (const message of turn.assistantMessages ?? []) {
    sections.push(`${speakerLine("assistant", message.at, message.phase)}\n${safeBody(message.body)}`);
  }
  const finalAlreadyShown = (turn.assistantMessages ?? []).some((message) => safeBody(message.body) === safeBody(turn.finalResponse));
  if (turn.finalResponse && !finalAlreadyShown) {
    sections.push(`${speakerLine("assistant", turn.completedAt, "final_answer")}\n${turn.finalResponse}`);
  }
  return sections.filter(Boolean).join("\n\n");
}

export function renderOutboundEvent(event: OutboundEvent, options: PresentationOptions = {}) {
  const activeThread = eventActiveThread(event, options);
  const finish = (body: string, label = "Active context") => withContext(body, activeThread, label);
  if (event.kind === "thread.output") {
    return finish([header("Result", { symbol: "✓", part: options.part }), threadSubject(event.thread), safeBody(event.body)].filter(Boolean).join("\n\n"));
  }
  if (event.kind === "thread.completed") {
    const elsewhere = Boolean(activeThread) && !sameThread(activeThread, event.thread);
    return finish([
      header(elsewhere ? "Completed elsewhere" : "Completed", { symbol: "✓", part: options.part }),
      `${threadSubject(event.thread)}\n✓ Completed · ${event.completedAt ? relativeTime(event.completedAt) : "now"}`,
      safeBody(event.body),
    ].filter(Boolean).join("\n\n"), elsewhere ? "Active context unchanged" : "Active context");
  }
  if (event.kind === "thread.live-message") {
    const when = event.at ? relativeTime(event.at) : "now";
    const line = event.role === "user"
      ? `You · Mirrored from Mac · ${when}${partSuffix(options.part)}`
      : `${speakerLine("assistant", event.at, event.phase).replace(/ · unknown$/, " · now")}${partSuffix(options.part)}`;
    return finish([line, safeBody(event.body, "No text content.")].join("\n\n"));
  }
  if (event.kind === "thread.progress") {
    return finish([header("Still working", { symbol: "●", part: options.part }), safeBody(event.phase)].join("\n\n"));
  }
  if (event.kind === "service.directory") return renderThreadDirectory(event.directory, { context: options.context, part: options.part });
  if (event.kind === "thread.detail") return finish(renderThreadDetail(event, options.part));
  if (event.kind === "thread.request") {
    const request = normalizeRequest(event);
    return finish([header("Latest request", { part: options.part }), threadSubject(event.thread), "Commands\n/thread · /turn · /history · /reasoning", `${speakerLine("user", request.at)}\n${request.body || "No user request was found."}`].join("\n\n"));
  }
  if (event.kind === "thread.turn") return finish(renderTurn(event.thread, event.turn, "Current / last turn", options.part));
  if (event.kind === "thread.history") {
    const turns = event.turns.filter((turn): turn is ThreadTurn => Boolean(turn));
    const sections = [header("History", { part: options.part }), `${threadSubject(event.thread)}\n${plural(turns.length, "completed turn")} · newest first`, "Commands\n/thread · /request · /turn · /reasoning"];
    turns.forEach((turn, index) => {
      const response = turn.finalResponse || turn.assistantMessages?.at(-1)?.body || "No final text response.";
      sections.push(`Turn ${index + 1} · ${relativeTime(turn.completedAt || turn.requestAt)}\nYou\n${turn.request || "No request text found."}\n\nCodex\n${response}`);
    });
    if (turns.length === 0) sections.push("Note\nNo completed turns were found in the available history.");
    if (event.hasMore) sections.push("Note\nMore completed turns are available. Try /history 5.");
    return finish(sections.join("\n\n"));
  }
  if (event.kind === "service.reasoning") {
    const reasoningOptions = event.options.map((option) => typeof option === "string" ? { value: option, label: reasoningName(option) || option } : option);
    const rows = reasoningOptions.map((option) => `${option.selected ? "●" : "○"} ${option.label || reasoningName(option.value) || option.value}${option.selected ? " · selected" : ""}\n   /reasoning ${option.value}`);
    const selected = reasoningOptions.find((option) => option.selected);
    const current = reasoningName(event.current);
    const selection = selected?.value === "default"
      ? `Task default${current ? ` · ${current}` : ""}`
      : selected?.label || reasoningName(selected?.value) || current || "Task default";
    const status = event.invalid
      ? `▲ “${cleanLine(event.invalid, "value")}” is not available.`
      : event.changed
        ? `✓ Updated · ${selection}`
        : `Current · ${selection}`;
    return finish([
      header("Reasoning", { part: options.part }),
      threadSubject(event.thread),
      status,
      `Options\n${rows.join("\n\n")}`,
      event.note ? `Note\n${event.note}` : null,
    ].filter(Boolean).join("\n\n"));
  }
  if (event.kind === "service.switched") {
    const followingFork = event.reason === "fork";
    return finish([
      header(followingFork ? "Following fork" : "Context switched", { symbol: "↪", part: options.part }),
      threadSubject(event.thread),
      followingFork ? "New messages now go to the active fork of this task." : "New messages now go to this task.",
      "Commands\n/thread · /threads",
    ].join("\n\n"), "Now active");
  }
  if (event.kind === "service.presence") {
    return event.state === "online"
      ? finish([header("Mac connected", { symbol: "✓", part: options.part }), "Ready for new task messages."].join("\n\n"), "Active context unchanged")
      : finish([header("Mac disconnected", { symbol: "×", part: options.part }), "New task messages will wait until it reconnects."].join("\n\n"), "Active context unchanged");
  }
  if (event.kind === "service.menu") {
    if (event.label === "COMMANDS") {
      return event.body
        ? finish([header("Commands", { part: options.part }), event.body, event.note].filter(Boolean).join("\n\n"))
        : renderHelp(options);
    }
    return renderThreadMenu(event.items ?? [], { label: event.label === "PROJECTS" ? "PROJECTS" : "THREADS", note: event.note, context: options.context, part: options.part });
  }
  const labels: Record<NoticeCode, { symbol: string; label: string }> = {
    connected: { symbol: "◆", label: "Connected" },
    queued: { symbol: "◷", label: "Pending" },
    cancelled: { symbol: "×", label: "Cancelled" },
    "needs-attention": { symbol: "▲", label: "Needs attention" },
    updated: { symbol: "✓", label: "Updated" },
  };
  const notice = labels[event.code];
  const about = event.thread ? `About\n${threadTitle(event.thread)}\n${threadProject(event.thread)}` : null;
  const unchanged = Boolean(event.thread && activeThread && !sameThread(event.thread, activeThread));
  return finish([
    header(notice.label, { symbol: notice.symbol, part: options.part }),
    about,
    renderLabeledBody("Details", event.body),
  ].filter(Boolean).join("\n\n"), unchanged ? "Active context unchanged" : "Active context");
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
