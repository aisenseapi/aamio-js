// A readable message to an inbox whose owner holds no key, and the secrets that never go in one unasked.
//
// On 19 November 2026 a scope's key went to an agent that had only the hosted endpoint, in a message that was signed
// and not sealed. The runtime refused the address, since no key was known for it, so the message was written around
// the runtime, and nothing asked anyone. Now the runtime writes to such an address when told readable, says how the
// inbox was opened, and stops a readable message that carries a scope key, a read key or the home's private key,
// unless the user says yes: --allow-secret on the command line, a dialog over MCP. The same checks as aamio-python's
// tests/test_readable_to_open_channel.py and aamio-php's tests/readable.inc.php.
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
import { SECRET_QUESTION, serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const ADDRESS = "abcdefghijklmnopqrst";
const MODERN = "2026-07-28";

// A home in a folder of its own, closed before the folder goes: a held owner.lock cannot be removed on Windows.
async function writer(t, { hosted = false } = {}) {
  const fake = new FakeAamio();
  if (hosted) fake.hosted.add(ADDRESS);
  const root = await mkdtemp(join(tmpdir(), "aamio-node-readable-"));
  const dir = join(root, "home");
  await initIdentity(dir);
  const runtime = await NodeRuntime.open({ home: dir, host: HOST, fetch: fake.fetch, clock: () => fake.time });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.ensureInbox();
  return { fake, runtime };
}

const posted = (fake, w = ADDRESS) => fake.threads.get(w)?.messages ?? [];

async function scopeKey(runtime, name = "team") {
  await runtime.scopeNew(name);
  return runtime.scopes.find((scope) => scope.name === name).key;
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

// ------------------------------------------------------------- the runtime --

test("a readable message goes signed and not sealed to an address without a key, and the same words twice are two messages", async (t) => {
  const { fake, runtime } = await writer(t);

  const sent = await runtime.send(ADDRESS, { text: "hei fra en lokal runtime", readable: true });

  assert.equal(sent.readable, true);
  assert.equal(sent.to, ADDRESS);
  assert.match(sent.readable_note, /the service can read it/);
  assert.equal(sent.opened_via, undefined);
  const [message] = posted(fake);
  const body = JSON.parse(message.body);
  assert.equal(body.text, "hei fra en lokal runtime");
  assert.equal(body.reply_to, runtime.channel("inbox").w);
  assert.equal(message.from, runtime.keys.public);
  assert.equal(message.sealed, false);

  const first = await runtime.send(ADDRESS, { text: "ok", readable: true });
  const second = await runtime.send(ADDRESS, { text: "ok", readable: true });
  assert.notEqual(first.message_id, second.message_id);
  assert.notEqual(first.sha256, second.sha256, "a reader would take the second for a replay of the first");
  assert.equal(posted(fake).length, 3);
});

test("without readable the address is refused, and the refusal names the way", async (t) => {
  const { fake, runtime } = await writer(t);

  const refused = await refusal(runtime.send(ADDRESS, { text: "hei" }));

  assert.equal(refused.code, "unknown_address");
  assert.match(refused.message, /--readable/);
  assert.match(refused.message, /hosted endpoint/);
  assert.equal(posted(fake).length, 0);
});

test("readable is refused where a key is known, and what is not an address is not said back", async (t) => {
  const { fake, runtime } = await writer(t);
  const bob = Keys.generate().public;
  await runtime.partnerAdd("bob", bob);
  runtime.state.peers[ADDRESS] = bob;

  for (const to of ["bob", bob, ADDRESS]) {
    const refused = await refusal(runtime.send(to, { text: "hei", readable: true }));
    assert.equal(refused?.code, "readable_with_key", to);
  }
  delete runtime.state.peers[ADDRESS];
  const key = await scopeKey(runtime);
  const notAddress = await refusal(runtime.send(key, { text: "hei", readable: true }));
  assert.equal(notAddress.code, "unknown_address");
  assert.ok(!notAddress.message.includes(key));
  assert.equal(posted(fake).length, 0);
});

test("a readable message that carries a secret of this home is not stored or sent, and the error names it without saying it", async (t) => {
  const { fake, runtime } = await writer(t);
  const key = await scopeKey(runtime);
  const inboxKey = runtime.channel("inbox").read_key;
  const seed = Buffer.from(runtime.keys.seed).toString("hex");
  const cases = [
    ["the key of a scope", { text: `the key is ${key}, keep it` }, "the key of scope team", key],
    ["the read key of the inbox", { text: `read it with ${inboxKey}` }, "the read key of your inbox", inboxKey],
    ["the private key", { text: `my seed ${seed}` }, "this home's private key", seed],
    ["a scope key in capitals", { text: `THE KEY IS ${key.toUpperCase()}` }, "the key of scope team", key],
    ["a scope key in data", { text: "see data", data: { nested: { scope_key: key } } }, "the key of scope team", key],
  ];
  for (const [what, message, named, value] of cases) {
    const before = JSON.stringify(Object.keys(runtime.outbox));
    const stopped = await refusal(runtime.send(ADDRESS, { ...message, readable: true }));
    assert.equal(stopped?.code, "secret_in_readable", what);
    assert.ok(stopped.found.includes(named), what);
    assert.equal(stopped.w, ADDRESS);
    assert.equal(stopped.hosted, false);
    assert.ok(!stopped.message.toLowerCase().includes(value.toLowerCase()), `${what}: named, never said`);
    assert.match(stopped.message, /Nothing was stored or sent/);
    assert.match(stopped.message, /--allow-secret/);
    assert.equal(JSON.stringify(Object.keys(runtime.outbox)), before, what);
    assert.equal(posted(fake).length, 0, what);
  }

  const sent = await runtime.send(ADDRESS, { text: `the key is ${key}`, readable: true, allowSecret: true });
  assert.equal(sent.readable, true);
  assert.ok(posted(fake)[0].body.includes(key));
});

test("an inbox opened through the hosted endpoint is named in the stop and in the answer", async (t) => {
  const { fake, runtime } = await writer(t, { hosted: true });
  const key = await scopeKey(runtime);

  const stopped = await refusal(runtime.send(ADDRESS, { text: key, readable: true }));
  assert.equal(stopped.hosted, true);
  assert.match(stopped.message, /hosted endpoint/);
  assert.equal(runtime.openedVia(ADDRESS), "hosted");

  const sent = await runtime.send(ADDRESS, { text: "hei", readable: true });
  assert.equal(sent.opened_via, "hosted");
  assert.match(sent.readable_note, /send no secret there/);
  assert.equal(posted(fake).length, 1);
});

test("the service's answer says hosted when the gate read before did not", async (t) => {
  const { fake, runtime } = await writer(t);

  await runtime.send(ADDRESS, { text: "hei", readable: true });
  fake.hosted.add(ADDRESS);
  const sent = await runtime.send(ADDRESS, { text: "hei igjen", readable: true });

  assert.equal(sent.opened_via, "hosted");
});

test("a sealed message to an address whose key is known is not looked through, and the flags are true or false", async (t) => {
  const { fake, runtime } = await writer(t);
  const other = Keys.generate().public;
  const key = await scopeKey(runtime);
  runtime.state.peers[ADDRESS] = other;

  const sent = await runtime.send(ADDRESS, { text: `the key is ${key}` });
  assert.equal(sent.readable, undefined);
  assert.equal(posted(fake)[0].sealed, true);

  for (const given of [{ readable: "yes" }, { readable: true, allowSecret: 1 }]) {
    assert.equal((await refusal(runtime.send(ADDRESS, { text: "hei", ...given })))?.code, "invalid_arguments");
  }
});

// ------------------------------------------------------------------- MCP --

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
  };
}

const reply = (id) => (message) => message.id === id && message.method === undefined;
const asking = (message) => message.method === "elicitation/create";
const initialize = (version, capabilities = {}) => ({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: version, capabilities, clientInfo: { name: "test", version: "0" } } });
const call = (id, args, params = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "aamio_send", arguments: args, ...params } });
const modern = (extra = {}, capabilities = { elicitation: {} }) => ({ _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": capabilities }, ...extra });

test("over MCP a secret in a readable message is put to the user while the call waits, and sent only on yes", async (t) => {
  const { fake, runtime } = await writer(t, { hosted: true });
  const key = await scopeKey(runtime);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", { elicitation: {} }));
  await mcp.next(reply(0));
  const args = { to: ADDRESS, text: `the key is ${key}`, readable: true };

  mcp.send(call(1, args));
  const question = await mcp.next(asking);
  assert.match(question.params.message, /the key of scope team/);
  assert.match(question.params.message, /hosted endpoint/);
  assert.ok(!JSON.stringify(question).includes(key), "the question names the secret, never says it");
  assert.deepEqual(question.params.requestedSchema.required, ["send"]);
  mcp.send({ jsonrpc: "2.0", id: question.id, result: { action: "decline" } });
  const no = (await mcp.next(reply(1))).result;
  assert.equal(no.isError, false);
  assert.equal(no.structuredContent.sent, false);
  assert.equal(no.structuredContent.action, "decline");
  assert.equal(posted(fake).length, 0);

  mcp.send(call(2, args));
  const unticked = await mcp.next(asking);
  mcp.send({ jsonrpc: "2.0", id: unticked.id, result: { action: "accept", content: { send: false } } });
  assert.equal((await mcp.next(reply(2))).result.structuredContent.sent, false);
  assert.equal(posted(fake).length, 0);

  mcp.send(call(3, args));
  const yes = await mcp.next(asking);
  mcp.send({ jsonrpc: "2.0", id: yes.id, result: { action: "accept", content: { send: true } } });
  const sent = (await mcp.next(reply(3))).result;
  assert.equal(sent.isError, false, JSON.stringify(sent));
  assert.equal(sent.structuredContent.readable, true);
  assert.equal(posted(fake).length, 1);
  assert.ok(posted(fake)[0].body.includes(key));

  mcp.send(call(4, { ...args, allow_secret: true }));
  assert.equal((await mcp.next(reply(4))).result.structuredContent.error_code, "invalid_arguments", "the model cannot say yes for the user");
  mcp.send(call(5, { to: ADDRESS, text: "hei", readable: "yes" }));
  assert.equal((await mcp.next(reply(5))).result.structuredContent.error_code, "invalid_arguments");
  mcp.send(call(6, { to: ADDRESS, text: "hei", readable: true }));
  assert.equal((await mcp.next(reply(6))).result.structuredContent.readable, true, "no secret, no question");
  assert.equal(posted(fake).length, 2);
  mcp.end();
  await mcp.served;
});

test("over MCP without a dialog nothing is sent and the way is said", async (t) => {
  const { fake, runtime } = await writer(t);
  const key = await scopeKey(runtime);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", {}));
  await mcp.next(reply(0));

  mcp.send(call(1, { to: ADDRESS, text: key, readable: true }));
  const result = (await mcp.next(reply(1))).result;

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, "secret_in_readable");
  assert.equal(result.structuredContent.sent, false);
  assert.deepEqual(result.structuredContent.carries, ["the key of scope team"]);
  assert.match(result.structuredContent.fix, /--allow-secret/);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(posted(fake).length, 0);
  mcp.end();
  await mcp.served;
});

test("over 2026-07-28 the question is the result, and the yes belongs to that message and no other", async (t) => {
  const { fake, runtime } = await writer(t);
  const key = await scopeKey(runtime);
  const mcp = connect(runtime);
  const args = { to: ADDRESS, text: `the key is ${key}`, readable: true };

  mcp.send(call(1, args, modern()));
  const first = (await mcp.next(reply(1))).result;
  assert.equal(first.resultType, "input_required");
  assert.equal(first.inputRequests[SECRET_QUESTION].method, "elicitation/create");
  assert.ok(!JSON.stringify(first).includes(key));
  assert.equal(posted(fake).length, 0);

  const yes = { [SECRET_QUESTION]: { action: "accept", content: { send: true } } };
  mcp.send(call(2, { ...args, text: `another text with ${key}` }, modern({ requestState: first.requestState, inputResponses: yes })));
  assert.equal((await mcp.next(reply(2))).result.structuredContent.sent, false);
  assert.equal(posted(fake).length, 0);

  mcp.send(call(3, args, modern({ requestState: first.requestState, inputResponses: yes })));
  const sent = (await mcp.next(reply(3))).result;
  assert.equal(sent.structuredContent.readable, true, JSON.stringify(sent));
  assert.equal(posted(fake).length, 1);
  mcp.end();
  await mcp.served;
});

test("aamio_send says readable and takes it, and takes no allow_secret", async (t) => {
  const { runtime } = await writer(t);
  const mcp = connect(runtime);
  mcp.send(initialize("2025-06-18", {}));
  await mcp.next(reply(0));
  mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tools = (await mcp.next(reply(1))).result.tools;
  const send = tools.find((tool) => tool.name === "aamio_send");
  assert.equal(send.inputSchema.properties.readable.type, "boolean");
  assert.equal(send.inputSchema.properties.allow_secret, undefined);
  assert.match(send.description, /readable/);
  assert.match(send.description, /dialog/);
  mcp.end();
  await mcp.served;
});
