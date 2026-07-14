import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REMOTE_CONTROL_ENROLL_SCOPE,
  REMOTE_CONTROL_SCOPE,
  RemoteControlController,
  encodeSignedDevicePayload,
  normalizeManualPairingCode,
  readCodexAuth,
  remoteControlInternals,
} from "../src/remote-control-controller.mjs";

function jwt(payload) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function authToken({ accountId = "account-1", accountUserId = "user-1", expiresAt = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  return jwt({
    exp: expiresAt,
    sub: "subject-1",
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_account_user_id: accountUserId,
      user_id: accountUserId,
    },
  });
}

function jsonFile(file, value, mode = 0o600) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode });
  chmodSync(file, mode);
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imessage-remote-controller-"));
  const authFile = path.join(directory, "auth.json");
  const globalStateFile = path.join(directory, "global-state.json");
  const enrollmentFile = path.join(directory, "enrollment.json");
  const accessToken = authToken();
  jsonFile(authFile, { tokens: { access_token: accessToken, account_id: "account-1" } });
  jsonFile(globalStateFile, {
    "electron-local-remote-control-environment-id": "env-1",
    "electron-local-remote-control-installation-id": "install-1",
  });
  const enrollment = {
    schemaVersion: 1,
    accountUserId: "user-1",
    clientId: "client-1",
    keyId: "key-1",
    publicKeySpkiDerBase64: "public-key",
    algorithm: "ecdsa_p256_sha256",
    protectionClass: "os_protected_nonextractable",
    createdAt: new Date().toISOString(),
  };
  jsonFile(enrollmentFile, enrollment);
  return { directory, authFile, globalStateFile, enrollmentFile, accessToken, enrollment };
}

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
    async text() { return JSON.stringify(value); },
  };
}

function controllerOptions(run, overrides = {}) {
  return {
    authFile: run.authFile,
    globalStateFile: run.globalStateFile,
    enrollmentFile: run.enrollmentFile,
    allowUnverifiedBundle: true,
    appVersion: "26.707.72221",
    buildVersion: "5307",
    appServerVersion: "0.144.2",
    ...overrides,
  };
}

function publicKeyFor(enrollment) {
  return {
    keyId: enrollment.keyId,
    publicKeySpkiDerBase64: enrollment.publicKeySpkiDerBase64,
    algorithm: enrollment.algorithm,
    protectionClass: enrollment.protectionClass,
  };
}

function signingDeviceKeyClient(enrollment, overrides = {}) {
  return {
    async getDeviceKeyPublic() { return publicKeyFor(enrollment); },
    async signDeviceKey() {
      return {
        algorithm: enrollment.algorithm,
        signatureDerBase64: "signature",
        signedPayloadBase64: "payload",
      };
    },
    ...overrides,
  };
}

function refreshChallenge(enrollment, overrides = {}) {
  return {
    purpose: "remote_control_client_enrollment",
    audience: "remote_control_client_enrollment",
    account_user_id: enrollment.accountUserId,
    client_id: enrollment.clientId,
    target_origin: "https://chatgpt.com",
    target_path: "/backend-api/codex/remote/control/client/refresh/finish",
    device_identity_hash: remoteControlInternals.deviceIdentityHash(enrollment),
    nonce: Buffer.alloc(32, 3).toString("base64url"),
    challenge_id: "challenge-1",
    challenge_token: "challenge-token",
    challenge_expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    env_id: "env-1",
    installation_id: "install-1",
    client_type: "CODEX_DESKTOP_APP",
    app_server_version: "0.144.2",
    online: true,
    ...overrides,
  };
}

function sessionResponse(enrollment, overrides = {}) {
  return {
    account_user_id: enrollment.accountUserId,
    client_id: enrollment.clientId,
    remote_control_token: "session-token",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    scopes: [REMOTE_CONTROL_SCOPE],
    ...overrides,
  };
}

function stepUpToken(accountUserId = "user-1") {
  return jwt({
    iat: Math.floor(Date.now() / 1000),
    pwd_auth_time: Date.now(),
    scope: REMOTE_CONTROL_ENROLL_SCOPE,
    "https://api.openai.com/auth": { chatgpt_account_user_id: accountUserId },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Codex auth is owner-private, account-bound, and fresh", () => {
  const run = fixture();
  const identity = readCodexAuth({ authFile: run.authFile });
  assert.equal(identity.accountId, "account-1");
  assert.equal(identity.accountUserId, "user-1");

  chmodSync(run.authFile, 0o644);
  assert.throws(() => readCodexAuth({ authFile: run.authFile }), (error) => error?.code === "CODEX_AUTH_REQUIRED");
});

test("manual pairing codes follow the Codex Desktop canonical form", () => {
  assert.equal(normalizeManualPairingCode("ab12-cd34"), "AB12-CD34");
  assert.equal(normalizeManualPairingCode("ab12 cd34 trailing"), "AB12-CD34");
  assert.throws(
    () => normalizeManualPairingCode("1234567"),
    (error) => error?.code === "CODEX_REMOTE_PAIRING_CODE_INVALID",
  );
});

test("device signing payload is canonical and domain separated", () => {
  const digest = createHash("sha256").update("token").digest("base64url");
  const nonce = Buffer.alloc(32, 7).toString("base64url");
  const encoded = encodeSignedDevicePayload({
    type: "remoteControlClientConnection",
    nonce,
    audience: "remote_control_client_websocket",
    sessionId: "session-1",
    targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/client",
    accountUserId: "user-1",
    clientId: "client-1",
    tokenSha256Base64url: digest,
    tokenExpiresAt: 1_900_000_000,
    scopes: [REMOTE_CONTROL_SCOPE],
  });
  const value = JSON.parse(encoded.toString("utf8"));
  assert.equal(value.domain, "codex-device-key-sign-payload/v1");
  assert.equal(value.payload.type, "remoteControlClientConnection");
  assert.deepEqual(Object.keys(value.payload), [
    "accountUserId", "audience", "clientId", "nonce", "scopes", "sessionId",
    "targetOrigin", "targetPath", "tokenExpiresAt", "tokenSha256Base64url", "type",
  ]);
});

test("authorization URL uses a scoped PKCE reauthentication flow", () => {
  const url = new URL(remoteControlInternals.buildAuthorizationUrl({
    redirectUri: "http://localhost:1455/auth/callback",
    codeChallenge: "challenge",
    state: "state",
    accountId: "account-1",
  }));
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.searchParams.get("scope"), REMOTE_CONTROL_ENROLL_SCOPE);
  assert.equal(url.searchParams.get("reauth"), "remote_control");
  assert.equal(url.searchParams.get("max_age"), "0");
  assert.equal(url.searchParams.get("allowed_workspace_id"), "account-1");
  assert.equal(url.searchParams.get("current_workspace_id"), "account-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("controller refresh pins the account, key, environment, installation, and version", async () => {
  const run = fixture();
  const deviceHash = remoteControlInternals.deviceIdentityHash(run.enrollment);
  const challenge = {
    purpose: "remote_control_client_enrollment",
    audience: "remote_control_client_enrollment",
    account_user_id: "user-1",
    client_id: "client-1",
    target_origin: "https://chatgpt.com",
    target_path: "/backend-api/codex/remote/control/client/refresh/finish",
    device_identity_hash: deviceHash,
    nonce: Buffer.alloc(32, 3).toString("base64url"),
    challenge_id: "challenge-1",
    challenge_token: "challenge-token",
    challenge_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, authorization: options.headers.Authorization });
    if (String(url).endsWith("/refresh/start")) return response({ account_user_id: "user-1", client_id: "client-1", device_key_challenge: challenge });
    if (String(url).endsWith("/refresh/finish")) return response({
      account_user_id: "user-1",
      client_id: "client-1",
      remote_control_token: "session-token",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      scopes: [REMOTE_CONTROL_SCOPE],
    });
    if (String(url).includes("/clients/client-1/environments")) return response({ items: [{
      env_id: "env-1",
      installation_id: "install-1",
      client_type: "CODEX_DESKTOP_APP",
      app_server_version: "0.144.2",
      online: true,
    }], cursor: null });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const deviceKeyClient = {
    async getDeviceKeyPublic() { return {
      keyId: "key-1",
      publicKeySpkiDerBase64: "public-key",
      algorithm: "ecdsa_p256_sha256",
      protectionClass: "os_protected_nonextractable",
    }; },
    async signDeviceKey(_keyId, payload) {
      assert.equal(payload.type, "remoteControlClientEnrollment");
      return { algorithm: "ecdsa_p256_sha256", signatureDerBase64: "signature", signedPayloadBase64: "payload" };
    },
  };
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl,
    deviceKeyClient,
  }));
  const session = await controller.refreshSession();
  assert.equal(session.clientId, "client-1");
  assert.equal(session.envId, "env-1");
  assert.equal(session.headers["x-codex-client-session-token"], "Bearer session-token");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${run.accessToken}`));
});

test("controller never falls back when the pinned installation differs", async () => {
  const run = fixture();
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl: async () => response({ items: [{
      env_id: "env-1",
      installation_id: "different-installation",
      client_type: "CODEX_DESKTOP_APP",
      app_server_version: "0.144.2",
      online: true,
    }], cursor: null }),
    deviceKeyClient: {},
  }));
  await assert.rejects(controller.resolveEnvironment(run.enrollment), (error) => error?.code === "CODEX_REMOTE_HOST_MISMATCH");
});

test("an empty client directory never falls back to the account-wide host directory", async () => {
  const run = fixture();
  const requests = [];
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/clients/client-1/environments")) {
        return response({ items: [], cursor: null });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    deviceKeyClient: {},
  }));

  await assert.rejects(
    controller.resolveEnvironment(run.enrollment),
    (error) => error?.code === "CODEX_REMOTE_PAIRING_REQUIRED",
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/clients\/client-1\/environments/);
  assert.doesNotMatch(requests[0], /\/codex\/remote\/control\/environments\?/);
});

test("manual pairing claims and verifies only the exact pinned client-scoped environment", async () => {
  const run = fixture();
  const requests = [];
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl: async (url, options) => {
      const value = String(url);
      requests.push({ url: value, options });
      if (value.endsWith("/backend-api/wham/remote/control/client/pair")) {
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, `Bearer ${run.accessToken}`);
        assert.deepEqual(JSON.parse(options.body), {
          client_id: "client-1",
          manual_pairing_code: "AB12-CD34",
        });
        return response({ environment_id: "env-1" });
      }
      if (value.includes("/codex/remote/control/clients/client-1/environments")) {
        return response({ items: [environment({ online: false })], cursor: null });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    deviceKeyClient: signingDeviceKeyClient(run.enrollment),
  }));

  const paired = await controller.pairEnvironment("ab12 cd34");

  assert.deepEqual(paired, { paired: true, environmentId: "env-1", hostOnline: false });
  assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[1].url, /\/codex\/remote\/control\/environments\?/);
});

test("manual pairing rejects a claimed environment that is not the Desktop pin", async () => {
  const run = fixture();
  let requests = 0;
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl: async (url) => {
      requests += 1;
      assert.match(String(url), /\/wham\/remote\/control\/client\/pair$/);
      return response({ environment_id: "env-other" });
    },
    deviceKeyClient: signingDeviceKeyClient(run.enrollment),
  }));

  await assert.rejects(
    controller.pairEnvironment("AB12CD34"),
    (error) => error?.code === "CODEX_REMOTE_HOST_MISMATCH",
  );
  assert.equal(requests, 1, "a mismatched claim must not be followed into any directory");
});

test("manual pairing maps generic claim failures without inventing code-expiry semantics", async (t) => {
  const cases = [
    [401, "CODEX_AUTH_REQUIRED"],
    [403, "CODEX_REMOTE_PAIRING_FORBIDDEN"],
    [404, "CODEX_REMOTE_PAIRING_UNAVAILABLE"],
    [409, "CODEX_REMOTE_PAIRING_FAILED"],
  ];
  for (const [status, code] of cases) {
    await t.test(String(status), async () => {
      const run = fixture();
      const controller = new RemoteControlController(controllerOptions(run, {
        fetchImpl: async () => response({ detail: "generic pairing failure" }, status),
        deviceKeyClient: signingDeviceKeyClient(run.enrollment),
      }));
      await assert.rejects(
        controller.pairEnvironment("AB12CD34"),
        (error) => error?.code === code && error?.status === status,
      );
    });
  }
});

test("websocket device proof accepts the real HTTPS challenge target and signs it unchanged", async () => {
  const run = fixture();
  const token = "remote-session-token";
  const tokenExpiresAt = Math.floor(Date.now() / 1000) + 300;
  let signedPayload = null;
  const deviceKeyClient = signingDeviceKeyClient(run.enrollment, {
    async signDeviceKey(keyId, payload) {
      assert.equal(keyId, run.enrollment.keyId);
      signedPayload = payload;
      return {
        algorithm: run.enrollment.algorithm,
        signatureDerBase64: "connection-signature",
        signedPayloadBase64: "connection-payload",
      };
    },
  });
  const controller = new RemoteControlController(controllerOptions(run, {
    deviceKeyClient,
    websocketUrl: "wss://chatgpt.com/backend-api/codex/remote/control/client",
  }));
  const session = {
    clientId: run.enrollment.clientId,
    envId: "env-1",
    tokenExpiresAt,
    scopes: [REMOTE_CONTROL_SCOPE],
    headers: { "x-codex-client-session-token": `Bearer ${token}` },
  };
  const challenge = {
    type: "device_key_challenge",
    purpose: "remote_control_client_websocket",
    audience: "remote_control_client_websocket",
    nonce: Buffer.alloc(32, 9).toString("base64url"),
    sessionId: "session-1",
    targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/client",
    accountUserId: run.enrollment.accountUserId,
    clientId: run.enrollment.clientId,
    tokenSha256Base64url: createHash("sha256").update(token).digest("base64url"),
    tokenExpiresAt,
    scopes: [REMOTE_CONTROL_SCOPE],
  };

  const proof = await controller.authorizeDeviceChallenge(challenge, session);

  assert.deepEqual(proof, {
    type: "device_key_proof",
    keyId: run.enrollment.keyId,
    signatureDerBase64: "connection-signature",
    signedPayloadBase64: "connection-payload",
    algorithm: run.enrollment.algorithm,
  });
  assert.deepEqual(signedPayload, {
    type: "remoteControlClientConnection",
    nonce: challenge.nonce,
    audience: challenge.audience,
    sessionId: challenge.sessionId,
    targetOrigin: "https://chatgpt.com",
    targetPath: challenge.targetPath,
    accountUserId: challenge.accountUserId,
    clientId: challenge.clientId,
    tokenSha256Base64url: challenge.tokenSha256Base64url,
    tokenExpiresAt,
    scopes: [REMOTE_CONTROL_SCOPE],
  });
});

test("environment resolution fails closed when any host pin is absent", async (t) => {
  const cases = [
    ["installation_id", "CODEX_REMOTE_HOST_MISMATCH"],
    ["client_type", "CODEX_REMOTE_HOST_MISMATCH"],
    ["app_server_version", "CODEX_REMOTE_INCOMPATIBLE"],
  ];
  for (const [field, expectedCode] of cases) {
    await t.test(field, async () => {
      const run = fixture();
      const candidate = environment();
      delete candidate[field];
      const controller = new RemoteControlController(controllerOptions(run, {
        fetchImpl: async () => response({ items: [candidate], cursor: null }),
        deviceKeyClient: {},
      }));
      await assert.rejects(
        controller.resolveEnvironment(run.enrollment),
        (error) => error?.code === expectedCode,
      );
    });
  }
});

test("local status reports pairing as unknown without turning setup into a network dependency", async () => {
  const run = fixture();
  let networkCalls = 0;
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl: async () => { networkCalls += 1; return response({}); },
    deviceKeyClient: signingDeviceKeyClient(run.enrollment),
  }));

  const status = await controller.status({ network: false });

  assert.equal(status.authenticated, true);
  assert.equal(status.enrolled, true);
  assert.equal(status.paired, null);
  assert.equal(status.available, false);
  assert.equal(networkCalls, 0);
});

test("network status distinguishes unpaired and paired-offline hosts", async (t) => {
  await t.test("unpaired", async () => {
    const run = fixture();
    const controller = new RemoteControlController(controllerOptions(run, {
      fetchImpl: async (url) => {
        assert.match(String(url), /\/clients\/client-1\/environments/);
        return response({ items: [], cursor: null });
      },
      deviceKeyClient: signingDeviceKeyClient(run.enrollment),
    }));
    const status = await controller.status({ network: true });
    assert.equal(status.enrolled, true);
    assert.equal(status.paired, false);
    assert.equal(status.hostOnline, null);
    assert.equal(status.available, false);
    assert.equal(status.code, "CODEX_REMOTE_PAIRING_REQUIRED");
  });

  await t.test("paired but offline", async () => {
    const run = fixture();
    const controller = new RemoteControlController(controllerOptions(run, {
      fetchImpl: async () => response({ items: [environment({ online: false })], cursor: null }),
      deviceKeyClient: signingDeviceKeyClient(run.enrollment),
    }));
    const status = await controller.status({ network: true });
    assert.equal(status.enrolled, true);
    assert.equal(status.paired, true);
    assert.equal(status.hostOnline, false);
    assert.equal(status.available, false);
    assert.equal(status.code, "CODEX_HOST_OFFLINE");
  });
});

test("a fresh cached session cannot retain a rotated Codex access token", async () => {
  const run = fixture();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    if (String(url).endsWith("/refresh/start")) {
      return response({
        account_user_id: run.enrollment.accountUserId,
        client_id: run.enrollment.clientId,
        device_key_challenge: refreshChallenge(run.enrollment),
      });
    }
    if (String(url).endsWith("/refresh/finish")) return response(sessionResponse(run.enrollment));
    if (String(url).includes("/clients/client-1/environments")) {
      return response({ items: [environment()], cursor: null });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl,
    deviceKeyClient: signingDeviceKeyClient(run.enrollment),
  }));
  const first = await controller.refreshSession();
  assert.equal(first.headers.Authorization, `Bearer ${run.accessToken}`);

  const rotatedToken = authToken({ expiresAt: Math.floor(Date.now() / 1000) + 7200 });
  assert.notEqual(rotatedToken, run.accessToken);
  jsonFile(run.authFile, { tokens: { access_token: rotatedToken, account_id: "account-1" } });
  const second = await controller.refreshSession();

  assert.equal(second.headers.Authorization, `Bearer ${rotatedToken}`);
  assert.ok(calls.some((call) => call.authorization === `Bearer ${rotatedToken}`));
});

test("a failed forced refresh invalidates the previously cached session", async () => {
  const run = fixture();
  let failRefresh = false;
  let refreshStarts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/refresh/start")) {
      refreshStarts += 1;
      if (failRefresh) return response({ detail: "temporary failure" }, 503);
      return response({
        account_user_id: run.enrollment.accountUserId,
        client_id: run.enrollment.clientId,
        device_key_challenge: refreshChallenge(run.enrollment),
      });
    }
    if (String(url).endsWith("/refresh/finish")) return response(sessionResponse(run.enrollment));
    if (String(url).includes("/clients/client-1/environments")) {
      return response({ items: [environment()], cursor: null });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl,
    deviceKeyClient: signingDeviceKeyClient(run.enrollment),
  }));
  await controller.refreshSession();
  failRefresh = true;

  await assert.rejects(
    controller.refreshSession({ force: true }),
    (error) => error?.code === "CODEX_REMOTE_UNAVAILABLE",
  );
  await assert.rejects(
    controller.refreshSession(),
    (error) => error?.code === "CODEX_REMOTE_UNAVAILABLE",
  );
  assert.equal(refreshStarts, 3, "the second request must not reuse the pre-failure session");
});

test("concurrent forced refreshes share one enrollment refresh", async () => {
  const run = fixture();
  const startGate = deferred();
  let refreshStarts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/refresh/start")) {
      refreshStarts += 1;
      await startGate.promise;
      return response({
        account_user_id: run.enrollment.accountUserId,
        client_id: run.enrollment.clientId,
        device_key_challenge: refreshChallenge(run.enrollment),
      });
    }
    if (String(url).endsWith("/refresh/finish")) return response(sessionResponse(run.enrollment));
    if (String(url).includes("/clients/client-1/environments")) {
      return response({ items: [environment()], cursor: null });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl,
    deviceKeyClient: signingDeviceKeyClient(run.enrollment),
  }));

  const first = controller.refreshSession({ force: true });
  const second = controller.refreshSession({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const startsBeforeRelease = refreshStarts;
  startGate.resolve();
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.equal(startsBeforeRelease, 1);
  assert.equal(refreshStarts, 1);
  assert.strictEqual(firstSession, secondSession);
});

test("authorization replaces a locally cached enrollment revoked by the server", async () => {
  const run = fixture();
  const replacement = {
    ...run.enrollment,
    clientId: "client-2",
    keyId: "key-2",
    publicKeySpkiDerBase64: "replacement-public-key",
    createdAt: new Date().toISOString(),
  };
  const enrollChallenge = {
    purpose: "remote_control_client_enrollment",
    audience: "remote_control_client_enrollment",
    account_user_id: replacement.accountUserId,
    client_id: replacement.clientId,
    target_origin: "https://chatgpt.com",
    target_path: "/backend-api/codex/remote/control/client/enroll/finish",
    nonce: Buffer.alloc(32, 5).toString("base64url"),
    challenge_id: "replacement-challenge",
    challenge_token: "replacement-challenge-token",
    challenge_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const requests = [];
  const deletedKeys = [];
  const deviceKeyClient = signingDeviceKeyClient(run.enrollment, {
    async createDeviceKey(policy) {
      assert.equal(policy, "allow_os_protected_nonextractable");
      return publicKeyFor(replacement);
    },
    async deleteDeviceKey(keyId) { deletedKeys.push(keyId); },
    async signDeviceKey(keyId) {
      assert.equal(keyId, replacement.keyId);
      return {
        algorithm: replacement.algorithm,
        signatureDerBase64: "replacement-signature",
        signedPayloadBase64: "replacement-payload",
      };
    },
  });
  const fetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname;
    requests.push(pathname);
    if (pathname.endsWith("/refresh/start")) {
      return response({ detail: "Remote-control client has been revoked" }, 404);
    }
    if (pathname.endsWith("/enroll/start")) {
      return response({
        account_user_id: replacement.accountUserId,
        client_id: replacement.clientId,
        device_key_challenge: enrollChallenge,
      });
    }
    if (pathname.endsWith("/enroll/finish")) return response(sessionResponse(replacement));
    throw new Error(`Unexpected URL: ${url}`);
  };
  const controller = new RemoteControlController(controllerOptions(run, {
    fetchImpl,
    deviceKeyClient,
  }));

  const result = await controller.authorize({ stepUpToken: stepUpToken() });
  const saved = JSON.parse(readFileSync(run.enrollmentFile, "utf8"));

  assert.deepEqual(result, { authorized: true, changed: true, clientId: replacement.clientId });
  assert.deepEqual(requests, [
    "/backend-api/codex/remote/control/client/refresh/start",
    "/backend-api/codex/remote/control/client/enroll/start",
    "/backend-api/codex/remote/control/client/enroll/finish",
  ]);
  assert.deepEqual(deletedKeys, [run.enrollment.keyId]);
  assert.equal(saved.clientId, replacement.clientId);
  assert.equal(saved.keyId, replacement.keyId);
  assert.equal(saved.protectionClass, "os_protected_nonextractable");
});
