import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { inspectLocalImsgChat, inspectLocalImsgMessage } from "../src/imsg-chat.mjs";

function mirrorBodyHash(text) {
  return createHash("sha256").update(`local-user-mirror-body-v1\0${text}`).digest("hex");
}

test("inspects bounded local chat metadata without logging participant handles", () => {
  const calls = [];
  const result = inspectLocalImsgChat({
    binary: "/private/imsg",
    chatId: 42,
    run(binary, args, options) {
      calls.push({ binary, args, options });
      return '{"id":42,"guid":"private-guid","service":"iMessage","is_group":false,"participants":["+15551234567",{"handle":"user@example.com"}]}\n';
    },
  });
  assert.deepEqual(result, {
    chatId: 42,
    chatGuid: "private-guid",
    service: "iMessage",
    isGroup: false,
    participants: ["+15551234567", "user@example.com"],
  });
  assert.deepEqual(calls[0].args, ["group", "--chat-id", "42", "--json"]);
  assert.equal(calls[0].options.timeout, 15_000);
});

test("fails closed when local chat metadata is missing or malformed", () => {
  assert.throws(
    () => inspectLocalImsgChat({ binary: "/private/imsg", chatId: 0 }),
    (error) => error?.code === "IMSG_CHAT_INVALID",
  );
  assert.throws(
    () => inspectLocalImsgChat({ binary: "/private/imsg", chatId: 42, run: () => "not-json\n" }),
    (error) => error?.code === "IMSG_CHAT_INVALID",
  );
  assert.throws(
    () => inspectLocalImsgChat({ binary: "/private/imsg", chatId: 42, run: () => '{"id":7,"guid":"other"}\n' }),
    (error) => error?.code === "IMSG_CHAT_MISMATCH",
  );
});

test("an exact message lookup returns only content-free mirror proof metadata", () => {
  const calls = [];
  const result = inspectLocalImsgMessage({
    chatId: 42,
    messageGuid: "INBOUND-MIRROR-GUID",
    database: "/private/chat.db",
    run(binary, args, options) {
      calls.push({ binary, args, options });
      return JSON.stringify([{
        guid: "INBOUND-MIRROR-GUID",
        chat_id: 42,
        is_from_me: 0,
        sender: "+12145550196",
        thread_originator_guid: "THREAD-ROOT-GUID",
        text: "Exact mirrored request",
      }]);
    },
  });
  assert.deepEqual(result, {
    guid: "INBOUND-MIRROR-GUID",
    chat_id: 42,
    is_from_me: false,
    sender: "+12145550196",
    thread_originator_guid: "THREAD-ROOT-GUID",
    body_hash: mirrorBodyHash("Exact mirrored request"),
  });
  assert.equal(Object.hasOwn(result, "text"), false);
  const query = calls[0].args.at(-1);
  assert.match(query, /m\.thread_originator_guid AS thread_originator_guid/u);
  assert.match(query, /m\.text AS text/u);
  assert.equal(query.includes("INBOUND-MIRROR-GUID"), false, "the untrusted GUID remains blob-encoded");
  assert.equal(calls[0].options.maxBuffer, 256 * 1024);
});

test("exact message lookup strips only a terminal legacy mirror tag before hashing", () => {
  const token = "codex-mirror-0123456789abcdef0123456789abcdef";
  const tag = `\u{E0001}${[...token].map((character) => String.fromCodePoint(0xe0000 + character.codePointAt(0))).join("")}\u{E007F}`;
  const result = inspectLocalImsgMessage({
    chatId: 42,
    messageGuid: "LEGACY-MIRROR-GUID",
    database: "/private/chat.db",
    run: () => JSON.stringify([{
      guid: "LEGACY-MIRROR-GUID",
      chat_id: 42,
      is_from_me: false,
      sender: "+12145550196",
      thread_originator_guid: "THREAD-ROOT-GUID",
      text: `Legacy request${tag}`,
    }]),
  });
  assert.equal(result.body_hash, mirrorBodyHash("Legacy request"));
  assert.throws(
    () => inspectLocalImsgMessage({
      chatId: 42,
      messageGuid: "AMBIGUOUS-GUID",
      database: "/private/chat.db",
      run: () => JSON.stringify([
        { guid: "AMBIGUOUS-GUID", chat_id: 42, is_from_me: 0 },
        { guid: "AMBIGUOUS-GUID", chat_id: 42, is_from_me: 0 },
      ]),
    }),
    (error) => error?.code === "IMSG_MESSAGE_LOOKUP_INVALID",
  );
});
