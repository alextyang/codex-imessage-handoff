import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldSuppressSubmittedUserMirror,
  submittedUserMirrorMode,
} from "../src/submitted-user-mirror-policy.mjs";

test("top-level routed prompts mirror into the selected task while native Reply prompts do not echo", () => {
  assert.equal(submittedUserMirrorMode({ kind: "prompt", threadId: "thread-a" }), "mirror");
  assert.equal(submittedUserMirrorMode({
    kind: "prompt",
    threadId: "thread-a",
    fromAwaitingPrompt: true,
  }), "mirror");
  assert.equal(submittedUserMirrorMode({
    kind: "switch",
    threadId: "thread-a",
    prompt: "Run the tests.",
  }), "mirror");
  assert.equal(submittedUserMirrorMode({
    kind: "prompt",
    threadId: "thread-a",
    threadOriginatorGuid: "native-root-guid",
  }), "suppress");
});

test("claimed mirror policy is restart-safe and legacy jobs keep their no-echo behavior", () => {
  assert.equal(shouldSuppressSubmittedUserMirror({ userMirrorMode: "mirror" }), false);
  assert.equal(shouldSuppressSubmittedUserMirror({ userMirrorMode: "suppress" }), true);
  assert.equal(shouldSuppressSubmittedUserMirror({}), true);
  assert.equal(shouldSuppressSubmittedUserMirror(null), true);
});
