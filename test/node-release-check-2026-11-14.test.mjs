// What the release check of 14 November 2026 found here and in the other two
// runtimes. Half of a UTF-16 surrogate pair, as "\ud800" decodes to, was read
// as JSON here, went out as U+FFFD in its place, and aamio-php reads no such
// body as JSON. And a delivery read again, after a read that threw or a cursor
// that could not be written, in this process or the next, was written to the
// archive a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime, unfitJson, unfitText } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const HALF = '{"text": "\\ud800"}';

/** Homes in a folder of their own, opened and opened again by name. */
async function homes(t, fake) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-1114-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async (name, fresh = true) => {
    if (fresh) await initIdentity(join(root, name));
    const runtime = await NodeRuntime.open({ home: join(root, name), host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  return { root, open };
}

/** The bytes as they are, signed by the sender, to the address. */
async function write(fake, sender, w, body) {
  const answer = await fake.fetch(`${HOST}/${w}`, { method: "POST", body, headers: { "X-Key": sender.keys.public, "X-Sig": sender.keys.sign(threadSigningInput(w, body)) } });
  assert.equal(answer.status, 201);
}

function failSaving(runtime, file, times = 1) {
  const real = runtime.saveJson.bind(runtime);
  runtime.saveJson = async (name, value) => {
    if (name === file && times > 0) {
      times--;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return real(name, value);
  };
}

const rows = async (home, label) => {
  const path = join(home, "archive", label + ".jsonl");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === "received").map((row) => row.seq).sort((a, b) => a - b);
};

test("half a surrogate pair is named where it stands, and a whole pair is a character like any other", () => {
  assert.deepEqual(unfitJson(JSON.parse('{"a": {"\\ud800": 1}}')), ["a.\\ud800", "half a pair"]);
  assert.deepEqual(unfitJson(JSON.parse('{"a": 1e999, "b": "\\udfff"}')), ["a", "not finite"], "the first in the document is named");
  assert.equal(unfitJson(JSON.parse('{"face": "\\ud83d\\ude00"}')), null);
  assert.ok(unfitText(["data.\\ud800", "half a pair"]).startsWith("data.\\ud800 holds half of a UTF-16 surrogate pair"));
});

test("a body with half a surrogate pair is text, and the ordinary messages around it arrive within a byte budget", async (t) => {
  const fake = new FakeAamio();
  const { open } = await homes(t, fake);
  const owner = await open("a");
  const guest = await open("b");
  await owner.partnerAdd("guest", guest.keys.public);
  await owner.read();
  const w = owner.channel("inbox").w;
  await write(fake, guest, w, JSON.stringify({ text: "before" }));
  await write(fake, guest, w, HALF);
  await write(fake, guest, w, JSON.stringify({ text: "after" }));
  const read = await owner.read({ maxBytes: 100000 });
  assert.deepEqual(read.map((m) => [m.format, m.body.text]), [["json", "before"], ["text", HALF], ["json", "after"]]);
  assert.ok(Buffer.from(JSON.stringify(read), "utf8").toString("utf8").isWellFormed());
});

test("over MCP half a surrogate pair in the arguments is refused, and on the command line before the home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-1114-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"aamio_send","arguments":{"to":"nobody","text":"\\ud800"}}}',
  ];
  const env = { ...process.env, AAMIO_BOARD: "http://127.0.0.1:9" };
  const served = spawnSync(process.execPath, [bin, "--home", join(root, "home"), "--host", "http://127.0.0.1:9", "serve"], { input: lines.join("\n") + "\n", encoding: "utf8", env, timeout: 60000 });
  const told = served.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((a) => a.id === 2)?.result?.structuredContent ?? {};
  assert.equal(told.error_code, "invalid_arguments");
  assert.ok(told.error.startsWith("text holds half of a UTF-16 surrogate pair"), told.error);
  const home = join(root, "cli");
  const done = spawnSync(process.execPath, [bin, "--home", home, "--host", "http://127.0.0.1:9", "send", "bob", "hi", "--data", '{"t":"\\ud800"}'], { encoding: "utf8", env, timeout: 60000 });
  assert.deepEqual([done.status, done.stdout], [2, ""], done.stderr);
  assert.ok(done.stderr.includes("--data holds half of a UTF-16 surrogate pair") && !existsSync(home), done.stderr);
});

test("a delivery read again after a read that threw is written to the archive once", async (t) => {
  const fake = new FakeAamio();
  const { root, open } = await homes(t, fake);
  const owner = await open("a");
  const guest = await open("b");
  await owner.partnerAdd("guest", guest.keys.public);
  await owner.read();
  const side = await owner.channelOpen("side", { ttl: 600, allow: ["guest"] });
  await write(fake, guest, side.w, JSON.stringify({ text: "first" }));
  await write(fake, guest, side.w, JSON.stringify({ text: "second" }));
  const real = owner.readEntry.bind(owner);
  owner.readEntry = (channel, raw) => {
    if (channel.label === "side" && raw?.seq === 2) throw new RangeError("the test made the second message fail");
    return real(channel, raw);
  };
  assert.deepEqual(await owner.read(), []);
  owner.readEntry = real;
  assert.deepEqual((await owner.read()).map((m) => [m.body.text, m.archived]), [["first", true], ["second", true]]);
  assert.deepEqual(await rows(join(root, "a"), "side"), [1, 2], "each delivery is one row");
});

test("after a restart a delivery an earlier process wrote down is one row, and handed over again", async (t) => {
  const fake = new FakeAamio();
  const { root, open } = await homes(t, fake);
  let owner = await open("a");
  const guest = await open("b");
  await owner.partnerAdd("guest", guest.keys.public);
  await owner.read();
  const side = await owner.channelOpen("side", { ttl: 600, allow: ["guest"] });
  await write(fake, guest, side.w, JSON.stringify({ text: "first" }));
  await write(fake, guest, side.w, JSON.stringify({ text: "second" }));
  // The inbox is read first: both saves of the read fail, the side's with its messages written down.
  failSaving(owner, "state.json", 2);
  assert.deepEqual(await owner.read(), [], "nothing is handed over from a read that could not be written down");
  assert.deepEqual(await rows(join(root, "a"), "side"), [1, 2]);
  await owner.close();
  owner = await open("a", false);
  assert.deepEqual((await owner.read()).map((m) => [m.body.text, m.archived]), [["first", true], ["second", true]], "the next process hands them over");
  assert.deepEqual(await rows(join(root, "a"), "side"), [1, 2], "and the archive still holds each once");
});

/** A home whose side channel holds texts at the service, read by nobody yet, and the rows an earlier process would have written for them. */
async function crafted(t, texts) {
  const fake = new FakeAamio();
  const { root, open } = await homes(t, fake);
  const first = await open("a");
  const guest = await open("b");
  await first.partnerAdd("guest", guest.keys.public);
  await first.read();
  const side = await first.channelOpen("side", { ttl: 600, allow: ["guest"] });
  const rows = [];
  for (const [index, text] of texts.entries()) {
    const body = JSON.stringify({ text });
    await write(fake, guest, side.w, body);
    rows.push(Buffer.from(JSON.stringify({ kind: "received", channel: "side", w: side.w, instance: fake.threads.get(side.w).instance, seq: index + 1, sha256: createHash("sha256").update(body).digest("hex"), body: { text } }), "utf8"));
  }
  await first.close();
  await mkdir(join(root, "a", "archive"), { recursive: true });
  return { home: join(root, "a"), rows, open };
}

/** The seq of every row the archive's reader counts for the side channel, and how many lines the file has. */
async function written(home) {
  const lines = (await readFile(join(home, "archive", "side.jsonl"))).toString("latin1").split("\n").filter(Boolean).map((line) => Buffer.from(line, "latin1"));
  const seqs = [];
  for (const [number, line] of lines.entries()) {
    try {
      const raw = number === 0 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf ? line.subarray(3) : line;
      const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      if (row.kind === "received") seqs.push(row.seq);
    } catch {
      // not a row the reader counts
    }
  }
  return [seqs.sort((a, b) => a - b), lines.length];
}

for (const [name, expected] of [["a byte order mark", [[1, 2], 2]], ["a line that is not UTF-8", [[1, 2], 3]], ["a line that starts where the end starts", [[1, 1, 2], 3]]]) {
  test(`the rows used again are the ones the archive reader counts: ${name}`, async (t) => {
    const { home, rows, open } = await crafted(t, ["first", "second"]);
    if (name === "a line that is not UTF-8") rows[0] = Buffer.from(rows[0].toString("latin1").replace('"first"', '"fir\xffst"'), "latin1");
    const mark = name === "a byte order mark" ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
    await writeFile(join(home, "archive", "side.jsonl"), Buffer.concat([mark, rows[0], Buffer.from("\n"), rows[1], Buffer.from("\n")]));
    const again = await open("a", false);
    if (name === "a line that starts where the end starts") again.archiveTailBytes = rows[1].length + 1;
    assert.deepEqual((await again.read()).map((m) => [m.body.text, m.archived]), [["first", true], ["second", true]]);
    assert.deepEqual(await written(home), expected);
  });
}

test("a row a prune removed is written again, never taken as there", async (t) => {
  const { home, rows, open } = await crafted(t, ["first"]);
  const path = join(home, "archive", "side.jsonl");
  await writeFile(path, Buffer.concat([rows[0], Buffer.from("\n")]));
  const again = await open("a", false);
  assert.deepEqual((await again.read()).map((m) => [m.body.text, m.archived]), [["first", true]]);
  assert.deepEqual(await written(home), [[1], 1], "the row an earlier process wrote is used");
  // A prune writes the file again beside itself and renames it over: here, without the row.
  await writeFile(path + ".tmp", "");
  await rename(path + ".tmp", path);
  again.channel("side").after = 0;
  assert.deepEqual((await again.read()).map((m) => [m.body.text, m.archived]), [["first", true]]);
  assert.deepEqual(await written(home), [[1], 1], "written again: the archive has what the message says");
});

test("tidying that is due runs before a read weighs its messages, and each says archived of a row that is there", async (t) => {
  // The fourth release check of 14 November 2026, item 1: with tidying due and a
  // ceiling under one row, the read used the row an earlier process wrote and
  // wrote the next, the tidying took both, and each message said archived.
  const { home, rows, open } = await crafted(t, ["first", "second"]);
  await writeFile(join(home, "archive", "side.jsonl"), Buffer.concat([rows[0], Buffer.from("\n")]));
  const again = await open("a", false);
  again.archivePolicy = { mode: "keep", days: null, max_mb: 128 / (1024 * 1024) };
  again.prunedAt = 0;
  assert.ok(rows[0].length > 128, "the ceiling is under one row");
  assert.deepEqual((await again.read()).map((m) => [m.body.text, m.archived]), [["first", true], ["second", true]]);
  assert.deepEqual(await written(home), [[1, 2], 2], "the archive has what the messages say, after the tidying of the same read");
  assert.ok(again.prunedAt > 0, "the tidying ran");
});

test("tidying between two reads still takes what was there, and the next read's own row stays", async (t) => {
  const fake = new FakeAamio();
  const { root, open } = await homes(t, fake);
  const owner = await open("a");
  const guest = await open("b");
  await owner.partnerAdd("guest", guest.keys.public);
  await owner.read();
  const side = await owner.channelOpen("side", { ttl: 600, allow: ["guest"] });
  await write(fake, guest, side.w, JSON.stringify({ text: "first" }));
  assert.deepEqual((await owner.read()).map((m) => [m.body.text, m.archived]), [["first", true]]);
  assert.deepEqual(await rows(join(root, "a"), "side"), [1]);
  await write(fake, guest, side.w, JSON.stringify({ text: "second" }));
  owner.archivePolicy = { mode: "keep", days: null, max_mb: 128 / (1024 * 1024) };
  owner.prunedAt = 0;
  assert.deepEqual((await owner.read()).map((m) => [m.body.text, m.archived]), [["second", true]]);
  assert.deepEqual(await rows(join(root, "a"), "side"), [2], "the first went with the tidying, which ran first; the second is there");
});

test("after a cursor that could not be written and a prune, the mark is the row that is there", async (t) => {
  const fake = new FakeAamio();
  const { root, open } = await homes(t, fake);
  const owner = await open("a");
  const guest = await open("b");
  await owner.partnerAdd("guest", guest.keys.public);
  await owner.read();
  const side = await owner.channelOpen("side", { ttl: 600, allow: ["guest"] });
  await write(fake, guest, side.w, JSON.stringify({ text: "first" }));
  // The inbox is read first: both saves of the read fail, the side's with its message written down.
  failSaving(owner, "state.json", 2);
  assert.deepEqual(await owner.read(), []);
  assert.deepEqual(await rows(join(root, "a"), "side"), [1]);
  await owner.archivePrune({ everything: true });
  assert.deepEqual(await rows(join(root, "a"), "side"), []);
  assert.deepEqual((await owner.read()).map((m) => [m.body.text, m.archived]), [["first", true]]);
  assert.deepEqual(await rows(join(root, "a"), "side"), [1], "the mark is the row that is there: it is written again");
});
