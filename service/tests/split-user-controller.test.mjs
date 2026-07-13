import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalJson,
  publicKeyFingerprint,
  userIdentityHash,
} from "../src/split-user-staging.mjs";
import { verifyHelperPublicAttestation } from "../src/split-user-controller.mjs";

const hashes = {
  manifest: "1".repeat(64),
  controller: "2".repeat(64),
  recipient: "3".repeat(64),
  account: "4".repeat(64),
  conversation: "5".repeat(64),
  profile: "6".repeat(64),
};

function fixture() {
  const dedicatedUser = { uid: 502, username: "codex", home: "/Users/codex" };
  const dedicatedIdentity = userIdentityHash(dedicatedUser);
  const helper = generateKeyPairSync("ed25519");
  const helperPublicKey = helper.publicKey.export({ type: "spki", format: "pem" }).toString();
  const helperPublicKeyFingerprint = publicKeyFingerprint(helper.publicKey);
  const expectedHelperAttestation = {
    role: "imsg-helper",
    identityHash: dedicatedIdentity,
    accountHash: hashes.account,
    conversationHash: hashes.conversation,
    profileHash: hashes.profile,
  };
  const helperAttestationHash = Buffer.from(canonicalJson(expectedHelperAttestation));
  const body = {
    version: 1,
    bundleId: "bundle-id",
    manifestHash: hashes.manifest,
    controllerPublicKeyFingerprint: hashes.controller,
    helperPublicKey,
    helperPublicKeyFingerprint,
    helperIdentityHash: dedicatedIdentity,
    expectedRecipientHash: hashes.recipient,
    accountFingerprint: hashes.account,
    conversationHash: hashes.conversation,
    profileHash: hashes.profile,
    expectedHelperAttestation,
    helperAttestationHash: createHash("sha256").update(helperAttestationHash).digest("hex"),
    installedAt: "2026-07-12T12:00:00.000Z",
  };
  const signature = sign(null, Buffer.from(canonicalJson(body)), helper.privateKey).toString("base64");
  return {
    dedicatedUser,
    attestation: { ...body, signature },
    activeState: {
      bundleId: body.bundleId,
      bundleManifestHash: hashes.manifest,
      controllerPublicKeyFingerprint: hashes.controller,
      expectedRecipientHash: hashes.recipient,
    },
    manifest: {
      bundleId: body.bundleId,
      controllerPublicKey: { fingerprint: hashes.controller },
      expectedRecipientHash: hashes.recipient,
      dedicatedIdentityHash: dedicatedIdentity,
    },
  };
}

test("helper public attestation pins its bundle, key, account, and conversation", () => {
  const value = fixture();
  const verified = verifyHelperPublicAttestation(value);
  assert.equal(verified.helperPublicKeyFingerprint, value.attestation.helperPublicKeyFingerprint);
  assert.deepEqual(verified.expectedHelperAttestation, value.attestation.expectedHelperAttestation);
});

test("helper public attestation rejects a signed identity from another prepared bundle", () => {
  const value = fixture();
  value.activeState.expectedRecipientHash = "a".repeat(64);
  assert.throws(() => verifyHelperPublicAttestation(value), { code: "SPLIT_USER_ATTESTATION_MISMATCH" });
});

test("helper public attestation rejects unsigned mutation", () => {
  const value = fixture();
  value.attestation.accountFingerprint = "b".repeat(64);
  assert.throws(() => verifyHelperPublicAttestation(value), { code: "SPLIT_USER_ATTESTATION_INVALID" });
});
