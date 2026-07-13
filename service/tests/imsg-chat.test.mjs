import assert from "node:assert/strict";
import test from "node:test";
import { inspectLocalImsgChat } from "../src/imsg-chat.mjs";

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
