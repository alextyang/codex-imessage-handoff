import {
  reasoningDisplay,
  renderOutboundMessages,
  type OutboundEvent,
  type PresentationOptions,
} from "./presentation.ts";

export type NativeTextStyle = "bold" | "italic" | "underline" | "strikethrough";

/**
 * An NSRange-compatible range. JavaScript string offsets are UTF-16 code-unit
 * offsets, which is also what Apple's attributed-string APIs expect.
 */
export interface NativeTextRange {
  location: number;
  length: number;
  style: NativeTextStyle;
}

export interface RichTextIntent {
  kind: "text";
  /** Text with supported formatting delimiters removed. */
  text: string;
  /** The exact transport-neutral presentation used when rich text is absent. */
  fallbackText: string;
  ranges: NativeTextRange[];
}

export interface RichPollOption {
  id: string;
  label: string;
  selected: boolean;
  command: string;
}

export interface RichPollIntent {
  kind: "poll";
  question: string;
  options: RichPollOption[];
  allowMultiple: false;
  fallback: RichTextIntent;
}

export type RichMessageIntent = RichTextIntent | RichPollIntent;

export interface RichTransportCapabilities {
  richText?: boolean;
  polls?: boolean;
}

export interface RichPresentationOptions {
  presentation?: PresentationOptions;
  capabilities?: RichTransportCapabilities;
}

interface OpenDelimiter {
  token: string;
  styles: NativeTextStyle[];
  start: number;
}

const DELIMITERS: ReadonlyArray<{ token: string; styles: NativeTextStyle[] }> = [
  { token: "***", styles: ["bold", "italic"] },
  { token: "___", styles: ["bold", "italic"] },
  { token: "**", styles: ["bold"] },
  { token: "__", styles: ["underline"] },
  { token: "~~", styles: ["strikethrough"] },
  { token: "++", styles: ["underline"] },
  { token: "*", styles: ["italic"] },
  { token: "_", styles: ["italic"] },
];

const ESCAPABLE = new Set(["\\", "*", "_", "~", "+", "`", "#"]);
const STYLE_ORDER: Record<NativeTextStyle, number> = {
  bold: 0,
  italic: 1,
  underline: 2,
  strikethrough: 3,
};

function delimiterAt(source: string, index: number) {
  return DELIMITERS.find(({ token }) => source.startsWith(token, index)) ?? null;
}

function hasClosingDelimiter(source: string, index: number, token: string) {
  for (let cursor = index + token.length; cursor <= source.length - token.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "`") {
      const ticks = source.slice(cursor).match(/^`+/)?.[0] ?? "`";
      const end = source.indexOf(ticks, cursor + ticks.length);
      if (end >= 0) cursor = end + ticks.length - 1;
      continue;
    }
    if (source.startsWith(token, cursor)) return true;
  }
  return false;
}

function normalizeRanges(ranges: NativeTextRange[]) {
  const valid = ranges
    .filter((range) => range.location >= 0 && range.length > 0)
    .sort((left, right) => STYLE_ORDER[left.style] - STYLE_ORDER[right.style]
      || left.location - right.location
      || left.length - right.length);
  const merged: NativeTextRange[] = [];
  for (const range of valid) {
    const previous = merged.at(-1);
    const previousEnd = previous ? previous.location + previous.length : -1;
    const rangeEnd = range.location + range.length;
    if (previous?.style === range.style && range.location <= previousEnd) {
      previous.length = Math.max(previousEnd, rangeEnd) - previous.location;
    } else {
      merged.push({ ...range });
    }
  }
  return merged.sort((left, right) => left.location - right.location
    || left.length - right.length
    || STYLE_ORDER[left.style] - STYLE_ORDER[right.style]);
}

interface MarkdownLink {
  end: number;
  image: boolean;
  label: string;
  target: string;
}

function markdownLinkAt(source: string, index: number): MarkdownLink | null {
  const image = source[index] === "!" && source[index + 1] === "[";
  const opening = image ? index + 1 : index;
  if (source[opening] !== "[") return null;

  let cursor = opening + 1;
  let bracketDepth = 1;
  for (; cursor < source.length && bracketDepth > 0; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "[") bracketDepth += 1;
    else if (source[cursor] === "]") bracketDepth -= 1;
  }
  if (bracketDepth !== 0 || source[cursor] !== "(") return null;

  const label = source.slice(opening + 1, cursor - 1);
  const targetStart = cursor + 1;
  let parenthesisDepth = 1;
  cursor = targetStart;
  for (; cursor < source.length && parenthesisDepth > 0; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "(") parenthesisDepth += 1;
    else if (source[cursor] === ")") parenthesisDepth -= 1;
  }
  if (parenthesisDepth !== 0) return null;

  let target = source.slice(targetStart, cursor - 1).trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  target = target.replace(/\\([\\() ])/g, "$1");
  if (!label.trim() || !target) return null;
  return { end: cursor, image, label, target };
}

function isPortableLinkTarget(value: string) {
  return /^(?:https?:|mailto:|tel:|codex:)/i.test(value);
}

/**
 * Compile the deliberately small Markdown subset emitted by presentation.ts
 * into attributed-string text and deterministic NSRange-compatible spans.
 * Portable URLs stay visible so Messages can keep them clickable. Local file
 * links and images lose their unusable destination and retain a bold label.
 * Inline/fenced code stays byte-for-byte visible.
 */
export function compileMarkdownRanges(source: string) {
  let text = "";
  const ranges: NativeTextRange[] = [];
  const stack: OpenDelimiter[] = [];
  let lineStart = true;
  let headingStart: number | null = null;

  const closeHeading = () => {
    if (headingStart !== null && text.length > headingStart) {
      ranges.push({ location: headingStart, length: text.length - headingStart, style: "bold" });
    }
    headingStart = null;
  };

  for (let index = 0; index < source.length;) {
    if (lineStart) {
      const heading = source.slice(index).match(/^(#{1,6})[ \t]+/);
      if (heading) {
        index += heading[0].length;
        headingStart = text.length;
      }
      lineStart = false;
      if (index >= source.length) break;
    }

    const character = source[index];
    if (character === "\n") {
      closeHeading();
      text += character;
      index += 1;
      lineStart = true;
      continue;
    }

    if (character === "\\" && index + 1 < source.length && ESCAPABLE.has(source[index + 1])) {
      text += source[index + 1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const ticks = source.slice(index).match(/^`+/)?.[0] ?? "`";
      const end = source.indexOf(ticks, index + ticks.length);
      if (end >= 0) {
        text += source.slice(index, end + ticks.length);
        index = end + ticks.length;
        continue;
      }
    }

    const link = markdownLinkAt(source, index);
    if (link) {
      const compiledLabel = compileMarkdownRanges(link.label);
      const untrimmedLabel = compiledLabel.text;
      const leadingWhitespace = untrimmedLabel.length - untrimmedLabel.trimStart().length;
      const label = untrimmedLabel.trim();
      const labelEnd = leadingWhitespace + label.length;
      if (label) {
        const labelStart = text.length;
        text += label;
        for (const range of compiledLabel.ranges) {
          const start = Math.max(leadingWhitespace, range.location);
          const end = Math.min(labelEnd, range.location + range.length);
          if (end > start) {
            ranges.push({
              ...range,
              location: labelStart + start - leadingWhitespace,
              length: end - start,
            });
          }
        }
        if (link.image || !isPortableLinkTarget(link.target)) {
          ranges.push({ location: labelStart, length: label.length, style: "bold" });
        } else {
          ranges.push({ location: labelStart, length: label.length, style: "underline" });
          if (label !== link.target) text += ` — ${link.target}`;
        }
        index = link.end;
        continue;
      }
    }

    if (/^https?:\/\//i.test(source.slice(index)) && (index === 0 || /[\s(<[]/.test(source[index - 1]))) {
      const url = source.slice(index).match(/^https?:\/\/[^\s>]+/i)?.[0];
      if (url) {
        text += url;
        index += url.length;
        continue;
      }
    }

    const delimiter = delimiterAt(source, index);
    if (delimiter) {
      const open = stack.at(-1);
      const previous = index > 0 ? source[index - 1] : "";
      const next = source[index + delimiter.token.length] ?? "";
      if (open?.token === delimiter.token && previous && !/\s/.test(previous)) {
        stack.pop();
        const length = text.length - open.start;
        for (const style of open.styles) ranges.push({ location: open.start, length, style });
        index += delimiter.token.length;
        continue;
      }
      const underscoreInsideWord = delimiter.token.includes("_")
        && /[\p{L}\p{N}]/u.test(previous)
        && /[\p{L}\p{N}]/u.test(next);
      if (!underscoreInsideWord && next && !/\s/.test(next) && hasClosingDelimiter(source, index, delimiter.token)) {
        stack.push({ ...delimiter, start: text.length });
        index += delimiter.token.length;
        continue;
      }
    }

    text += character;
    index += 1;
  }
  closeHeading();

  return { text, ranges: normalizeRanges(ranges) };
}

function appendPatternRanges(text: string, ranges: NativeTextRange[], event?: OutboundEvent) {
  for (const match of text.matchAll(/(^|[\s·(“])\/(?:new|threads|recent|refresh|projects|search|thread|open|request|message|turn|history|reasoning|defaultreasoning|listen|mute|unmute|status|retry|dismiss|cancel|help)\b/gim)) {
    const prefixLength = match[1].length;
    const token = match[0].slice(prefixLength);
    ranges.push({ location: (match.index ?? 0) + prefixLength, length: token.length, style: "bold" });
  }
  if (event?.kind === "service.directory" || (event?.kind === "service.menu" && event.label !== "COMMANDS")) {
    for (const match of text.matchAll(/(^|\n)[ \t]*(“[^”\n]*”)(?=\n|$)/g)) {
      const quote = match[2];
      ranges.push({ location: (match.index ?? 0) + match[0].lastIndexOf(quote), length: quote.length, style: "italic" });
    }
  }
}

function compiledBody(value: string) {
  return compileMarkdownRanges(value).text.trim();
}

function appendCommentaryRanges(event: OutboundEvent, text: string, ranges: NativeTextRange[]) {
  if (event.kind === "thread.live-message" && event.role === "assistant" && event.phase === "commentary") {
    if (text.length > 0) ranges.push({ location: 0, length: text.length, style: "italic" });
    return;
  }

  const commentaryBodies: string[] = [];
  if (event.kind === "thread.detail") {
    for (const message of event.assistantMessages ?? []) {
      if (message.phase === "commentary") commentaryBodies.push(compiledBody(message.body));
    }
  } else if (event.kind === "thread.turn" && event.turn) {
    for (const message of event.turn.assistantMessages ?? []) {
      if (message.phase === "commentary") commentaryBodies.push(compiledBody(message.body));
    }
  } else if (event.kind === "thread.history") {
    for (const turn of event.turns) {
      for (const message of turn?.assistantMessages ?? []) {
        if (message.phase === "commentary") commentaryBodies.push(compiledBody(message.body));
      }
    }
  }

  let cursor = 0;
  for (const body of commentaryBodies.filter(Boolean)) {
    const location = text.indexOf(body, cursor);
    if (location < 0) continue;
    ranges.push({ location, length: body.length, style: "italic" });
    cursor = location + body.length;
  }
}

export function richTextIntent(
  fallbackText: string,
  options: { richText?: boolean; event?: OutboundEvent } = {},
): RichTextIntent {
  if (options.richText === false) {
    return { kind: "text", text: fallbackText, fallbackText, ranges: [] };
  }
  const compiled = compileMarkdownRanges(fallbackText);
  const ranges = [...compiled.ranges];
  appendPatternRanges(compiled.text, ranges, options.event);
  if (options.event) appendCommentaryRanges(options.event, compiled.text, ranges);
  return {
    kind: "text",
    text: compiled.text,
    fallbackText,
    ranges: normalizeRanges(ranges),
  };
}

function reasoningValue(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return !normalized || normalized === "default" ? "none" : normalized;
}

function reasoningPoll(
  event: Extract<OutboundEvent, { kind: "service.reasoning" }>,
  fallbackText: string,
  capabilities: RichTransportCapabilities,
): RichPollIntent {
  const current = reasoningValue(event.current);
  const currentDisplay = reasoningDisplay(current);
  return {
    kind: "poll",
    question: `Reasoning · ${currentDisplay.emoji} ${currentDisplay.label}`,
    options: event.options.map((option) => {
      const item = typeof option === "string" ? { value: option } : option;
      const value = reasoningValue(item.value);
      const display = reasoningDisplay(value);
      return {
        id: value,
        label: `${display.emoji} ${display.label}${(item.selected ?? value === current) ? " · selected" : ""}`,
        selected: item.selected ?? value === current,
        command: `/reasoning ${value}`,
      };
    }),
    allowMultiple: false,
    fallback: richTextIntent(fallbackText, { richText: capabilities.richText, event }),
  };
}

/** Render one transport-neutral intent for each semantic outbound bubble. */
export function renderRichOutboundIntents(
  event: OutboundEvent,
  options: RichPresentationOptions = {},
): RichMessageIntent[] {
  const messages = renderOutboundMessages(event, options.presentation);
  const capabilities = options.capabilities ?? {};
  if (event.kind === "service.reasoning" && !event.changed && !event.invalid && capabilities.polls && messages[0]) {
    return [reasoningPoll(event, messages[0], capabilities)];
  }
  return messages.map((message) => richTextIntent(message, { richText: capabilities.richText, event }));
}
