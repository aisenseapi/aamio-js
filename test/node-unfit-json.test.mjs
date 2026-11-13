// A message no reader can hold, and arguments no tool can take (a security review of 13 November 2026). A body is
// read as JSON only when every number in it is finite and it is nested at most 64 deep, as in aamio-python and
// aamio-php, and anything else is handed over as text. A body nested 5 000 deep made every read of its thread throw,
// and what the other channels had handed over in the same read, their cursors saved, was lost. A channel whose read
// throws is said in attention, and the other channels still come back. Over MCP, arguments holding such a number or
// nesting are refused before any tool runs; on the command line --data and --gate are refused before the home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { BODY_MAX_DEPTH, NodeRuntime, unfitJson } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const nested = (n) => "[".repeat(n) + "1" + "]".repeat(n);

/** Two homes that are each other's partners, each with its inbox open: owner in a, guest in b. */
async function pair(t, fake) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-unfit-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async (name) => {
    await initIdentity(join(root, name));
    const runtime = await NodeRuntime.open({ home: join(root, name), host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  const owner = await open("a");
  const guest = await open("b");
  await owner.partnerAdd("guest", guest.keys.public);
  await guest.partnerAdd("owner", owner.keys.public);
  await owner.read();
  await guest.read();
  return { owner, guest };
}

/** The bytes as they are, signed by the sender, to the address: what any writer the channel admits can send. */
async function write(fake, sender, w, body) {
  const answer = await fake.fetch(`${HOST}/${w}`, { method: "POST", body, headers: { "X-Key": sender.keys.public, "X-Sig": sender.keys.sign(threadSigningInput(w, body)) } });
  assert.equal(answer.status, 201);
}

/** A strict reader: JSON.parse, and nothing that stringify turned into null. */
function strict(value) {
  const text = JSON.stringify(value);
  JSON.parse(text);
  return text;
}

test("what no reader can hold is the first thing unfitJson names, and 64 deep is still JSON", () => {
  assert.equal(unfitJson(JSON.parse(nested(BODY_MAX_DEPTH))), null);
  assert.deepEqual(unfitJson(JSON.parse(nested(BODY_MAX_DEPTH + 1)))[1], "too deep");
  assert.deepEqual(unfitJson(JSON.parse('{"a": 1, "b": {"c": 1e999}}')), ["b.c", "not finite"]);
  assert.deepEqual(unfitJson(JSON.parse("1" + "0".repeat(400))), ["", "not finite"]);
  assert.equal(unfitJson({ text: "hi", data: { 0: [1, 2.5] } }), null);
});

for (const [label, poison] of [["a number that is not finite", '{"text":"x","data":{"n":1e999}}'], ["nesting 5 000 deep", '{"text":"x","data":' + nested(5000) + "}"]]) {
  test(`${label} between two ordinary messages is handed over as text, and both ordinary ones arrive`, async (t) => {
    const fake = new FakeAamio();
    const { owner, guest } = await pair(t, fake);
    const inbox = owner.channel("inbox").w;
    await write(fake, guest, inbox, JSON.stringify({ text: "before" }));
    await write(fake, guest, inbox, poison);
    await write(fake, guest, inbox, JSON.stringify({ text: "after" }));
    const sealed = guest.keys.seal(owner.keys.public, poison);
    await write(fake, guest, inbox, sealed);
    const read = await owner.read();
    strict(read);
    assert.deepEqual(read.map((m) => [m.format, typeof m.body.text === "string" ? m.body.text.slice(0, 12) : m.body.text]),
      [["json", "before"], ["text", poison.slice(0, 12)], ["json", "after"], ["text", poison.slice(0, 12)]]);
    assert.ok(read.every((m) => m.verified === true && m.sender === "guest"));
    assert.deepEqual(await owner.read(), [], "and the cursor is past all four");
  });
}

test("a channel whose read throws is said, and the channels before it still hand over what they read", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest } = await pair(t, fake);
  const side = await owner.channelOpen("side", { ttl: 600, allow: ["guest"] });
  await write(fake, guest, owner.channel("inbox").w, JSON.stringify({ text: "on the inbox" }));
  await write(fake, guest, side.w, JSON.stringify({ text: "on the side" }));
  const real = owner.poll.bind(owner);
  owner.poll = async (channel, ...rest) => {
    if (channel.label === "side") throw new RangeError("the test made this channel fail");
    return real(channel, ...rest);
  };
  const read = await owner.read();
  assert.deepEqual(read.map((m) => m.body.text), ["on the inbox"], "the inbox's message comes back: its cursor had moved");
  const told = await owner.attentionTaken();
  assert.ok(told.some((note) => note.channel === "side" && note.state === "unread" && note.what.includes("RangeError")), JSON.stringify(told));
  owner.poll = real;
  assert.deepEqual((await owner.read()).map((m) => m.body.text), ["on the side"], "and the side's message waits for the next read");
});

// A channel that threw halfway through its messages kept the hashes of the ones
// it had taken before it threw, the next channel's save wrote them down, and the
// next read handed those messages over marked replay, never having handed them
// over at all (the release check of 13 November 2026).
test("a channel that throws on its second message keeps none of what it took, so the next read hands both over as new", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest } = await pair(t, fake);
  const side = await owner.channelOpen("side", { ttl: 600, allow: ["guest"] });
  await write(fake, guest, side.w, JSON.stringify({ text: "first on the side" }));
  await write(fake, guest, side.w, JSON.stringify({ text: "second on the side" }));
  const real = owner.readEntry.bind(owner);
  owner.readEntry = (channel, raw) => {
    if (channel.label === "side" && raw?.seq === 2) throw new RangeError("the test made the second message fail");
    return real(channel, raw);
  };
  assert.deepEqual(await owner.read(), [], "nothing from the side is handed over");
  const told = await owner.attentionTaken();
  assert.ok(told.some((note) => note.channel === "side" && note.state === "unread"), JSON.stringify(told));
  owner.readEntry = real;
  // The inbox is read first and written down, with whatever the side holds in memory.
  const again = await owner.read();
  assert.deepEqual(again.map((m) => [m.body.text, m.replay]), [["first on the side", false], ["second on the side", false]], "neither is marked a copy: neither was handed over before");
});

function cli(home, ...words) {
  return spawnSync(process.execPath, [bin, "--home", home, "--host", "http://127.0.0.1:9", ...words], { encoding: "utf8", env: { ...process.env, AAMIO_BOARD: "http://127.0.0.1:9" }, timeout: 60000 });
}

test("on the command line --data and --gate that no reader can hold are refused before the home, with 2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-unfit-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [words, said] of [
    [["send", "bob", "hi", "--data", '{"n":1e999}'], "--data holds a number that is not finite"],
    [["send", "bob", "hi", "--data", nested(BODY_MAX_DEPTH)], "--data is nested too deep"],
    [["board", "answer", "post", "hi", "--data", "[1e999]"], "--data holds a number that is not finite"],
    [["channel", "open", "room", "--gate", '{"require":{"pow":{"bits":1e999}}}'], "--gate holds a number that is not finite"],
  ]) {
    const home = join(root, "home");
    const done = cli(home, ...words);
    assert.deepEqual([done.status, done.stdout], [2, ""], done.stderr);
    assert.ok(done.stderr.includes(said), done.stderr);
    assert.equal(existsSync(home), false);
  }
  // One level less is JSON every reader holds, with the message around it.
  const home = join(root, "fine");
  const done = cli(home, "send", "bob", "hi", "--data", nested(BODY_MAX_DEPTH - 1));
  assert.notEqual(done.status, 2, done.stderr);
});

test("over MCP, arguments no reader can hold are refused before any tool runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-unfit-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
  ].map((m) => JSON.stringify(m));
  lines.push('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"aamio_send","arguments":{"to":"nobody","text":"x","data":{"n":1e999}}}}');
  lines.push('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"aamio_send","arguments":{"to":"nobody","text":"x","data":' + nested(BODY_MAX_DEPTH) + "}}}");
  lines.push('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"aamio_addon_hello_wave","arguments":{"to":1e999}}}');
  const done = spawnSync(process.execPath, [bin, "--home", join(root, "home"), "--host", "http://127.0.0.1:9", "serve"], { input: lines.join("\n") + "\n", encoding: "utf8", env: { ...process.env, AAMIO_BOARD: "http://127.0.0.1:9" }, timeout: 60000 });
  const answers = done.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const told = (id) => answers.find((a) => a.id === id)?.result?.structuredContent ?? {};
  assert.deepEqual([told(2).error_code, told(2).error], ["invalid_arguments", "data.n is a number that is not finite, as 1e999 is: JSON can write it, and nothing that reads it can hold it"]);
  assert.equal(told(3).error_code, "invalid_arguments");
  assert.ok(told(3).error.endsWith("is nested deeper than 64: a reader hands a message nested that deep over as text"), told(3).error);
  assert.deepEqual([told(4).error_code, told(4).error.startsWith("to is a number that is not finite")], ["invalid_arguments", true], "an add-on's tool too, before it is looked for");
});
