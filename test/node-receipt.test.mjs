// Stage 1 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): the receipt, compared with what
// this process read, and the byte budget on reads, against the fake aamio with its receipt route and Verifyum in
// memory. The same receipt over the real service is in code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Keys, sha256hex } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio, VERIFYUM, publicBytes } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-receipt-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const made = {};
  for (const name of names) {
    made[name] = join(root, name);
    await initIdentity(made[name]);
  }
  const open = async (home) => {
    const runtime = await NodeRuntime.open({ home, host: HOST, verifyum: VERIFYUM, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  return { ...made, open };
}

/** Two homes that are each other's partners, each with its inbox open. */
async function pair(t, fake) {
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const receiver = await open(homeA);
  const sender = await open(homeB);
  await receiver.partnerAdd("sender", sender.keys.public);
  await sender.partnerAdd("receiver", receiver.keys.public);
  await receiver.read();
  await sender.read();
  return { receiver, sender, homeA, open };
}

test("a reopened home keeps its identity, while a receipt reports fresh observations", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  await sender.send("receiver", { text: "one observation" });
  assert.equal((await receiver.read()).length, 1);

  const live = await receiver.receipt("inbox");
  assert.equal(live.root_adds_up, true);
  assert.equal(live.held_locally, 1);
  assert.equal(live.local_root_matches, true);
  assert.deepEqual(live.local_differences, []);
  assert.deepEqual(live.keys, ["sender"], "a signer this process checked is shown by name");
  assert.deepEqual(live.keys_service_claim_only, []);
  await receiver.close();

  const reopened = await open(homeA);
  assert.equal(reopened.keys.public, receiver.keys.public, "the same identity");
  const fresh = await reopened.receipt("inbox");
  assert.equal(fresh.root, live.root);
  assert.equal(fresh.root_adds_up, true);
  assert.equal(fresh.held_locally, 0);
  assert.equal(fresh.local_root_matches, null, "not compared, which is not a failure");
  assert.match(fresh.local_check, /^Not compared: this process holds 0 of the 1 messages/);
  assert.deepEqual(fresh.keys, [sender.keys.public], "a signer only the service vouches for is never given a partner's name");
  assert.deepEqual(fresh.keys_service_claim_only, [sender.keys.public]);
  assert.equal(fresh.keys_unverified_count, 1);
  assert.equal("local_differences" in fresh, false);
});

test("a receipt is signed as it was fetched, and an empty thread compares", async (t) => {
  const fake = new FakeAamio();
  const { receiver } = await pair(t, fake);
  const empty = await receiver.receipt();
  assert.equal(empty.count, 0);
  assert.equal(empty.root, sha256hex(""));
  assert.equal(empty.root_adds_up, true);
  assert.equal(empty.local_root_matches, true, "nothing held of nothing counted is a match");
  assert.equal(empty.signed_text, `aamio-receipt-v1\n${empty.w}\n${empty.root}\n0\n${fake.time}`);
  assert.equal(empty.signed_by, receiver.keys.public);
  const { verify } = await import("../src/aamio.js");
  assert.equal(verify(receiver.keys.public, empty.signed_text, empty.signature), true);
});

test("a receipt that does not add up, that changed a line, or that counts less than was read, says so", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "first" });
  await sender.send("receiver", { text: "second" });
  assert.equal((await receiver.read()).length, 2);
  const lines = (r) => r.messages.map((m) => `${m.seq}\t${m.at}\t${m.sha256}\t${m.from ?? "-"}\n`).join("");
  // A receipt in good shape: its commitment names its root, and it counts its lines.
  const shaped = (r, messages, extra = {}) => {
    const root = sha256hex(lines({ messages }));
    return { ...r, ...extra, messages, root, commitment: "sha256:" + root };
  };

  // Lines that add up to another root than the one it claims: what root_adds_up is there for.
  fake.tamperReceipt = (r) => ({ ...r, root: "0".repeat(64), commitment: "sha256:" + "0".repeat(64) });
  const wrongRoot = await receiver.receipt();
  assert.equal(wrongRoot.root_adds_up, false);
  assert.equal(wrongRoot.local_root_matches, false);

  fake.tamperReceipt = (r) => shaped(r, r.messages.map((m) => (m.seq === 2 ? { ...m, at: m.at + 7 } : m)));
  const changed = await receiver.receipt();
  assert.equal(changed.root_adds_up, true, "its own arithmetic holds");
  assert.equal(changed.local_root_matches, false, "and it is not what was read here");
  assert.deepEqual(changed.local_differences, [{ seq: 2, fields: ["at"] }]);

  fake.tamperReceipt = (r) => shaped(r, r.messages.slice(0, 1), { count: 1 });
  const fewer = await receiver.receipt();
  assert.equal(fewer.root_adds_up, true);
  assert.equal(fewer.local_root_matches, false);
  assert.match(fewer.local_check, /^Mismatch: the receipt counts fewer messages than this process read/);
});

test("a message the inbox's list kept out still counts for the receipt", async (t) => {
  const fake = new FakeAamio();
  const { receiver } = await pair(t, fake);
  const { s: homeS, open } = await fixture(t, fake, "s");
  const stranger = await open(homeS);
  // The service lost the thread, and a write opened one with no list at the same address.
  const inbox = receiver.channel("inbox");
  fake.forget(inbox.w);
  fake.time += 1;
  await stranger.client.send(inbox.w, { text: "not on the list" }, { encryptTo: receiver.keys.public });
  assert.deepEqual(await receiver.read(), [], "kept out here");
  const receipt = await receiver.receipt();
  assert.equal(receipt.count, 1);
  assert.equal(receipt.held_locally, 1, "but observed");
  assert.equal(receipt.local_root_matches, true);
  assert.deepEqual(receipt.keys, [stranger.keys.public], "a stranger's checked key has no name to be given");
});

test("a root is anchored only when asked, with the idempotency key aamio-python and aamio-php use", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "to anchor" });
  await receiver.read();
  const plain = await receiver.receipt();
  assert.equal(fake.anchors.length, 0, "no call leaves the machine without anchor");
  assert.equal("anchor" in plain, false);

  const anchored = await receiver.receipt("inbox", { anchor: true });
  assert.equal(fake.anchors.length, 1);
  const key = sha256hex(`aamio-listen:${receiver.keys.hash}:${anchored.root}`).slice(0, 32);
  assert.deepEqual(fake.anchors[0], { commitment: `sha256:${anchored.root}`, idempotency_key: key });
  assert.equal(anchored.anchor.proof_id, "proof-" + key.slice(0, 8));

  await receiver.receipt("inbox", { anchor: true });
  assert.equal(fake.anchors[1].idempotency_key, key, "the same root anchors under the same key, so a second ask is the same proof");

  fake.anchorAnswer = () => fake.reply(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{\"error\":\"down\"}" }], isError: true } });
  const failed = await receiver.receipt("inbox", { anchor: true });
  assert.equal(failed.root_adds_up, true, "the receipt stands");
  assert.deepEqual(failed.anchor, { error: 200, detail: "{\"error\":\"down\"}" }, "with Verifyum's own words");

  fake.anchorAnswer = () => Promise.reject(new TypeError("fetch failed"));
  const unreached = await receiver.receipt("inbox", { anchor: true });
  assert.deepEqual(unreached.anchor, { error: 0, detail: "fetch failed" }, "and 0 when nothing answered");
});

test("an unknown channel and a service that will not give the receipt are errors that say so", async (t) => {
  const fake = new FakeAamio();
  const { receiver } = await pair(t, fake);
  await assert.rejects(receiver.receipt("nowhere"), (error) => error.code === "unknown_channel" && /It has inbox/.test(error.message));
  fake.tamperReceipt = () => ({ nothing: "here" });
  await assert.rejects(receiver.receipt(), { code: "receipt_failed" });
});

test("a byte budget hands over whole messages that fit, and says what it kept back", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "a".repeat(400) });
  await sender.send("receiver", { text: "b".repeat(400) });
  const one = await receiver.read({ maxBytes: 1300 });
  assert.equal(one.length, 1, "only the first fits");
  assert.equal(fake.budgets.at(-1), 1300);
  const kept = (await receiver.attentionTaken()).filter((note) => note.state === "more");
  assert.equal(kept.length, 1, "and the rest is said to wait");
  assert.match(kept[0].what, /than the byte budget this read asked for/);
  const two = await receiver.read({ maxBytes: 1300 });
  assert.deepEqual([...one, ...two].map((m) => m.body.text[0]), ["a", "b"], "the next read takes the rest, nothing skipped");

  await sender.send("receiver", { text: "c".repeat(3000) });
  assert.deepEqual(await receiver.read({ maxBytes: 600 }), [], "a message larger than the budget is not sent");
  const said = (await receiver.attentionTaken()).find((note) => note.state === "too_large");
  assert.match(said.what, /^message 3 on this channel is \d+ bytes and does not fit/);
  assert.equal((await receiver.read()).length, 1, "a read without a budget takes it");
  assert.equal(fake.budgets.at(-1), null, "and asked for none");

  await sender.send("receiver", { text: "under any budget" });
  assert.equal((await receiver.read({ maxBytes: 999999999 })).length, 1, "a budget larger than the service takes is sent as the largest it does take");
  assert.equal(fake.budgets.at(-1), 99999999);
  assert.deepEqual((await receiver.attentionTaken()).filter((note) => note.state === "unread"), [], "rather than a header it answers 400 to");
});

test("a read that reaches its limit says so in its own words, and names a channel it had no room to ask", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  const { c: homeC, open } = await fixture(t, fake, "c");
  const third = await open(homeC);
  for (const text of ["one", "two", "three"]) await sender.send("receiver", { text });
  assert.equal((await receiver.read({ limit: 2 })).length, 2);
  const said = (await receiver.attentionTaken()).filter((note) => note.state === "more");
  assert.equal(said.length, 1);
  assert.match(said[0].what, /as many messages as its limit allows/);
  assert.doesNotMatch(said[0].what, /budget/, "no budget was asked for, so none is blamed");
  assert.deepEqual((await receiver.read()).map((m) => m.body.text), ["three"]);

  // The inbox opens again for a new partner, and the older one is still read for the sender.
  const older = receiver.channel("inbox");
  await receiver.partnerAdd("third", third.keys.public);
  const newer = receiver.channel("inbox");
  assert.notEqual(newer.w, older.w);
  await sender.client.send(older.w, { text: "on the older inbox" }, { encryptTo: receiver.keys.public });
  await sender.client.send(newer.w, { text: "on the new inbox" }, { encryptTo: receiver.keys.public });
  assert.deepEqual((await receiver.read({ limit: 1 })).map((m) => m.body.text), ["on the new inbox"]);
  const left = (await receiver.attentionTaken()).filter((note) => note.state === "more");
  assert.deepEqual(left.map((note) => note.channel), [older.label], "the older inbox was not asked, and is named");
  assert.match(left[0].what, /reached its limit of 1 message\(s\) before it asked this channel/);
  assert.deepEqual((await receiver.read()).map((m) => m.body.text), ["on the older inbox"], "and nothing was passed over");
});

test("over MCP aamio_read asks for one message's worth per channel unless told, and aamio_receipt is the thirteenth tool", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  const call = async (name, args) => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk; });
    const request = { jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } };
    await serveMcp({ home: receiver.home, version: "test", runtime: receiver, input: Readable.from([JSON.stringify(request) + "\n"]), output });
    return JSON.parse(text.trim());
  };
  const tools = (await call("tools/list")).result.tools;
  assert.equal(tools.length, 13);
  assert.ok(tools.some((tool) => tool.name === "aamio_receipt"));

  await sender.send("receiver", { text: "over mcp" });
  assert.equal((await call("aamio_read", {})).result.structuredContent.count, 1);
  assert.equal(fake.budgets.at(-1), 65536, "the default budget");
  await call("aamio_read", { max_bytes: 2048 });
  assert.equal(fake.budgets.at(-1), 2048);
  assert.equal((await call("aamio_read", { max_bytes: 100 })).error.code, -32602, "under 512 is refused by the schema");

  const receipt = (await call("aamio_receipt", { channel: "inbox" })).result.structuredContent;
  assert.equal(receipt.held_locally, 1);
  assert.equal(receipt.local_root_matches, true);
  assert.equal((await call("aamio_receipt", { anchor: "yes" })).error.code, -32602);
  const nowhere = (await call("aamio_receipt", { channel: "nowhere" })).result;
  assert.equal(nowhere.isError, true);
  assert.equal(nowhere.structuredContent.error_code, "unknown_channel");
  assert.equal(fake.anchors.length, 0);
});

test("the command line checks receipt and read --max-bytes before a home is made", () => {
  const home = join(tmpdir(), `aamio-receipt-cli-${process.pid}-${Date.now()}`);
  const refused = [
    [["receipt", "--channel"], /^--channel needs a value\./],
    [["receipt", "--channel="], /^--channel names a channel/],
    [["receipt", "--anchor=yes"], /^--anchor takes no value\./],
    [["receipt", "extra"], /^receipt takes no arguments\./],
    [["read", "--max-bytes", "100"], /^--max-bytes is a whole number, 512 or more\./],
    [["read", "--max-bytes", "x"], /^--max-bytes is a whole number, 512 or more\./],
    [["read", "--limit", "0"], /^--limit is a whole number from 1 to 200\./],
    [["read", "--limit", "0201"], /^--limit is a whole number from 1 to 200\./],
  ];
  for (const [args, said] of refused) {
    const ran = spawnSync(process.execPath, [bin, "--home", home, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(ran.status, 2, `${args.join(" ")}: ${ran.stderr}`);
    assert.match(ran.stderr, said, args.join(" "));
  }
  assert.equal(existsSync(home), false);
  assert.match(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).stdout, /receipt \[--channel LABEL\] \[--anchor\]/);
});

test("the command line takes leading zeros as it did, and a byte budget of 512 or more as MCP does", async (t) => {
  // Arguments that pass go on to the home, which here is a file, so the command stops there with 1 and not with
  // the 2 of a usage error. Nothing is asked of the network: the hosts point at a closed port.
  const file = join(tmpdir(), `aamio-receipt-cli-file-${process.pid}-${Date.now()}`);
  await writeFile(file, "not a home");
  t.after(() => rm(file, { force: true }));
  const env = { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9" };
  for (const args of [["read", "--limit", "0001"], ["read", "--limit", "000001"], ["lookup", "--wait", "001"], ["board", "find", "--min-work-bits", "0001"], ["read", "--max-bytes", "1000000000"]]) {
    const ran = spawnSync(process.execPath, [bin, "--home", file, ...args], { encoding: "utf8", timeout: 30_000, env });
    assert.equal(ran.status, 1, `${args.join(" ")}: ${ran.stderr}`);
    assert.doesNotMatch(ran.stderr, /whole number/, args.join(" "));
  }
});

test("a receipt for a thread opened again at the same address compares nothing read on the old one, before or after the first new read", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "on the first thread" });
  assert.equal((await receiver.read()).length, 1);
  assert.equal((await receiver.receipt()).local_root_matches, true);

  // The service restarts without its store, and a write opens a new thread at the same address, later.
  const inbox = receiver.channel("inbox");
  fake.forget(inbox.w);
  fake.time += 5;
  await sender.client.send(inbox.w, { text: "on the new thread" }, { encryptTo: receiver.keys.public });
  const before = await receiver.receipt();
  assert.equal(before.root_adds_up, true);
  assert.equal(before.held_locally, 0, "nothing of the new thread was read here");
  assert.equal(before.local_root_matches, null);
  assert.deepEqual(before.keys, [sender.keys.public], "its signer is the service's word, not a partner checked here");
  assert.equal(before.keys_unverified_count, 1);
  assert.match(before.local_check, /on an earlier thread, opened at \d+; this receipt is for the one opened at \d+/);

  assert.deepEqual((await receiver.read()).map((m) => m.body.text), ["on the new thread"]);
  const after = await receiver.receipt();
  assert.equal(after.held_locally, 1);
  assert.equal(after.local_root_matches, true);
  assert.deepEqual(after.keys, ["sender"]);
});

test("an answer that is not a receipt for this channel is refused before it is compared, signed or anchored", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "one" });
  await receiver.read();
  const refused = [
    [(r) => ({ ...r, w: "b".repeat(20) }), /it is for "bbbbbbbbbbbbbbbbbbbb", not for [a-z2-7]{20}, the address asked for/],
    [(r) => ({ ...r, count: 7 }), /it counts 7 messages and has 1 lines/],
    [(r) => ({ ...r, schema: undefined }), /its schema is null, not aamio-receipt-v1/],
    [(r) => ({ ...r, commitment: "sha256:" + "0".repeat(64) }), /its commitment is not sha256: and its root/],
    [(r) => ({ ...r, issued_at: "soon" }), /its issued_at is not a time/],
    [(r) => ({ ...r, messages: [{ ...r.messages[0], sha256: "x" }] }), /line 1 is not a message line in order/],
    [(r) => ({ ...r, root: "ROOT", commitment: "sha256:ROOT" }), /its root is not a sha256 in hex/],
    [(r) => ({ ...r, keys: [7] }), /its keys are not a list of keys/],
  ];
  for (const [tamper, why] of refused) {
    fake.tamperReceipt = tamper;
    await assert.rejects(receiver.receipt("inbox", { anchor: true }), (error) => error.code === "receipt_failed" && why.test(error.message) && /Nothing was compared, signed or anchored\.$/.test(error.message), why.source);
  }
  assert.equal(fake.anchors.length, 0, "and nothing was anchored");
});

test("an anchoring Verifyum answers with an error status is an error, whatever its body says", async (t) => {
  const fake = new FakeAamio();
  const { receiver } = await pair(t, fake);
  fake.anchorAnswer = () => new Response("Service Unavailable", { status: 503 });
  assert.deepEqual((await receiver.receipt("inbox", { anchor: true })).anchor, { error: 503, detail: "Service Unavailable" }, "a 503 in plain text is a 503");

  const proof = { proof_id: "proof-not-made", proof_url: "https://fake.verifyum/p/x", status: "pending" };
  fake.anchorAnswer = () => fake.reply(503, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(proof) }], isError: false } });
  const refused = (await receiver.receipt("inbox", { anchor: true })).anchor;
  assert.equal(refused.error, 503, "a 503 that names a proof made no proof");
  assert.equal("proof_id" in refused, false);

  fake.anchorAnswer = () => Promise.reject(new TypeError("fetch failed"));
  assert.deepEqual((await receiver.receipt("inbox", { anchor: true })).anchor, { error: 0, detail: "fetch failed" }, "and nothing answered is 0");

  delete fake.anchorAnswer;
  assert.match((await receiver.receipt("inbox", { anchor: true })).anchor.proof_id, /^proof-[0-9a-f]{8}$/, "a 200 with a proof is an anchoring");
});

test("a byte budget is kept for what is handed over, also when the service sends more than fits", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  const size = (m) => Buffer.byteLength(JSON.stringify(m), "utf8");
  const inbox = receiver.channel("inbox");

  // Plain signed text is larger opened here than at the service: 337 bytes and 306. The service sends two to a
  // budget of 640, and one of them fits as they are handed over.
  for (const text of ["h1", "h2", "h3"]) await sender.client.send(inbox.w, text);
  const first = await receiver.read({ maxBytes: 640 });
  assert.equal(fake.budgets.at(-1), 640);
  assert.deepEqual(first.map((m) => m.body.text), ["h1"], "one fits as handed over");
  assert.ok(size(first[0]) <= 640 && size(first[0]) * 2 > 640);
  const stopped = (await receiver.attentionTaken()).filter((note) => note.state === "more");
  assert.equal(stopped.length, 1);
  assert.match(stopped[0].what, /^this read stopped at the byte budget it asked for, 640 bytes of messages as they are handed over here/);
  assert.equal(inbox.after, first[0].seq, "the cursor stands at the last message handed over, not at the service's next");
  const partial = await receiver.receipt();
  assert.equal(partial.held_locally, 1, "what was not taken was not observed either");

  // A new process takes the rest from the cursor, in order, none twice, none a replay.
  await receiver.close();
  const again = await open(homeA);
  const rest = [];
  for (let i = 0; i < 5 && rest.length < 2; i++) rest.push(...(await again.read({ maxBytes: 640 })));
  assert.deepEqual([...first, ...rest].map((m) => [m.body.text, m.replay]), [["h1", false], ["h2", false], ["h3", false]]);
});

test("a service that sends everything is held to the budget here, and one message larger than it comes on its own", async (t) => {
  const fake = new FakeAamio();
  fake.ignoreBudget = true;
  const { receiver, sender } = await pair(t, fake);
  for (const text of ["one", "two", "three"]) await sender.send("receiver", { text });
  const taken = [];
  for (let i = 0; i < 5 && taken.length < 3; i++) {
    const got = await receiver.read({ maxBytes: 600 });
    assert.equal(got.length, 1, "one at a time: two of these are 778 bytes as handed over");
    taken.push(...got);
  }
  assert.deepEqual(taken.map((m) => [m.body.text, m.replay]), [["one", false], ["two", false], ["three", false]]);
  assert.equal(receiver.channel("inbox").after, 3);
  assert.equal((await receiver.receipt()).local_root_matches, true, "every row taken once, and observed once");
  await receiver.attentionTaken();

  await sender.send("receiver", { text: "x".repeat(2000) });
  await sender.send("receiver", { text: "short" });
  const large = await receiver.read({ maxBytes: 600 });
  assert.deepEqual(large.map((m) => m.body.text.length), [2000], "already here, so handed over on its own");
  const notes = await receiver.attentionTaken();
  assert.match(notes.find((note) => note.state === "over_budget").what, /^message 4 on this channel is \d+ bytes as handed over here, larger than the whole byte budget of 600/);
  assert.ok(notes.some((note) => note.state === "more"), "and the short one is said to wait");
  assert.deepEqual((await receiver.read({ maxBytes: 600 })).map((m) => m.body.text), ["short"]);
});

test("a read that waits says a too_large once", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "z".repeat(3000) });
  assert.deepEqual(await receiver.read({ wait: 1, maxBytes: 600 }), []);
  const said = (await receiver.attentionTaken()).filter((note) => note.state === "too_large");
  assert.equal(said.length, 1, "asked before the wait and in it, said once");
  assert.equal(receiver.channel("inbox").after, 0, "and the cursor stays before it");
});

test("the test service measures a message as the service does: its own fields, in UTF-8 bytes", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  const w = receiver.channel("inbox").w;
  await sender.client.send(w, "\u{1F600}".repeat(130));
  const stored = fake.threads.get(w).messages.at(-1);
  const bytes = publicBytes(stored);
  assert.ok(bytes > JSON.stringify(stored).length, "an emoji is four bytes and two units of a JavaScript string");
  assert.deepEqual(await receiver.read({ maxBytes: bytes - 1 }), [], "one byte under, and the service keeps it");
  assert.equal((await receiver.attentionTaken()).find((note) => note.state === "too_large").what.startsWith(`message 1 on this channel is ${bytes} bytes`), true);
  assert.equal((await receiver.read({ maxBytes: bytes })).length, 1, "at its size, the service sends it");
});

test("what was read of a thread is let go once its receipt can no longer be taken", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.send("receiver", { text: "kept for a while" });
  await receiver.read();
  const inbox = receiver.channel("inbox");
  assert.equal(receiver.observed.get(inbox.w).rows.size, 1);
  fake.time = inbox.expire_at + 60;
  await receiver.read();
  assert.equal(receiver.observed.has(inbox.w), true, "kept through the service's grace for receipts");
  fake.time = inbox.expire_at + 121;
  await receiver.read();
  assert.equal(receiver.observed.has(inbox.w), false, "and let go after it");
});
