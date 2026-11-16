/**
 * Transports in the Node runtime (contract 3, phase 2): two homes exchange messages over the local network with
 * aamio.at out of reach.
 *
 * The lan transport from addons/lan runs on 127.0.0.1, each home on a UDP port of its own with the other named as its
 * peer and broadcast off, so nothing leaves the machine. The service is at http://127.0.0.1:9, where nobody answers:
 * what arrives came over the transport. enable reads the transport from its manifest and probes it; the commands bind
 * and unbind and keep the profiles; and two processes, as two machines run them, exchange a message: one reads and
 * waits, or serves, and the other sends. The tests of the follow-up check hold two runtimes in this process, each with
 * its own transport, so they can look at what each of them kept, said and archived.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probe } from "../src/node-addon-process.js";
import { describe as describeAddons, enable } from "../src/node-addons.js";
import { CarryState, mark } from "../src/node-carry-state.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import * as transports from "../src/node-transports.js";
import { FakeAamio } from "./fake-aamio.mjs";

const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const lanDir = fileURLToPath(new URL("../addons/lan/", import.meta.url));
const NOWHERE = "http://127.0.0.1:9";

async function freePorts(count) {
  const sockets = [];
  for (let i = 0; i < count; i++) {
    const socket = createSocket("udp4");
    await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
    sockets.push(socket);
  }
  const ports = sockets.map((socket) => socket.address().port);
  await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
  return ports;
}

const lanVariables = (port, peer) => ({ AAMIO_LAN_PORT: String(port), AAMIO_LAN_BIND: "127.0.0.1", AAMIO_LAN_BROADCAST: "none", AAMIO_LAN_PEERS: `127.0.0.1:${peer}` });

/** aamio-lan as npm leaves it in a home's folder for add-ons, with the home's identity made first. */
async function homeWithLan(dir, name) {
  const home = join(dir, name);
  await initIdentity(home);
  const root = join(home, "addon-packages", "npm");
  const pkg = join(root, "node_modules", "aamio-lan");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "aamio-lan": "0.1.0" } }));
  for (const file of ["package.json", "aamio-addon.json", "transport.js"]) copyFileSync(join(lanDir, file), join(pkg, file));
  return home;
}

/** A folder of the test's own for the transports' working folders, in place of the user's. */
function stateFolder(t, dir) {
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = join(dir, "state");
  process.env.XDG_STATE_HOME = join(dir, "state");
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function pair(dir) {
  const homes = {};
  for (const name of ["a", "b"]) {
    homes[name] = await homeWithLan(dir, name);
    await enable(homes[name], "lan", { probe });
  }
  const a = await NodeRuntime.open({ home: homes.a, host: NOWHERE });
  const b = await NodeRuntime.open({ home: homes.b, host: NOWHERE });
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await transports.bind(a, "b", "lan");
  await transports.bind(b, "a", "lan");
  await a.close();
  await b.close();
  return homes;
}

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return null;
};

test("enable reads a transport from its manifest, probes it, and says what it gets", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-transports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  stateFolder(t, dir);
  const home = await homeWithLan(dir, "home");
  const row = (await describeAddons(home)).addons[0];
  assert.deepEqual([row.name, row.contract, row.enabled, row.medium, row.permissions], ["lan", 3, false, "lan", ["network_local"]], JSON.stringify(row));
  assert.deepEqual(row.environment, ["AAMIO_LAN_PORT", "AAMIO_LAN_BIND", "AAMIO_LAN_BROADCAST", "AAMIO_LAN_PEERS"]);
  const said = await enable(home, "lan", { probe });
  assert.equal(said.addons[0].enabled, true);
  assert.deepEqual(said.addons[0].mcp_tools, []);
  for (const words of ["is a transport here from now on", "never the home's key", "network_local", "aamio transport bind PARTNER lan"]) assert.ok(said.note.includes(words), said.note);
  const folder = transports.workingFolder(home, "lan", { make: false });
  assert.ok(existsSync(folder) && !folder.startsWith(home), folder);
});

test("the commands bind, keep the profiles, and stop a send whose bindings cannot be read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-transports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  stateFolder(t, dir);
  const homes = {};
  for (const name of ["c", "d"]) {
    homes[name] = await homeWithLan(dir, name);
    await enable(homes[name], "lan", { probe });
  }
  const c = await NodeRuntime.open({ home: homes.c, host: NOWHERE });
  const d = await NodeRuntime.open({ home: homes.d, host: NOWHERE });
  try {
    await commandsOn(c, d, homes);
  } finally {
    await c.close();
    await d.close();
  }
});

async function commandsOn(c, d, homes) {
  await c.partnerAdd("d", d.keys.public);
  const bound = await transports.bind(c, "d", "lan");
  assert.deepEqual(bound.routes, [{ transport: "lan", profile: "sealed" }]);
  assert.ok(bound.note.includes("never over HTTPS instead"));
  const readable = transports.profileAdd(c, "open-lan", { readable: true, lifetime: 300, window: 30 });
  assert.equal(readable.profile.mode, "readable");
  assert.ok(readable.note.includes("everyone who hears the medium can read"));
  assert.equal(await code(Promise.resolve().then(() => transports.profileAdd(c, "short", { lifetime: 20, window: 30 }))), "transport_profile_invalid");
  assert.equal(await code(Promise.resolve().then(() => transports.profileAdd(c, "Big Name"))), "transport_profile_invalid");
  assert.equal(await code(Promise.resolve().then(() => transports.profileRemove(c, "sealed"))), "transport_profile_in_use");
  assert.equal(await code(Promise.resolve().then(() => transports.profileAdd(c, "sealed", { readable: true }))), "transport_profile_in_use", "not changed under a bound partner");
  assert.equal(await code(transports.bind(c, "d", "radio")), "transport_unknown");
  const listed = await transports.listing(c);
  assert.deepEqual(listed.transports.map((row) => [row.name, row.partners]), [["lan", ["d"]]]);
  assert.equal(listed.profiles.length, 2);
  assert.deepEqual(transports.unbind(c, "d").routes, []);
  assert.ok(readFileSync(join(homes.c, "transports", "bindings.json"), "utf8").includes('"partners":{}'), "an empty map is written as an object, as the other runtimes read it");
  await transports.bind(c, "d", "lan");
  writeFileSync(join(homes.c, "transports", "bindings.json"), "{not json");
  assert.equal(await code(c.send("d", { text: "hvor?" })), "transport_config_unreadable");
  assert.deepEqual(c.outboxPending(), [], "nothing went over HTTPS instead");
}

function start(home, args, env, input = false) {
  const child = spawn(process.execPath, [bin, "--home", home, "--host", NOWHERE, ...args], { env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  const ended = new Promise((resolve) => child.on("exit", (status) => resolve(status)));
  const stderr = () => Buffer.concat(err).toString("utf8");
  const up = async (seconds = 20) => {
    const until = Date.now() + seconds * 1000;
    while (!stderr().includes("transport lan: up")) {
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  };
  return { child, ended, up, stdout: () => Buffer.concat(out).toString("utf8"), stderr };
}

test("the command line hosts the transport while read waits, and serve while it waits for the next line", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-transports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  stateFolder(t, dir);
  const homes = await pair(dir);
  const [portA, portB] = await freePorts(2);
  const env = (port, peer) => ({ ...process.env, ...lanVariables(port, peer) });

  const reader = start(homes.b, ["read", "--wait", "25"], env(portB, portA));
  assert.ok(await reader.up(), reader.stderr());
  const sent = spawnSync(process.execPath, [bin, "--home", homes.a, "--host", NOWHERE, "send", "b", "hei fra kommandolinjen"], { encoding: "utf8", timeout: 60_000, env: env(portA, portB) });
  const answer = JSON.parse(sent.stdout);
  assert.equal(sent.status, 0, sent.stderr);
  assert.deepEqual([answer.status, answer.via], ["confirmed", "lan"], sent.stdout);
  assert.equal(await reader.ended, 0, reader.stderr());
  const read = JSON.parse(reader.stdout());
  assert.deepEqual(read.messages.map((message) => message.body.text), ["hei fra kommandolinjen"], reader.stdout());
  assert.equal(read.messages[0].channel, "lan");
  assert.equal(read.messages[0].encrypted, true);
  assert.ok(read.attention.some((note) => note.channel === "inbox" && note.state === "unreachable"), "the inbox it could not reach is said");

  const server = start(homes.b, ["serve"], env(portB, portA), true);
  assert.ok(await server.up(), server.stderr());
  const toServer = spawnSync(process.execPath, [bin, "--home", homes.a, "--host", NOWHERE, "send", "b", "hei til serveren"], { encoding: "utf8", timeout: 60_000, env: env(portA, portB) });
  assert.equal(JSON.parse(toServer.stdout).status, "confirmed", toServer.stdout + toServer.stderr);
  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aamio_read", arguments: { wait: 0 } } }) + "\n");
  const until = Date.now() + 20_000;
  let readAnswer = null;
  while (readAnswer === null && Date.now() < until) {
    for (const line of server.stdout().split("\n")) {
      try {
        const message = JSON.parse(line);
        if (message.id === 2) readAnswer = message.result?.structuredContent ?? null;
      } catch {
        // A line not yet whole.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server.child.stdin.end();
  await server.ended;
  assert.deepEqual((readAnswer?.messages ?? []).map((message) => message.body.text), ["hei til serveren"], server.stdout() + server.stderr());
});

// ------------------------------------------------------------------ the follow-up check of 2026-11-15, findings 1, 2, 4, 6, 7 and 8
//
// Two runtimes in this process, each with its own lan transport on 127.0.0.1, as two machines run them. b takes in what
// a sends as serve does it, with its transports started, or as the command line does it, in a read that waits.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(condition, what, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  while (!condition()) {
    assert.ok(Date.now() < end, what);
    await sleep(50);
  }
}

/**
 * Homes a and b, open in this process, each the other's partner and bound to lan. open opens one of them again after it
 * was closed, against a service in memory when one is given. Every runtime has its transport on a port of its own on
 * 127.0.0.1 with broadcast off, also one a test never means to start.
 */
async function homes(t) {
  const dir = mkdtempSync(join(tmpdir(), "aamio-transports-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  stateFolder(t, dir);
  const [portA, portB] = await freePorts(2);
  const ports = { a: [portA, portB], b: [portB, portA] };
  const at = {};
  for (const name of ["a", "b"]) {
    at[name] = await homeWithLan(dir, name);
    await enable(at[name], "lan", { probe });
  }
  const open = async (name, { archive = true, fake = null } = {}) => {
    const service = fake ? { host: "https://fake.aamio", fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time } : { host: NOWHERE };
    const runtime = await NodeRuntime.open({ home: at[name], archive, ...service });
    opened.push(runtime);
    runtime.transportService().environ = { ...process.env, ...lanVariables(...ports[name]) };
    return runtime;
  };
  const a = await open("a");
  const b = await open("b");
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await transports.bind(a, "b", "lan");
  await transports.bind(b, "a", "lan");
  return { a, b, dir, at, ports, open };
}

/** The same homes after a sent the texts and b took them in without anybody reading them: b is closed, a is still open. */
async function takenInUnread(t, texts) {
  const made = await homes(t);
  await made.b.startTransports();
  for (const text of texts) assert.equal((await made.a.send("b", { text })).status, "confirmed");
  await made.b.close();
  return made;
}

/** Everything the archive of a home holds, as text. */
function archiveOf(home) {
  const folder = join(home, "archive");
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort().map((name) => readFileSync(join(folder, name), "utf8")).join("") : "";
}

const long = (n) => `${n} ${"x".repeat(600)}`;
const heads = (messages) => messages.map((message) => message.body.text.slice(0, 2));

for (const serves of [true, false]) {
  test(`follow-up finding 1: a scope shared over a transport is kept, and its key is never shown or archived, ${serves ? "as serve reads" : "as the command line reads"}`, async (t) => {
    // A scope that came over a transport went past the scope handling: the key was shown to the reader and written to
    // the archive, and no scope was kept. And the one who shared it kept the key in its archive of what it sent.
    const { a, b, at } = await homes(t);
    await a.scopeNew("review");
    const key = a.scopeKey("review").key;
    let reading = null;
    if (serves) await b.startTransports();
    else {
      reading = b.read({ wait: 25 });
      reading.catch(() => {});
      await eventually(() => b.transportService().status().lan === "up", "the reader's transport never came up");
    }
    const shared = await a.scopeShare("review", "b", "read");
    assert.deepEqual([shared.status, shared.via, shared.scope, shared.access], ["confirmed", "lan", "review", "read"], JSON.stringify(shared));
    const got = serves ? await b.read({ wait: 10 }) : await reading;
    assert.equal(got.length, 1, JSON.stringify(got));
    const view = got[0].body.data.aamio_scope;
    assert.deepEqual([view.kept, view.shared_as, view.can_read, "key" in view], [true, "review", true, false], JSON.stringify(view));
    assert.ok(!JSON.stringify(got).includes(key), "the key never reaches whoever reads the message");
    assert.deepEqual(b.scopeList().map((scope) => scope.name), ["a.review"]);
    assert.equal(b.scopeKey("a.review").key, key);
    assert.equal(got[0].archived, true);
    assert.ok(archiveOf(at.b).includes("a.review") && !archiveOf(at.b).includes(key), "the archive has the message, and not the key");
    const sent = archiveOf(at.a).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === "sent");
    assert.deepEqual(sent.map((row) => row.body.data), [{ aamio_scope: { name: "review", access: "read" } }], "what was shared and with whom, never the key");
    assert.ok(!archiveOf(at.a).includes(key));
  });
}

for (const serves of [true, false]) {
  test(`seen names what was read over a transport, and the sender sees it in its trace, ${serves ? "as serve reads" : "as the command line reads"}`, async (t) => {
    // seen never named a message that came over a transport: what was read over one went past the trace, where seen is
    // taken from, and a send over one was not recorded there either. In all three runtimes (the exchange over one local
    // network of 16 November 2026).
    const { a, b } = await homes(t);
    let reading = null;
    if (serves) await b.startTransports();
    else {
      reading = b.read({ wait: 25 });
      reading.catch(() => {});
      await eventually(() => b.transportService().status().lan === "up", "the reader's transport never came up");
    }
    const first = await a.send("b", { text: "første over nettet" });
    assert.equal(first.status, "confirmed", JSON.stringify(first));
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    const got = serves ? await b.read({ wait: 10 }) : await reading;
    assert.deepEqual(got.map((message) => message.sha256), [first.sha256], "both sides name it by the sha256 of its envelope");
    assert.ok(!("seen" in got[0].body), "a had read nothing of b's");

    const back = await b.send("a", { text: "svar over nettet", re: got[0].sha256 });
    assert.equal(back.status, "confirmed", JSON.stringify(back));
    assert.ok(/^[0-9a-f]{64}$/.test(back.sha256) && back.sha256 !== first.sha256, JSON.stringify(back));
    const answers = await a.read({ wait: 10 });
    assert.deepEqual(answers.map((message) => [message.body.seen, message.body.re]), [[first.sha256, first.sha256]], "b read it, and says so");
    assert.equal(answers[0].sha256, back.sha256);

    const mine = a.trace("b");
    assert.deepEqual(mine.sent.map((row) => [row.message_id, row.via, row.sha256, row.outcome, row.seen_by_them, row.answered_by_them]),
      [[first.mark, "lan", first.sha256, "confirmed", true, true]], JSON.stringify(mine));
    const sent = mine.sent[0];
    assert.ok(sent.sealed === true && sent.bytes > 0 && !("status" in sent) && !("w" in sent) && !("seq" in sent), JSON.stringify(sent));
    assert.deepEqual(sent.fields, ["from", "text"]);
    assert.deepEqual(mine.received.map((row) => [row.channel, row.sha256, row.seen, row.re]), [["lan", back.sha256, first.sha256, first.sha256]]);
    assert.equal(mine.received[0].acknowledges.sha256, first.sha256);
    assert.deepEqual(mine.no_read_claim, []);
    assert.ok(mine.note.startsWith("1 delivered, and their runtime says it read and opened 1 of them."), mine.note);
    assert.equal(mine.last_read.sha256, back.sha256, "a has read b's answer, and its next message names it");

    const theirs = b.trace("a");
    assert.deepEqual(theirs.received.map((row) => [row.channel, row.sha256]), [["lan", first.sha256]]);
    assert.deepEqual(theirs.sent.map((row) => [row.via, row.sha256, row.seen_by_them]), [["lan", back.sha256, null]]);
    assert.ok(theirs.note.includes("unknown, not unread") && theirs.note.includes("the envelope a transport carried") && !theirs.note.includes("is what the service stored"), theirs.note);
  });
}

test("follow-up finding 1: a scope is not shared under a readable profile, and one that comes readable is not kept", async (t) => {
  // Under a readable profile everyone who hears the medium would read the key, so it does not go; and a message that
  // carries one all the same has it taken out, and nothing is kept from it.
  const { a, b, at, ports } = await homes(t);
  for (const [runtime, partner] of [[a, "b"], [b, "a"]]) {
    transports.unbind(runtime, partner);
    transports.profileAdd(runtime, "open", { readable: true });
    await transports.bind(runtime, partner, "lan", "open");
  }
  await a.scopeNew("review");
  const key = a.scopeKey("review").key;
  const refused = await a.scopeShare("review", "b", "read").then(() => null, (error) => error);
  assert.equal(refused?.code, "scope_needs_sealed");
  assert.match(refused.message, /readable/);
  assert.deepEqual([a.transportService().outbox(), a.outboxPending()], [[], []], "nothing went, over the transport or over HTTPS");
  await b.startTransports();
  assert.equal((await a.send("b", { text: "by hand", data: { aamio_scope: { name: "review", key } } })).status, "confirmed");
  const got = await b.read({ wait: 10 });
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].encrypted, false);
  const view = got[0].body.data.aamio_scope;
  assert.ok(view.kept === false && view.note.includes("sealed") && !JSON.stringify(got).includes(key), JSON.stringify(view));
  assert.deepEqual(b.scopeList(), []);
  assert.ok(!archiveOf(at.b).includes(key));
  // The command line answers the refusal as it answers the others: JSON with its code, and exit status 1.
  await a.close();
  const asked = spawnSync(process.execPath, [bin, "--home", at.a, "--host", NOWHERE, "scope", "share", "review", "b", "--access", "read"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...lanVariables(...ports.a) } });
  assert.equal(asked.status, 1, asked.stderr);
  assert.equal(JSON.parse(asked.stdout).error_code, "scope_needs_sealed", asked.stdout + asked.stderr);
});

test("follow-up finding 1: a scope from a key that has since left the book is not kept, and its key is not archived", async (t) => {
  // A message that is withheld goes to the archive all the same, so the key comes out of it first.
  const { a, b, at } = await homes(t);
  await a.scopeNew("review");
  const key = a.scopeKey("review").key;
  await b.startTransports();
  assert.equal((await a.scopeShare("review", "b", "read")).status, "confirmed");
  await b.partnerRemove("a");
  assert.deepEqual(await b.read({ wait: 0 }), []);
  const notes = await b.attentionTaken();
  assert.ok(notes.some((note) => note.state === "removed_key" && note.what.includes("the archive has it")), JSON.stringify(notes));
  assert.deepEqual(b.scopeList(), []);
  const kept = archiveOf(at.b);
  assert.ok(kept.includes("left the address book") && !kept.includes(key), "the archive has the message, and not the key");
  assert.deepEqual(b.transportService().carry().pending(), []);
});

test("follow-up finding 6: the byte budget holds for what came over a transport, and only what is handed over is taken", async (t) => {
  // Three messages of 600 characters came whole on a budget of 512, all three were taken, and nothing said so.
  const made = await takenInUnread(t, [0, 1, 2].map(long));
  const b = await made.open("b", { archive: false });
  const first = await b.read({ wait: 0, maxBytes: 512 });
  assert.deepEqual(heads(first), ["0 "], "one larger than the whole budget comes on its own, as a message already here does");
  const notes = Object.fromEntries((await b.attentionTaken()).map((note) => [note.state, note]));
  assert.ok(notes.over_budget?.channel === "lan" && notes.over_budget.what.includes("512"), JSON.stringify(notes));
  assert.ok(notes.over_budget.what.includes(`is ${Buffer.byteLength(JSON.stringify(first[0]), "utf8")} bytes`), "weighed as it is handed over");
  assert.ok(notes.more_carried_bytes?.what.includes("lan") && notes.more_carried_bytes.what.includes("nothing was dropped"), JSON.stringify(notes));
  assert.equal(b.transportService().carry().pending().length, 2, "only what was handed over is taken");
  const rest = await b.read({ wait: 0, maxBytes: 4096 });
  assert.deepEqual(heads(rest), ["1 ", "2 "], "whole messages within the budget, in the order they came");
  assert.ok(!(await b.attentionTaken()).some((note) => note.state === "more_carried_bytes"));
  assert.deepEqual([b.transportService().carry().pending(), await b.read({ wait: 0, maxBytes: 512 })], [[], []]);
});

test("follow-up finding 6: a budget two messages fit under leaves the third for the next read", async (t) => {
  const made = await takenInUnread(t, [0, 1, 2].map(long));
  const b = await made.open("b", { archive: false });
  const json = (text) => ({ value: JSON.parse(text) });
  const weight = Buffer.byteLength(JSON.stringify(b.transportService().entries(json)[0]), "utf8");
  const got = await b.read({ wait: 0, maxBytes: 2 * weight + 100 });
  assert.deepEqual(heads(got), ["0 ", "1 "]);
  const states = (await b.attentionTaken()).map((note) => note.state);
  assert.ok(states.includes("more_carried_bytes") && !states.includes("over_budget"), JSON.stringify(states));
  assert.deepEqual(heads(await b.read({ wait: 0 })), ["2 "]);
});

/** One call of a tool on a server started with start: what it answered, or null when nothing came in time. */
async function call(server, id, name, args) {
  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    for (const line of server.stdout().split("\n")) {
      try {
        const message = JSON.parse(line);
        if (message.id === id) return message.result?.structuredContent ?? null;
      } catch {
        // A line not yet whole.
      }
    }
    await sleep(100);
  }
  return null;
}

test("follow-up finding 6, over MCP: aamio_read holds the same budget for what came over a transport", async (t) => {
  const made = await takenInUnread(t, [0, 1, 2].map(long));
  const server = start(made.at.b, ["serve"], { ...process.env, ...lanVariables(...made.ports.b) }, true);
  try {
    server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
    server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const first = await call(server, 2, "aamio_read", { wait: 0, max_bytes: 512 });
    assert.deepEqual(heads(first?.messages ?? []), ["0 "], server.stdout() + server.stderr());
    assert.ok(first.attention.some((note) => note.channel === "lan" && note.state === "over_budget"), JSON.stringify(first.attention));
    assert.ok(first.attention.some((note) => note.channel === "read" && note.state === "more_carried_bytes"), JSON.stringify(first.attention));
    const rest = await call(server, 3, "aamio_read", { wait: 0 });
    assert.deepEqual(heads(rest?.messages ?? []), ["1 ", "2 "], server.stdout() + server.stderr());
  } finally {
    server.child.stdin.end();
    await server.ended;
  }
});

for (const serves of [true, false]) {
  test(`follow-up finding 7: what came before the last unbind is still read, ${serves ? "as serve reads" : "as the command line reads"}`, async (t) => {
    // read asked whether a partner was bound before it looked at what had come, so after the last unbind a message
    // that waited was not read, while unbind said it still would be.
    const made = await takenInUnread(t, ["before the unbind"]);
    const b = await made.open("b", { archive: false });
    const said = transports.unbind(b, "a");
    assert.deepEqual(said.routes, []);
    assert.ok(said.note.includes("is still read"), said.note);
    if (serves) assert.equal(await b.startTransports(), false);
    const got = await b.read({ wait: serves ? 3 : 0 });
    assert.deepEqual(got.map((message) => message.body.text), ["before the unbind"], JSON.stringify(got));
    assert.deepEqual([got[0].channel, got[0].sender, got[0].profile], [transports.UNBOUND_CHANNEL, "a", null]);
    assert.deepEqual(b.transportService().carry().pending(), []);
    assert.deepEqual(b.transportService().status(), {}, "nothing is bound, so no transport was started to read it");
  });
}

test("follow-up finding 7: a message from a key that left the book is still withheld after the last unbind", async (t) => {
  // The check against the address book stays: what waits from a key no longer in it is not handed over.
  const made = await takenInUnread(t, ["from one who left"]);
  const b = await made.open("b", { archive: false });
  await b.partnerRemove("a");
  assert.deepEqual(new transports.Config(made.at.b).bindings(), {});
  assert.deepEqual(await b.read({ wait: 0 }), []);
  assert.ok((await b.attentionTaken()).some((note) => note.state === "removed_key"));
  assert.deepEqual(b.transportService().carry().pending(), []);
});

test("follow-up finding 8: a transport no partner is bound to any more is stopped, and one bound again is started", async (t) => {
  // After the only partner was removed the transport ran on, held its port and would have been started again after a stop.
  const { a, b, ports } = await homes(t);
  await b.startTransports();
  const service = b.transportService();
  await eventually(() => service.status().lan === "up", "the transport never came up");
  const child = service.running.get("lan").process.child;
  assert.equal(child.exitCode, null);
  await b.partnerRemove("a");
  await eventually(() => !("lan" in service.status()), "the transport was not taken out of what runs");
  await eventually(() => child.exitCode !== null || child.signalCode !== null, "the transport process lived on");
  assert.ok(await portIsFree(ports.b[0]), "the port is given back");
  await b.partnerAdd("a", a.keys.public);
  await transports.bind(b, "a", "lan");
  await eventually(() => service.status().lan === "up", "a transport bound again was not started");
  assert.equal((await a.send("b", { text: "after the new binding" })).status, "confirmed");
  assert.deepEqual((await b.read({ wait: 10 })).map((message) => message.body.text), ["after the new binding"]);
});

/** Whether nothing holds the UDP port a home's transport listens on. */
async function portIsFree(port) {
  const holder = createSocket({ type: "udp4", reuseAddr: false });
  const free = await new Promise((resolve) => {
    holder.once("error", () => resolve(false));
    holder.bind({ port, address: "127.0.0.1", exclusive: true }, () => resolve(true));
  });
  await new Promise((resolve) => holder.close(resolve));
  return free;
}

test("follow-up finding 8, in Node: a transport is started once when two callers start the service at the same moment", async (t) => {
  // The refresh starts a transport bound meanwhile, and a send or a read starts the service too. Two starts of one
  // transport gave two processes, and the one the service kept could be the one that found the port taken.
  const { b } = await homes(t);
  const said = [];
  b.log = (line) => said.push(line);
  const service = b.transportService();
  await Promise.all([service.start(), service.start()]);
  await eventually(() => service.status().lan === "up", "the transport never came up");
  assert.equal(said.filter((line) => line === "transport lan: up").length, 1, JSON.stringify(said));
});

for (const how of ["startTransports", "read"]) {
  test(`a start under way when the owner closes adds and starts nothing after it, through ${how}`, async (t) => {
    // The check of 16 November 2026: a start that was reading the manifests when close ran went on after the home had
    // been let go of. It added the transport and started it and the service's loop, in a runtime that was closed, and
    // the port was held while another runtime could have the home.
    const made = await homes(t);
    const b = made.b;
    const service = b.transportService();
    const read = service.manifests.bind(service);
    let letGo = null;
    const held = new Promise((resolve) => {
      letGo = resolve;
    });
    let reading = 0;
    service.manifests = async () => {
      const found = await read();
      reading += 1;
      await held;
      return found;
    };
    const starting = (how === "read" ? b.read({ wait: 0.05 }) : b.startTransports()).catch(() => null);
    await eventually(() => reading > 0, "the start never read the manifests");
    let closed = false;
    const closing = b.close().then(() => {
      closed = true;
    });
    await sleep(300);
    assert.equal(closed, false, "close waits for the start that is under way");
    letGo();
    await Promise.all([starting, closing]);
    assert.deepEqual(service.status(), {}, "nothing was added after the stop");
    assert.ok(await portIsFree(made.ports.b[0]), "and no transport was started");
    // The home and the port are free for the next owner.
    const again = await made.open("b");
    assert.equal(await again.startTransports(), true);
    await eventually(() => again.transportService().status().lan === "up", "the next owner's transport never came up");
  });
}

test("follow-up finding 4, in the service: a transport whose carrier cannot be made stays down with the reason, and its process is stopped", async (t) => {
  // A carrier state that refuses, as it now does to every read after a failed write, threw out of the start with the
  // transport's process left running, and the next round started another.
  const made = await homes(t);
  await made.b.close();
  mkdirSync(join(made.at.b, "transports"), { recursive: true });
  writeFileSync(join(made.at.b, "transports", "carry.json"), "{not json");
  const b = await made.open("b", { archive: false });
  const said = [];
  b.log = (line) => said.push(line);
  const service = b.transportService();
  await service.start();
  assert.match(service.status().lan, /^down: carry_state_unreadable: .* It stays down until that is put right and aamio starts again$/);
  assert.ok(await portIsFree(made.ports.b[0]), "the transport's process is gone");
  await sleep(1500);
  assert.equal(said.filter((line) => line.includes("carry_state_unreadable")).length, 1, "said once, and not started again");
  const refused = await b.send("a", { text: "nowhere" }).then(() => null, (error) => error);
  assert.equal(refused?.code, "transport_down");
  assert.match(refused.message, /carry_state_unreadable.*Nothing was sent\.$/);
});

test("follow-up finding 2, through the runtime: a message written readable is given up and said when the partner is bound sealed", async (t) => {
  // The owner takes the outbox up, gives the readable message up, and says so in attention.
  const { a, b } = await homes(t);
  await b.close();
  const readable = transports.checked(transports.profileRecord("open", { mode: "readable" }));
  const service = a.transportService();
  const state = service.carry();
  const other = new CarryState(b.keys);
  const now = Math.floor(Date.now() / 1000);
  const [session, ask] = state.ask(b.keys.publicRaw, readable, 0);
  const [, challenge] = other.deliver(ask, [a.keys.publicRaw], readable, 0, now);
  state.deliver(challenge, [b.keys.publicRaw], readable, 0, now);
  state.send(b.keys.publicRaw, session, new TextEncoder().encode("readable"), readable);
  const key = mark(b.keys.publicRaw, session, 1);
  await service.start();
  await eventually(() => service.status().lan === "up", "the transport never came up");
  await eventually(() => service.outbox()[0]?.outcome === "unknown", "the readable message was not given up", 5);
  assert.deepEqual(service.outbox(), [{ mark: key, outcome: "unknown" }]);
  const notes = (await a.attentionTaken()).filter((note) => note.state === "not_sent_again");
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.ok(notes[0].channel === "lan" && notes[0].what.includes(key) && notes[0].what.includes("sealed"), JSON.stringify(notes));
});

test("follow-up finding 4, through the runtime: a carrier state closed after a failed write is said, and the read goes on", async (t) => {
  // The read handed over what the state held in memory, and then could not mark it as taken.
  const made = await takenInUnread(t, ["kept through a failed write"]);
  const b = await made.open("b", { archive: false });
  const service = b.transportService();
  const file = service.config.statePath();
  mkdirSync(`${file}.tmp`);
  assert.throws(() => service.carry().prune(Math.floor(Date.now() / 1000)), { code: "carry_storage_failed" });
  assert.deepEqual(await b.read({ wait: 0 }), [], "nothing is handed over from memory");
  const notes = await b.attentionTaken();
  assert.ok(notes.some((note) => note.channel === "transports" && note.state === "carry_unreadable" && note.what.includes("carry_storage_failed")), JSON.stringify(notes));
  assert.ok(notes.some((note) => note.channel === "inbox" && note.state === "unreachable"), "the read went on to the inbox, which it could not reach");
  rmdirSync(`${file}.tmp`);
  service.carry().restart();
  assert.deepEqual((await b.read({ wait: 0 })).map((message) => message.body.text), ["kept through a failed write"]);
});

test("follow-up finding 4, through the runtime: a carrier state that cannot be read is said, bound or not, and the read goes on", async (t) => {
  // With a partner bound the whole read failed; with none bound the state is asked now, for what waits to be read.
  const fake = new FakeAamio();
  const made = await homes(t);
  await made.b.close();
  mkdirSync(join(made.at.b, "transports"), { recursive: true });
  writeFileSync(join(made.at.b, "transports", "carry.json"), "{not json");
  const b = await made.open("b", { archive: false, fake });
  for (const bound of [true, false]) {
    if (!bound) transports.unbind(b, "a");
    assert.deepEqual(await b.read({ wait: 0 }), [], bound ? "bound" : "not bound");
    const notes = await b.attentionTaken();
    assert.ok(notes.some((note) => note.channel === "transports" && note.state === "carry_unreadable" && note.what.includes("carry_state_unreadable")), JSON.stringify(notes));
    assert.ok(b.channel("inbox") !== null && !notes.some((note) => note.channel === "inbox"), "the read went on to the inbox");
  }
});
