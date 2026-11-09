// The release check of 0.6.0 of 9 November (code/php/docs/aamio-node-utveksling-gjennomgang-2026-11-09.md,
// "Utgivelseskontroll av Node 0.6.0"): a partner change that counts only once it is written down, the way by hand
// that names this server's home, the first inbox said as it is, an address from the board, and arguments checked
// before a home is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Keys } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const ENOSPC = () => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-release-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const made = { root };
  for (const name of names) {
    made[name] = join(root, name);
    await mkdir(join(made[name], ".."), { recursive: true });
    await initIdentity(made[name]);
  }
  const open = async (home) => {
    const runtime = await NodeRuntime.open({ home, host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  return { ...made, open };
}

/** Saves of this file fail before the rename, while the test says so. */
function failSaving(runtime, file) {
  const real = runtime.saveJson.bind(runtime);
  const control = { failing: true };
  runtime.saveJson = async (name, value) => {
    if (name === file && control.failing) throw ENOSPC();
    return real(name, value);
  };
  return control;
}

/** One MCP session against a runtime: initialize with the dialog, aamio_partner_add answered with key, then aamio_partners. */
async function addOverMcp(runtime, name, key) {
  const input = new PassThrough();
  const output = new PassThrough();
  const said = [];
  let rest = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    rest += chunk;
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      said.push(message);
      // The user answers the dialog with the key.
      if (message.method === "elicitation/create") input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { key } } }) + "\n");
      if (message.id === 1 && message.method === undefined) {
        input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aamio_partners", arguments: {} } }) + "\n");
      }
      if (message.id === 2 && message.method === undefined) input.end();
    }
  });
  const served = serveMcp({ home: runtime.home, version: "test", runtime, input, output });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "test", version: "0" } } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aamio_partner_add", arguments: { name } } }) + "\n");
  await served;
  const answer = (id) => said.find((m) => m.id === id && m.method === undefined)?.result;
  return { added: answer(1), partners: answer(2)?.structuredContent?.partners };
}

const book = async (home) => JSON.parse(await readFile(join(home, "partners.json"), "utf8"));

test("P1: a partner change the address book could not take is not added, in this server or after a restart", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  let a = await open(homeA);
  const first = Keys.generate();
  const second = Keys.generate();
  const third = Keys.generate();
  await a.partnerAdd("bob", first.public);
  await a.read();
  const allow = [...a.channel("inbox").allow];

  // A new key for bob, and a new partner, both approved in the dialog, while partners.json cannot be written.
  const disk = failSaving(a, "partners.json");
  for (const [name, key] of [["bob", second.public], ["carol", third.public]]) {
    const { added, partners } = await addOverMcp(a, name, key);
    assert.equal(added.isError, true);
    assert.equal(added.structuredContent.added, false, `${name}: not added`);
    assert.equal(added.structuredContent.error_code, "ENOSPC");
    assert.deepEqual(partners.map((p) => [p.name, p.key]), [["bob", first.public]], `${name}: this server still has the book the file has`);
  }
  disk.failing = false;
  await a.read();
  assert.deepEqual(a.channel("inbox").allow, allow, "the next read keeps the inbox's list: no key the book does not hold can write");
  await a.close();
  a = await open(homeA);
  assert.deepEqual(a.partnerList().map((p) => [p.name, p.key]), [["bob", first.public]], "and a restart finds the same book");
});

test("P1: a partner written down is added, also when the inbox could not be opened again for them", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  let a = await open(homeA);
  const bob = Keys.generate();
  const carol = Keys.generate();
  await a.partnerAdd("bob", bob.public);
  await a.read();
  failSaving(a, "state.json");
  const { added, partners } = await addOverMcp(a, "carol", carol.public);
  assert.equal(added.structuredContent.added, true);
  assert.equal(added.structuredContent.rotated, false);
  assert.match(added.structuredContent.error, /could not be written down/);
  assert.deepEqual(partners.map((p) => p.name), ["bob", "carol"]);
  assert.deepEqual((await book(homeA)).map((p) => p.name), ["bob", "carol"], "the book holds the change");
  await a.close();
  a = await open(homeA);
  assert.deepEqual(a.partnerList().map((p) => p.name), ["bob", "carol"]);
  await a.read();
  assert.deepEqual([...a.channel("inbox").allow].sort(), [bob.public, carol.public].sort(), "and the next read opens the inbox for both");
});

test("the way by hand names this server's home, quoted, and following it changes that home and no other", async (t) => {
  const fake = new FakeAamio();
  const { root, open } = await fixture(t, fake);
  const served = join(root, "a home with spaces", "aamio");
  const other = join(root, "the default home");
  await mkdir(join(served, ".."), { recursive: true });
  await initIdentity(served);
  await initIdentity(other);
  const a = await open(served);
  const carol = Keys.generate();
  await a.partnerAdd("carol", carol.public);

  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const done = serveMcp({ home: a.home, version: "test", runtime: a, input, output });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aamio_partner_add", arguments: { name: "bob" } } }) + "\n");
  await done;
  const fix = text.trim().split("\n").map((line) => JSON.parse(line)).find((m) => m.id === 1).result.structuredContent.fix;
  assert.match(fix, /npx aamio --home "[^"]+" partner add bob KEY/);
  const named = fix.match(/--home "([^"]+)"/)[1];
  assert.equal(named, a.home, "the home this server holds, in double quotes since the path has spaces");
  await a.close();

  // Followed as written, with AAMIO_HOME pointing elsewhere: the change lands in the named home only.
  const bob = Keys.generate();
  const ran = spawnSync(process.execPath, [bin, "--home", named, "partner", "add", "bob", bob.public], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOME: other, AAMIO_HOST: "http://127.0.0.1:9" } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual((await book(served)).map((p) => p.name), ["carol", "bob"]);
  assert.equal(existsSync(join(other, "partners.json")), false, "and nothing in the other home");
});

test("a key held under another name: the way to rename is partner add with that same key, in this server's home", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  const a = await open(homeA);
  const carol = Keys.generate();
  await a.partnerAdd("carol", carol.public);
  const { added } = await addOverMcp(a, "caroline", carol.public);
  assert.equal(added.structuredContent.added, false);
  assert.ok(added.structuredContent.fix.includes(`npx aamio --home ${a.home} partner add caroline with that same key`), added.structuredContent.fix);
  assert.doesNotMatch(added.structuredContent.fix, /removes/, "no command the CLI does not have");
  // What it says works: the entry with the key gets the new name.
  await a.partnerAdd("caroline", carol.public);
  assert.deepEqual(a.partnerList().map((p) => [p.name, p.key]), [["caroline", carol.public]]);
});

test("the first inbox is open before there are partners, said as such when the first partner is added, and read until it expires", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, s: homeS, open } = await fixture(t, fake, "a", "s");
  const a = await open(homeA);
  const stranger = await open(homeS);
  await a.read();
  const first = a.channel("inbox");
  assert.deepEqual(first.allow, [], "open: a first contact has nobody to name");
  const bob = Keys.generate();
  const changed = await a.partnerAdd("bob", bob.public);
  assert.equal(changed.rotated, true);
  const note = (await a.attentionTaken()).find((n) => n.state === "open");
  assert.match(note.what, new RegExp(`inbox ${first.w} was open to anyone and is still read until ${first.expire_at}`));
  await stranger.client.send(first.w, { text: "to the open address" }, { encryptTo: a.keys.public });
  const got = await a.read();
  assert.deepEqual(got.map((m) => [m.body.text, m.sender]), [["to the open address", "unknown key"]], "the open one is still read, as the note says");
});

test("an address from the board, in a later process, is refused with the way that works: board answer", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  let b = await open(homeB);
  const { post } = await a.boardPost({ kind: "need", title: "x", text: "y" });
  assert.equal((await b.boardFind({})).posts[0].id, post.id);
  await b.close();
  b = await open(homeB);
  await assert.rejects(b.send(post.w, { text: "straight to the address" }), (error) => error.code === "unknown_address" && /board answer POST_ID/.test(error.message));
  const answered = await b.boardAnswer(post.id, { text: "through the board" });
  assert.equal(b.outbox[answered.message_id].status, "delivered");
});

test("a partner's name and key and send --re are checked before a home is made", (t) => {
  const dir = join(tmpdir(), `aamio-release-cli-${process.pid}-${Date.now()}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "never");
  for (const [args, said] of [[["partner", "add", "bob", "not-a-key"], /not a base64url Ed25519 public key/], [["partner", "add", "bad\u0007name", Keys.generate().public], /1 to 64 characters/],
    [["send", "bob", "hi", "--re", "xyz"], /64 lowercase hex characters/]]) {
    const ran = spawnSync(process.execPath, [bin, "--home", home, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, said);
    assert.equal(existsSync(home), false, `${args.join(" ")}: no home made`);
  }
});
