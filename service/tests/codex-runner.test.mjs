import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRunner } from "../src/codex-runner.mjs";

test("runner passes the exact user message through stdin", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-runner-test-"));
  const capture = path.join(directory, "capture.txt");
  const fake = path.join(directory, "fake-codex.mjs");
  const image = path.join(directory, "generated.png");
  writeFileSync(image, "png");
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
writeFileSync(process.env.IMESSAGE_TEST_CAPTURE, input);
writeFileSync(process.env.IMESSAGE_TEST_CAPTURE + ".args", JSON.stringify(process.argv.slice(2)));
const index = process.argv.indexOf("--output-last-message");
writeFileSync(process.argv[index + 1], "A clean answer.");
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"generated_image",path:process.env.IMESSAGE_TEST_IMAGE}}));
console.log(JSON.stringify({type:"turn.completed"}));
`, "utf8");
  chmodSync(fake, 0o700);
  const previous = process.env.IMESSAGE_TEST_CAPTURE;
  const previousImage = process.env.IMESSAGE_TEST_IMAGE;
  process.env.IMESSAGE_TEST_CAPTURE = capture;
  process.env.IMESSAGE_TEST_IMAGE = image;
  try {
    const phases = [];
    const prompt = "First line\n\nDo not wrap this message.";
    const result = await new CodexRunner({ codexPath: fake }).run({
      thread: { id: "thread-1", cwd: directory },
      prompt,
      reasoningEffort: "high",
      onPhase: (phase) => phases.push(phase),
    });
    assert.equal(readFileSync(capture, "utf8"), prompt);
    assert.deepEqual(JSON.parse(readFileSync(`${capture}.args`, "utf8")).slice(0, 3), [
      "exec",
      "--config",
      'model_reasoning_effort="high"',
    ]);
    assert.equal(result.body, "A clean answer.");
    assert.deepEqual(result.generatedImages, [image]);
    assert.deepEqual(phases, ["Starting work.", "Finishing the response."]);
  } finally {
    if (previous === undefined) delete process.env.IMESSAGE_TEST_CAPTURE;
    else process.env.IMESSAGE_TEST_CAPTURE = previous;
    if (previousImage === undefined) delete process.env.IMESSAGE_TEST_IMAGE;
    else process.env.IMESSAGE_TEST_IMAGE = previousImage;
  }
});

test("runner reports a missing Codex executable without hanging", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-runner-missing-"));
  const runner = new CodexRunner({ codexPath: path.join(directory, "missing-codex") });
  await assert.rejects(
    runner.run({ thread: { id: "thread-missing", cwd: directory }, prompt: "Hello" }),
    (error) => error.code === "CODEX_UNAVAILABLE",
  );
  assert.equal(runner.isRunning(), false);
});
