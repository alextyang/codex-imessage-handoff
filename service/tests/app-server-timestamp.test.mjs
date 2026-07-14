import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAppServerTimestamp } from "../src/app-server-timestamp.mjs";

test("normalizes app-server Unix seconds without producing 1970 task identities", () => {
  assert.equal(
    normalizeAppServerTimestamp(1_783_987_200, "fallback"),
    "2026-07-14T00:00:00.000Z",
  );
  assert.equal(
    normalizeAppServerTimestamp(1_783_987_200_000, "fallback"),
    "2026-07-14T00:00:00.000Z",
  );
  assert.equal(
    normalizeAppServerTimestamp("2026-07-14T00:00:00-07:00", "fallback"),
    "2026-07-14T07:00:00.000Z",
  );
  assert.equal(normalizeAppServerTimestamp(null, "fallback"), "fallback");
});
