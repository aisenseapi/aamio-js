/**
 * listen follows the service's cursor.
 *
 * Threads live on tmpfs. A restart takes them, and a write to an address whose
 * thread is gone opens a new one there that counts from one again. The service
 * then reads an old cursor from the start and says reset, with a next lower
 * than the one the reader held. listen kept the highest seq it had seen, asked
 * past the new thread on every call, and handed the same messages over each
 * time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Aamio, Keys } from "../src/aamio.js";
import { FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";

test("after a reset listen asks from the service's next, and nothing comes twice", async () => {
  const asked = [];
  const answers = [
    { exists: true, messages: [{ seq: 1, at: 1, body: "one" }, { seq: 2, at: 2, body: "two" }], next: 2, reset: { after: 40, newest: 2, what: "after 40 is past the last message" } },
    { exists: true, messages: [{ seq: 3, at: 3, body: "three" }], next: 3 },
  ];
  const fetch = async (url) => {
    asked.push(url);
    const body = answers.shift() || { exists: true, messages: [], next: 3 };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  const client = new Aamio({ keys: Keys.generate(), fetch });
  const thread = { w: "w".repeat(20), id: "i".repeat(26) };
  const seen = [];
  for await (const message of client.listen(thread, { after: 40, wait: 1 })) {
    seen.push(message.seq);
    if (seen.length === 3) break;
  }
  assert.deepEqual(seen, [1, 2, 3]);
  assert.match(asked[0], /\/after\/40\//);
  assert.match(asked[1], /\/after\/2\//, "the second call asks from the reset cursor, not from 40 again");
});

// listen knows a thread by the instance the service names it by (a review of 10 November 2026).

test("listen reads a thread opened again at the address from the start, and says so once", async () => {
  const fake = new FakeAamio();
  const fetch = (url, init) => fake.fetch(url, init);
  const owner = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const writer = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const thread = await owner.open({ ttl: 600 });
  assert.match(thread.instance, /^[0-9a-f]{16}$/, "open keeps the instance the service names");
  await writer.send(thread.w, "old one");
  const resets = [];
  const messages = owner.listen(thread, { wait: 1, onReset: (reset) => resets.push(reset) });
  assert.equal((await messages.next()).value.plain, "old one");
  // Its owner opens the address again in the same second, with the same lifetime and list, and two messages come.
  // The cursor at 1 is not past them, so the service says no reset.
  fake.threads.set(thread.w, { ...fake.threads.get(thread.w), messages: [], instance: "6".repeat(16) });
  await writer.send(thread.w, "new one");
  await writer.send(thread.w, "new two");
  assert.equal((await messages.next()).value.plain, "new one", "the first message of the new thread");
  assert.equal((await messages.next()).value.plain, "new two");
  await messages.return();
  assert.equal(resets.length, 1, "said once");
  assert.match(resets[0].what, /instance 6{16} where this listener knew instance [0-9a-f]{16}/);
  assert.equal(thread.instance, "6".repeat(16));
});

test("listen takes the instance and the expiry of a thread the service read from the start, and says the reset once", async () => {
  const fake = new FakeAamio();
  const fetch = (url, init) => fake.fetch(url, init);
  const owner = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const writer = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const thread = await owner.open({ ttl: 3600 });
  await writer.send(thread.w, "one");
  await writer.send(thread.w, "two");
  const resets = [];
  const messages = owner.listen(thread, { wait: 1, onReset: (reset) => resets.push(reset) });
  assert.equal((await messages.next()).value.plain, "one");
  assert.equal((await messages.next()).value.plain, "two");
  // A restart takes the thread, and a write opens one with the service's lifetime: the cursor at 2 is past it.
  fake.forget(thread.w);
  await writer.send(thread.w, "after the restart");
  assert.equal((await messages.next()).value.plain, "after the restart");
  await messages.return();
  assert.equal(resets.length, 1, "the service's reset, once");
  assert.equal(thread.instance, fake.threads.get(thread.w).instance);
  assert.equal(thread.expireAt, fake.threads.get(thread.w).expire_at, "and the expiry of the thread that is there");
});
