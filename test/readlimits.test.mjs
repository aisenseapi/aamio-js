/**
 * Asking the service for a small answer.
 *
 * The service has taken X-Limit and X-Max-Bytes since 0.7.2, and no file in this
 * package sent either. A thread may hold two hundred messages of 65536 bytes, so
 * one read could be about a megabyte, and for a browser on a phone or an agent
 * reading through a model that is the whole cost of the call. Measured on the
 * live service on 20 September 2026: the same thread, 20 529 bytes without the
 * headers and 360 with them.
 *
 * Whole messages only. A signed message cut in half does not verify, so a budget
 * smaller than the first message comes back as too_large naming it, never as a
 * piece of it. Nothing here does the cutting: the service does, and this only
 * asks and passes on what came back.
 *
 * A service that does not offer read-limits ignores both headers and answers as
 * it always did, which is why they are safe to send without asking first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Aamio } from "../src/aamio.js";

const W = "i".repeat(20);
const THREAD = { w: W, id: "read-key", allow: [] };

/** A client that records what went out and answers with these messages. */
function watching(messages = [], extra = {}) {
  const sent = [];
  const fetch = async (url, options = {}) => {
    sent.push({ url, headers: options.headers || {} });
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ w: W, exists: true, count: messages.length, allow: [], messages, next: messages.length, waited: 0, ...extra }),
    };
  };
  return { client: new Aamio({ fetch }), sent };
}

test("a read that asked for nothing sends no limit header, so an older service sees the call it always saw", async () => {
  const { client, sent } = watching();
  await client.read(THREAD);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers["X-Limit"], undefined);
  assert.equal(sent[0].headers["X-Max-Bytes"], undefined);
  assert.equal(sent[0].headers["X-Read"], "read-key");
});

test("a count and a budget reach the service as the headers it reads", async () => {
  const { client, sent } = watching();
  await client.read(THREAD, { limit: 5, maxBytes: 4096 });

  assert.equal(sent[0].headers["X-Limit"], "5", "the count did not reach the wire");
  assert.equal(sent[0].headers["X-Max-Bytes"], "4096", "the budget did not reach the wire");
});

test("each one can be set on its own", async () => {
  const { client, sent } = watching();
  await client.read(THREAD, { limit: 3 });
  await client.read(THREAD, { maxBytes: 2048 });

  assert.equal(sent[0].headers["X-Limit"], "3");
  assert.equal(sent[0].headers["X-Max-Bytes"], undefined);
  assert.equal(sent[1].headers["X-Limit"], undefined);
  assert.equal(sent[1].headers["X-Max-Bytes"], "2048");
});

test("what the service left behind comes back untouched, so the caller knows to ask again", async () => {
  const { client } = watching([], { more: true, next: 12 });
  const answer = await client.read(THREAD, { limit: 2 });

  assert.equal(answer.more, true, "more was dropped on the way through");
  assert.equal(answer.next, 12, "next must be the last message handed over, or the next read skips one");
});

test("a message too large for the budget is named, not cut", async () => {
  const tooLarge = { seq: 7, bytes: 70000, fix: "Raise X-Max-Bytes above 70000 or read this one on its own." };
  const { client } = watching([], { too_large: tooLarge });
  const answer = await client.read(THREAD, { maxBytes: 1024 });

  assert.deepEqual(answer.too_large, tooLarge, "the caller cannot act on a budget it never learns was too small");
});

test("the limits go with wait and with a cursor rather than replacing them", async () => {
  const { client, sent } = watching();
  await client.read(THREAD, { after: 9, wait: 3, limit: 4 });

  assert.match(sent[0].url, /\/after\/9\/wait\/3$/, sent[0].url);
  assert.equal(sent[0].headers["X-Limit"], "4");
});
