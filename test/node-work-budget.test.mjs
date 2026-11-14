// Proof of work inside a call is held to the time the call has (a security review of 13 November 2026): every
// send did its work in the call, however long, and the event loop with it, where aamio-php's Gate::plan stops
// work that would take longer than a tool call is given. The same rule here, with the outcomes a review of 14
// November 2026 asked for: no post when it stops before one, the one post a 428 answered when it stops after
// that, an unknown that stays unknown, and low or no work delivered as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { Aamio, AamioError, GateStop, Keys, gatePlan } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { WORK_BUDGET, serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const w = "q".repeat(20);
const heavy = { require: { pow: { bits: 24, covers: 1 } } };
// A budget no work of 24 bits fits in, on any machine, so no test rests on its speed or on luck.
const TINY = 0.000001;

/** A runtime on a home of its own, whose posts answer as the test says and are counted. */
async function runtimeFor(t, answers = []) {
  const fake = new FakeAamio();
  const root = await mkdtemp(join(tmpdir(), "aamio-node-budget-"));
  const home = join(root, "home");
  await initIdentity(home);
  const runtime = await NodeRuntime.open({ home, host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const posts = [];
  runtime.post = async (to, envelope, headers) => {
    posts.push(headers["X-Work"] ?? null);
    return answers[posts.length - 1] ?? { status: 201, result: { seq: posts.length, at: 1, sha256: "h", expire_at: 2 } };
  };
  const entry = await runtime.outboxAdd(w, Keys.generate().public, "sealed bytes", { text: "x" });
  return { runtime, posts, entry };
}

test("work past the budget of a call is not started, and nothing is posted", async (t) => {
  const { runtime, posts, entry } = await runtimeFor(t);
  runtime.workBudget = TINY;
  await assert.rejects(runtime.deliver(entry, gatePlan(heavy, w, HOST, 3600)), (error) => error instanceof GateStop && error.reason.includes("not started") && error.reason.includes("nothing was sent") && error.fix.includes("command line"));
  assert.deepEqual(posts, []);
  assert.equal(entry.status, "stopped");
});

test("where the inbox closes first, the advice is a longer inbox or more compute, not the command line", () => {
  assert.throws(() => gatePlan(heavy, w, HOST, 1), (error) => error instanceof GateStop && error.why.includes("takes writes for") && !error.why.includes("nothing was sent") && error.fix.includes("more compute") && !error.fix.includes("command line"));
});

test("a gate a 428 names is held to the budget, and the one post that went is the answer", async (t) => {
  const { runtime, posts, entry } = await runtimeFor(t, [{ status: 428, result: { error: "work required", gate: heavy, seconds_left: 3000 } }]);
  runtime.workBudget = TINY;
  const answer = await runtime.deliver(entry, gatePlan({}, w, HOST, 3600));
  assert.equal(posts.length, 1);
  assert.equal(answer.status, 428);
  assert.match(answer.result.fix, /^The message went once and the inbox refused it with 428, and it was not sent again\. This inbox requires proof of work of 24 bits.*longer than a tool call is given here, so the work was not started\. Send it from the command line/);
  assert.ok(!answer.result.fix.includes("nothing was sent"), "a message that went is never said to have sent nothing");
  assert.equal(entry.status, "refused", "recorded as the refusal it was, not as a message that never left");
});

test("a 428 whose gate the client cannot meet is the answer too", async (t) => {
  const { runtime, posts, entry } = await runtimeFor(t, [{ status: 428, result: { error: "work required", gate: { require: { pow: { bits: 24, covers: 1 } } }, seconds_left: 1 } }]);
  const answer = await runtime.deliver(entry, gatePlan({}, w, HOST, 3600));
  assert.equal(posts.length, 1);
  assert.equal(answer.status, 428);
  assert.match(answer.result.fix, /^The message went once and the inbox refused it with 428, and it was not sent again\. This inbox requires proof of work of 24 bits.*takes writes for 1 seconds more/);
  assert.equal(entry.status, "refused");
});

test("a retry stopped before it posts leaves an unknown unknown, with its id and bytes", async (t) => {
  const { runtime, posts, entry } = await runtimeFor(t);
  Object.assign(entry, { status: "unknown", ever_open: true, attempts: 1, last_status: 0 });
  runtime.client.gates.set(w, heavy);
  runtime.client.gateLeft.set(w, [3600, Date.now()]);
  runtime.workBudget = TINY;
  await assert.rejects(runtime.outboxRetry(), (error) => error instanceof GateStop && error.message_id === entry.id && error.reason.includes("not started"));
  assert.deepEqual(posts, []);
  assert.equal(entry.status, "unknown");
  assert.equal(entry.ever_open, true);
  assert.equal(entry.envelope, "sealed bytes");
  assert.equal(runtime.outbox[entry.id], entry);
});

test("low or no work is delivered as before within a budget, and without one the work is done", async (t) => {
  const { runtime, posts, entry } = await runtimeFor(t);
  runtime.workBudget = 40;
  assert.equal((await runtime.deliver(entry, gatePlan({}, w, HOST, 3600))).status, 201);
  const second = await runtime.outboxAdd("r".repeat(20), Keys.generate().public, "more sealed bytes", { text: "y" });
  assert.equal((await runtime.deliver(second, gatePlan({ require: { pow: { bits: 8, covers: 1 } } }, "r".repeat(20), HOST, 3600))).status, 201);
  assert.notEqual(posts[1], null, "eight bits are done in the call");
  // Eighteen bits: estimated, so past a budget of TINY, and done in about a second here.
  const estimated = { require: { pow: { bits: 18, covers: 1 } } };
  runtime.workBudget = TINY;
  const third = await runtime.outboxAdd("s".repeat(20), Keys.generate().public, "third sealed bytes", { text: "z" });
  await assert.rejects(runtime.deliver(third, gatePlan(estimated, "s".repeat(20), HOST, 3600)), (error) => error instanceof GateStop);
  runtime.workBudget = null;
  assert.equal((await runtime.deliver(third, gatePlan(estimated, "s".repeat(20), HOST, 3600))).status, 201);
  assert.equal(typeof posts[2], "string", "on the command line the work has the time it needs");
});

test("the library's send keeps a budget its caller sets, before the work and after a 428", async () => {
  const posts = [];
  let gateNext = heavy;
  const fetch = async (url, init) => {
    if (url.endsWith("/gate")) return { status: 200, headers: { get: (name) => (name.toLowerCase() === "x-seconds-left" ? "3600" : null) }, text: async () => JSON.stringify(gateNext) };
    posts.push(init.headers["X-Work"] ?? null);
    return { status: 428, text: async () => JSON.stringify({ error: "work required", gate: heavy, seconds_left: 3000 }) };
  };
  const client = new Aamio({ keys: Keys.generate(), fetch });
  client.workBudget = TINY;
  await assert.rejects(client.send(w, "hello"), (error) => error instanceof GateStop && error.reason.includes("not started"));
  assert.equal(posts.length, 0);
  gateNext = {};
  client.forgetGate(w);
  await assert.rejects(client.send(w, "hello"), (error) => error instanceof AamioError && error.status === 428 && String(error.body.fix).startsWith("The message went once and the inbox refused it with 428") && error.stop.includes("longer than a tool call"));
  assert.equal(posts.length, 1);
});

test("the MCP server gives a tool call forty seconds of work", async (t) => {
  const fake = new FakeAamio();
  const root = await mkdtemp(join(tmpdir(), "aamio-node-budget-"));
  const home = join(root, "home");
  await initIdentity(home);
  const runtime = await NodeRuntime.open({ home, host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(runtime.workBudget ?? null, null, "on the command line there is none");
  await serveMcp({ home, version: "test", runtime, input: Readable.from([]), output: new PassThrough() });
  assert.equal(WORK_BUDGET, 40);
  assert.equal(runtime.workBudget, 40);
});
