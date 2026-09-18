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
