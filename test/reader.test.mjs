/**
 * A reader checks for itself, and keeps the allowlist it opened a thread with.
 *
 * From a security review on 18 September 2026. verified in an answer was the
 * service's word, and read() took it: the trust model says an operator cannot
 * forge a signature, which is only true for a reader that checks one. And the
 * service holds an allowlist in memory, so a write to an address after its
 * store was emptied opens a thread with no list at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Aamio, Keys, checkMessage, sha256hex, threadSigningInput, verify } from "../src/aamio.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const W = "i".repeat(20);
const alice = Keys.fromSeedHex("01".repeat(32));
const mallory = Keys.fromSeedHex("09".repeat(32));

/** One message as GET /{w} returns it, really signed. keys null is an unsigned one. */
function stored(w, seq, body, keys = alice, fields = {}) {
  const message = { seq, at: seq, type: "text", body, sha256: sha256hex(body), from: null, sig: null, verified: false };
  if (keys) Object.assign(message, { from: keys.public, sig: keys.sign(threadSigningInput(w, body)), verified: true });
  return { ...message, ...fields };
}

/** A client whose service answers one read with these messages. */
function reading(messages, keys = null) {
  const fetch = async () => ({ status: 200, text: async () => JSON.stringify({ w: W, exists: true, count: messages.length, allow: [], messages, next: messages.length, waited: 0 }) });
  return new Aamio({ fetch, keys });
}

test("the contract vector verifies, and stops verifying when anything moves", () => {
  const { a, w, body, signature } = vectors;
  assert.ok(verify(a.public, threadSigningInput(w, body), signature));
  assert.ok(!verify(a.public, threadSigningInput("a".repeat(20), body), signature));
  assert.ok(!verify(a.public, threadSigningInput(w, body + " "), signature));
  assert.ok(!verify(alice.public, threadSigningInput(w, body), signature));
  assert.ok(!verify("not a key", "x", "not a signature"));
});

test("a signed message is verified here, and an unsigned one is unverified without a complaint", () => {
  assert.deepEqual(checkMessage(W, stored(W, 1, "hello")), { verified: true, sha256: sha256hex("hello") });
  assert.deepEqual(checkMessage(W, stored(W, 1, "hello", null)), { verified: false, sha256: sha256hex("hello") });
});

test("what the service calls verified has to check out", () => {
  const moved = stored("o".repeat(20), 1, "hello");
  const altered = { ...stored(W, 1, "hello"), body: "hello!", sha256: sha256hex("hello!") };
  const bare = { ...stored(W, 1, "hello", null), verified: true };
  const wrongHash = { ...stored(W, 1, "hello"), sha256: "0".repeat(64) };
  for (const [message, expected] of [[moved, "does not check out"], [altered, "does not check out"], [bare, "gave no key or signature"], [wrongHash, "does not hash"]]) {
    const checked = checkMessage(W, message);
    assert.equal(checked.verified, false);
    assert.ok(checked.whyNot.includes(expected), checked.whyNot);
  }
});

test("read goes by its own result, and a forged sender leaves nothing of the claim", async () => {
  const forged = { ...stored(W, 2, "pay the invoice", mallory), from: alice.public };
  const data = await reading([stored(W, 1, "hello"), forged]).read({ id: "read-key", w: W });

  assert.deepEqual(data.messages.map((m) => m.verified), [true, false]);
  assert.equal(data.messages[0].from, alice.public);
  assert.equal(data.messages[1].from, null);
  assert.ok(data.messages[1].unverifiedBecause.includes("though the service said it did"));
  assert.equal(data.messages[0].unverifiedBecause, undefined);
  assert.equal(data.keptOut, undefined);
});

test("a sealed message under a forged sender is not opened", async () => {
  const bob = Keys.fromSeedHex("02".repeat(32));
  const envelope = mallory.seal(bob.public, "for bob");
  const forged = { ...stored(W, 1, envelope, mallory), from: alice.public };
  const data = await reading([forged], bob).read({ id: "read-key", w: W });

  assert.equal(data.messages[0].encrypted, true);
  assert.equal(data.messages[0].plain, null);
  assert.equal(data.messages[0].error, "encrypted message without a verified sender");
});

test("a thread opened for one key keeps everyone else out, and says so", async () => {
  const messages = [stored(W, 1, "from alice"), stored(W, 2, "from a stranger", mallory), stored(W, 3, "unsigned", null)];
  const data = await reading(messages).read({ id: "read-key", w: W, allow: [alice.public] });

  assert.deepEqual(data.messages.map((m) => m.seq), [1]);
  assert.deepEqual(data.keptOut.map((k) => k.seq), [2, 3]);
  assert.ok(data.keptOut[0].why.includes("named keys"));
});

test("a thread opened for any signed key keeps the unsigned out", async () => {
  const data = await reading([stored(W, 1, "signed stranger", mallory), stored(W, 2, "unsigned", null)]).read({ id: "read-key", w: W, allow: ["*"] });

  assert.deepEqual(data.messages.map((m) => m.seq), [1]);
  assert.deepEqual(data.keptOut.map((k) => k.seq), [2]);
  assert.ok(data.keptOut[0].why.includes("signed messages only"));
});

test("a forged allowed key is kept out too", async () => {
  const forged = { ...stored(W, 1, "let me in", mallory), from: alice.public };
  const data = await reading([forged]).read({ id: "read-key", w: W, allow: [alice.public] });

  assert.deepEqual(data.messages, []);
  assert.deepEqual(data.keptOut.map((k) => k.seq), [1]);
});

test("a thread without a list takes everything as before", async () => {
  const data = await reading([stored(W, 1, "signed", mallory), stored(W, 2, "unsigned", null)]).read({ id: "read-key", w: W });

  assert.deepEqual(data.messages.map((m) => m.seq), [1, 2]);
  assert.equal(data.keptOut, undefined);
});

test("listen hands what was kept out to onKeptOut and yields the rest", async () => {
  const client = reading([stored(W, 1, "from alice"), stored(W, 2, "from a stranger", mallory)]);
  const controller = new AbortController();
  const kept = [];
  const yielded = [];
  for await (const message of client.listen({ id: "read-key", w: W, allow: [alice.public] }, { wait: 0, signal: controller.signal, onKeptOut: (list) => kept.push(...list) })) {
    yielded.push(message.seq);
    controller.abort();
  }

  assert.deepEqual(yielded, [1]);
  assert.deepEqual(kept.map((k) => k.seq), [2]);
});

test("decode without an address takes the service's fields as they are, as it always did", () => {
  const client = new Aamio({});
  const message = client.decode({ seq: 1, at: 1, type: "text", body: "hello", sha256: "h", from: "a-key", sig: null, verified: true });

  assert.equal(message.verified, true);
  assert.equal(message.from, "a-key");
});
