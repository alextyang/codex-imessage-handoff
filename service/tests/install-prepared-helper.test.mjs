import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preparedHelperInstallCommand } from "../scripts/install-prepared-helper.mjs";

test("prepared helper installation uses the bundle runtime in the helper GUI domain", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "prepared-helper-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const node = path.join(root, "payload/runtime/node/node");
  const installer = path.join(root, "install-helper.mjs");
  mkdirSync(path.dirname(node), { recursive: true });
  writeFileSync(node, "runtime", { mode: 0o700 });
  writeFileSync(installer, "installer", { mode: 0o700 });
  chmodSync(node, 0o700);
  chmodSync(installer, 0o700);

  const command = preparedHelperInstallCommand({ uid: 502, helperUser: "codex", bundleRoot: root });
  assert.match(command, /^'\/bin\/launchctl' 'asuser' '502' '\/usr\/bin\/sudo' '-H' '-u' 'codex'/);
  assert.match(command, /payload\/runtime\/node\/node/);
  assert.match(command, /install-helper\.mjs/);
  assert.match(command, /--bundle=/);
  assert.doesNotMatch(command, /\/opt\/homebrew|expectedSender|chatGuid/);
});

test("prepared helper installation rejects missing or unsafe bundle executables", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "prepared-helper-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => preparedHelperInstallCommand({ uid: 502, helperUser: "codex", bundleRoot: root }),
    (error) => error?.code === "HELPER_INSTALL_BUNDLE_INVALID",
  );
});
