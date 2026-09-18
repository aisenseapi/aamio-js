/**
 * Work up to 32 bits, for an inbox that means to meet only writers with compute.
 *
 * 32 bits takes this client hours, and an inbox lives an hour at most, so a
 * slow writer must not find out from a 410 after an hour of work. The time
 * left is read from X-Seconds-Left on the gate, work that would not be done by
 * then is not started, and work that runs over is stopped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Aamio, GateStop, Keys, describeSeconds, expectedSeconds, gatePlan, setWorkSolver, solveWork, workRate } from "../src/aamio.js";

test("work that would not be done before the inbox closes is not started", () => {
  assert.throws(
    () => gatePlan({ require: { pow: { bits: 32, covers: 1 } } }, "w".repeat(20), undefined, 60),
    (error) => error instanceof GateStop && error.reason.includes("32 bits") && error.reason.includes("not started") && error.reason.includes("nothing was sent"),
  );
});

test("work that fits goes ahead, with how long it takes here", () => {
  const advice = gatePlan({ require: { pow: { bits: 20, covers: 1 } } }, "w".repeat(20), undefined, 3600);
  assert.equal(advice.bits, 20);
  assert.ok(advice.expectedSeconds > 0 && advice.expectedSeconds < 3600);
});

test("the estimate doubles with each bit, at the rate measured here", () => {
  assert.ok(workRate() > 0);
  assert.ok(Math.abs(expectedSeconds(21) - 2 * expectedSeconds(20)) < 1e-9);
  assert.equal(describeSeconds(600), "10 minutes");
});

test("work past its deadline is stopped", () => {
  const started = Date.now();
  assert.equal(solveWork("w".repeat(20), "k".repeat(43), "body", 40, Date.now() + 300), null);
  assert.ok(Date.now() - started < 5000);
});

test("a handed solver is timed for the estimate, since it can be far faster than the loop", () => {
  setWorkSolver(null);
  const loop = workRate();
  // A solver that answers at once looks very fast, and the estimate follows it.
  setWorkSolver({ thread: () => "0" });
  const handed = workRate();
  setWorkSolver(null);
  assert.ok(handed > loop);
});

test("the client reads the time left from the gate, and a send that cannot fit sends nothing", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push(init.method + " " + url);
    if (url.endsWith("/gate")) {
      return { status: 200, headers: { get: (name) => (name.toLowerCase() === "x-seconds-left" ? "5" : null) }, text: async () => JSON.stringify({ require: { pow: { bits: 26, covers: 1 } } }) };
    }
    return { status: 201, text: async () => JSON.stringify({ seq: 1 }) };
  };
  const client = new Aamio({ keys: Keys.generate(), fetch });
  const w = "q".repeat(20);
  await assert.rejects(client.send(w, "hello"), (error) => error instanceof GateStop && error.reason.includes("not started"));
  assert.ok(client.secondsLeft(w) <= 5 && client.secondsLeft(w) > 4);
  assert.deepEqual(requests.filter((r) => r.startsWith("POST")), []);
});
