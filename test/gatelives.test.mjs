/**
 * A gate kept for an address, and a new inbox at the same address.
 *
 * Found by an outside review on 18 September 2026: the time a kept gate said
 * counted down to nothing and stayed there, so a new inbox at the address,
 * with no gate at all, was refused on the old one's terms without the service
 * being asked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Aamio, AamioError, GateStop, Keys } from "../src/aamio.js";

function service(gates, postStatus = 201) {
  const seen = { gateReads: 0, posts: 0 };
  const fetch = async (url, init) => {
    if (url.endsWith("/gate")) {
      const [gate, left] = gates[Math.min(seen.gateReads, gates.length - 1)];
      seen.gateReads++;
      return { status: 200, headers: { get: (name) => (name.toLowerCase() === "x-seconds-left" ? String(left) : null) }, text: async () => JSON.stringify(gate) };
    }
    seen.posts++;
    return { status: postStatus, text: async () => JSON.stringify(postStatus === 201 ? { seq: 1 } : { error: "Thread has expired", fix: "Open a new one" }) };
  };
  return { client: new Aamio({ keys: Keys.generate(), fetch }), seen };
}

const w = "q".repeat(20);

test("a new inbox at an old address is asked about before a no", async () => {
  // The first life asked for 17 bits and its time is up; the new one asks nothing.
  const { client, seen } = service([[{ require: { pow: { bits: 17, covers: 1 } } }, 0], [{}, 600]]);
  await client.gate(w);
  const sent = await client.send(w, "hello");
  assert.equal(sent.seq, 1);
  assert.equal(seen.gateReads, 2, "one more read of the gate, and only one");
  assert.equal(seen.posts, 1);
});

test("a real no is still a no after one more read", async () => {
  const closed = [{ require: { pow: { bits: 30, covers: 1 } } }, 0];
  const { client, seen } = service([closed, closed]);
  await client.gate(w);
  await assert.rejects(client.send(w, "hello"), (error) => error instanceof GateStop);
  assert.equal(seen.gateReads, 2);
  assert.equal(seen.posts, 0);
});

test("an inbox that answers 410 takes its gate with it", async () => {
  const { client } = service([[{}, 600]], 410);
  await assert.rejects(client.send(w, "hello"), (error) => error instanceof AamioError && error.status === 410);
  assert.equal(client.gates.has(w), false);
  assert.equal(client.secondsLeft(w), null);
});
