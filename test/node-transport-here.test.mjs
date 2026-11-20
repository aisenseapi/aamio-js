/**
 * Where things are reached: where a transport is reached (contract 3, B3: here), where a partner is reached (bind
 * --address, and what a fresh envelope shows), and what a send that found nobody says. The same cases as aamio-python's
 * tests/test_transport_here.py, over the local network on 127.0.0.1 where that test has its simulated Bluetooth: Node has
 * no Bluetooth transport. Broadcast is off and every peer is on 127.0.0.1, so nothing leaves this machine.
 *
 * Found in the field test over real Bluetooth of 19 November 2026: the address had to be typed by hand, a machine had
 * another address than the day before, nothing kept where the partner had been heard from, and the send said "the same
 * network" and nothing of what the transport knew.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keys } from "../src/aamio.js";
import { probe } from "../src/node-addon-process.js";
import { enable } from "../src/node-addons.js";
import { Carrier } from "../src/node-carrier.js";
import { CarryState, profile } from "../src/node-carry-state.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { TransportProcess, environment, hereOf, textOf } from "../src/node-transport-host.js";
import * as transports from "../src/node-transports.js";

const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const lanDir = fileURLToPath(new URL("../addons/lan/", import.meta.url));
const LAN_VERSION = JSON.parse(readFileSync(join(lanDir, "aamio-addon.json"), "utf8")).version;
const LAN_VARIABLES = ["AAMIO_LAN_PORT", "AAMIO_LAN_BIND", "AAMIO_LAN_BROADCAST", "AAMIO_LAN_PEERS"];
const NOWHERE = "http://127.0.0.1:9";
const A = Keys.fromSeedHex("01".repeat(32));
const B = Keys.fromSeedHex("02".repeat(32));
const baseEnv = Object.fromEntries(["PATH", "SYSTEMROOT", "TEMP", "TMP"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const bytes = (value) => new TextEncoder().encode(value);
const hex = (key) => Buffer.from(key).toString("hex");

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

/** Whether nothing holds the UDP port. */
async function portIsFree(port) {
  const holder = createSocket({ type: "udp4", reuseAddr: false });
  const free = await new Promise((resolve) => {
    holder.once("error", () => resolve(false));
    holder.bind({ port, address: "127.0.0.1", exclusive: true }, () => resolve(true));
  });
  await new Promise((resolve) => holder.close(resolve));
  return free;
}

/** The lan transport on 127.0.0.1 at port, broadcast off, with the peers named and no other. */
const lanOnly = (port, peers = []) => ({ AAMIO_LAN_PORT: String(port), AAMIO_LAN_BIND: "127.0.0.1", AAMIO_LAN_BROADCAST: "none",
  AAMIO_LAN_PEERS: peers.map((peer) => `127.0.0.1:${peer}`).join(",") });

/** The lan transport started, its describe read and nothing else waited for. */
async function lan(port, peers, folder) {
  mkdirSync(folder, { recursive: true });
  const transport = new TransportProcess("lan", LAN_VERSION, [process.execPath, join(lanDir, "transport.js")], folder,
    environment(LAN_VARIABLES, { ...baseEnv, ...lanOnly(port, peers) }), { describeSeconds: 30 });
  await transport.start("0.0.0-test", "node", folder);
  return transport;
}

/** The events until a ready gave room. */
async function untilRoom(transport, seconds = 15) {
  const events = [];
  const until = Date.now() + seconds * 1000;
  while (transport.room() <= 0) {
    assert.ok(Date.now() < until, JSON.stringify(events));
    events.push(...(await transport.poll(50)));
  }
  return events;
}

async function pumpUntil(carriers, condition, seconds = 30) {
  const until = Date.now() + seconds * 1000;
  while (!condition()) {
    assert.ok(Date.now() < until, JSON.stringify(carriers.map((carrier) => [carrier.refused, [...carrier.addresses]])));
    for (const carrier of carriers) await carrier.pump(10);
  }
}

const failure = (promise) => promise.then(() => null, (error) => error);

// ------------------------------------------------------------- here, in the host

test("here is a short list of the transport's own addresses", () => {
  assert.deepEqual(hereOf(["bt:8C:1D:55:03:7B:53"], "bt"), ["bt:8C:1D:55:03:7B:53"]);
  assert.deepEqual(hereOf(["lan:10.0.0.7:47474", "lan:10.0.0.8:47474"], "lan"), ["lan:10.0.0.7:47474", "lan:10.0.0.8:47474"]);
  assert.deepEqual(hereOf([], "bt"), []);
  for (const bad of [["lan:10.0.0.7:47474"], ["bt:"], ["bt:a b"], ["bt:x", "bt:x"], [0, 1, 2, 3, 4].map((n) => `bt:${n}`), "bt:x", [7], ["bt:" + "x".repeat(126)], null, ["bt:ø"]]) {
    assert.equal(hereOf(bad, "bt"), null, JSON.stringify(bad));
  }
});

test("a ready with here is said once, and a here that cannot be taken stops nothing", async () => {
  const logged = [];
  const transport = new TransportProcess("bt", "0.1.0", [], null, {}, { log: (line) => logged.push(line) });
  transport.medium = "bt";
  const take = async (more = {}) => {
    transport.inject(JSON.stringify({ t: "ready", credit: 1, sends_read: 0, ...more }));
    return transport.poll(0);
  };
  assert.equal(transport.readied, false);
  assert.deepEqual(await take({ here: ["bt:8C:1D:55:03:7B:53"] }), [["here", ["bt:8C:1D:55:03:7B:53"]]]);
  assert.equal(transport.readied, true);
  assert.deepEqual(await take({ here: ["bt:8C:1D:55:03:7B:53"] }), [], "the same again is nothing new");
  assert.deepEqual(await take({ here: ["lan:10.0.0.7:47474"] }), []);
  assert.ok(logged.at(-1).includes("here is not taken"), logged.at(-1));
  assert.deepEqual([transport.here, transport.room(), transport.failed], [["bt:8C:1D:55:03:7B:53"], 1, null], "a hint never stops a transport");
  assert.deepEqual(await take(), []);
  assert.deepEqual(transport.here, ["bt:8C:1D:55:03:7B:53"], "a ready without here leaves it as it was");
  assert.deepEqual(await take({ here: ["bt:DC:FB:48:D5:EA:C0"] }), [["here", ["bt:DC:FB:48:D5:EA:C0"]]], "another day, another address");
});

test("what a transport says of a frame it could not send is kept, at most 300 characters of it", async () => {
  const logged = [];
  const transport = new TransportProcess("lan", LAN_VERSION, [], null, {}, { clock: () => 7, log: (line) => logged.push(line) });
  transport.frames.set("f-1", { status: "waiting", deadline: 2000, late: false, answered: false });
  transport.inject(JSON.stringify({ t: "error", code: "down", message: "said of no frame" }));
  transport.inject(JSON.stringify({ t: "error", id: "f-1", code: "nowhere", message: "ø".repeat(400) }));
  await transport.poll(0);
  assert.deepEqual([transport.status("f-1"), transport.lastError], ["not_sent", { at: 7, code: "nowhere", message: "ø".repeat(300) }]);
  assert.ok(logged.includes("transport lan: said of no frame"), "an error for no frame is said, and is not one of a frame");
});

test("standard error that is not UTF-8 is read in the system's code page", () => {
  assert.equal(textOf(Buffer.from("et tilkoblingsforsøk", "utf8")), "et tilkoblingsforsøk");
  const said = textOf(Buffer.from("et tilkoblingsforsøk", "latin1"));
  assert.ok(typeof said === "string" && said.startsWith("et tilkoblingsfors"), said);
  if (process.platform === "win32") assert.equal(said, "et tilkoblingsforsøk", "as the field test's Norwegian Windows wrote it");
});

/**
 * A transport that never says where it is reached, as one over a medium without addresses, as sound: describe, a ready
 * without here, and an error for every frame. It says each start that is not a probe in started.txt in its folder, and
 * writes a line to standard error first in windows-1252, as a Python transport on Norwegian Windows did.
 */
const STUB = `"use strict";
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stderr.write(Buffer.concat([Buffer.from("stub: et tilkoblingsfors"), Buffer.from([0xf8]), Buffer.from("k\\n")]));
let read = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.t === "hello") {
    say({ t: "describe", name: "stub", version: "0.1.0", aamio_addon: 3, medium: "stub",
      properties: { max_frame_up: 1200, max_frame_down: 1200, rate_up: 1000000, rate_down: 1000000, direction: "duplex", addressing: "none",
        link_ack: false, airtime: null, metadata_visible_to: "range", medium_encrypts: false } });
    if (message.probe !== true) {
      appendFileSync("started.txt", "started\\n");
      say({ t: "ready", credit: 1, sends_read: 0 });
    }
  } else if (message.t === "send") {
    read += 1;
    say({ t: "error", id: message.id, code: "nowhere", message: "nobody hears this stub." });
    say({ t: "ready", credit: 1, sends_read: read });
  } else if (message.t === "stop") {
    process.exit(0);
  }
}).on("close", () => process.exit(0));
`;

/** The stub as npm leaves it in a home: its package.json, its manifest as a transport over the medium stub, and STUB. */
const STUB_PACKAGE = {
  "package.json": JSON.stringify({ name: "aamio-stub", version: "0.1.0", aamioAddon: "./aamio-addon.json" }),
  "aamio-addon.json": JSON.stringify({ aamio_addon: 3, name: "stub", version: "0.1.0", description: "A transport that never says where it is reached.",
    transport: { medium: "stub", start: { node: "transport.js" }, platforms: ["linux", "darwin", "win32"], permissions: [] } }),
  "transport.js": STUB,
};

test("a transport's own words on standard error are read in the system's code page when they are not UTF-8", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "aamio-here-stub-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const logged = [];
  const transport = new TransportProcess("stub", "0.1.0", [process.execPath, "-e", STUB], folder, environment([], baseEnv), { log: (line) => logged.push(line), describeSeconds: 30 });
  try {
    await transport.start("0.0.0-test", "node", folder);
    await untilRoom(transport);
    const until = Date.now() + 5000;
    while (!logged.some((line) => line.startsWith("transport stub: stub: et tilkoblingsfors")) && Date.now() < until) await transport.poll(50);
    const line = logged.find((said) => said.startsWith("transport stub: stub: et tilkoblingsfors"));
    assert.ok(line, JSON.stringify(logged));
    if (process.platform === "win32") assert.equal(line, "transport stub: stub: et tilkoblingsforsøk");
    assert.equal(transport.here, null, "a ready without here says nothing of where it is reached");
  } finally {
    await transport.stop();
  }
});

test("the local network says the address it listens on", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "aamio-here-lan-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [port] = await freePorts(1);
  const transport = await lan(port, [], folder);
  try {
    const events = await untilRoom(transport);
    assert.deepEqual(transport.here, [`lan:127.0.0.1:${port}`]);
    assert.ok(events.some((event) => event[0] === "here" && event[1][0] === `lan:127.0.0.1:${port}`), JSON.stringify(events));
  } finally {
    await transport.stop();
  }
});

test("on 0.0.0.0 the local network says this machine's own addresses, the one a route takes first", async (t) => {
  // test/lan-any-address.mjs, loaded into the transport's process, binds 0.0.0.0 as 127.0.0.1 and answers the route's
  // question with 10.9.8.7, so nothing listens beyond this machine and the first address is known.
  const folder = mkdtempSync(join(tmpdir(), "aamio-here-any-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [port] = await freePorts(1);
  const env = environment(LAN_VARIABLES, { ...baseEnv, ...lanOnly(port), AAMIO_LAN_BIND: "0.0.0.0" });
  env.AAMIO_TEST_ROUTE = "10.9.8.7";
  const transport = new TransportProcess("lan", LAN_VERSION, [process.execPath, "--import", new URL("./lan-any-address.mjs", import.meta.url).href, join(lanDir, "transport.js")],
    folder, env, { describeSeconds: 30 });
  try {
    await transport.start("0.0.0-test", "node", folder);
    await untilRoom(transport);
    const mine = ["10.9.8.7"];
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal && !mine.includes(entry.address) && !/^(?:127\.|169\.254\.|0\.0\.0\.0$)/.test(entry.address)) mine.push(entry.address);
      }
    }
    assert.deepEqual(transport.here, mine.slice(0, 4).map((ip) => `lan:${ip}:${port}`), "the route's first, then the others, at most four, without loopback and link-local ones");
  } finally {
    await transport.stop();
  }
});

// ------------------------------------------------------------- what moves a partner's address

test("a fresh envelope moves the address, and an ask played again from another machine does not", async (t) => {
  // An ask can be played again from anywhere: had it moved the address, every message would go to the machine that
  // played it. A's ask is caught on its way to a B that is not there yet, and played to B from a third socket.
  const folder = mkdtempSync(join(tmpdir(), "aamio-here-replay-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [portA, portB, portC] = await freePorts(3);
  const caught = [];
  const radioA = await lan(portA, [portB], join(folder, "a"));
  const given = radioA.send.bind(radioA);
  radioA.send = (frame, to = null, deadlineMs = 30000) => {
    caught.push(frame);
    return given(frame, to, deadlineMs);
  };
  let radioB = null;
  const third = createSocket("udp4");
  try {
    const chosen = profile({ mode: "sealed" });
    const atA = new Carrier(new CarryState(A, join(folder, "a.json")), radioA, chosen, [B.publicRaw], { askRetrySeconds: 60 });
    atA.open(B.publicRaw);
    await pumpUntil([atA], () => caught.length > 0);
    radioB = await lan(portB, [], join(folder, "b"));
    const heard = [];
    const atB = new Carrier(new CarryState(B, join(folder, "b.json")), radioB, chosen, [A.publicRaw], { heard: (pk, address) => heard.push([hex(pk), address]) });
    // B's port is open once its ready came: a datagram before that is lost.
    await pumpUntil([atB], () => radioB.room() > 0);
    const answers = [];
    third.on("message", (data) => answers.push(data));
    await new Promise((resolve) => third.bind(portC, "127.0.0.1", resolve));
    await new Promise((resolve) => third.send(Buffer.concat([Buffer.from("AL1"), randomBytes(8), caught[0]]), portB, "127.0.0.1", resolve));
    await pumpUntil([atB], () => answers.length > 0, 10);
    assert.ok(answers[0].subarray(0, 3).equals(Buffer.from("AL1")), "the ask was taken and answered with a challenge, to where it came from");
    assert.deepEqual([atB.addresses.has(hex(A.publicRaw)), heard], [false, []], "an ask moves no address");
  } finally {
    await radioA.stop();
    if (radioB !== null) await radioB.stop();
    await new Promise((resolve) => third.close(resolve));
  }
});

test("where a partner was heard from fresh is kept and said, and where the transport is reached is told", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "aamio-here-fresh-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [portA, portB] = await freePorts(2);
  const radios = [await lan(portA, [portB], join(folder, "a")), await lan(portB, [portA], join(folder, "b"))];
  try {
    const chosen = profile({ mode: "sealed" });
    const heardA = [];
    const heardB = [];
    const hereA = [];
    const logged = [];
    const atA = new Carrier(new CarryState(A, join(folder, "a.json")), radios[0], chosen, [B.publicRaw], { retrySeconds: 1, askRetrySeconds: 3,
      heard: (pk, address) => heardA.push([hex(pk), address]), onHere: (here) => hereA.push(here) });
    const atB = new Carrier(new CarryState(B, join(folder, "b.json")), radios[1], chosen, [A.publicRaw], { retrySeconds: 1, askRetrySeconds: 3,
      heard: (pk, address) => heardB.push([hex(pk), address]), nameOf: () => "a", log: (line) => logged.push(line) });
    atA.open(B.publicRaw);
    await pumpUntil([atA, atB], () => atA.openSession(B.publicRaw) !== null);
    assert.deepEqual(heardA, [[hex(B.publicRaw), `lan:127.0.0.1:${portB}`]], "the challenge answers A's own ask: fresh");
    assert.deepEqual(hereA, [[`lan:127.0.0.1:${portA}`]], "the transport said where it is reached, once");
    const sent = atA.send(B.publicRaw, atA.openSession(B.publicRaw), bytes("hei"));
    await pumpUntil([atA, atB], () => atA.confirmed(sent) && atB.inbox.length > 0);
    assert.deepEqual(heardB, [[hex(A.publicRaw), `lan:127.0.0.1:${portA}`]], "the open answers B's own challenge: fresh, and said once");
    assert.ok(logged.includes("transport lan: a message came in from a"), JSON.stringify(logged));
  } finally {
    for (const radio of radios) await radio.stop();
  }
});

// ------------------------------------------------------------- through the core

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

/** A home with an identity, and a package in its folder for add-ons as npm leaves it. */
async function homeWith(dir, name, distribution, version, files) {
  const home = join(dir, name);
  await initIdentity(home);
  const root = join(home, "addon-packages", "npm");
  const pkg = join(root, "node_modules", distribution);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { [distribution]: version } }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(pkg, file), text);
  return home;
}

const homeWithLan = (dir, name) => homeWith(dir, name, "aamio-lan", LAN_VERSION,
  Object.fromEntries(["package.json", "aamio-addon.json", "transport.js"].map((file) => [file, readFileSync(join(lanDir, file))])));

/** Homes a and b with lan enabled and open in this process, each with a port of its own; partners of each other unless said. */
async function lanHomes(t, { partners = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aamio-here-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  stateFolder(t, dir);
  const [portA, portB, gone] = await freePorts(3);
  const ports = { a: portA, b: portB, gone };
  const at = {};
  for (const name of ["a", "b"]) {
    at[name] = await homeWithLan(dir, name);
    await enable(at[name], "lan", { probe });
  }
  const open = async (name) => {
    const runtime = await NodeRuntime.open({ home: at[name], host: NOWHERE });
    opened.push(runtime);
    runtime.transportService().environ = { ...process.env, ...lanOnly(ports[name]) };
    return runtime;
  };
  const a = await open("a");
  const b = await open("b");
  if (partners) {
    await a.partnerAdd("b", b.keys.public);
    await b.partnerAdd("a", a.keys.public);
  }
  return { a, b, at, ports, open, dir };
}

test("a bound address needs no peers, and the answer goes where the partner was heard", async (t) => {
  const made = await lanHomes(t);
  const { a, b, ports } = made;
  const bound = await transports.bind(a, "b", "lan", null, `lan:127.0.0.1:${ports.b}`);
  assert.equal(bound.address, `lan:127.0.0.1:${ports.b}`);
  assert.ok(bound.note.includes("first ask goes to"), bound.note);
  await transports.bind(b, "a", "lan");
  // No peers on either side: a has the address it was given, and b learns a's.
  await b.startTransports();
  const sent = await a.send("b", { text: "hei over nettet" });
  assert.deepEqual([sent.status, sent.via], ["confirmed", "lan"], JSON.stringify(sent));
  assert.deepEqual((await b.read({ wait: 10 })).map((message) => message.body.text), ["hei over nettet"]);
  const kept = new transports.Config(b.home).addresses()[a.keys.public].lan;
  assert.deepEqual([kept.address, kept.from], [`lan:127.0.0.1:${ports.a}`, "heard"]);
  const listed = await transports.listing(a);
  const row = listed.bindings.find((entry) => entry.partner === "b");
  assert.deepEqual([row.addresses.lan.address, row.addresses.lan.from], [`lan:127.0.0.1:${ports.b}`, "you"]);
  assert.deepEqual(listed.transports.find((item) => item.name === "lan").here, [`lan:127.0.0.1:${ports.a}`], "where a's lan said it is reached");
  await a.close();
  await b.close();
  // A new owner of b's home, with no peers named, answers a over the address b kept.
  const b2 = await made.open("b");
  const a2 = await made.open("a");
  await a2.startTransports();
  const back = await b2.send("a", { text: "svar over nettet" });
  assert.equal(back.status, "confirmed", JSON.stringify(back));
  assert.deepEqual((await a2.read({ wait: 10 })).map((message) => message.body.text), ["svar over nettet"]);
});

test("an address that stopped answering gives way to the peers on every second ask", async (t) => {
  const { a, b, ports } = await lanHomes(t);
  await transports.bind(a, "b", "lan", null, `lan:127.0.0.1:${ports.gone}`);
  await transports.bind(b, "a", "lan");
  a.transportService().environ = { ...process.env, ...lanOnly(ports.a, [ports.b]) };
  await b.startTransports();
  const sent = await a.send("b", { text: "hei" });
  assert.equal(sent.status, "confirmed", JSON.stringify(sent));
  const kept = new transports.Config(a.home).addresses()[b.keys.public].lan;
  assert.deepEqual([kept.address, kept.from], [`lan:127.0.0.1:${ports.b}`, "heard"], "the challenge from b moved the address it had gone stale at");
});

test("a send that found nobody says what the transport said, and no network", async (t) => {
  const { a, b } = await lanHomes(t);
  await transports.bind(a, "b", "lan");
  const failed = await failure(a.transportService().send(b.keys.publicRaw, bytes("hei"), 4));
  assert.equal(failed?.code, "carry_not_sent", failed?.message);
  assert.ok(failed.message.includes("within reach of lan") && !failed.message.includes("same network"), failed.message);
  assert.ok(failed.message.endsWith("lan said of the last frame it could not send: no broadcast and no peers: a frame to nobody in particular has nowhere to go"), failed.message);
});

test("transport here starts it for a moment, keeps where it is reached, and lets the port go", async (t) => {
  const { a, ports } = await lanHomes(t, { partners: false });
  let item = (await transports.listing(a)).transports.find((entry) => entry.name === "lan");
  assert.equal(item.here, null);
  assert.ok(item.here_fix.includes("aamio transport here lan"), item.here_fix);
  const said = await transports.here(a, "lan");
  assert.deepEqual(said.here, [`lan:127.0.0.1:${ports.a}`]);
  assert.ok(said.note.includes("started for a moment") && said.note.includes(`--address lan:127.0.0.1:${ports.a}`), said.note);
  const kept = new transports.Config(a.home).here().lan;
  assert.deepEqual([kept.medium, kept.here, kept.version], ["lan", [`lan:127.0.0.1:${ports.a}`], LAN_VERSION], "kept in the home, with the version that said it");
  assert.ok(await portIsFree(ports.a), "the port is given back");
  item = (await transports.listing(a)).transports.find((entry) => entry.name === "lan");
  assert.ok(item.here[0] === `lan:127.0.0.1:${ports.a}` && Number.isInteger(item.here_at), JSON.stringify(item));
  assert.deepEqual(await a.transportService().hereForAddons(), [{ transport: "lan", medium: "lan", here: [`lan:127.0.0.1:${ports.a}`], at: item.here_at }]);
  assert.equal((await failure(transports.here(a, "radio")))?.code, "transport_unknown");
});

test("an add-on that needs here gets it learned by a start of a moment when nothing is kept", async (t) => {
  const { a, ports } = await lanHomes(t, { partners: false });
  const said = await a.transportService().hereForAddons();
  assert.deepEqual(said.map((item) => [item.transport, item.medium, item.here]), [["lan", "lan", [`lan:127.0.0.1:${ports.a}`]]]);
});

test("bind with an address checks it, and sets it for a partner bound already", async (t) => {
  const { a } = await lanHomes(t);
  const wrong = await failure(transports.bind(a, "b", "lan", null, "bt:8C:1D:55:03:7B:53"));
  assert.equal(wrong?.code, "transport_address_invalid");
  assert.equal(wrong.message, "an address on lan is lan: and then where the partner is reached, as its card or aamio transport here on its machine says it, at most 128 characters of printable ASCII without spaces");
  assert.deepEqual(new transports.Config(a.home).bindings(), {}, "nothing was bound");
  await transports.bind(a, "b", "lan");
  const again = await failure(transports.bind(a, "b", "lan"));
  assert.ok(again?.code === "transport_already_bound" && again.message.includes("--address"), again?.message);
  const moved = await transports.bind(a, "b", "lan", null, "lan:10.0.0.7:47474");
  assert.deepEqual([moved.address, moved.routes.length], ["lan:10.0.0.7:47474", 1]);
  assert.ok(moved.note.startsWith("The first ask to b on lan goes to lan:10.0.0.7:47474 from now on"), moved.note);
  const other = await failure(transports.bind(a, "b", "lan", "slow", "lan:10.0.0.7:47474"));
  assert.ok(other?.code === "transport_already_bound" && other.message.includes("unbind first"), other?.message);
  transports.unbind(a, "b", "lan");
  assert.deepEqual(new transports.Config(a.home).addresses(), {}, "an unbind takes where the partner is reached with it");
});

test("a hint file that cannot be read stops no send", async (t) => {
  const { a, b } = await lanHomes(t);
  await transports.bind(a, "b", "lan");
  const folder = join(a.home, "transports");
  writeFileSync(join(folder, "addresses.json"), "{not json");
  writeFileSync(join(folder, "here.json"), '{"version": 9}');
  const config = new transports.Config(a.home);
  assert.deepEqual([config.addresses(), config.here()], [{}, {}]);
  assert.equal((await transports.listing(a)).bindings[0].partner, "b");
  config.setAddress(b.keys.public, "lan", "lan:10.0.0.7:47474", "you", 1);
  assert.equal(config.addresses()[b.keys.public].lan.address, "lan:10.0.0.7:47474", "written again whole");
});

test("a transport that says nothing of where it is reached is started once per version", async (t) => {
  // A medium without addresses, as sound, says nothing of where it is reached. Unkept, every card over MCP started it
  // again for a moment, and a transport over sound opens the microphone as it starts.
  const dir = mkdtempSync(join(tmpdir(), "aamio-here-once-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  stateFolder(t, dir);
  const home = await homeWith(dir, "a", "aamio-stub", "0.1.0", STUB_PACKAGE);
  await enable(home, "stub", { probe });
  const a = await NodeRuntime.open({ home, host: NOWHERE });
  opened.push(a);
  const marks = join(transports.workingFolder(home, "stub", { make: false }), "started.txt");
  const starts = () => (existsSync(marks) ? readFileSync(marks, "utf8").split("\n").filter(Boolean).length : 0);
  const service = a.transportService();
  const first = await service.hereForAddons();
  assert.deepEqual(first.map((item) => [item.transport, item.medium, item.here]), [["stub", "stub", []]],
    "it says nothing of where it is reached, and is there all the same: a card knows the medium is this machine's");
  const kept = new transports.Config(home).here().stub;
  assert.deepEqual([kept.here, kept.version, starts()], [[], "0.1.0", 1]);
  const learn = service.learnHere;
  service.learnHere = async () => assert.fail("started again for a card");
  assert.deepEqual(await service.hereForAddons(), [{ transport: "stub", medium: "stub", here: [], at: kept.at }]);
  assert.deepEqual((await transports.listing(a)).transports.find((item) => item.name === "stub").here, []);
  // What another version said is not taken for this one's: it is asked again, once.
  service.learnHere = learn;
  new transports.Config(home).setHere("stub", "stub", [], 1, "0.0.9");
  assert.deepEqual((await service.hereForAddons()).map((item) => [item.transport, item.here]), [["stub", []]]);
  assert.deepEqual([starts(), new transports.Config(home).here().stub.version], [2, "0.1.0"]);
  const said = await transports.here(a, "stub");
  assert.deepEqual([said.here, said.note], [null, "stub says nothing of where it is reached: a version from before here (contract 3, B3), or a medium without addresses. "
    + "A card can name the medium stub without an address."]);
});

test("an add-on that needs media gets the enabled transports and nothing is started", async (t) => {
  // A reader of a card asks only which media this machine has. Asking for here instead starts a transport that says
  // nothing kept for a moment, and one over Bluetooth LE announces the machine as it starts (19 November 2026).
  const dir = mkdtempSync(join(tmpdir(), "aamio-here-media-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  stateFolder(t, dir);
  const home = await homeWith(dir, "a", "aamio-stub", "0.1.0", STUB_PACKAGE);
  // And lan beside it, as npm leaves a second package.
  const root = join(home, "addon-packages", "npm");
  mkdirSync(join(root, "node_modules", "aamio-lan"));
  for (const file of ["package.json", "aamio-addon.json", "transport.js"]) writeFileSync(join(root, "node_modules", "aamio-lan", file), readFileSync(join(lanDir, file)));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "aamio-stub": "0.1.0", "aamio-lan": LAN_VERSION } }));
  await enable(home, "stub", { probe });
  await enable(home, "lan", { probe });
  const a = await NodeRuntime.open({ home, host: NOWHERE });
  opened.push(a);
  const service = a.transportService();
  service.learnHere = async () => assert.fail("started for media");
  assert.deepEqual(await service.mediaForAddons(), [{ transport: "lan", medium: "lan" }, { transport: "stub", medium: "stub" }]);
  assert.deepEqual(new transports.Config(home).here(), {}, "nothing was learned, and nothing kept");
  assert.equal(existsSync(join(transports.workingFolder(home, "stub", { make: false }), "started.txt")), false, "and the stub was not started");
});

test("the command line says where a transport is reached, and binds a partner to an address it checks", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-here-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  stateFolder(t, dir);
  const home = await homeWithLan(dir, "home");
  await enable(home, "lan", { probe });
  const [port] = await freePorts(1);
  const env = { ...process.env, ...lanOnly(port) };
  const cli = (...args) => spawnSync(process.execPath, [bin, "--home", home, "--host", NOWHERE, ...args], { encoding: "utf8", timeout: 60_000, env });
  const help = cli("--help");
  assert.ok(help.stdout.includes("transport here TRANSPORT") && help.stdout.includes("[--address ADDRESS]"), help.stdout);
  const said = cli("transport", "here", "lan");
  assert.equal(said.status, 0, said.stderr);
  assert.deepEqual(JSON.parse(said.stdout).here, [`lan:127.0.0.1:${port}`], said.stdout);
  assert.ok(await portIsFree(port), "the port is given back");
  assert.equal(cli("transport", "here").status, 2, "transport here takes TRANSPORT");
  assert.equal(cli("partner", "add", "b", B.public).status, 0);
  const wrong = cli("transport", "bind", "b", "lan", "--address", "bt:8C:1D:55:03:7B:53");
  assert.equal(wrong.status, 1, wrong.stderr);
  assert.equal(JSON.parse(wrong.stdout).error_code, "transport_address_invalid", wrong.stdout);
  const bound = cli("transport", "bind", "b", "lan", "--address", "lan:127.0.0.1:47474");
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(JSON.parse(bound.stdout).address, "lan:127.0.0.1:47474");
  const listed = JSON.parse(cli("transport", "list").stdout);
  assert.deepEqual(listed.transports[0].here, [`lan:127.0.0.1:${port}`]);
  assert.deepEqual([listed.bindings[0].addresses.lan.address, listed.bindings[0].addresses.lan.from], ["lan:127.0.0.1:47474", "you"]);
});
