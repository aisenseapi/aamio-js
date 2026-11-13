// The release check of 0.6.0 of 9 November (code/php/docs/aamio-node-utveksling-gjennomgang-2026-11-09.md,
// "Utgivelseskontroll av Node 0.6.0"): a partner change that counts only once it is written down, the way by hand
// that names this server's home, the first inbox said as it is, an address from the board, and arguments checked
// before a home is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
    // Said as what it is, with the book as it was: the code of the file system is in the words.
    assert.equal(added.structuredContent.error_code, "not_saved");
    assert.match(added.structuredContent.error, /^partners\.json could not be written \(ENOSPC\), so the address book is as it was\./);
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

/** The command by_hand gives, run as written in the shell it names, with KEY put in, AAMIO_HOME elsewhere and TEAM set. */
function runByHand(byHand, key, env) {
  const command = byHand.command.replace(/ KEY$/, ` ${key}`);
  const shell = byHand.shell === "PowerShell" ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]] : ["sh", ["-c", command]];
  return spawnSync(shell[0], shell[1], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
}

test("the way by hand is run as written in the shell it names, and changes this server's home and no other", async (t) => {
  const fake = new FakeAamio();
  const { root, open } = await fixture(t, fake);
  // Spaces, %TEAM% for cmd.exe, $TEAM for sh and PowerShell, and a quote: a name no shell may take apart.
  const served = join(root, "Aamio-%TEAM% $TEAM it's", "home");
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
  const said = text.trim().split("\n").map((line) => JSON.parse(line)).find((m) => m.id === 1).result.structuredContent;
  assert.equal(said.by_hand.shell, process.platform === "win32" ? "PowerShell" : "sh");
  assert.match(said.fix, new RegExp(`in ${said.by_hand.shell} with the key bob gave them in place of KEY`));
  await a.close();

  const bob = Keys.generate();
  const ran = runByHand(said.by_hand, bob.public, { TEAM: "blue", AAMIO_HOME: other, AAMIO_HOST: "http://127.0.0.1:9" });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.deepEqual((await book(served)).map((p) => p.name), ["carol", "bob"], "the partner is in the home this server holds");
  assert.equal(existsSync(join(other, "partners.json")), false, "and not in the default home");
  assert.deepEqual((await readdir(root)).sort(), ["Aamio-%TEAM% $TEAM it's", "the default home"].sort(), "and no home was made under a name a shell expanded");
});

test("a key held under another name: by_hand renames with partner add and that same key, in this server's home", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  const a = await open(homeA);
  const carol = Keys.generate();
  await a.partnerAdd("carol", carol.public);
  const { added } = await addOverMcp(a, "caroline", carol.public);
  assert.equal(added.structuredContent.added, false);
  assert.match(added.structuredContent.by_hand.command, new RegExp(` partner add caroline ${carol.public.replace(/[-]/g, "\\-")}$`));
  assert.doesNotMatch(added.structuredContent.fix, /removes/, "no command the CLI does not have");
  await a.close();
  const ran = runByHand(added.structuredContent.by_hand, "", { AAMIO_HOST: "http://127.0.0.1:9" });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.deepEqual((await book(homeA)).map((p) => [p.name, p.key]), [["caroline", carol.public]], "the entry with the key has the new name");
});

/** One call over 2026-07-28: the tool's result, with the client's capabilities and any state and answer it carries. */
async function modernCall(runtime, args, extra = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const done = serveMcp({ home: runtime.home, version: "test", runtime, input, output });
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } };
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aamio_partner_add", arguments: args, _meta: meta, ...extra } }) + "\n");
  await done;
  return JSON.parse(text.trim()).result;
}

const answering = (state, content, action = "accept") => ({ requestState: state, inputResponses: { aamio_partner_key: { action, ...(content ? { content } : {}) } } });

test("two forms open for one new contact: the older answer does not replace the newer without a question of its own", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  let a = await open(homeA);
  const first = Keys.generate();
  const second = Keys.generate();
  const older = await modernCall(a, { name: "bob" });
  const newer = await modernCall(a, { name: "bob" });
  assert.equal(older.resultType, "input_required");
  assert.equal(newer.resultType, "input_required");

  const approved = await modernCall(a, { name: "bob" }, answering(newer.requestState, { key: first.public }));
  assert.equal(approved.structuredContent.added, true);
  const late = await modernCall(a, { name: "bob" }, answering(older.requestState, { key: second.public }));
  assert.equal(late.resultType, "input_required", "the older answer is not applied: the user is asked again");
  const again = late.inputRequests.aamio_partner_key.params;
  assert.match(again.message, /was put in your address book with another key/);
  assert.match(again.message, /replaces that one/);
  assert.deepEqual(a.partnerList().map((p) => p.key), [first.public], "and the key there is kept meanwhile");

  const cancelled = await modernCall(a, { name: "bob" }, answering(late.requestState, null, "cancel"));
  assert.equal(cancelled.structuredContent.added, false);
  await a.close();
  a = await open(homeA);
  assert.deepEqual(a.partnerList().map((p) => p.key), [first.public], "after a restart the first key is still there");

  const asked = await modernCall(a, { name: "bob" });
  assert.match(asked.inputRequests.aamio_partner_key.params.message, /is in your address book already, and the key you give replaces/);
  const replaced = await modernCall(a, { name: "bob" }, answering(asked.requestState, { key: second.public }));
  assert.equal(replaced.structuredContent.added, true, "a replacement the user approved as one is made");
  assert.deepEqual(a.partnerList().map((p) => p.key), [second.public]);
});

test("an older form answered with the key the newer one put there changes nothing and asks nothing", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  const a = await open(homeA);
  const key = Keys.generate();
  const older = await modernCall(a, { name: "bob" });
  const newer = await modernCall(a, { name: "bob" });
  await modernCall(a, { name: "bob" }, answering(newer.requestState, { key: key.public }));
  const same = await modernCall(a, { name: "bob" }, answering(older.requestState, { key: key.public }));
  assert.equal(same.resultType, "complete");
  assert.equal(same.structuredContent.added, true);
  assert.deepEqual(a.partnerList().map((p) => p.key), [key.public]);
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
  // In the answer of the call that changed the book, which partner add on the command line prints before it ends.
  assert.equal(changed.old_inbox.open, true);
  assert.match(changed.old_inbox.note, new RegExp(`inbox ${first.w} was open to anyone, signed or not, and is still read until ${first.expire_at}`));
  assert.match(changed.old_inbox.note, /takes writes from the 1 key\(s\) in the address book only/);
  assert.equal((await a.attentionTaken()).some((n) => n.state === "open"), false, "said once, there");
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
    // The answer is JSON on standard output, as in aamio-python and aamio-php, and nothing is made for it.
    assert.deepEqual([ran.status, ran.stderr], [1, ""], args.join(" "));
    assert.match(JSON.parse(ran.stdout).error, said);
    assert.equal(existsSync(home), false, `${args.join(" ")}: no home made`);
  }
});
