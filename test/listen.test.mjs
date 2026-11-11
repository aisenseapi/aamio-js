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

/**
 * The fake service, with an end to a listener that reads on without what the
 * test waits for. The fake answers at once where the service would wait, and
 * a listener that missed a message asked again and again without letting a
 * timer run, so the test hung rather than failed.
 */
function capped(fake, most = 50) {
  let reads = 0;
  return (url, init) => {
    if ((init?.method || "GET") === "GET" && ++reads > most) throw new Error(`listen read ${most} times without what the test waits for`);
    return fake.fetch(url, init);
  };
}

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
  const fetch = capped(fake);
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
  const fetch = capped(fake);
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

test("two listeners on one thread each read a thread opened again from the start, and each says so once", async () => {
  const fake = new FakeAamio();
  const fetch = capped(fake);
  const owner = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const writer = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const thread = await owner.open({ ttl: 600 });
  await writer.send(thread.w, "old one");
  const resets = [[], []];
  const listeners = [0, 1].map((n) => owner.listen(thread, { wait: 1, onReset: (reset) => resets[n].push(reset) }));
  for (const listener of listeners) assert.equal((await listener.next()).value.plain, "old one");
  fake.threads.set(thread.w, { ...fake.threads.get(thread.w), messages: [], instance: "7".repeat(16) });
  await writer.send(thread.w, "new one");
  await writer.send(thread.w, "new two");
  for (const listener of listeners) {
    assert.equal((await listener.next()).value.plain, "new one", "each from the start, the second as well as the first");
    assert.equal((await listener.next()).value.plain, "new two");
    await listener.return();
  }
  assert.deepEqual(resets.map((said) => said.length), [1, 1], "each says it once");
});

test("listen reads a cursor that came without the thread's instance again from the start once, and says what came before may come again", async () => {
  const fake = new FakeAamio();
  const fetch = capped(fake);
  const owner = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const writer = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const opened = await owner.open({ ttl: 600 });
  await writer.send(opened.w, "old one");
  // The thread as an earlier version stored it, its read key and address, and the address opened again in the same
  // second with the same lifetime and list.
  const stored = { id: opened.id, w: opened.w };
  fake.threads.set(opened.w, { ...fake.threads.get(opened.w), messages: [], instance: "8".repeat(16) });
  await writer.send(opened.w, "new one");
  await writer.send(opened.w, "new two");
  const resets = [];
  const messages = owner.listen(stored, { after: 1, wait: 1, onReset: (reset) => resets.push(reset) });
  assert.equal((await messages.next()).value.plain, "new one");
  assert.equal((await messages.next()).value.plain, "new two");
  await messages.return();
  assert.equal(resets.length, 1);
  assert.match(resets[0].what, /cursor, 1, came without the thread's instance/);
  assert.equal(stored.instance, "8".repeat(16), "and kept from now on");
});

test("listen on an unchanged thread, from the start, or at a service that names no instance reads as it did", async () => {
  for (const [named, start, without, expected, said] of [
    [true, 1, false, ["old two"], 0],
    [false, 1, false, ["old one", "old two"], 1],
    [false, 0, false, ["old one", "old two"], 0],
    [false, 1, true, ["old two"], 0],
  ]) {
    const fake = new FakeAamio();
    fake.noInstance = without;
    const fetch = capped(fake);
    const owner = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
    const writer = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
    const opened = await owner.open({ ttl: 600 });
    await writer.send(opened.w, "old one");
    await writer.send(opened.w, "old two");
    const thread = named ? opened : { id: opened.id, w: opened.w };
    const resets = [];
    const messages = owner.listen(thread, { after: start, wait: 1, onReset: (reset) => resets.push(reset) });
    const how = JSON.stringify({ named, start, without });
    for (const want of expected) assert.equal((await messages.next()).value.plain, want, how);
    await messages.return();
    assert.equal(resets.length, said, how);
  }
});

test("a listener made before the thread changed knows the thread it was made for, also when it is first asked after another one saw the change", async () => {
  const fake = new FakeAamio();
  const fetch = capped(fake);
  const owner = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const writer = new Aamio({ base: HOST, keys: Keys.generate(), fetch });
  const thread = await owner.open({ ttl: 600 });
  await writer.send(thread.w, "old one");
  const first = owner.listen(thread, { wait: 1, onReset: () => {} });
  assert.equal((await first.next()).value.plain, "old one");
  // Made now, with its cursor past the old message, and not asked for anything until the thread has changed and the
  // first listener has written the new instance on the thread.
  const resets = [];
  const late = owner.listen(thread, { after: 1, wait: 1, onReset: (reset) => resets.push(reset) });
  fake.threads.set(thread.w, { ...fake.threads.get(thread.w), messages: [], instance: "9".repeat(16) });
  await writer.send(thread.w, "new one");
  await writer.send(thread.w, "new two");
  assert.equal((await first.next()).value.plain, "new one");
  await first.return();
  assert.equal(thread.instance, "9".repeat(16), "the first listener wrote the new instance on the thread");
  assert.equal((await late.next()).value.plain, "new one", "and the late one still knew the old thread, so it reads the new one from the start");
  assert.equal((await late.next()).value.plain, "new two");
  await late.return();
  assert.equal(resets.length, 1);
});
