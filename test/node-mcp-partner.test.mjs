// aamio_partner_add over MCP: the name from the model, the key from the user in a dialog of their app (MCP
// elicitation), both ways the protocol has for it, and a server that reads on while it waits for the answer.
// The same tool as aamio-python's and aamio-php's servers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Keys } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const MODERN = "2026-07-28";
const VERSION = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

// A home in a folder of its own, closed before the folder goes: a held owner.lock cannot be removed on Windows.
async function home(t) {
  const fake = new FakeAamio();
  const root = await mkdtemp(join(tmpdir(), "aamio-node-mcp-partner-"));
  const dir = join(root, "home");
  await initIdentity(dir);
  const runtime = await NodeRuntime.open({ home: dir, host: HOST, fetch: fake.fetch, clock: () => fake.time });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}

// The client end of the server's stdio: what it sends, and every message the server writes, each taken once.
function connect(runtime) {
  const input = new PassThrough();
  const output = new PassThrough();
  const said = [];
  const taken = new Set();
  const lines = new EventEmitter();
  let rest = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    rest += chunk;
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (line.trim()) said.push(JSON.parse(line));
    }
    lines.emit("line");
  });
  const served = serveMcp({ home: runtime.home, version: "test", runtime, input, output });
  const take = (match) => {
    const index = said.findIndex((message, at) => !taken.has(at) && match(message));
    if (index < 0) return undefined;
    taken.add(index);
    return said[index];
  };
  return {
    said,
    served,
    send: (message) => input.write(JSON.stringify(message) + "\n"),
    end: () => input.end(),
    async next(match, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = take(match);
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`the server did not say it: ${JSON.stringify(said)}`);
        const stop = new AbortController();
        try {
          await Promise.race([once(lines, "line", { signal: stop.signal }), sleep(left, null, { signal: stop.signal })]);
        } finally {
          stop.abort();
        }
      }
    },
    /** Nothing matching was said, after a while for it to come. */
    async never(match, ms = 300) {
      await sleep(ms);
      assert.equal(take(match), undefined, `the server said what it should not: ${JSON.stringify(said)}`);
    },
  };
}

const reply = (id) => (message) => message.id === id && message.method === undefined;
const asking = (message) => message.method === "elicitation/create";
const initialize = (version, capabilities = {}) => ({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: version, capabilities, clientInfo: { name: "test", version: "0" } } });
const call = (id, args, params = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "aamio_partner_add", arguments: args, ...params } });
const modern = (extra = {}, capabilities = { elicitation: {} }) => ({ _meta: { [VERSION]: MODERN, [CAPABILITIES]: capabilities }, ...extra });

test("asked while the call waits: the user gives the key, a ping is answered during the wait, and the partner is added", async (t) => {
  const runtime = await home(t);
  const bob = Keys.generate();
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  await mcp.next(reply(0));
  mcp.send(call(1, { name: "bob" }));
  const question = await mcp.next(asking);
  assert.equal(question.params.mode, undefined, "2025-06-18 has no modes to name");
  assert.match(question.params.message, /add bob to your aamio address book/);
  assert.match(question.params.message, /decline/);
  assert.deepEqual(question.params.requestedSchema.required, ["key"]);
  assert.equal(question.params.requestedSchema.properties.key.minLength, 43);

  mcp.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual((await mcp.next(reply(2))).result, {}, "a ping is answered at once while the user is asked");
  assert.deepEqual(runtime.partnerList(), [], "nothing is added before the user answers");

  mcp.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { key: ` ${bob.public} ` } } });
  const added = (await mcp.next(reply(1))).result;
  assert.equal(added.isError, false, JSON.stringify(added));
  assert.equal(added.structuredContent.added, true);
  assert.equal(added.structuredContent.partner, "bob");
  assert.match(added.structuredContent.next, /aamio_whoami/);
  assert.deepEqual(runtime.partnerList().map((p) => [p.name, p.key]), [["bob", bob.public]], "the key the user gave, trimmed");
  mcp.end();
  await mcp.served;
});

test("2025-11-25 names the form mode, and a user who declines adds nothing", async (t) => {
  const runtime = await home(t);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-11-25", { elicitation: { form: {} } }));
  await mcp.next(reply(0));
  mcp.send(call(1, { name: "bob" }));
  const question = await mcp.next(asking);
  assert.equal(question.params.mode, "form");
  mcp.send({ jsonrpc: "2.0", id: question.id, result: { action: "decline" } });
  const declined = (await mcp.next(reply(1))).result;
  assert.equal(declined.isError, false);
  assert.equal(declined.structuredContent.added, false);
  assert.equal(declined.structuredContent.action, "decline");
  mcp.send(call(3, { name: "carol" }));
  const second = await mcp.next(asking);
  mcp.send({ jsonrpc: "2.0", id: second.id, result: { action: "cancel" } });
  assert.equal((await mcp.next(reply(3))).result.structuredContent.action, "cancel");
  mcp.send(call(4, { name: "dave" }));
  const third = await mcp.next(asking);
  mcp.send({ jsonrpc: "2.0", id: third.id, error: { code: -32601, message: "no dialogs here" } });
  const refused = (await mcp.next(reply(4))).result;
  assert.equal(refused.structuredContent.error_code, "no_dialog");
  assert.match(refused.structuredContent.error, /no dialogs here/);
  assert.deepEqual(runtime.partnerList(), []);
  mcp.end();
  await mcp.served;
});

test("a call cancelled while the user is asked ends the wait, withdraws the question and is answered with nothing", async (t) => {
  const runtime = await home(t);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  await mcp.next(reply(0));
  mcp.send(call(1, { name: "bob" }));
  const question = await mcp.next(asking);
  // A call queued behind the wait, cancelled before it is served.
  mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aamio_partners", arguments: {} } });
  mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
  mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "the user moved on" } });
  const withdrawn = await mcp.next((message) => message.method === "notifications/cancelled");
  assert.equal(withdrawn.params.requestId, question.id);
  // A late answer to the withdrawn question is passed over, and the server goes on.
  mcp.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { key: Keys.generate().public } } });
  mcp.send({ jsonrpc: "2.0", id: 3, method: "ping" });
  await mcp.next(reply(3));
  await mcp.never((message) => message.id === 1 || message.id === 2);
  assert.deepEqual(runtime.partnerList(), [], "nothing is added");
  mcp.end();
  await mcp.served;
});

test("a cancellation of a call already answered is not kept, and a later call with the same id is served", async (t) => {
  const runtime = await home(t);
  const mcp = connect(runtime);
  mcp.send({ jsonrpc: "2.0", id: 7, method: "ping" });
  await mcp.next(reply(7));
  mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
  mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } });
  mcp.send({ jsonrpc: "2.0", id: 7, method: "ping" });
  mcp.send({ jsonrpc: "2.0", id: 8, method: "ping" });
  await mcp.next(reply(7));
  await mcp.next(reply(8));
  mcp.end();
  await mcp.served;
});

test("the input ends while the user is asked: the call is answered with nothing and the server ends", async (t) => {
  const runtime = await home(t);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  await mcp.next(reply(0));
  mcp.send(call(1, { name: "bob" }));
  await mcp.next(asking);
  mcp.end();
  await mcp.served;
  assert.equal(mcp.said.some((message) => message.id === 1), false);
  assert.deepEqual(runtime.partnerList(), []);
});

test("a call that would ask after the input has ended is not left waiting for an answer", async (t) => {
  const runtime = await home(t);
  // The home is held, so the calls are served only after the end of the input has been read.
  let release;
  const held = runtime.serial(() => new Promise((resolve) => { release = resolve; }));
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aamio_partners", arguments: {} } });
  mcp.send(call(2, { name: "bob" }));
  mcp.end();
  await sleep(200);
  release();
  await held;
  await mcp.served;
  assert.ok(mcp.said.some(reply(1)), "what came before the end is answered");
  assert.equal(mcp.said.some(asking), false, "no question that nobody can answer");
  assert.equal(mcp.said.some(reply(2)), false);
  assert.deepEqual(runtime.partnerList(), []);
});

test("over 2026-07-28 the question is the result, and the answer comes with the call made again, once", async (t) => {
  const runtime = await home(t);
  const bob = Keys.generate();
  const mcp = connect(runtime);
  mcp.send(call(1, { name: "bob" }, modern()));
  const first = (await mcp.next(reply(1))).result;
  assert.equal(first.resultType, "input_required");
  const question = first.inputRequests.aamio_partner_key;
  assert.equal(question.method, "elicitation/create");
  assert.equal(question.params.mode, "form");
  assert.equal(typeof first.requestState, "string");
  assert.deepEqual(runtime.partnerList(), []);

  const answer = { aamio_partner_key: { action: "accept", content: { key: bob.public } } };
  mcp.send(call(2, { name: "bob" }, modern({ requestState: first.requestState, inputResponses: answer })));
  const added = (await mcp.next(reply(2))).result;
  assert.equal(added.resultType, "complete");
  assert.equal(added.structuredContent.added, true, JSON.stringify(added));
  assert.deepEqual(runtime.partnerList().map((p) => p.key), [bob.public]);

  const other = { aamio_partner_key: { action: "accept", content: { key: Keys.generate().public } } };
  mcp.send(call(3, { name: "bob" }, modern({ requestState: first.requestState, inputResponses: other })));
  const replayed = (await mcp.next(reply(3))).result;
  assert.equal(replayed.structuredContent.error_code, "no_dialog", "a state is used once");
  mcp.send(call(4, { name: "bob" }, modern({ requestState: "e30." + "0".repeat(64), inputResponses: other })));
  assert.equal((await mcp.next(reply(4))).result.structuredContent.error_code, "no_dialog", "and a state this server did not seal is not taken");
  mcp.send(call(5, { name: "carol" }, modern({ requestState: first.requestState, inputResponses: other })));
  assert.equal((await mcp.next(reply(5))).result.structuredContent.error_code, "no_dialog", "nor one sealed for another name");
  assert.deepEqual(runtime.partnerList().map((p) => p.key), [bob.public], "the key the user gave stays");

  mcp.send(call(6, { name: "carol" }, modern()));
  const asked = (await mcp.next(reply(6))).result;
  mcp.send(call(7, { name: "carol" }, modern({ requestState: asked.requestState, inputResponses: {} })));
  assert.equal((await mcp.next(reply(7))).result.resultType, "input_required", "a missing answer is asked for again");
  mcp.end();
  await mcp.served;
});

test("an app that cannot show a form is told how the user adds the partner instead, and nothing is added", async (t) => {
  const runtime = await home(t);
  for (const [version, capabilities] of [["2025-06-18", {}], ["2025-11-25", { elicitation: { url: {} } }], ["2025-03-26", { elicitation: {} }]]) {
    const mcp = connect(runtime);
    mcp.send(initialize(version, capabilities));
    await mcp.next(reply(0));
    mcp.send(call(1, { name: "bob" }));
    const said = (await mcp.next(reply(1))).result;
    assert.equal(said.isError, true);
    assert.equal(said.structuredContent.error_code, "no_dialog", version);
    assert.match(said.structuredContent.fix, /npx aamio --home ("[^"]+"|\S+) partner add bob KEY/);
    assert.ok(said.structuredContent.fix.includes(runtime.home), "in this server's home");
    assert.equal(mcp.said.some(asking), false);
    mcp.end();
    await mcp.served;
  }
  const mcp = connect(runtime);
  mcp.send(call(1, { name: "bob" }, modern({}, {})));
  assert.equal((await mcp.next(reply(1))).result.structuredContent.error_code, "no_dialog", "2026-07-28 without the capability on the request");
  mcp.end();
  await mcp.served;
  assert.deepEqual(runtime.partnerList(), []);
});

test("a key from the model is refused, and so are a bad name, a bad key and a key held under another name", async (t) => {
  const runtime = await home(t);
  const carol = Keys.generate();
  await runtime.partnerAdd("carol", carol.public);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  await mcp.next(reply(0));

  mcp.send(call(1, { name: "bob", key: Keys.generate().public }));
  const keyed = (await mcp.next(reply(1))).result;
  assert.equal(keyed.isError, true);
  assert.deepEqual(keyed.structuredContent.given, ["key"]);
  assert.match(keyed.structuredContent.fix, /never from the conversation/);

  mcp.send(call(2, { name: "bob smith" }));
  assert.match((await mcp.next(reply(2))).result.structuredContent.error, /letters, digits, dots, dashes and underscores/);
  mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "aamio_partner_add", arguments: "bob" } });
  assert.equal((await mcp.next(reply(3))).error.code, -32602);

  mcp.send(call(4, { name: "bob" }));
  const question = await mcp.next(asking);
  mcp.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { key: "not a key" } } });
  const bad = (await mcp.next(reply(4))).result;
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.added, false);
  assert.match(bad.structuredContent.error, /not an aamio public key/);

  mcp.send(call(5, { name: "bob" }));
  const again = await mcp.next(asking);
  mcp.send({ jsonrpc: "2.0", id: again.id, result: { action: "accept", content: { key: carol.public } } });
  const held = (await mcp.next(reply(5))).result;
  assert.equal(held.isError, true);
  assert.match(held.structuredContent.error, /in the address book already, as carol/);
  assert.equal(mcp.said.filter(asking).length, 2, "nobody is asked for a call refused before the question");
  assert.deepEqual(runtime.partnerList().map((p) => [p.name, p.key]), [["carol", carol.public]], "nothing changed");
  mcp.end();
  await mcp.served;
});

test("a name in the book is asked about in the book's spelling, and the key the user gives replaces its key", async (t) => {
  const runtime = await home(t);
  await runtime.partnerAdd("Bob", Keys.generate().public);
  const bob = Keys.generate();
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  await mcp.next(reply(0));
  mcp.send(call(1, { name: "bob" }));
  const question = await mcp.next(asking);
  assert.match(question.params.message, /add Bob to your aamio address book/);
  assert.match(question.params.message, /Bob is in your address book already/);
  mcp.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { key: bob.public } } });
  assert.equal((await mcp.next(reply(1))).result.structuredContent.added, true);
  assert.deepEqual(runtime.partnerList().map((p) => [p.name, p.key]), [["Bob", bob.public]]);
  mcp.end();
  await mcp.served;
});
