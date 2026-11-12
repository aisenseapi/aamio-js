// The tools of the add-ons enabled in a home, over the local MCP server: listed beside the core's when the server
// starts, called through the add-on's own process, and with the core between the model and what an add-on may be
// given: the key behind a name, and the user's own word for a website, asked in a form of their app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { keyHash } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { RUNTIME_TOOL_NAMES, serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { enable, hostsFile, loaded } from "../src/node-addons.js";
import { probe } from "../src/node-addon-process.js";
import { FakeAamio } from "./fake-aamio.mjs";
import { install, manifestFor, ran } from "./addon-fixture.mjs";

const HOST = "https://fake.aamio";
const MODERN = "2026-07-28";
const VERSION = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const core = { coreTools: RUNTIME_TOOL_NAMES };

// Homes on one fake service, each with its identity before anything is installed in it, and closed before the
// folder goes: a held owner.lock cannot be removed on Windows.
async function world(t) {
  const fake = new FakeAamio();
  const root = await mkdtemp(join(tmpdir(), "aamio-node-addons-mcp-"));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    fake,
    home: async (name) => {
      const home = join(root, name);
      await initIdentity(home);
      return home;
    },
    open: async (home) => {
      const runtime = await NodeRuntime.open({ home, host: HOST, fetch: fake.fetch, clock: () => fake.time });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

// The client end of the server's stdio: what it sends, and every message the server writes, each taken once.
function connect(runtime, addons) {
  const input = new PassThrough();
  const output = new PassThrough();
  const said = [];
  const taken = new Set();
  const lines = new EventEmitter();
  let rest = "";
  let ids = 0;
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
  const served = serveMcp({ home: runtime.home, version: "test", runtime, addons, input, output });
  const client = {
    served,
    send: (message) => input.write(JSON.stringify(message) + "\n"),
    async end() {
      input.end();
      await served;
    },
    async next(match, ms = 15000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const index = said.findIndex((message, at) => !taken.has(at) && match(message));
        if (index >= 0) {
          taken.add(index);
          return said[index];
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`the server did not say it: ${JSON.stringify(said).slice(0, 2000)}`);
        const stop = new AbortController();
        try {
          await Promise.race([once(lines, "line", { signal: stop.signal }), sleep(left, null, { signal: stop.signal })]);
        } finally {
          stop.abort();
        }
      }
    },
    /** One request and its answer. */
    async ask(method, params = {}) {
      const id = ++ids;
      client.send({ jsonrpc: "2.0", id, method, params });
      return client.next((message) => message.id === id && message.method === undefined);
    },
    /** One tool call, started: the id to wait for. */
    start(name, args, extra = {}) {
      const id = ++ids;
      client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...extra } });
      return id;
    },
    /** One tool call and what it answered. */
    async call(name, args, extra = {}) {
      const id = client.start(name, args, extra);
      return (await client.next((message) => message.id === id && message.method === undefined)).result;
    },
  };
  return client;
}

test("the server offers the tools of the add-ons enabled in its home, and calls them through the process", async (t) => {
  const { home, open } = await world(t);
  const mine = await home("mine");
  const other = await home("other");
  const { ran: marker } = await install(mine, { manifest: manifestFor("demo2", { deadline: 1 }) });
  // The same package in another home, where nobody enabled it.
  await install(other, { manifest: manifestFor("demo2", { deadline: 1 }) });
  await enable(mine, "demo2", { ...core, probe });
  const runtime = await open(mine);
  const client = connect(runtime, await loaded(mine, core));
  await client.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

  const tools = (await client.ask("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [...RUNTIME_TOOL_NAMES, "aamio_addon_demo2_ping", "aamio_addon_demo2_check", "aamio_addon_demo2_sleep", "aamio_addon_demo2_bytes"]);
  assert.equal(RUNTIME_TOOL_NAMES.length, 24);
  const ping = tools.find((tool) => tool.name === "aamio_addon_demo2_ping");
  assert.deepEqual(ping, { name: "aamio_addon_demo2_ping", description: "answers pong", inputSchema: { type: "object", properties: { word: { type: "string" } }, additionalProperties: false } }, "the tool as its manifest has it, with nothing added");
  assert.deepEqual(await ran(marker), ["probe probe"], "listing ran nothing");

  const pong = await client.call("aamio_addon_demo2_ping", { word: "hei" });
  assert.equal(pong.isError, false);
  assert.deepEqual([pong.structuredContent.kind, pong.structuredContent.name, pong.structuredContent.arguments, pong.structuredContent.state_dir, pong.structuredContent.own_key],
    ["tool", "aamio_addon_demo2_ping", { word: "hei" }, join(mine, "addons", "demo2"), null]);
  assert.deepEqual(JSON.parse(pong.content[0].text), pong.structuredContent);
  // What the tool does not take is refused in the answer, with where a key comes from, before anything runs.
  const before = (await ran(marker)).length;
  const extra = await client.call("aamio_addon_demo2_ping", { word: "hei", key: "x".repeat(43) });
  assert.equal(extra.isError, true);
  assert.deepEqual([extra.structuredContent.given, extra.structuredContent.error], [["key"], "aamio_addon_demo2_ping takes word, and was given key"]);
  assert.equal((await ran(marker)).length, before);
  const bytes = await client.call("aamio_addon_demo2_bytes", {});
  assert.deepEqual([bytes.isError, bytes.structuredContent], [false, { raw_base64: Buffer.from("raw\n").toString("base64") }]);
  const wrong = await client.ask("tools/call", { name: "aamio_addon_demo2_ping", arguments: ["hei"] });
  assert.deepEqual([wrong.error.code, wrong.error.message], [-32602, "arguments must be an object"]);

  // The acceptance test of contract 2: a process that never answers is stopped at its deadline, the call says so,
  // and the server answers the core's own tools straight after.
  const started = Date.now();
  const slept = await client.call("aamio_addon_demo2_sleep", {});
  assert.ok(Date.now() - started < 6000);
  assert.deepEqual([slept.isError, slept.structuredContent.status, slept.structuredContent.reason, slept.structuredContent.addon], [true, "unreachable", "addon_timeout", "demo2"]);
  const who = await client.call("aamio_whoami", {});
  assert.deepEqual([who.isError, who.structuredContent.key], [false, runtime.keys.public]);
  assert.equal((await client.call("aamio_addon_demo2_ping", {})).structuredContent.pong, true);
  await client.end();

  // The choice is the home's: a server on a home where the same package is installed and not enabled has the core's tools alone.
  const elsewhere = connect(await open(other), await loaded(other, core));
  await elsewhere.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.deepEqual((await elsewhere.ask("tools/list")).result.tools.map((tool) => tool.name), RUNTIME_TOOL_NAMES);
  const unknown = await elsewhere.ask("tools/call", { name: "aamio_addon_demo2_ping", arguments: {} });
  assert.deepEqual([unknown.error.code, unknown.error.message], [-32602, "Unknown tool"]);
  await elsewhere.end();
});

test("over MCP the user is asked which website they expect, and what they type has to match", async (t) => {
  const { home, open } = await world(t);
  const mine = await home("mine");
  const { ran: marker } = await install(mine);
  await enable(mine, "demo2", { ...core, probe });
  const runtime = await open(mine);
  const partner = "k".repeat(42) + "A";
  await runtime.partnerAdd("bob", partner);
  const addons = await loaded(mine, core);
  const hosts = async () => JSON.parse(await readFile(hostsFile(mine, addons[0]), "utf8").catch(() => "[]"));
  const check = { site: "Firma.example", partner: "bob" };

  // An app that cannot show a form: nothing is read, and the way by hand is said.
  const mute = connect(runtime, addons);
  await mute.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const refused = await mute.call("aamio_addon_demo2_check", check);
  assert.deepEqual([refused.isError, refused.structuredContent.status, refused.structuredContent.reason, refused.structuredContent.host, refused.structuredContent.partner], [true, "invalid", "host_not_allowed", "firma.example", "bob"]);
  assert.match(refused.structuredContent.fix, /this app did not say it can show them a form \(the elicitation capability of MCP\), so nothing was read\. The user adds it from their own records: stop this server, run aamio addon demo2 allow firma\.example, and start it again\./);
  assert.equal(refused.structuredContent.key, undefined, "the key is the core's to give the add-on, and is not in the refusal");
  // One subject, and one only; a name that is nobody's; a website that is none.
  assert.equal((await mute.call("aamio_addon_demo2_check", { site: "firma.example" })).structuredContent.reason, "choose_subject");
  assert.equal((await mute.call("aamio_addon_demo2_check", { site: "firma.example", partner: "bob", message: "a".repeat(64) })).structuredContent.reason, "choose_subject");
  assert.equal((await mute.call("aamio_addon_demo2_check", { site: "firma.example", partner: "nobody" })).structuredContent.reason, "partner_unavailable");
  assert.equal((await mute.call("aamio_addon_demo2_check", { site: "https://firma.example", partner: "bob" })).structuredContent.reason, "invalid_host");
  assert.equal((await mute.call("aamio_addon_demo2_check", { site: "firma.example", message: "not-a-hash" })).structuredContent.reason, "invalid_message_hash");
  assert.equal((await mute.call("aamio_addon_demo2_check", { site: "firma.example", message: "a".repeat(64) })).structuredContent.reason, "source_unavailable");
  assert.deepEqual([await ran(marker), await hosts()], [["probe probe"], []], "none of it started the process or changed the list");
  await mute.end();

  // An app that can: the question is a request of its own while the call waits.
  const client = connect(runtime, addons);
  await client.ask("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } });
  const answerWith = async (result) => {
    const id = client.start("aamio_addon_demo2_check", check);
    const question = await client.next((message) => message.method === "elicitation/create");
    client.send({ jsonrpc: "2.0", id: question.id, result });
    return [question, (await client.next((message) => message.id === id && message.method === undefined)).result];
  };
  const [question, mistyped] = await answerWith({ action: "accept", content: { domain: "f1rma.example" } });
  assert.match(question.params.message, /^Your agent asks to read a website, through the add-on demo2, about your partner bob\. Which website do you expect\? Type the domain from your own records/);
  assert.equal(/firma/i.test(JSON.stringify(question.params)), false, "the website the agent asked for is not in the form: the user types it from their own records");
  assert.deepEqual(question.params.requestedSchema.required, ["domain"]);
  assert.deepEqual([mistyped.isError, mistyped.structuredContent.reason], [true, "host_not_confirmed"]);
  const [, declined] = await answerWith({ action: "decline" });
  assert.deepEqual([declined.isError, declined.structuredContent], [false, { status: "invalid", reason: "host_declined", host: "firma.example", note: "The user did not agree to this website, so nothing was read and nothing was added. Do not ask again unless the user says so." }]);
  const [, closed] = await answerWith({ action: "cancel" });
  assert.equal(closed.structuredContent.reason, "host_not_answered");
  assert.deepEqual([await ran(marker), await hosts()], [["probe probe"], []], "nothing was read and nothing was added");

  const [, read] = await answerWith({ action: "accept", content: { domain: "FIRMA.example" } });
  assert.equal(read.isError, false);
  assert.deepEqual(read.structuredContent.arguments, { site: "firma.example", partner: "bob" });
  assert.deepEqual(read.structuredContent.subject, { key: partner, subject_source: "partner", partner: "bob", signature_checked_locally: null });
  assert.equal(read.structuredContent.own_key, runtime.keys.public, "the runtime's public key, which the tool's manifest asks for");
  assert.deepEqual(await hosts(), ["firma.example"], "a match stays on the list");
  // And is not asked about again.
  const again = await client.call("aamio_addon_demo2_check", check);
  assert.equal(again.structuredContent.pong, true);
  await client.end();

  // Over 2026-07-28 the question is the call's result, and the answer comes with the call made again.
  const modern = connect(runtime, addons);
  const meta = { _meta: { [VERSION]: MODERN, [CAPABILITIES]: { elicitation: {} } } };
  const other = { site: "other.example", partner: "bob" };
  const asked = await modern.call("aamio_addon_demo2_check", other, meta);
  assert.equal(asked.resultType, "input_required");
  assert.deepEqual(Object.keys(asked.inputRequests), ["aamio_addon_host"]);
  assert.equal(asked.inputRequests.aamio_addon_host.method, "elicitation/create");
  assert.equal(asked.inputRequests.aamio_addon_host.params.mode, "form");
  assert.equal(/other\.example/.test(JSON.stringify(asked.inputRequests)), false);
  const accept = { inputResponses: { aamio_addon_host: { action: "accept", content: { domain: "other.example" } } } };
  // An answer carried over to another website belongs to no question this server asked about it.
  const carried = await modern.call("aamio_addon_demo2_check", { site: "third.example", partner: "bob" }, { ...meta, ...accept, requestState: asked.requestState });
  assert.deepEqual([carried.isError, carried.structuredContent.reason], [true, "host_not_allowed"]);
  assert.match(carried.structuredContent.fix, /the answer did not come with a question this server asked, in the last 15 minutes, about .*, so nothing was read\. Call aamio_addon_demo2_check again to ask the user again/);
  assert.deepEqual(await hosts(), ["firma.example"]);
  const fresh = await modern.call("aamio_addon_demo2_check", other, meta);
  const done = await modern.call("aamio_addon_demo2_check", other, { ...meta, ...accept, requestState: fresh.requestState });
  assert.deepEqual([done.resultType, done.isError, done.structuredContent.arguments.site], ["complete", false, "other.example"]);
  assert.deepEqual(await hosts(), ["firma.example", "other.example"]);
  // A state that was used is used up.
  const twice = await modern.call("aamio_addon_demo2_check", { site: "fourth.example", partner: "bob" }, { ...meta, inputResponses: { aamio_addon_host: { action: "accept", content: { domain: "fourth.example" } } }, requestState: fresh.requestState });
  assert.equal(twice.structuredContent.reason, "host_not_allowed");
  await modern.end();
});

test("the key behind a message is the one this process verified, and the form names it by its hash", async (t) => {
  const { home, open } = await world(t);
  const mine = await home("mine");
  await install(mine);
  await enable(mine, "demo2", { ...core, probe });
  const receiver = await open(mine);
  const sender = await open(await home("sender"));
  await receiver.partnerAdd("sender", sender.keys.public);
  await sender.partnerAdd("receiver", receiver.keys.public);
  await receiver.read();
  await sender.send("receiver", { text: "check who I am" });
  const [message] = await receiver.read();
  assert.equal(message.verified, true);
  assert.deepEqual(receiver.verifiedSigners(message.sha256), [sender.keys.public]);
  assert.deepEqual(receiver.verifiedSigners("0".repeat(64)), []);

  const client = connect(receiver, await loaded(mine, core));
  await client.ask("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } });
  const id = client.start("aamio_addon_demo2_check", { site: "example.org", message: message.sha256 });
  const question = await client.next((said) => said.method === "elicitation/create");
  assert.match(question.params.message, new RegExp(`about the key that signed a message \\(hash ${keyHash(sender.keys.public).slice(0, 8)}\\)\\.`));
  assert.equal(question.params.message.includes("check who I am"), false, "nothing a message wrote is in the form");
  client.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { domain: "example.org" } } });
  const answer = (await client.next((said) => said.id === id && said.method === undefined)).result;
  assert.deepEqual(answer.structuredContent.subject, { key: sender.keys.public, subject_source: "message", message_sha256: message.sha256, signature_checked_locally: true });
  assert.deepEqual(answer.structuredContent.arguments, { site: "example.org", message: message.sha256 });
  await client.end();
});
