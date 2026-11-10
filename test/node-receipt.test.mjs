// Stage 1 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): the receipt, compared with what
// this process read, and the byte budget on reads, against the fake aamio with its receipt route and Verifyum in
// memory. The same receipt over the real service is in code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Keys, sha256hex } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio, VERIFYUM } from "./fake-aamio.mjs";

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

  fake.tamperReceipt = (r) => ({ ...r, root: "0".repeat(64) });
  const wrongRoot = await receiver.receipt();
  assert.equal(wrongRoot.root_adds_up, false);
  assert.equal(wrongRoot.local_root_matches, false);

  fake.tamperReceipt = (r) => {
    const messages = r.messages.map((m) => (m.seq === 2 ? { ...m, at: m.at + 7 } : m));
    return { ...r, messages, root: sha256hex(lines({ messages })) };
  };
  const changed = await receiver.receipt();
  assert.equal(changed.root_adds_up, true, "its own arithmetic holds");
  assert.equal(changed.local_root_matches, false, "and it is not what was read here");
  assert.deepEqual(changed.local_differences, [{ seq: 2, fields: ["at"] }]);

  fake.tamperReceipt = (r) => {
    const messages = r.messages.slice(0, 1);
    return { ...r, messages, count: 1, root: sha256hex(lines({ messages })) };
  };
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
    [["read", "--max-bytes", "100"], /^--max-bytes is a whole number from 512 to 999999999\./],
    [["read", "--max-bytes", "x"], /^--max-bytes is a whole number from 512/],
  ];
  for (const [args, said] of refused) {
    const ran = spawnSync(process.execPath, [bin, "--home", home, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(ran.status, 2, `${args.join(" ")}: ${ran.stderr}`);
    assert.match(ran.stderr, said, args.join(" "));
  }
  assert.equal(existsSync(home), false);
  assert.match(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).stdout, /receipt \[--channel LABEL\] \[--anchor\]/);
});
