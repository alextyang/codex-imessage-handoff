export interface ThreadLabel {
  id?: string;
  title: string;
  projectLabel?: string | null;
}

export interface MenuItem extends ThreadLabel {
  current?: boolean;
}

export type NoticeCode =
  | "connected"
  | "queued"
  | "cancelled"
  | "needs-attention";

export type OutboundEvent =
  | { kind: "thread.output"; thread: ThreadLabel; body: string }
  | { kind: "thread.progress"; thread: ThreadLabel; phase: string }
  | { kind: "service.menu"; label?: "THREADS" | "PROJECTS" | "COMMANDS"; items?: MenuItem[]; body?: string; note?: string }
  | { kind: "service.switched"; thread: ThreadLabel }
  | { kind: "service.notice"; code: NoticeCode; body: string; thread?: ThreadLabel };

const HEADER_PREFIX = "CODEX · ";
const MAX_LABEL_LENGTH = 80;

function cleanLine(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, MAX_LABEL_LENGTH);
}

export function threadTitle(thread: ThreadLabel) {
  return cleanLine(thread.title, "Untitled thread");
}

export function header(label: string) {
  return `${HEADER_PREFIX}${cleanLine(label, "CODEX").toUpperCase()}`;
}

export function threadHeader(thread: ThreadLabel, part?: { index: number; total: number }) {
  const base = `${HEADER_PREFIX}${threadTitle(thread)}`;
  return part && part.total > 1 ? `${base} · ${part.index}/${part.total}` : base;
}

export function renderThreadMenu(items: MenuItem[], options: { label?: "THREADS" | "PROJECTS"; note?: string } = {}) {
  const label = options.label ?? "THREADS";
  const rows = items.map((item, index) => {
    const current = item.current ? "  • current" : "";
    const project = item.projectLabel?.trim() ? `  · ${cleanLine(item.projectLabel, "")}` : "";
    return `${index + 1}  ${threadTitle(item)}${project}${current}`;
  });
  const body = rows.length > 0 ? rows.join("\n") : "No available threads.";
  const note = options.note ?? (rows.length > 0 ? "Reply with a number to switch." : "");
  return [header(label), body, note].filter(Boolean).join("\n\n");
}

export function renderHelp() {
  return [
    header("COMMANDS"),
    [
      "/threads       Choose a recent thread",
      "/search words  Find a thread",
      "/projects      Browse by project",
      "/status        Show current activity",
      "/cancel        Stop current work",
    ].join("\n"),
    "In a thread menu, reply with a number to switch.\nYou can also send “2: your message” to switch and continue.",
  ].join("\n\n");
}

export function renderOutboundEvent(event: OutboundEvent) {
  if (event.kind === "thread.output") {
    return [threadHeader(event.thread), event.body.trim()].filter(Boolean).join("\n\n");
  }
  if (event.kind === "thread.progress") {
    return [header("WORKING"), threadTitle(event.thread), event.phase.trim()].filter(Boolean).join("\n\n");
  }
  if (event.kind === "service.switched") {
    return [
      header("SWITCHED"),
      [threadTitle(event.thread), event.thread.projectLabel?.trim() || null].filter(Boolean).join("\n"),
      "Send a message to continue this thread.",
    ].filter(Boolean).join("\n\n");
  }
  if (event.kind === "service.menu") {
    if (event.label === "COMMANDS") {
      return event.body ? [header("COMMANDS"), event.body, event.note].filter(Boolean).join("\n\n") : renderHelp();
    }
    return renderThreadMenu(event.items ?? [], { label: event.label === "PROJECTS" ? "PROJECTS" : "THREADS", note: event.note });
  }
  const labels: Record<NoticeCode, string> = {
    connected: "CONNECTED",
    queued: "QUEUED",
    cancelled: "CANCELLED",
    "needs-attention": "NEEDS ATTENTION",
  };
  return [header(labels[event.code]), event.thread ? threadTitle(event.thread) : null, event.body.trim()].filter(Boolean).join("\n\n");
}

export function parseMenuSelection(value: string) {
  const match = value.trim().match(/^([1-9]\d*)(?:\s*:\s*([\s\S]+))?$/);
  return match ? { index: Number(match[1]) - 1, prompt: match[2]?.trim() || null } : null;
}

export function parseSlashCommand(value: string) {
  const text = value.trim();
  const match = text.match(/^\/(threads|recent|projects|search|status|cancel|help)(?:\s+([\s\S]+))?$/i);
  return match ? { command: match[1].toLowerCase(), argument: match[2]?.trim() || null } : null;
}
