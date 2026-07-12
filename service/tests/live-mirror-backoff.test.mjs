import assert from "node:assert/strict";
import test from "node:test";
import { LiveMirrorRetryBackoff } from "../src/live-mirror-backoff.mjs";

test("live mirror retry backoff starts ready and waits one second after its first failure", () => {
  let now = 10_000;
  const backoff = new LiveMirrorRetryBackoff({ now: () => now });

  assert.equal(backoff.ready(), true);
  assert.equal(backoff.remaining(), 0);
  assert.equal(backoff.recordFailure(), 1_000);
  assert.equal(backoff.ready(), false);
  assert.equal(backoff.remaining(), 1_000);

  now += 999;
  assert.equal(backoff.ready(), false);
  assert.equal(backoff.remaining(), 1);
  now += 1;
  assert.equal(backoff.ready(), true);
  assert.equal(backoff.remaining(), 0);
});

test("consecutive failures double the delay and cap it at thirty seconds", () => {
  let now = 0;
  const backoff = new LiveMirrorRetryBackoff({ now: () => now });
  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

  for (const delay of expected) {
    assert.equal(backoff.recordFailure(), delay);
    assert.equal(backoff.remaining(), delay);
    now += delay;
    assert.equal(backoff.ready(), true);
  }
});

test("reset makes retry immediately ready and restores the initial delay", () => {
  let now = 50_000;
  const backoff = new LiveMirrorRetryBackoff({ now: () => now });
  backoff.recordFailure();
  now += 1_000;
  assert.equal(backoff.recordFailure(), 2_000);
  assert.equal(backoff.ready(), false);

  backoff.reset();
  assert.equal(backoff.ready(), true);
  assert.equal(backoff.remaining(), 0);
  assert.equal(backoff.recordFailure(), 1_000);
});

test("invalid clocks fail without silently opening the retry gate", () => {
  assert.throws(() => new LiveMirrorRetryBackoff({ now: 1 }), /now function/);
  const backoff = new LiveMirrorRetryBackoff({ now: () => Number.NaN });
  assert.throws(() => backoff.recordFailure(), /finite number/);
});
