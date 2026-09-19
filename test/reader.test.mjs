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
import { Aamio, Keys, checkMessage, sha256hex, threadSigningInput, verify, deriveAddress, isScopeKey, isKey } from "../src/aamio.js";

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
  assert.equal(message.checked, false);
});

test("open retains its own normalised policy when the service omits or replaces it", async () => {
  for (const echo of [undefined, [], ["*"], [mallory.public]]) {
    const requests = [];
    const client = new Aamio({ fetch: async (url, init) => {
      requests.push(init);
      return { status: 201, text: async () => JSON.stringify({ expire_at: 123, allow: echo }) };
    } });
    const thread = await client.open({ allow: [" " + alice.public + ",", alice.public, " "] });
    assert.deepEqual(thread.allow, [alice.public]);
    assert.deepEqual(thread.allowAnswered, echo ?? null);
    assert.equal(requests[0].headers["X-Allow"], alice.public);
    const guarded = await reading([stored(thread.w, 1, "stranger", mallory), stored(thread.w, 2, "unsigned", null)]).read(thread);
    assert.equal(guarded.messages.length, 0);
    assert.equal(guarded.keptOut.length, 2);
    assert.deepEqual((await client.openWith(alice.public)).allow, [alice.public]);
    assert.deepEqual((await client.open({ allow: [alice.public + ", *", ""] })).allow, ["*"]);
    assert.deepEqual((await client.open({ allow: [" ", ","] })).allow, []);
    assert.equal(requests.at(-1).headers["X-Allow"], undefined);
    const count = requests.length;
    await assert.rejects(client.open({ allow: ["*", null] }), TypeError);
    assert.equal(requests.length, count);
  }
});

test("keptOut distinguishes forged, altered, stranger and unsigned messages", async () => {
  const forged = { ...stored(W, 1, "forged", mallory), from: alice.public };
  const altered = { ...stored(W, 2, "original"), body: "altered" };
  const result = await reading([forged, altered, stored(W, 3, "stranger", mallory), stored(W, 4, "unsigned", null)]).read({ id: "read-key", w: W, allow: [alice.public] });
  assert.equal(result.messages.length, 0);
  assert.match(result.keptOut[0].unverifiedBecause, /signature/);
  assert.match(result.keptOut[1].unverifiedBecause, /hash/);
  assert.equal(result.keptOut[2].unverifiedBecause, undefined);
  assert.equal(result.keptOut[3].unverifiedBecause, undefined);
  assert.equal(result.next, 4);
});

test("decoder failure cannot restore an unverified sender or plaintext", async () => {
  const client = reading([stored(W, 1, "claimed", mallory, { from: alice.public })]);
  client.decode = () => { throw new RangeError("synthetic decoder failure"); };
  const result = await client.read({ id: "read-key", w: W });
  assert.equal(result.messages[0].verified, false);
  assert.equal(result.messages[0].from, null);
  assert.equal(result.messages[0].plain, null);
  assert.equal(result.messages[0].json, undefined);
  assert.equal(result.messages[0].unverifiedBecause, "the message could not be checked here: RangeError");
  const guarded = await client.read({ id: "read-key", w: W, allow: [alice.public] });
  assert.equal(guarded.messages.length, 0);
  assert.match(guarded.keptOut[0].unverifiedBecause, /RangeError/);
});

test("one malformed record is a diagnostic and does not hide the next message", async () => {
  const result = await reading([null, stored(W, 2, "valid")]).read({ id: "read-key", w: W });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].verified, false);
  assert.equal(result.messages[0].from, null);
  assert.equal(result.messages[1].verified, true);
  assert.equal(result.messages[1].checked, true);
  assert.equal(result.next, 2);
});

test("listen reports and retains excluded messages when no callback is provided", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const client = reading([stored(W, 1, "allowed"), stored(W, 2, "stranger", mallory)]);
  const thread = { id: "read-key", w: W, allow: [alice.public] };
  for await (const message of client.listen(thread)) {
    assert.equal(message.seq, 1);
    break;
  }
  assert.deepEqual(thread.keptOut.map((entry) => entry.seq), [2]);
  assert.equal(warning.mock.callCount(), 1);
});

test("listen exposes missing threads and resets to callbacks and its thread state", async () => {
  const controller = new AbortController();
  const reset = { after: 8, newest: 1, what: "new thread" };
  const pages = [{ exists: false, messages: [], next: 0, note: "gone" }, { exists: true, messages: [stored(W, 1, "new")], next: 1, reset }];
  const client = new Aamio({ fetch: async () => ({ status: 200, text: async () => JSON.stringify(pages.shift()) }) });
  const thread = { id: "read-key", w: W };
  const gone = [], resets = [];
  for await (const message of client.listen(thread, { signal: controller.signal, onGone: (data) => gone.push(data.note), onReset: (value) => resets.push(value) })) {
    assert.equal(message.seq, 1);
    controller.abort();
  }
  assert.deepEqual(gone, ["gone"]);
  assert.deepEqual(resets, [reset]);
  assert.equal(thread.gone, false);
  assert.deepEqual(thread.reset, reset);
});

test("legacy base64 spellings verify but an allowlist compares exact key strings", async () => {
  assert.ok(verify(vectors.a.public, vectors.signInput, vectors.strayBits.signature));
  assert.ok(verify(vectors.strayBits.key, vectors.signInput, vectors.signature));
  const old = { seq: 1, at: 1, body: vectors.body, sha256: sha256hex(vectors.body), from: vectors.strayBits.key, sig: vectors.signature, verified: true };
  const result = await reading([old]).read({ id: "read-key", w: vectors.w, allow: [vectors.a.public] });
  assert.equal(result.messages.length, 0);
  assert.equal(result.keptOut.length, 1);
  assert.equal(result.keptOut[0].unverifiedBecause, undefined);
});

test("shape checks refuse trailing newlines before deriving or sending", async () => {
  assert.throws(() => deriveAddress(vectors.id + "\n"), TypeError);
  assert.equal(isScopeKey("a".repeat(26) + "\n"), false);
  assert.equal(isKey(alice.public + "\n"), false);
  let requests = 0;
  const client = new Aamio({ keys: alice, fetch: async () => { requests++; throw new Error("must not send"); } });
  await assert.rejects(client.board.post({ scope: "a".repeat(20) + "\n" }), TypeError);
  assert.equal(requests, 0);
});

test("board reply inboxes retain signed-only policy even when the service drops its echo", async () => {
  const client = new Aamio({ keys: alice, fetch: async (url, init) => ({ status: init.method === "PUT" ? 201 : 200, text: async () => JSON.stringify(init.method === "PUT" ? { expire_at: Math.floor(Date.now() / 1000) + 1800 } : { messages: [stored(url.split("/").at(-1), 1, JSON.stringify({ post: "p1", text: "unsigned answer" }), null)], next: 1 }) }) });
  const inbox = await client.board.inbox();
  const result = await client.read(inbox);
  assert.deepEqual(inbox.allow, ["*"]);
  assert.deepEqual(client.board.replies(result.messages, "p1"), []);
  assert.equal(result.keptOut.length, 1);
});
