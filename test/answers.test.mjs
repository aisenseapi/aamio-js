/**
 * An answer that guessed the field names still has to reach its post.
 *
 * The same fixtures as the Python client's tests, so a message that one
 * client understands is understood by the other. Both keep sending the
 * documented names; only reading is generous.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Aamio, Keys } from "../src/aamio.js";

const CANONICAL = { post: "p1", reply_to: "r".repeat(20), text: "use a 5 minute debounce" };
const GUESSED = { post_id: "p1", w: "r".repeat(20), reply: "use a 5 minute debounce" };

/** One stored message as the service returns it, decoded by the client. */
function decode(body, { verified = true, from = "a-verified-key" } = {}) {
  const client = new Aamio({ keys: Keys.generate() });
  return client.decode({ seq: 1, at: 1800000000, type: "json", body, sha256: "h", from, verified, sig: null });
}

test("a plaintext answer with guessed names is read as an answer", () => {
  const m = decode(JSON.stringify(GUESSED));
  assert.equal(m.encrypted, false);
  assert.equal(m.json.post, "p1");
  assert.equal(m.json.reply_to, "r".repeat(20));
  assert.equal(m.json.text, GUESSED.reply);
  assert.deepEqual(m.renamed, { post_id: "post", w: "reply_to", reply: "text" });
});

test("and the board finds it under the post it answers", () => {
  const client = new Aamio({ keys: Keys.generate() });
  const messages = [decode(JSON.stringify(GUESSED))];
  assert.equal(client.board.replies(messages, "p1").length, 1);
});

test("the documented names are left exactly as they are", () => {
  const m = decode(JSON.stringify(CANONICAL));
  assert.deepEqual(m.json, CANONICAL);
  assert.equal(m.renamed, undefined);
});

test("a message that is not an answer is not rewritten into one", () => {
  // w and id mean other things elsewhere in the protocol.
  const m = decode(JSON.stringify({ id: "abc", w: "c".repeat(20), note: "hello" }));
  assert.deepEqual(m.json, { id: "abc", w: "c".repeat(20), note: "hello" });
  assert.equal(m.renamed, undefined);
});

test("two spellings that disagree keep the documented one and report the other", () => {
  const m = decode(JSON.stringify({ post: "p1", post_id: "p2", text: "hei" }));
  assert.equal(m.json.post, "p1");
  assert.deepEqual(m.conflicting, { post_id: "p2" });
});

test("plain prose is kept whole rather than parsed into nothing", () => {
  const long = "x".repeat(1200);
  const m = decode(long);
  assert.equal(m.plain, long);
  assert.equal(m.json, undefined);
});

test("one message a sender made undecodable does not cost the others", () => {
  // String() on a value whose toString is not callable throws, and the whole
  // batch went with it, good messages included.
  const client = new Aamio({ keys: Keys.generate() });
  const bad = { seq: 1, at: 1, type: "json", body: JSON.stringify({ post: "p1", text: { toString: 1 }, reply: "hi" }), sha256: "h1", from: "k", verified: true, sig: null };
  const good = { seq: 2, at: 2, type: "json", body: JSON.stringify({ post: "p1", text: "an ordinary answer" }), sha256: "h2", from: "k", verified: true, sig: null };
  const out = [bad, good].map((m) => client.decodeSafely(m));
  assert.equal(out.length, 2);
  assert.equal(out[1].json.text, "an ordinary answer");
});

test("a field holding an object is left as the sender wrote it", () => {
  const client = new Aamio({ keys: Keys.generate() });
  const m = client.decodeSafely({ seq: 1, at: 1, type: "json", body: JSON.stringify({ post: "p1", text: { toString: 1 }, reply: "hi" }), sha256: "h", from: "k", verified: true, sig: null });
  assert.deepEqual(m.json.text, { toString: 1 });
  assert.equal(m.conflicting, undefined);
});

test("the board default lifetime is one value in one place", async () => {
  const m = await import("../src/aamio.js");
  assert.equal(m.BOARD_TTL, 1800);
});

test("two spellings of the same value are not a disagreement", () => {
  const client = new Aamio({ keys: Keys.generate() });
  const m = client.decodeSafely({ seq: 1, at: 1, type: "json", body: JSON.stringify({ post: "p1", reply: "on my way", message: "on my way" }), sha256: "h", from: "k", verified: true, sig: null });
  assert.equal(m.json.text, "on my way");
  assert.deepEqual(m.renamed, { reply: "text" });
  assert.equal(m.conflicting, undefined);
});

test("two spellings that actually differ still are", () => {
  const client = new Aamio({ keys: Keys.generate() });
  const m = client.decodeSafely({ seq: 1, at: 1, type: "json", body: JSON.stringify({ post: "p1", reply: "on my way", message: "cannot make it" }), sha256: "h", from: "k", verified: true, sig: null });
  assert.equal(m.json.text, "on my way");
  assert.deepEqual(m.conflicting, { message: "cannot make it" });
});
