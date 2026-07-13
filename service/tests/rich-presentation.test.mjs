import assert from "node:assert/strict";
import test from "node:test";
import { renderOutboundMessages } from "../../protocol/presentation.ts";
import {
  compileMarkdownRanges,
  renderRichOutboundIntents,
  richTextIntent,
} from "../../protocol/rich-presentation.ts";

const THREAD = {
  id: "rich-thread",
  title: "Polish message formatting",
  createdAt: "2026-07-12T07:00:00.000Z",
  projectKey: "handoff",
  projectLabel: "iMessage handoff",
};

const presentation = { context: { activeThread: THREAD } };

function rangeFor(ranges, style, location, length) {
  return ranges.some((range) => range.style === style
    && range.location === location
    && range.length === length);
}

test("Markdown compiles to deterministic UTF-16 native style ranges", () => {
  const source = "🧪 **Bold and *italic* end** __under__ ~~strike~~";
  const result = compileMarkdownRanges(source);

  assert.equal(result.text, "🧪 Bold and italic end under strike");
  const bold = "Bold and italic end";
  const italic = "italic";
  assert.equal(result.text.indexOf(bold), 3, "the leading emoji occupies two UTF-16 units");
  assert.ok(rangeFor(result.ranges, "bold", result.text.indexOf(bold), bold.length));
  assert.ok(rangeFor(result.ranges, "italic", result.text.indexOf(italic), italic.length));
  assert.ok(rangeFor(result.ranges, "underline", result.text.indexOf("under"), "under".length));
  assert.ok(rangeFor(result.ranges, "strikethrough", result.text.indexOf("strike"), "strike".length));
});

test("nested formatting remains correct around emoji and non-ASCII text", () => {
  const result = compileMarkdownRanges("**🧪 bold *café* done**");
  assert.equal(result.text, "🧪 bold café done");
  assert.deepEqual(result.ranges, [
    { location: 0, length: result.text.length, style: "bold" },
    { location: result.text.indexOf("café"), length: "café".length, style: "italic" },
  ]);
});

test("escaped markers, inline code, and URL punctuation remain literal", () => {
  const source = `${String.raw`\*literal\* \_plain\_`} \`**code**\` https://example.test/a_b_c`;
  const result = compileMarkdownRanges(source);
  assert.equal(result.text, "*literal* _plain_ `**code**` https://example.test/a_b_c");
  assert.deepEqual(result.ranges, []);
});

test("Markdown headings lose only their marker and become bold", () => {
  const result = compileMarkdownRanges("## 🧭 Browse\nPlain text");
  assert.equal(result.text, "🧭 Browse\nPlain text");
  assert.deepEqual(result.ranges, [{ location: 0, length: "🧭 Browse".length, style: "bold" }]);
});

test("rich text intents retain an exact Markdown fallback", () => {
  const fallbackText = "🧪 **A task**\n\n▲ Needs attention\nReasoning: high\n\ncodex://threads/a-task\n\n/listen · /link · /mute\n/turn · /history · /reasoning · /cancel";
  const intent = richTextIntent(fallbackText);
  assert.equal(intent.fallbackText, fallbackText);
  assert.equal(intent.text, "🧪 A task\n\n▲ Needs attention\nReasoning: high\n\ncodex://threads/a-task\n\n/listen · /link · /mute\n/turn · /history · /reasoning · /cancel");
  assert.ok(rangeFor(intent.ranges, "bold", intent.text.indexOf("A task"), "A task".length));
  for (const command of ["/listen", "/link", "/mute", "/turn", "/history", "/reasoning", "/cancel"]) {
    assert.ok(rangeFor(intent.ranges, "bold", intent.text.indexOf(command), command.length));
  }

  assert.deepEqual(richTextIntent(fallbackText, { richText: false }), {
    kind: "text",
    text: fallbackText,
    fallbackText,
    ranges: [],
  });
});

test("directory previews are italic while project and selected titles are bold", () => {
  const event = {
    kind: "service.directory",
    directory: {
      groups: [{
        projectKey: "handoff",
        projectLabel: "iMessage handoff",
        startedAt: "2026-07-01T00:00:00.000Z",
        threads: [{
          ...THREAD,
          index: 1,
          current: true,
          status: "idle",
          activityAt: "2026-07-12T08:00:00.000Z",
          requestPreview: "Show every rich message type.",
        }],
      }],
    },
  };
  const [intent] = renderRichOutboundIntents(event, {
    presentation,
    capabilities: { richText: true },
  });
  assert.equal(intent.kind, "text");
  assert.doesNotMatch(intent.text, /\*\*/);
  const preview = "“Show every rich message type.”";
  assert.ok(rangeFor(intent.ranges, "italic", intent.text.indexOf(preview), preview.length));
  assert.ok(rangeFor(intent.ranges, "bold", intent.text.indexOf("iMessage handoff"), "iMessage handoff".length));
  assert.ok(rangeFor(intent.ranges, "bold", intent.text.indexOf("Polish message formatting"), "Polish message formatting".length));
});

test("assistant commentary bubbles are italic without losing nested emphasis", () => {
  const event = {
    kind: "thread.live-message",
    messageId: "commentary-1",
    thread: THREAD,
    role: "assistant",
    phase: "commentary",
    body: "🧭 Checking **three paths** now.",
  };
  const [intent] = renderRichOutboundIntents(event, { presentation });
  assert.equal(intent.kind, "text");
  assert.equal(intent.text, "🧭 Checking three paths now.");
  assert.ok(rangeFor(intent.ranges, "italic", 0, intent.text.length));
  assert.ok(rangeFor(intent.ranges, "bold", intent.text.indexOf("three paths"), "three paths".length));
});

test("commentary recovered in a detail transcript is italicized by body", () => {
  const event = {
    kind: "thread.detail",
    thread: THREAD,
    state: "working",
    requestPreview: { body: "Make the local path richer." },
    assistantMessages: [
      { body: "Inspecting **Messages** support.", phase: "commentary" },
      { body: "The richer path is ready.", phase: "final_answer" },
    ],
  };
  const intents = renderRichOutboundIntents(event, { presentation });
  const assistant = intents.at(-1);
  assert.equal(assistant.kind, "text");
  const commentary = "Inspecting Messages support.";
  assert.ok(rangeFor(assistant.ranges, "italic", assistant.text.indexOf(commentary), commentary.length));
  assert.ok(rangeFor(assistant.ranges, "bold", assistant.text.indexOf("Messages"), "Messages".length));
  assert.equal(assistant.ranges.some((range) => range.style === "italic"
    && range.location <= assistant.text.indexOf("The richer path is ready.")
    && range.location + range.length > assistant.text.indexOf("The richer path is ready.")), false);
});

test("unchanged reasoning selectors become native polls when supported", () => {
  const event = {
    kind: "service.reasoning",
    thread: THREAD,
    current: "high",
    options: [
      { value: "default", selected: false },
      { value: "medium", selected: false },
      { value: "high", selected: true },
      { value: "xhigh", selected: false },
    ],
  };
  const exactFallback = renderOutboundMessages(event, presentation)[0];
  const [intent] = renderRichOutboundIntents(event, {
    presentation,
    capabilities: { richText: true, polls: true },
  });
  assert.equal(intent.kind, "poll");
  assert.equal(intent.question, "Reasoning · high selected");
  assert.equal(intent.allowMultiple, false);
  assert.equal(intent.fallback.fallbackText, exactFallback);
  assert.deepEqual(intent.options, [
    { id: "none", label: "none", selected: false, command: "/reasoning none" },
    { id: "medium", label: "medium", selected: false, command: "/reasoning medium" },
    { id: "high", label: "high · selected", selected: true, command: "/reasoning high" },
    { id: "xhigh", label: "xhigh", selected: false, command: "/reasoning xhigh" },
  ]);

  const [fallback] = renderRichOutboundIntents(event, {
    presentation,
    capabilities: { richText: false, polls: false },
  });
  assert.equal(fallback.kind, "text");
  assert.equal(fallback.text, exactFallback);
  assert.equal(fallback.fallbackText, exactFallback);
  assert.deepEqual(fallback.ranges, []);
});

test("changed and invalid reasoning responses remain text instead of polls", () => {
  for (const event of [
    {
      kind: "service.reasoning",
      thread: THREAD,
      current: "high",
      options: [{ value: "high", selected: true }],
      changed: true,
    },
    {
      kind: "service.reasoning",
      thread: THREAD,
      options: [],
      invalid: "maximum",
    },
  ]) {
    const intents = renderRichOutboundIntents(event, {
      presentation,
      capabilities: { richText: true, polls: true },
    });
    assert.equal(intents[0].kind, "text");
  }
});
