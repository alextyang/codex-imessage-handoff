import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createPrivateKey } from "node:crypto";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ImsgHelperServer } from "../src/imsg-helper-server.mjs";
import {
  controllerIdentityHash,
  createControllerAttestation,
  createHelperAttestation,
  extractImsgAccountIdentities,
  helperIdentityHash,
  imsgAccountFingerprint,
  imsgIdentityHashes,
  imsgProfileHash,
  ipcPublicKeyFingerprint,
} from "../src/imsg-ipc-protocol.mjs";
import {
  activeIdentityPins,
  discoverDedicatedImsgProfile,
  ensureImsgBridgeReady,
  installDedicatedImsgHelper,
  renderHelperLaunchAgent,
  validateHelperInstallIdentity,
} from "../src/split-user-helper-installer.mjs";
import {
  assertDedicatedHelperAccount,
  canonicalRecipient,
  expectedControllerIdentityHash,
  recipientIdentityHash,
  sha256,
  stageSplitUserHelperBundle,
  validateDedicatedSharedGroup,
} from "../src/split-user-staging.mjs";
import { readPrivateRecipientConfig, readPrivateRecipientFile } from "../scripts/prepare-split-user-helper.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function writeFixture(file, contents, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
  return file;
}

function filesBelow(root) {
  const files = [];
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else files.push(file);
    }
  };
  visit(root);
  return files;
}

function makeBundle(t, { shortRoot = false } = {}) {
  const root = mkdtempSync(path.join(shortRoot ? "/tmp" : os.tmpdir(), "split-user-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controllerHome = path.join(root, "controller");
  const codexHome = path.join(controllerHome, ".codex");
  const helperHome = path.join(root, "helper");
  const runtime = path.join(root, "runtime");
  const sharedBase = path.join(root, "shared");
  for (const directory of [codexHome, helperHome, runtime, sharedBase]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFixture(path.join(runtime, "imsg"), "original gui-only imsg\n", 0o755);
  writeFixture(path.join(runtime, "imsg-bridge-helper.dylib"), "private bridge dylib\n", 0o755);
  writeFixture(path.join(runtime, "Resources", "bridge.json"), "{\"bridge\":2}\n", 0o644);
  const daemonSafeImsg = writeFixture(path.join(root, "patched", "imsg"), "daemon-safe imsg\n", 0o755);
  const nodeRuntime = writeFixture(path.join(root, "standalone-runtime", "node"), "#!/bin/sh\nexit 0\n", 0o755);
  const uid = process.getuid();
  const controllerUsername = os.userInfo().username;
  const username = "codex-helper-fixture";
  const safeGid = (process.getgroups?.() || []).find((gid) => gid >= 500 && ![703, 701].includes(gid))
    || (process.getgroups?.() || []).find((gid) => gid >= 500);
  assert.ok(Number.isSafeInteger(safeGid), "the macOS test account needs one non-system supplemental group");
  const recipient = "+1 (555) 123-4567";
  const localIdentity = "P:+1 (555) 765-4321";
  const sharedRoot = path.join(sharedBase, "codex-imessage-helper");
  const stageOptions = {
    projectRoot,
    expectedRecipient: recipient,
    daemonSafeImsgBinary: daemonSafeImsg,
    imsgRuntimeRoot: runtime,
    sharedBase,
    sharedRoot,
    nodePath: nodeRuntime,
    controller: { uid, username: controllerUsername, home: controllerHome, codexHome, groupIds: [safeGid] },
    dedicatedUser: { uid, username, home: helperHome, groupIds: [safeGid] },
    sharedGroup: { name: "codex-imessage-fixture", gid: safeGid, members: [controllerUsername, username] },
    now: () => "2026-07-12T12:00:00.000Z",
    bundleId: "fixture-bundle",
  };
  const staged = stageSplitUserHelperBundle(stageOptions);
  return { root, controllerHome, codexHome, helperHome, runtime, sharedRoot, staged, stageOptions, daemonSafeImsg, uid, username, controllerUsername, safeGid, recipient, localIdentity };
}

function helperInstallOptions(fixture, extras = {}) {
  const account = {
    login: fixture.localIdentity,
    aliases: ["E:helper.alias@example.com"],
    last_addressed_handle: "+15557654321",
  };
  return {
    bundleRoot: fixture.sharedRoot,
    uid: fixture.uid,
    username: fixture.username,
    home: fixture.helperHome,
    groupIds: [fixture.safeGid],
    inspectedGroup: { name: "codex-imessage-fixture", gid: fixture.safeGid, members: [fixture.controllerUsername, fixture.username] },
    privateRoot: path.join(fixture.helperHome, "Library/Application Support/Codex iMessage Helper"),
    allowNonDarwin: true,
    loadAgent: false,
    bridgeReady: true,
    account,
    chats: [{
      id: 77,
      guid: "iMessage;-;private-conversation-guid",
      service: "iMessage",
      is_group: false,
      participants: [fixture.recipient],
      account_login: fixture.localIdentity,
      last_message_at: "2026-07-12T12:00:00Z",
    }],
    now: () => "2026-07-12T12:05:00.000Z",
    ...extras,
  };
}

test("recipient, controller, helper, account, and profile hashes use the shared IPC protocol", () => {
  assert.equal(canonicalRecipient("tel:+1 (555) 123-4567"), "phone:15551234567");
  assert.equal(recipientIdentityHash("P:+1 (555) 123-4567"), imsgIdentityHashes("tel:+15551234567")[0]);
  const codexHome = realpathSync(os.tmpdir());
  const controller = { uid: 501, username: "alex", codexHome };
  assert.equal(
    expectedControllerIdentityHash(controller),
    controllerIdentityHash(createControllerAttestation(controller)),
  );
  const account = {
    login: "P:+15557654321",
    account: { last_addressed_handle: "mailto:helper@example.com" },
    accounts: [{ aliases: ["E:alias@example.com"], handles: ["tel:+15559876543"] }],
  };
  const extracted = extractImsgAccountIdentities(account);
  const pins = activeIdentityPins(account);
  assert.equal(pins.accountFingerprint, imsgAccountFingerprint(extracted));
  assert.deepEqual(pins.hashes, imsgIdentityHashes(extracted));
});

test("split-user security rejects administrator helpers and broad or multi-user groups", () => {
  assert.throws(
    () => assertDedicatedHelperAccount({ uid: 502, username: "codex", home: "/Users/codex", groupIds: [20, 80] }, { controllerUsername: "alex" }),
    (error) => error?.code === "SPLIT_USER_HELPER_PRIVILEGED",
  );
  assert.throws(
    () => assertDedicatedHelperAccount({ uid: 502, username: "codex", home: "/Users/codex", groupIds: [20, 204] }, { controllerUsername: "alex" }),
    (error) => error?.code === "SPLIT_USER_HELPER_PRIVILEGED",
  );
  assert.throws(
    () => validateHelperInstallIdentity({
      uid: 502,
      username: "codex",
      groupIds: [700, 204],
      signedGroup: { name: "codex-imessage", gid: 700, members: ["alex", "codex"] },
      inspectedGroup: { name: "codex-imessage", gid: 700, members: ["alex", "codex"] },
    }),
    (error) => error?.code === "HELPER_ACCOUNT_PRIVILEGED",
  );
  assert.throws(
    () => validateDedicatedSharedGroup({ name: "staff", gid: 20, members: ["alex", "codex"] }, { controllerUsername: "alex", helperUsername: "codex" }),
    (error) => error?.code === "SPLIT_USER_SHARED_GROUP_UNSAFE",
  );
  assert.throws(
    () => validateDedicatedSharedGroup({ name: "codex-imessage", gid: 704, members: ["alex", "codex", "guest"] }, { controllerUsername: "alex", helperUsername: "codex" }),
    (error) => error?.code === "SPLIT_USER_SHARED_GROUP_UNSAFE",
  );
});

test("profile discovery selects the latest direct iMessage and rejects self chats", () => {
  const recipient = "+15551234567";
  const local = "helper@example.com";
  const expectedRecipientHash = imsgIdentityHashes(recipient)[0];
  const account = { account: { login: local, aliases: ["+15557654321"] } };
  const result = discoverDedicatedImsgProfile({
    binary: "/private/imsg",
    expectedRecipientHash,
    account,
    chats: [
      { id: 4, guid: "group", service: "iMessage", is_group: true, participants: [recipient], account_login: local },
      { id: 5, guid: "sms", service: "SMS", is_group: false, participants: [recipient], account_login: local },
      { id: 41, guid: "older", service: "iMessage", is_group: false, participants: [recipient], account_login: local, last_message_at: "2026-07-10T00:00:00Z" },
      { id: 42, guid: "latest-private-guid", service: "iMessage", is_group: false, participants: ["P:+1 (555) 123-4567"], last_addressed_handle: "E:helper@example.com", last_message_at: "2026-07-11T00:00:00Z" },
    ],
  });
  assert.equal(result.profile.chatId, 42);
  assert.equal(result.profile.chatGuid, "latest-private-guid");
  assert.equal(result.profile.localIdentity, "E:helper@example.com");
  assert.equal(result.profile.accountFingerprint, imsgAccountFingerprint(extractImsgAccountIdentities(account)));
  assert.equal(result.profileHash, imsgProfileHash(result.profile));
  assert.throws(
    () => discoverDedicatedImsgProfile({
      binary: "/private/imsg",
      expectedRecipientHash: imsgIdentityHashes(local)[0],
      account,
      chats: [{ id: 1, guid: "self", service: "iMessage", participants: [local], account_login: local }],
    }),
    (error) => error?.code === "HELPER_SELF_CHAT",
  );
});

test("bridge setup uses only the staged private runtime and waits for v2 readiness", () => {
  const calls = [];
  let statusCalls = 0;
  const run = (binary, args) => {
    calls.push([binary, ...args]);
    if (args[0] === "launch") return '{"launched":true}\n';
    statusCalls += 1;
    return statusCalls >= 3
      ? '{"advanced_features":true,"v2_ready":true,"rpc_methods":["watch.subscribe"]}\n'
      : '{"advanced_features":false,"v2_ready":false,"rpc_methods":[]}\n';
  };
  ensureImsgBridgeReady({ binary: "/private/runtime/imsg", bridgeDylib: "/private/runtime/bridge.dylib", run, wait: () => {} });
  assert.deepEqual(calls[1], ["/private/runtime/imsg", "launch", "--json", "--dylib", "/private/runtime/bridge.dylib"]);
  assert.equal(calls.some((call) => call.join(" ").includes("codex")), false);
});

test("bridge upgrades restart the dedicated Messages process before validating the staged dylib", () => {
  const calls = [];
  const run = (binary, args) => {
    calls.push([binary, ...args]);
    if (args[0] === "status") {
      return '{"advanced_features":true,"v2_ready":true,"rpc_methods":["watch.subscribe"]}\n';
    }
    return '{"status":"ok"}\n';
  };
  ensureImsgBridgeReady({
    binary: "/private/runtime/imsg",
    bridgeDylib: "/private/runtime/bridge.dylib",
    forceRestart: true,
    run,
    wait: () => {},
  });
  assert.deepEqual(calls.slice(0, 3), [
    ["/private/runtime/imsg", "launch", "--kill-only", "--json"],
    ["/private/runtime/imsg", "launch", "--json", "--dylib", "/private/runtime/bridge.dylib"],
    ["/private/runtime/imsg", "status", "--json"],
  ]);
});

test("LaunchAgent is persistent and contains path-only private configuration", () => {
  const plist = renderHelperLaunchAgent({
    nodePath: "/private/node",
    entrypoint: "/private/helper.mjs",
    configPath: "/private/config.json",
    stdoutLog: "/private/out.log",
    stderrLog: "/private/err.log",
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>SoftResourceLimits<\/key><dict><key>NumberOfFiles<\/key><integer>128<\/integer><\/dict>/);
  assert.match(plist, /<key>HardResourceLimits<\/key><dict><key>NumberOfFiles<\/key><integer>256<\/integer><\/dict>/);
  assert.doesNotMatch(plist, /NumberOfProcesses/);
  assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/private\/node<\/string><string>\/private\/helper\.mjs<\/string><\/array>/);
  assert.match(plist, /IMSG_HELPER_CONFIG/);
  assert.doesNotMatch(plist, /expectedSender|chatGuid|CODEX_HOME|codex exec|app-server/);
});

test("staging copies the complete imsg tree, replaces only imsg, and exposes no private state", (t) => {
  const fixture = makeBundle(t);
  const manifest = JSON.parse(readFileSync(path.join(fixture.sharedRoot, "bundle-manifest.json"), "utf8"));
  const stagedImsg = path.join(fixture.sharedRoot, manifest.imsg);
  assert.equal(manifest.sharedGroup.gid, fixture.safeGid);
  assert.deepEqual(manifest.sharedGroup.members, [fixture.controllerUsername, fixture.username].sort());
  assert.equal(lstatSync(path.join(fixture.sharedRoot, "exchange")).gid, fixture.safeGid);
  assert.equal(readFileSync(stagedImsg, "utf8"), "daemon-safe imsg\n");
  assert.equal(readFileSync(path.join(fixture.sharedRoot, "payload/runtime/imsg/imsg-bridge-helper.dylib"), "utf8"), "private bridge dylib\n");
  assert.equal(readFileSync(path.join(fixture.sharedRoot, "payload/runtime/imsg/Resources/bridge.json"), "utf8"), "{\"bridge\":2}\n");
  const launcher = readFileSync(path.join(fixture.sharedRoot, "Install Codex Messages.command"), "utf8");
  assert.match(launcher, /^#!\/bin\/sh\nset -u\n/);
  assert.match(launcher, /install-helper\.mjs/);
  assert.match(launcher, /The Codex Messages helper is ready/);
  assert.match(launcher, /Press Return to close/);
  assert.equal(lstatSync(path.join(fixture.sharedRoot, "Install Codex Messages.command")).mode & 0o777, 0o555);
  assert.equal(manifest.launcher.sha256, sha256(Buffer.from(launcher)));
  assert.equal(manifest.controllerIdentityHash, expectedControllerIdentityHash({
    uid: fixture.uid,
    username: fixture.controllerUsername,
    codexHome: fixture.codexHome,
  }));
  const publicText = filesBelow(fixture.sharedRoot).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(publicText, /BEGIN PRIVATE KEY|auth\.json|access_token/i);
  assert.equal(publicText.includes(fixture.recipient), false);
  const controllerPrivate = path.join(fixture.controllerHome, ".codex/imessage-handoff/split-user-controller/controller-private.pem");
  assert.equal(lstatSync(controllerPrivate).mode & 0o777, 0o600);
  assert.match(readFileSync(controllerPrivate, "utf8"), /BEGIN PRIVATE KEY/);
});

test("staging atomically upgrades an owned signed fixed destination", (t) => {
  const fixture = makeBundle(t);
  const exchange = path.join(fixture.sharedRoot, "exchange");
  const exchangeInode = lstatSync(exchange).ino;
  writeFileSync(path.join(exchange, "live-helper-marker"), "keep the live exchange\n", { mode: 0o660 });
  writeFileSync(fixture.daemonSafeImsg, "upgraded daemon-safe imsg\n", { mode: 0o755 });
  const upgraded = stageSplitUserHelperBundle({
    ...fixture.stageOptions,
    bundleId: "fixture-bundle-upgraded",
    now: () => "2026-07-12T13:00:00.000Z",
  });
  const manifest = JSON.parse(readFileSync(upgraded.manifestPath, "utf8"));
  assert.equal(manifest.bundleId, "fixture-bundle-upgraded");
  assert.equal(readFileSync(path.join(fixture.sharedRoot, manifest.imsg), "utf8"), "upgraded daemon-safe imsg\n");
  assert.equal(lstatSync(exchange).ino, exchangeInode);
  assert.equal(readFileSync(path.join(exchange, "live-helper-marker"), "utf8"), "keep the live exchange\n");
  assert.equal(readdirSync(path.dirname(fixture.sharedRoot)).some((name) => name.includes(".quarantine-")), false);
  assert.equal(readdirSync(path.dirname(fixture.sharedRoot)).some((name) => name.includes(".exchange-")), false);
  const active = JSON.parse(readFileSync(path.join(
    fixture.controllerHome,
    ".codex/imessage-handoff/split-user-controller/active-bundle.json",
  ), "utf8"));
  assert.equal(active.bundleId, "fixture-bundle-upgraded");
});

test("staging an upgrade preserves a reachable live helper socket", async (t) => {
  const fixture = makeBundle(t, { shortRoot: true });
  const socketPath = path.join(fixture.sharedRoot, "exchange", "imsg-helper.sock");
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const connect = () => new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
  await connect();

  writeFileSync(fixture.daemonSafeImsg, "live-socket upgrade\n", { mode: 0o755 });
  stageSplitUserHelperBundle({
    ...fixture.stageOptions,
    bundleId: "fixture-live-socket-upgrade",
  });

  assert.equal(existsSync(socketPath), true);
  await connect();
});

test("staging restores the signed prior bundle when active-state commit fails", (t) => {
  const fixture = makeBundle(t);
  const exchange = path.join(fixture.sharedRoot, "exchange");
  const exchangeInode = lstatSync(exchange).ino;
  writeFileSync(path.join(exchange, "live-helper-marker"), "keep the live exchange\n", { mode: 0o660 });
  const priorManifest = readFileSync(path.join(fixture.sharedRoot, "bundle-manifest.json"), "utf8");
  const priorImsg = readFileSync(path.join(fixture.sharedRoot, "payload/runtime/imsg/imsg"), "utf8");
  writeFileSync(fixture.daemonSafeImsg, "upgrade that must roll back\n", { mode: 0o755 });
  assert.throws(
    () => stageSplitUserHelperBundle({
      ...fixture.stageOptions,
      bundleId: "fixture-bundle-failed",
      beforeControllerStateCommit: () => { throw Object.assign(new Error("simulated state disk failure"), { code: "TEST_DISK_FAILURE" }); },
    }),
    (error) => error?.code === "TEST_DISK_FAILURE",
  );
  assert.equal(readFileSync(path.join(fixture.sharedRoot, "bundle-manifest.json"), "utf8"), priorManifest);
  assert.equal(readFileSync(path.join(fixture.sharedRoot, "payload/runtime/imsg/imsg"), "utf8"), priorImsg);
  assert.equal(lstatSync(exchange).ino, exchangeInode);
  assert.equal(readFileSync(path.join(exchange, "live-helper-marker"), "utf8"), "keep the live exchange\n");
  assert.equal(readdirSync(path.dirname(fixture.sharedRoot)).some((name) => name.includes(".quarantine-")), false);
  assert.equal(readdirSync(path.dirname(fixture.sharedRoot)).some((name) => name.includes(".exchange-")), false);
});

test("a failed helper upgrade restores its prior payload, config, and LaunchAgent", (t) => {
  const fixture = makeBundle(t);
  const first = installDedicatedImsgHelper(helperInstallOptions(fixture));
  const priorConfig = readFileSync(first.configPath, "utf8");
  const priorPlist = readFileSync(first.plistPath, "utf8");
  const priorConfigValue = JSON.parse(priorConfig);
  const priorEntrypoint = /<key>ProgramArguments<\/key><array><string>[^<]+<\/string><string>([^<]+)<\/string>/.exec(priorPlist)?.[1];
  assert.ok(priorEntrypoint && existsSync(priorEntrypoint));

  writeFileSync(fixture.daemonSafeImsg, "upgrade that fails during commit\n", { mode: 0o755 });
  stageSplitUserHelperBundle({ ...fixture.stageOptions, bundleId: "fixture-install-failed" });
  assert.throws(
    () => installDedicatedImsgHelper(helperInstallOptions(fixture, {
      beforeInstallCommit: () => { throw Object.assign(new Error("simulated installer crash"), { code: "TEST_INSTALL_CRASH" }); },
    })),
    (error) => error?.code === "TEST_INSTALL_CRASH",
  );

  assert.equal(readFileSync(first.configPath, "utf8"), priorConfig);
  assert.equal(readFileSync(first.plistPath, "utf8"), priorPlist);
  assert.equal(existsSync(priorConfigValue.imsgBinary), true);
  assert.equal(existsSync(priorEntrypoint), true);
  const releases = readdirSync(path.join(path.dirname(first.configPath), "releases"));
  assert.deepEqual(releases, ["fixture-bundle"]);
});

test("dedicated install keeps raw conversation and keys private while publishing protocol hashes", (t) => {
  const fixture = makeBundle(t);
  const account = {
    login: fixture.localIdentity,
    aliases: ["E:helper.alias@example.com"],
    last_addressed_handle: "+15557654321",
  };
  const chatGuid = "iMessage;-;private-conversation-guid";
  const result = installDedicatedImsgHelper({
    bundleRoot: fixture.sharedRoot,
    uid: fixture.uid,
    username: fixture.username,
    home: fixture.helperHome,
    groupIds: [fixture.safeGid],
    inspectedGroup: { name: "codex-imessage-fixture", gid: fixture.safeGid, members: [fixture.controllerUsername, fixture.username] },
    privateRoot: path.join(fixture.helperHome, "Library/Application Support/Codex iMessage Helper"),
    allowNonDarwin: true,
    loadAgent: false,
    bridgeReady: true,
    account,
    chats: [{
      id: 77,
      guid: chatGuid,
      service: "iMessage",
      is_group: false,
      participants: [fixture.recipient],
      account_login: fixture.localIdentity,
      last_message_at: "2026-07-12T12:00:00Z",
    }],
    now: () => "2026-07-12T12:05:00.000Z",
  });
  const config = JSON.parse(readFileSync(result.configPath, "utf8"));
  assert.equal(lstatSync(result.configPath).mode & 0o777, 0o600);
  assert.equal(config.profile.chatGuid, chatGuid);
  assert.equal(config.profile.expectedSender, fixture.recipient);
  assert.equal(config.profile.localIdentity, fixture.localIdentity);
  assert.equal(config.profile.accountFingerprint, imsgAccountFingerprint(extractImsgAccountIdentities(account)));
  assert.equal(config.expectedHelperIdentityHash, helperIdentityHash({ uid: fixture.uid, username: fixture.username, home: fixture.helperHome }));
  assert.equal(lstatSync(config.helperPrivateKeyPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(config.controllerPublicKeyPath).mode & 0o777, 0o600);

  const publicAttestation = JSON.parse(readFileSync(result.attestationPath, "utf8"));
  const expected = createHelperAttestation(config.profile, { uid: fixture.uid, username: fixture.username, home: fixture.helperHome });
  assert.deepEqual(publicAttestation.expectedHelperAttestation, {
    role: expected.role,
    identityHash: expected.identityHash,
    accountHash: expected.accountHash,
    conversationHash: expected.conversationHash,
    profileHash: expected.profileHash,
  });
  assert.equal(publicAttestation.helperPublicKeyFingerprint, ipcPublicKeyFingerprint(publicAttestation.helperPublicKey));
  assert.equal(publicAttestation.profileHash, imsgProfileHash(config.profile));
  const publicText = filesBelow(fixture.sharedRoot).map((file) => readFileSync(file, "utf8")).join("\n");
  assert.equal(publicText.includes(chatGuid), false);
  assert.equal(publicText.includes(fixture.recipient), false);
  assert.equal(publicText.includes(fixture.localIdentity), false);
  assert.doesNotMatch(publicText, /BEGIN PRIVATE KEY/);

  assert.doesNotThrow(() => new ImsgHelperServer({
    socketPath: path.join(fixture.sharedRoot, "exchange", "validation.sock"),
    privateKey: createPrivateKey(readFileSync(config.helperPrivateKeyPath)),
    controllerPublicKey: readFileSync(config.controllerPublicKeyPath),
    expectedControllerIdentityHash: config.expectedControllerIdentityHash,
    profile: config.profile,
    client: {},
  }));
  const plist = readFileSync(result.plistPath, "utf8");
  assert.match(plist, /RunAtLoad<\/key><true\/>/);
  assert.match(plist, /KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.doesNotMatch(plist, new RegExp(chatGuid));
});

test("private recipient input rejects symlinks, loose modes, and paths outside the controller home", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "split-user-recipient-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const safe = writeFixture(path.join(home, "recipient"), "+15551234567\n", 0o600);
  assert.equal(readPrivateRecipientFile(safe, { uid: process.getuid(), home }), "+15551234567");
  chmodSync(safe, 0o644);
  assert.throws(() => readPrivateRecipientFile(safe, { uid: process.getuid(), home }), (error) => error?.code === "SPLIT_USER_RECIPIENT_FILE_UNSAFE");
  const outside = writeFixture(path.join(root, "outside"), "+15551234567\n", 0o600);
  assert.throws(() => readPrivateRecipientFile(outside, { uid: process.getuid(), home }), (error) => error?.code === "SPLIT_USER_RECIPIENT_FILE_UNSAFE");
});

test("private v4 service config can supply the helper recipient without another secret file", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "split-user-recipient-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "controller");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = writeFixture(path.join(home, ".codex/imessage-handoff/config.json"), JSON.stringify({
    version: 4,
    imsg: {
      mode: "helper",
      expectedSender: "+15551234567",
    },
  }), 0o600);
  assert.equal(readPrivateRecipientConfig(config, { uid: process.getuid(), home }), "+15551234567");
  chmodSync(config, 0o644);
  assert.throws(
    () => readPrivateRecipientConfig(config, { uid: process.getuid(), home }),
    (error) => error?.code === "SPLIT_USER_RECIPIENT_CONFIG_UNSAFE",
  );
});
