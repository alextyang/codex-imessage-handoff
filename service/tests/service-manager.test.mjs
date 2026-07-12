import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderLaunchAgent, resolveCodexBinary } from "../src/service-manager.mjs";

test("LaunchAgent pins an executable Codex binary and a usable PATH", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-service-manager-"));
  const codex = path.join(directory, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(codex, 0o700);
  assert.equal(resolveCodexBinary({ CODEX_BIN: codex, PATH: "/usr/bin:/bin" }), codex);

  const plist = renderLaunchAgent({
    stateDb: path.join(directory, "state.sqlite"),
    stdoutLog: path.join(directory, "service.log"),
    stderrLog: path.join(directory, "service-error.log"),
  }, codex);
  assert.match(plist, new RegExp(`<key>CODEX_BIN</key><string>${codex}</string>`));
  assert.match(plist, /<key>PATH<\/key><string>[^<]*\/usr\/bin/);
});

