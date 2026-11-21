/**
 * The host side of contract 3 and a Carrier, for Node, against the transports in
 * the aamio-python repository beside this one: tests/fake_transport.py, which can
 * loop frames back, stay silent, give no room, answer late or break the contract,
 * and addons/sim-radio, the simulated radio over UDP on 127.0.0.1 the three
 * runtimes share as their medium. They are programs on standard input and output,
 * so the language they are written in does not matter. Both need a Python, from
 * AAMIO_TEST_PYTHON or the path; without one these tests are skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keys } from "../src/aamio.js";
import * as carry from "../src/carry.js";
import { CarryState, mark, profile } from "../src/node-carry-state.js";
import { Carrier } from "../src/node-carrier.js";
import { Reassembly, STOP_SECONDS, TransportFailed, TransportProcess, environment } from "../src/node-transport-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const pythonRepo = join(here, "..", "..", "aamio-python");
const fake = join(pythonRepo, "tests", "fake_transport.py");

// AAMIO_TEST_PYTHON is JSON, the program and its options, as the other tests here read it.
function findPython() {
  if (process.env.AAMIO_TEST_PYTHON) {
    const parsed = JSON.parse(process.env.AAMIO_TEST_PYTHON);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["python.exe"] : ["python3", "python"]) {
      const candidate = join(folder, name);
      if (folder && existsSync(candidate) && !candidate.toLowerCase().includes("windowsapps")) return [candidate];
    }
  }
  return null;
}

const python = findPython();
const skip = python === null || !existsSync(fake) ? "no Python, or no aamio-python beside this repository" : false;
const baseEnv = Object.fromEntries(["PATH", "SYSTEMROOT", "TEMP", "TMP"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const A = Keys.fromSeedHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const B = Keys.fromSeedHex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");

class Clock {
  constructor() {
    this.now = 1000;
  }
  get read() {
    return () => this.now;
  }
}

async function startFake(mode, clock = null) {
  const env = { ...environment([], baseEnv), FAKE_TRANSPORT_MODE: mode };
  const process_ = new TransportProcess("fake", "0.1.0", [...python, "-u", fake], tmpdir(), env, clock ? { clock: clock.read } : {});
  await process_.start("0.0.0-test", "node", tmpdir());
  return process_;
}

async function waitForRoom(transport, needed = 1) {
  const until = Date.now() + 10000;
  while (transport.room() < needed) {
    assert.ok(Date.now() < until, "no room");
    await transport.poll(100);
  }
}

test("frames go out within the room a ready gave, and come back whole", { skip }, async () => {
  const transport = await startFake("loopback");
  try {
    const envelope = carry.write(A, B.publicRaw, carry.READABLE, carry.MESSAGE, 0, new Uint8Array(8), 1, 1794700300, new Uint8Array(300).fill(120));
    const frames = carry.split(envelope, transport.properties.max_frame_up);
    assert.ok(frames.length > 4);
    const reassembly = new Reassembly();
    const ids = [];
    let whole = null;
    const until = Date.now() + 10000;
    while (whole === null) {
      assert.ok(Date.now() < until);
      while (frames.length && transport.room() > 0) ids.push(transport.send(frames.shift()));
      for (const event of await transport.poll(100)) if (event[0] === "received") whole = reassembly.add(event[2]) ?? whole;
    }
    assert.ok(carry.equal(whole, envelope));
    assert.ok(ids.every((id) => transport.status(id) === "sent"));
  } finally {
    await transport.stop();
  }
});

test("a transport that never answers is hung after three deadlines, whatever else it says", { skip }, async () => {
  const clock = new Clock();
  const transport = await startFake("silent", clock);
  try {
    await waitForRoom(transport, 3);
    const ids = [0, 1, 2].map(() => transport.send(new Uint8Array(22), null, 1000));
    await transport.poll(500);
    clock.now += 2;
    assert.throws(() => transport.checkTime(), (error) => error instanceof TransportFailed && error.code === "transport_hung");
    assert.deepEqual(ids.map((id) => transport.status(id)), ["unknown", "unknown", "unknown"]);
  } finally {
    await transport.stop();
  }
});

test("a transport that never gives room is hung after sixty seconds, whatever else it says", { skip }, async () => {
  const clock = new Clock();
  const transport = await startFake("no_room", clock);
  try {
    assert.equal(transport.send(new Uint8Array(22)), null);
    transport.inject('{"t":"status","state":"up","reason":"chatter"}');
    assert.deepEqual(await transport.poll(0), [["status", "up", "chatter"]]);
    clock.now += 59;
    transport.checkTime();
    clock.now += 1;
    assert.throws(() => transport.checkTime(), (error) => error.code === "transport_hung");
  } finally {
    await transport.stop();
  }
});

test("what a transport says with its describe is not lost", { skip }, async () => {
  // start read lines until describe had come and dropped whatever else had come with it: a status, or a frame that
  // came in as the medium opened. A port in use was said as down in the same breath, and whoever waited for it saw
  // nothing (a full run of 16 November 2026).
  const transport = await startFake("early");
  try {
    const heard = [];
    const until = Date.now() + 5000;
    while (heard.length < 2 && Date.now() < until) heard.push(...(await transport.poll(50)));
    assert.deepEqual(heard.map((event) => [event[0], event[1], event[0] === "received" ? Array.from(event[2]) : event[2]]),
      [["status", "up", "said with describe"], ["received", "early", [0, 1, 2]]]);
    assert.equal(transport.room(), 4);
  } finally {
    await transport.stop();
  }
});

test("what a transport says before its describe is kept, and describe is still waited for", { skip }, async () => {
  // The simulated radio listens before it has read hello, so a frame from a partner that is already sending comes
  // before describe. It is kept as what comes with describe is, and describe is still waited for: kept and then
  // not waited behind, the host never read the describe that came after (a full run of 16 November 2026).
  const began = Date.now();
  const transport = await startFake("eager");
  try {
    assert.ok(Date.now() - began < 5000, "describe was waited for, and came");
    const heard = await transport.poll(0);
    assert.deepEqual(heard.map((event) => [event[0], event[1], Array.from(event[2])]), [["received", "eager", [0, 1, 2]]]);
    await waitForRoom(transport, 4);
  } finally {
    await transport.stop();
  }
});

test("a late answer decides the status after the deadline", { skip }, async () => {
  const clock = new Clock();
  const transport = await startFake("late", clock);
  try {
    await waitForRoom(transport);
    const id = transport.send(new Uint8Array(22), null, 1000);
    clock.now += 2;
    transport.checkTime();
    assert.equal(transport.status(id), "unknown");
    const until = Date.now() + 5000;
    while (transport.status(id) === "unknown" && Date.now() < until) await transport.poll(100);
    assert.equal(transport.status(id), "sent");
    assert.equal(transport.frames.get(id).late, true);
  } finally {
    await transport.stop();
  }
});

test("a transport that does not describe itself is said with what is known of it", { skip }, async () => {
  // No describe within ten seconds said only that. A start that stopped so once, with three suites running, could not
  // be told from any other: whether the hello had gone, whether the process lived, or what it had said (16 November
  // 2026). Here the wait is one second.
  const env = { ...environment([], baseEnv), FAKE_TRANSPORT_MODE: "mute" };
  const transport = new TransportProcess("fake", "0.1.0", [...python, "-u", fake], tmpdir(), env, { describeSeconds: 1 });
  try {
    const failed = await transport.start("0.0.0-test", "node", tmpdir()).then(() => null, (error) => error);
    assert.equal(failed?.code, "transport_timeout");
    for (const words of ["no describe within 1 seconds of hello: ", "the hello was written to it", "its process runs", "it said 1 line that was no describe",
      "On standard error: the fake transport has nothing to say"]) assert.ok(failed.message.includes(words), failed.message);
  } finally {
    await transport.stop();
  }
});

for (const [mode, code] of [["bad_describe", "transport_bad_describe"], ["long_line", "transport_protocol"]]) {
  test(`a transport that breaks the contract is not used: ${mode}`, { skip }, async () => {
    const env = { ...environment([], baseEnv), FAKE_TRANSPORT_MODE: mode };
    const transport = new TransportProcess("fake", "0.1.0", [...python, "-u", fake], tmpdir(), env);
    try {
      await assert.rejects(transport.start("0.0.0-test", "node", tmpdir()), (error) => error.code === code);
    } finally {
      await transport.stop();
    }
  });
}

test("a message whose tries run out without a receipt is unknown, never confirmed", { skip }, async () => {
  const clock = new Clock();
  const now = 1794700000;
  const sealed = profile({ mode: "sealed" });
  const atA = new CarryState(A);
  const atB = new CarryState(B);
  const [session, ask] = atA.ask(B.publicRaw, sealed, clock.now);
  const [, challenge] = atB.deliver(ask, [A.publicRaw], sealed, clock.now, now);
  const [, opened] = atA.deliver(challenge, [B.publicRaw], sealed, clock.now, now);
  assert.equal(atB.deliver(opened, [A.publicRaw], sealed, clock.now, now)[0], "accepted");
  // The loopback gives every frame back to A, which it is not sealed to: no receipt can come.
  const transport = await startFake("loopback", clock);
  try {
    const carrier = new Carrier(atA, transport, sealed, [B.publicRaw], { clock: clock.read, wall: () => now, retrySeconds: 1, tries: 3 });
    const key = carrier.send(B.publicRaw, session, new TextEncoder().encode("hei"));
    assert.deepEqual([carrier.outcome(key), carrier.confirmed(key)], ["waiting", false]);
    const until = Date.now() + 20000;
    while (carrier.outcome(key) === "waiting") {
      assert.ok(Date.now() < until, "the tries never ran out");
      clock.now += 0.5;
      await carrier.pump(50);
    }
    assert.deepEqual([carrier.outcome(key), carrier.confirmed(key)], ["unknown", false]);
    assert.ok(carrier.refused.length > 0 && carrier.inbox.length === 0, "its own frames came back and were refused");
  } finally {
    await transport.stop();
  }
});

test("room is exact when lines cross, the first answer decides, and a ready that does not add up stops the transport", async () => {
  const transport = new TransportProcess("fake", "0.1.0", [], null, {}, { clock: new Clock().read });
  transport.written = 5;
  transport.inject('{"t":"ready","credit":3,"sends_read":4}');
  await transport.poll(0);
  assert.equal(transport.room(), 2);
  transport.frames.set("f-1", { status: "waiting", deadline: 2000, late: false, answered: false });
  transport.inject('{"t":"sent","id":"f-1"}');
  transport.inject('{"t":"error","id":"f-1","code":"cancelled"}');
  transport.inject('{"t":"link_ack","id":"f-1"}');
  await transport.poll(0);
  assert.equal(transport.status("f-1"), "sent");
  assert.equal(transport.frames.get("f-1").linkAck, true);
  const bad = new TransportProcess("fake", "0.1.0", [], null, {});
  bad.written = 5;
  bad.inject('{"t":"ready","credit":3,"sends_read":6}');
  await assert.rejects(bad.poll(0), (error) => error.code === "transport_protocol");
  assert.deepEqual(environment(["AAMIO_HOME", "SIM_PORT"], { PATH: "/bin", AAMIO_HOME: "/h", SIM_PORT: "4000", TOKEN: "t" }), { PATH: "/bin", SIM_PORT: "4000", AAMIO_ADDON: "3" });
});

async function freePort() {
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const POOR = { AAMIO_SIM_LOSS: "0.2", AAMIO_SIM_DUPLICATE: "0.2", AAMIO_SIM_REORDER: "0.3", AAMIO_SIM_MAX_FRAME: "32", AAMIO_SIM_SEED: "fase 1" };
for (const [mode, medium, label] of [["readable", {}, "clean"], ["readable", POOR, "poor"], ["sealed", POOR, "poor"]]) {
  test(`two homes over the simulated radio, ${mode}, ${label}: a message each way, once, with its receipt`, { skip, timeout: 240000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "aamio-carry-sim-"));
    const portA = await freePort();
    const portB = await freePort();
    const radios = [];
    try {
      for (const [own, peer] of [[portA, portB], [portB, portA]]) {
        const env = { ...environment([], baseEnv), PYTHONPATH: join(pythonRepo, "addons", "sim-radio", "src"), AAMIO_SIM_PORT: String(own), AAMIO_SIM_PEERS: String(peer), ...medium };
        // A whole suite starts many processes at once, and a radio may then need longer than ten seconds to describe itself.
        const radio = new TransportProcess("sim-radio", "0.1.0", [...python, "-u", "-m", "aamio_sim_radio.transport"], tmpdir(), env, { describeSeconds: 30 });
        await radio.start("0.0.0-test", "node", tmpdir());
        radios.push(radio);
      }
      const p = profile({ mode });
      const atA = new Carrier(new CarryState(A, join(root, "a", "carry.json")), radios[0], p, [B.publicRaw], { retrySeconds: 1, askRetrySeconds: 3 });
      const atB = new Carrier(new CarryState(B, join(root, "b", "carry.json")), radios[1], p, [A.publicRaw], { retrySeconds: 1, askRetrySeconds: 3 });
      const pumpUntil = async (condition) => {
        const until = Date.now() + 60000;
        while (!condition()) {
          assert.ok(Date.now() < until, JSON.stringify([atA.refused, atB.refused]));
          await atA.pump(10);
          await atB.pump(10);
        }
      };
      atA.open(B.publicRaw);
      await pumpUntil(() => atA.openSession(B.publicRaw) !== null);
      const sent = atA.send(B.publicRaw, atA.openSession(B.publicRaw), new TextEncoder().encode("hei fra A"));
      await pumpUntil(() => atA.confirmed(sent) && atB.inbox.length > 0);
      atB.open(A.publicRaw);
      await pumpUntil(() => atB.openSession(A.publicRaw) !== null);
      const reply = atB.send(A.publicRaw, atB.openSession(A.publicRaw), new TextEncoder().encode("hei tilbake fra B"));
      await pumpUntil(() => atB.confirmed(reply) && atA.inbox.length > 0);
      const settle = Date.now() + 2000;
      while (Date.now() < settle) {
        await atA.pump(10);
        await atB.pump(10);
      }
      assert.deepEqual(atB.inbox.map((entry) => new TextDecoder().decode(entry[3])), ["hei fra A"]);
      assert.deepEqual(atA.inbox.map((entry) => new TextDecoder().decode(entry[3])), ["hei tilbake fra B"]);
      assert.ok(carry.equal(atB.inbox[0][0], A.publicRaw));
    } finally {
      for (const radio of radios) await radio.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ------------------------------------------------------------------ the review of 2026-11-15, findings 1, 4, 5, 6 and 14

const NOW = 1794700000;
const readable = profile({ mode: "readable" });
const openedPair = (atA, atB) => {
  const [session, ask] = atA.ask(B.publicRaw, readable, 0);
  const [, challenge] = atB.deliver(ask, [A.publicRaw], readable, 0, NOW);
  const [, opening] = atA.deliver(challenge, [B.publicRaw], readable, 0, NOW);
  assert.equal(atB.deliver(opening, [A.publicRaw], readable, 0, NOW)[0], "accepted");
  return session;
};
const frameOf = (tag, index, count, size, fill) => {
  const frame = new Uint8Array(9 + size).fill(fill);
  frame.set([0x41, 0x46, 0, ...tag, index, count]);
  return frame;
};

test("finding 4: reassembly holds a copy once and never more than its room", () => {
  const reassembly = new Reassembly(new Clock().read);
  const first = frameOf([1, 2, 3, 4], 0, 2, 32768, 120);
  for (let i = 0; i < 10; i++) assert.equal(reassembly.add(first), null);
  assert.equal(reassembly.held(), first.length);
  for (let n = 1; n < 40; n++) {
    reassembly.add(frameOf([5, 6, 7, 8], n, 255, 32768, n));
    assert.ok(reassembly.held() <= 262144);
  }
  for (let n = 0; n < 40; n++) {
    reassembly.add(frameOf([n, 1, 2, 3], 0, 2, 20000, n));
    assert.ok(reassembly.held() <= 262144 && reassembly.groups.size <= 32);
  }
});

test("finding 5: a transport that stops reading never holds up the owner, its deadlines or its stop", { skip }, async () => {
  const clock = new Clock();
  const transport = await startFake("deaf", clock);
  try {
    await waitForRoom(transport, 2);
    const began = performance.now();
    const big = transport.send(new Uint8Array(65000), null, 100);
    const small = transport.send(new Uint8Array(20), null, 100);
    assert.ok(performance.now() - began < 500, "giving a frame waited for the transport to read");
    clock.now += 1;
    transport.checkTime();
    assert.ok(["unknown", "not_sent"].includes(transport.status(big)) && ["unknown", "not_sent"].includes(transport.status(small)));
    const stopping = performance.now();
    await transport.stop();
    assert.ok(performance.now() - stopping < 6000);
  } finally {
    await transport.stop();
  }
});

/**
 * A transport in Node that describes itself as fake 0.1.0 and stops when asked, or with STUBBORN never does, and with
 * IGNORE_TERM lets SIGTERM pass as well: for the stop itself, with no Python needed.
 */
const STOPPER = `"use strict";
const { createInterface } = require("node:readline");
const stubborn = process.env.STUBBORN === "1";
if (stubborn) setInterval(() => {}, 1000);
if (process.env.IGNORE_TERM === "1") process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.t === "hello") {
    process.stdout.write(JSON.stringify({ t: "describe", name: "fake", version: "0.1.0", aamio_addon: 3, medium: "fake",
      properties: { max_frame_up: 1200, max_frame_down: 1200, rate_up: 1000000, rate_down: 1000000, direction: "duplex", addressing: "none",
        link_ack: false, airtime: null, metadata_visible_to: "range", medium_encrypts: false } }) + "\\n");
  } else if (message.t === "stop" && !stubborn) {
    process.exit(0);
  }
}).on("close", () => {
  if (!stubborn) process.exit(0);
});
`;

test("a transport that stopped keeps no process alive for the five seconds a kill would have waited", () => {
  // The timer for the kill ran on after the transport had ended, so a command that started one for a moment, as aamio
  // transport here, ended five seconds late (20 November 2026). Measured in a process of its own, with nothing else to do.
  const host = new URL("../src/node-transport-host.js", import.meta.url).href;
  const script = `import { writeSync } from "node:fs";
import { TransportProcess, environment } from ${JSON.stringify(host)};
const transport = new TransportProcess("fake", "0.1.0", [process.execPath, "-e", ${JSON.stringify(STOPPER)}], ${JSON.stringify(tmpdir())},
  environment([], ${JSON.stringify(baseEnv)}), { describeSeconds: 30 });
await transport.start("0.0.0-test", "node", ${JSON.stringify(tmpdir())});
await transport.stop();
const stopped = performance.now();
process.on("exit", () => writeSync(1, String(Math.round(performance.now() - stopped))));
`;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: baseEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(ran.stdout !== "" && Number(ran.stdout) < 2500, `the process lived on ${ran.stdout} ms after the stop`);
});

test("a transport that does not stop when asked is killed after five seconds", async () => {
  const transport = new TransportProcess("fake", "0.1.0", [process.execPath, "-e", STOPPER], tmpdir(), { ...environment([], baseEnv), STUBBORN: "1" },
    { describeSeconds: 30 });
  try {
    await transport.start("0.0.0-test", "node", tmpdir());
    const child = transport.child;
    const began = performance.now();
    await transport.stop();
    const took = performance.now() - began;
    assert.ok(took >= STOP_SECONDS * 1000 - 200 && took < STOP_SECONDS * 1000 + 3000, `the stop took ${Math.round(took)} ms`);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "and the process has ended");
  } finally {
    await transport.stop();
  }
});

test("a transport that lets SIGTERM pass is killed all the same after five seconds, and the stop ends", { timeout: 30_000 }, async () => {
  // After the five seconds the stop sent SIGTERM and waited for the exit with no end: on POSIX a transport that catches it,
  // or whose clean-up never ends, kept the close and the next owner waiting (a review of 21 November 2026). Windows ends
  // the process whatever the signal, so there this holds as it is; it is run on Linux as well.
  const transport = new TransportProcess("fake", "0.1.0", [process.execPath, "-e", STOPPER], tmpdir(),
    { ...environment([], baseEnv), STUBBORN: "1", IGNORE_TERM: "1" }, { describeSeconds: 30 });
  try {
    await transport.start("0.0.0-test", "node", tmpdir());
    const child = transport.child;
    const began = performance.now();
    await transport.stop();
    const took = performance.now() - began;
    assert.ok(took < STOP_SECONDS * 1000 + 3000, `the stop took ${Math.round(took)} ms`);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "and the process has ended");
  } finally {
    await transport.stop();
  }
});

test("finding 6: frames that wait in the carrier make the transport hung after sixty seconds", { skip }, async () => {
  const clock = new Clock();
  const atA = new CarryState(A);
  const session = openedPair(atA, new CarryState(B));
  const transport = await startFake("no_room", clock);
  try {
    const carrier = new Carrier(atA, transport, readable, [B.publicRaw], { clock: clock.read, wall: () => NOW, retrySeconds: 1000 });
    carrier.send(B.publicRaw, session, new TextEncoder().encode("hei"));
    await carrier.pump(50);
    assert.equal(transport.waitingForRoomSince, clock.now);
    clock.now += 59;
    await carrier.pump(50);
    clock.now += 2;
    await assert.rejects(() => carrier.pump(50), (error) => error instanceof TransportFailed && error.code === "transport_hung");
  } finally {
    await transport.stop();
  }
});

test("finding 14: down takes the room away, up alone gives none back, and sixty seconds of down start it again", async () => {
  const transport = new TransportProcess("fake", "0.1.0", [], null, {}, { clock: new Clock().read });
  const rooms = [];
  for (const line of ['{"t":"ready","credit":3,"sends_read":0}', '{"t":"status","state":"down","reason":"the receiver stopped"}',
    '{"t":"ready","credit":3,"sends_read":0}', '{"t":"status","state":"up","reason":"back"}', '{"t":"ready","credit":3,"sends_read":0}']) {
    transport.inject(line);
    await transport.poll(0);
    rooms.push(transport.room());
  }
  assert.deepEqual(rooms, [3, 0, 0, 0, 3]);
  const clock = new Clock();
  const quiet = new TransportProcess("fake", "0.1.0", [], null, {}, { clock: clock.read });
  quiet.inject('{"t":"status","state":"down","reason":"the receiver stopped"}');
  await quiet.poll(0);
  clock.now += 59;
  quiet.checkTime();
  quiet.inject('{"t":"status","state":"up","reason":"back"}');
  await quiet.poll(0);
  clock.now += 120;
  quiet.checkTime();
  quiet.inject('{"t":"status","state":"down","reason":"stopped again"}');
  await quiet.poll(0);
  clock.now += 60;
  assert.throws(() => quiet.checkTime(), (error) => error instanceof TransportFailed && error.code === "transport_down");
});

test("finding 1: a carrier on the same home after a restart sends the same bytes with the tries left", { skip }, async () => {
  const clock = new Clock();
  const root = mkdtempSync(join(tmpdir(), "aamio-carry-resume-"));
  const file = join(root, "a.json");
  const atA = new CarryState(A, file);
  const atB = new CarryState(B);
  const [session, ask] = atA.ask(B.publicRaw, readable, 0);
  const [, challenge] = atB.deliver(ask, [A.publicRaw], readable, 0, NOW);
  atA.deliver(challenge, [B.publicRaw], readable, 0, NOW);
  const envelope = atA.send(B.publicRaw, session, new TextEncoder().encode("hei"), readable, { most: 5 });
  const key = mark(B.publicRaw, session, 1);
  const transport = await startFake("loopback", clock);
  try {
    const carrier = new Carrier(new CarryState(A, file), transport, readable, [B.publicRaw], { clock: clock.read, wall: () => NOW, tries: 5 });
    assert.ok(carry.equal(carrier.messages.get(key).envelope, envelope));
    await carrier.pump(50);
    const after = new CarryState(A, file);
    assert.deepEqual([after.durable.outbox[key].tries, after.counterOf(B.publicRaw, session), carrier.outcome(key)], [2, 1, "waiting"]);
  } finally {
    await transport.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the follow-up check of 2026-11-15, findings 2 and 5

/** What a Carrier needs of a transport, with the room in the test's hands and every frame given kept. */
class Medium {
  constructor(room = 0, frame = 64) {
    this.name = "medium";
    this.properties = { max_frame_up: frame };
    this.credit = room;
    this.given = [];
    this.events = [];
  }

  async poll() {
    const events = this.events;
    this.events = [];
    return events;
  }

  room() {
    return this.credit;
  }

  send(frame) {
    if (this.credit < 1) return null;
    this.credit -= 1;
    this.given.push(frame);
    return `f-${this.given.length}`;
  }

  status() {
    return "sent";
  }

  waiting() {
    return 0;
  }

  checkTime() {}

  waitingForRoom(waiting) {
    this.waits = waiting;
  }
}

const sealed = profile({ mode: "sealed" });
const bytes = (value) => new TextEncoder().encode(value);
/** Whether a try at the message waits in the carrier's queue, not one frame of it given to the transport yet. */
const queued = (carrier, key) => carrier.queue.some(([, , of, ids]) => of === key && ids.length === 0);
/** The bytes of a message as its sender keeps them, before its receipt. */
const keptEnvelope = (state, key) => state.unconfirmed().find(([of]) => of === key)[4];

test("follow-up finding 5: no try is counted while the first waits for room, and none goes after the tries are used", async () => {
  // With a budget of two and no room, three rounds used both tries and left two copies in the queue, which went out when
  // room came, after unknown had been said.
  const clock = new Clock();
  const atA = new CarryState(A);
  const session = openedPair(atA, new CarryState(B));
  const medium = new Medium(0);
  const carrier = new Carrier(atA, medium, readable, [B.publicRaw], { clock: clock.read, wall: () => NOW, retrySeconds: 2, tries: 2 });
  const key = carrier.send(B.publicRaw, session, bytes("hei"));
  for (const step of [0, 2.1, 2.1]) {
    clock.now += step;
    await carrier.pump(0);
  }
  assert.deepEqual([carrier.outcome(key), atA.durable.outbox[key].tries, carrier.queue.length, medium.given], ["waiting", 1, 1, []]);
  medium.credit = 1000;
  await carrier.pump(0);
  const first = medium.given.length;
  assert.ok(first > 0 && carrier.queue.length === 0, "the one try went when there was room");
  clock.now += 2.1;
  await carrier.pump(0);
  assert.deepEqual([medium.given.length, atA.durable.outbox[key].tries], [2 * first, 2], "the second try, counted as it began");
  clock.now += 2.1;
  await carrier.pump(0);
  assert.deepEqual([carrier.outcome(key), atA.durable.outbox[key].envelope], ["unknown", null]);
  for (let round = 0; round < 3; round++) {
    clock.now += 2.1;
    await carrier.pump(0);
  }
  assert.equal(medium.given.length, 2 * first, "nothing goes after the tries are used");
});

test("follow-up finding 5: a try that waits for room is not begun once its receipt has come", async () => {
  const clock = new Clock();
  const atA = new CarryState(A);
  const atB = new CarryState(B);
  const session = openedPair(atA, atB);
  const medium = new Medium(1000);
  const carrier = new Carrier(atA, medium, readable, [B.publicRaw], { clock: clock.read, wall: () => NOW, retrySeconds: 2, tries: 5 });
  const key = carrier.send(B.publicRaw, session, bytes("hei"));
  await carrier.pump(0);
  const first = medium.given.length;
  medium.credit = 0;
  clock.now += 2.1;
  await carrier.pump(0);
  assert.ok(queued(carrier, key) && atA.durable.outbox[key].tries === 1, "it waits, and has used nothing yet");
  const [, receipt] = atB.deliver(keptEnvelope(atA, key), [A.publicRaw], readable, 1, NOW);
  medium.events = carry.split(receipt, 64).map((frame) => ["received", null, frame]);
  await carrier.pump(0);
  assert.ok(carrier.confirmed(key));
  medium.credit = 1000;
  await carrier.pump(0);
  assert.deepEqual([medium.given.length, carrier.queue.length], [first, 0], "the copy that waited was not sent after the receipt");
  assert.equal(atA.durable.outbox[key].tries, 1, "and it was never counted");
});

test("a new owner uses no try while the transport has no room", async () => {
  // The check of 16 November 2026: every new owner counted a try as it took the outbox up, room or not. With a budget
  // of three and no room, three owners used it all, the bytes went, and not one frame had been given.
  const clock = new Clock();
  const root = mkdtempSync(join(tmpdir(), "aamio-carry-owner-"));
  try {
    const file = join(root, "a.json");
    const atA = new CarryState(A, file);
    const session = openedPair(atA, new CarryState(B));
    atA.send(B.publicRaw, session, bytes("hei"), readable, { most: 3 });
    const key = mark(B.publicRaw, session, 1);
    const options = { clock: clock.read, wall: () => NOW, retrySeconds: 2 };
    for (let owner = 0; owner < 3; owner++) {
      const medium = new Medium(0);
      const state = new CarryState(A, file);
      const carrier = new Carrier(state, medium, readable, [B.publicRaw], options);
      for (let round = 0; round < 3; round++) {
        clock.now += 2.1;
        await carrier.pump(0);
      }
      assert.deepEqual([medium.given, state.durable.outbox[key].tries, carrier.outcome(key)], [[], 1, "waiting"], `owner ${owner + 1}`);
    }
    // With room the next owner's try is counted as it begins, and goes.
    const medium = new Medium(1000);
    const state = new CarryState(A, file);
    const carrier = new Carrier(state, medium, readable, [B.publicRaw], options);
    await carrier.pump(0);
    assert.ok(medium.given.length > 0 && state.durable.outbox[key].tries === 2);
    // And the tries still end: one more goes, and then the outcome is unknown and the bytes are gone.
    for (let round = 0; round < 3; round++) {
      clock.now += 2.1;
      await carrier.pump(0);
    }
    assert.deepEqual([state.durable.outbox[key].tries, carrier.outcome(key), state.durable.outbox[key].envelope], [3, "unknown", null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("follow-up finding 2: bytes written readable are not taken up under a sealed profile", async () => {
  // A new owner compared only the partner's key, and sent the old readable bytes though the profile said sealed.
  const clock = new Clock();
  const root = mkdtempSync(join(tmpdir(), "aamio-carry-mode-"));
  try {
    const file = join(root, "a.json");
    const atA = new CarryState(A, file);
    const atB = new CarryState(B);
    let [session, ask] = atA.ask(B.publicRaw, readable, 0);
    let [, challenge] = atB.deliver(ask, [A.publicRaw], readable, 0, NOW);
    atA.deliver(challenge, [B.publicRaw], readable, 0, NOW);
    const envelope = atA.send(B.publicRaw, session, bytes("lesbar tekst"), readable, { most: 5 });
    const key = mark(B.publicRaw, session, 1);
    assert.ok(envelope[4] === carry.READABLE && Buffer.from(envelope).includes("lesbar tekst"));
    const medium = new Medium(1000);
    const said = [];
    let carrier = new Carrier(new CarryState(A, file), medium, sealed, [B.publicRaw], { clock: clock.read, wall: () => NOW, tries: 5, note: (line) => said.push(line) });
    assert.ok(!carrier.messages.has(key));
    for (let round = 0; round < 4; round++) {
      clock.now += 3;
      await carrier.pump(0);
    }
    assert.deepEqual(medium.given, [], "nothing readable went out under the sealed profile");
    const kept = new CarryState(A, file);
    assert.deepEqual([kept.outcome(key), kept.durable.outbox[key].envelope], ["unknown", null], "given up, with its mark and hash kept");
    assert.equal(said.length, 1);
    for (const words of [key, "readable", "sealed", "not sent again"]) assert.ok(said[0].includes(words), said[0]);
    // The same mode is taken up as before. One state at a time on the file, as one owner has the home.
    [session, ask] = kept.ask(B.publicRaw, sealed, 10);
    [, challenge] = atB.deliver(ask, [A.publicRaw], sealed, 10, NOW);
    kept.deliver(challenge, [B.publicRaw], sealed, 10, NOW);
    kept.send(B.publicRaw, session, bytes("forseglet"), sealed, { most: 5 });
    carrier = new Carrier(new CarryState(A, file), new Medium(1000), sealed, [B.publicRaw], { clock: clock.read, wall: () => NOW, tries: 5, note: (line) => said.push(line) });
    assert.deepEqual([[...carrier.messages.keys()], said.length], [[mark(B.publicRaw, session, 1)], 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A carrier of A's whose profile for the partner is read each time, a message sent in it, and what it was told. */
function withChangingProfile(room) {
  const clock = new Clock();
  const now = { mode: "readable" };
  const atA = new CarryState(A);
  const session = openedPair(atA, new CarryState(B));
  const medium = new Medium(room);
  const said = [];
  const carrier = new Carrier(atA, medium, () => (now.mode === "sealed" ? sealed : readable), [B.publicRaw], { clock: clock.read, wall: () => NOW, retrySeconds: 2, note: (line) => said.push(line) });
  const key = carrier.send(B.publicRaw, session, bytes("lesbar"));
  return { clock, now, atA, medium, said, carrier, key };
}

test("follow-up finding 2, while it runs: a try that waits for room is not begun once the profile is of another mode", async () => {
  const { now, medium, said, carrier, key } = withChangingProfile(0);
  await carrier.pump(0);
  assert.ok(queued(carrier, key));
  now.mode = "sealed";
  medium.credit = 1000;
  await carrier.pump(0);
  assert.deepEqual([medium.given, carrier.queue.length, carrier.messages.has(key)], [[], 0, false]);
  assert.deepEqual([carrier.outcome(key), said.length], ["unknown", 1]);
  assert.ok(said[0].includes("not sent again"), said[0]);
});

test("follow-up finding 2, at the next try: no try is counted or sent once the profile is of another mode", async () => {
  // The first try went whole while the profile was readable; the next would have gone readable under the sealed one.
  const { clock, now, atA, medium, said, carrier, key } = withChangingProfile(1000);
  await carrier.pump(0);
  const first = medium.given.length;
  assert.ok(first > 0 && carrier.queue.length === 0);
  now.mode = "sealed";
  for (let round = 0; round < 3; round++) {
    clock.now += 2.1;
    await carrier.pump(0);
  }
  assert.deepEqual([medium.given.length, atA.durable.outbox[key].tries, atA.durable.outbox[key].envelope, carrier.messages.has(key)], [first, 1, null, false]);
  assert.deepEqual([carrier.outcome(key), said.length], ["unknown", 1]);
  assert.ok(said[0].includes("not sent again") && said[0].includes(key), said[0]);
});

// ------------------------------------------------------------------ waits on a slow medium (phase 3, 16 November 2026)

// Bytes a second over sound: a full Earshot packet of 128 bytes takes 16.3 seconds.
const SOUND = 128 / 16.3;
const slowMedium = (room = 1000) => {
  const medium = new Medium(room, 128);
  Object.assign(medium.properties, { max_frame_down: 128, rate_up: SOUND, rate_down: SOUND });
  return medium;
};
const heard = (medium, envelope) => {
  medium.events = carry.split(envelope, 128).map((frame) => ["received", null, frame]);
};

test("on a slow medium a group is kept as long as its frames take there, twice over", () => {
  // Over sound a frame takes 16 seconds and more, and a message of more than six frames could never be put together
  // within 120 seconds. The group lives twice as long as its frames take on the medium, and never less than 120 seconds.
  const envelope = carry.write(A, B.publicRaw, carry.READABLE, carry.MESSAGE, 0, new Uint8Array(8), 1, 1794700300, new Uint8Array(900).fill(121));
  const frames = carry.split(envelope, 128);
  assert.equal(frames.length, 9);
  let clock = new Clock();
  const slow = new Reassembly(clock.read, 16.3);
  assert.ok(Math.abs(slow.lifetime(9) - 2 * 9 * 16.3) < 1e-9 && slow.lifetime(1) === 120);
  for (const frame of frames.slice(0, -1)) {
    assert.equal(slow.add(frame), null);
    clock.now += 20;
  }
  assert.ok(carry.equal(slow.add(frames.at(-1)), envelope), "nine frames over 160 seconds, put together");
  clock = new Clock();
  const fast = new Reassembly(clock.read);
  for (const frame of frames.slice(0, -1)) {
    assert.equal(fast.add(frame), null);
    clock.now += 20;
  }
  assert.ok(fast.add(frames.at(-1)) === null && fast.groups.size === 1, "on a fast medium the group went after 120 seconds, as before");
});

test("on a slow medium an ask goes again after the time it and its answer take there", async () => {
  // Over sound an ask of two frames and its challenge of two take 65 seconds on the medium, and with slack a turn is 130.
  // Asked again every 5 seconds, the air was full of asks and nothing else had a turn.
  const clock = new Clock();
  const medium = slowMedium();
  let carrier = new Carrier(new CarryState(A), medium, sealed, [B.publicRaw], { clock: clock.read, wall: () => NOW });
  carrier.random = () => 0;
  carrier.open(B.publicRaw);
  await carrier.pump(0);
  assert.ok(medium.given.length === 2 && carrier.asking(B.publicRaw), "an ask is two frames over sound");
  clock.now += 130;
  await carrier.pump(0);
  assert.equal(medium.given.length, 2, "not before the ask and its challenge could have gone, twice over");
  clock.now += 1;
  await carrier.pump(0);
  assert.equal(medium.given.length, 4, "asked again, with a new session");
  const fast = new Medium(1000, 128);
  carrier = new Carrier(new CarryState(A), fast, sealed, [B.publicRaw], { clock: clock.read, wall: () => NOW });
  carrier.open(B.publicRaw);
  await carrier.pump(0);
  clock.now += 5.1;
  await carrier.pump(0);
  assert.equal(fast.given.length, 4, "on a medium that gives no rate, again after 5 seconds as before");
});

test("on a slow medium an open goes again on a challenge's turn while it can still arrive in the window", async () => {
  // An open that waited for the message behind it and that message's receipt before it went again had two tries in a
  // window of 60 seconds at eight times real time; both were lost in collisions, and so was the session. It goes again on
  // a challenge's turn now, and a try that would come after the window is left out.
  const clock = new Clock();
  const windowed = profile({ mode: "sealed", challengeWindow: 400 });
  const atB = new CarryState(B);
  const medium = slowMedium();
  const carrier = new Carrier(new CarryState(A), medium, windowed, [B.publicRaw], { clock: clock.read, wall: () => NOW });
  carrier.random = () => 0.999;
  carrier.open(B.publicRaw);
  await carrier.pump(0);
  const [, challenge] = atB.deliver(carry.reassemble(medium.given), [A.publicRaw], windowed, 0, NOW);
  heard(medium, challenge);
  await carrier.pump(0);
  const given = medium.given.length;
  assert.ok(given === 4 && !carrier.asking(B.publicRaw), "the open went, two frames, and nothing is asked any more");
  // A turn is 130.4 seconds and up to half of it again: 195.5 with the random part near the top.
  clock.now += 195;
  await carrier.pump(0);
  assert.equal(medium.given.length, given);
  clock.now += 1;
  await carrier.pump(0);
  assert.equal(medium.given.length, given + 2, "the open again, one challenge's turn after it went");
  // The window is 400 seconds. The challenge's time on the medium went before the open began, and the open's own comes
  // after: a try that begins later than 334.8 seconds after the challenge came is too late. The third would begin at 391.5.
  clock.now += 196;
  await carrier.pump(0);
  clock.now += 200;
  await carrier.pump(0);
  assert.ok(medium.given.length === given + 2 && carrier.control.size === 0, "no try that would come after the window, and the open is let go");
});

test("a challenge ends every ask to that partner, and none is asked again", async () => {
  // The first ask was answered after it had been asked again with a new session: the second went on being asked again,
  // and on a half-duplex medium took turns from the message it was asked for.
  const clock = new Clock();
  const atB = new CarryState(B);
  const medium = new Medium(1000, 128);
  const carrier = new Carrier(new CarryState(A), medium, sealed, [B.publicRaw], { clock: clock.read, wall: () => NOW });
  carrier.open(B.publicRaw);
  await carrier.pump(0);
  const first = carry.reassemble(medium.given);
  clock.now += 5.1;
  await carrier.pump(0);
  assert.ok(carrier.asking(B.publicRaw) && medium.given.length === 4, "no challenge yet: asked again, with a new session");
  const [, challenge] = atB.deliver(first, [A.publicRaw], sealed, 0, NOW);
  heard(medium, challenge);
  await carrier.pump(0);
  assert.ok(!carrier.asking(B.publicRaw), "the challenge to the first ask ends the second as well");
  for (let round = 0; round < 4; round++) {
    clock.now += 5.1;
    await carrier.pump(0);
  }
  assert.ok(!carrier.asking(B.publicRaw) && carrier.openSession(B.publicRaw) !== null);
});

test("what a slow medium needs for a session and a send is measured in its frames", () => {
  // A challenge and its open with slack, the window in which an open has three tries, and how long a send waits: over
  // sound 130.4, 456.4 and 326 seconds. On a medium that gives no rate, nothing.
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const carrier = new Carrier(new CarryState(A), slowMedium(), sealed, [B.publicRaw], { clock: new Clock().read, wall: () => NOW });
  assert.ok(near(carrier.handshakeSeconds(), 2 * 16.3 * 4));
  assert.ok(near(carrier.windowForOpens(), 2 * 2 * 16.3 + 2 * 1.5 * 2 * 16.3 * 4));
  assert.ok(near(carrier.patience(12), 2 * 16.3 * (4 * 2 + 2)));
  const fast = new Carrier(new CarryState(A), new Medium(1000, 128), sealed, [B.publicRaw], { clock: new Clock().read, wall: () => NOW });
  assert.deepEqual([fast.handshakeSeconds(), fast.windowForOpens(), fast.patience(12)], [0, 0, 0]);
});

// ------------------------------------------------------------------ decided 17 November 2026

async function askedAndAnswered(clock, medium, atB, chosen) {
  const carrier = new Carrier(new CarryState(A), medium, chosen, [B.publicRaw], { clock: clock.read, wall: () => NOW });
  const session = carrier.open(B.publicRaw);
  await carrier.pump(0);
  const [, challenge] = atB.deliver(carry.reassemble(medium.given), [A.publicRaw], chosen, 0, NOW);
  heard(medium, challenge);
  await carrier.pump(0);
  assert.ok(carry.equal(carrier.usableSession(B.publicRaw, 3600), session));
  return { carrier, session };
}

test("a session a message went three tries in without a receipt takes no new message", async () => {
  // B started again takes A's session as expired (A6.8) and refuses what comes in it without a word over the medium
  // (A7). Once a message in it has gone three tries without a receipt, the next message asks for a new session; a receipt
  // that comes after all makes the session usable again.
  const clock = new Clock();
  const atB = new CarryState(B);
  const medium = new Medium(1000, 128);
  const { carrier, session } = await askedAndAnswered(clock, medium, atB, sealed);
  const key = carrier.send(B.publicRaw, session, bytes("hei"));
  await carrier.pump(0);
  clock.now += 2.1;
  await carrier.pump(0);
  assert.ok(carry.equal(carrier.usableSession(B.publicRaw, 3600), session), "two tries without a receipt: the session still takes messages");
  clock.now += 2.1;
  await carrier.pump(0);
  assert.equal(carrier.state.durable.outbox[key].tries, 3);
  assert.equal(carrier.usableSession(B.publicRaw, 3600), null, "three: the next message asks for a new session");
  const [, receipt] = atB.deliver(keptEnvelope(carrier.state, key), [A.publicRaw], sealed, 10, NOW);
  heard(medium, receipt);
  await carrier.pump(0);
  assert.ok(carrier.confirmed(key) && carry.equal(carrier.usableSession(B.publicRaw, 3600), session), "the receipt came after all");
});

test("a bound message whose open was lost opens its session, and the challenge goes no more", async () => {
  // Over sound the open was lost in collisions, the session with it, and the messages behind it were refused. A bound
  // message is signed over the challenge as the open is, so it opens the session itself, and the challenge stops.
  const clock = new Clock();
  const atA = new CarryState(A);
  const medium = new Medium(1000, 128);
  const carrier = new Carrier(new CarryState(B), medium, sealed, [A.publicRaw], { clock: clock.read, wall: () => NOW });
  const [session, ask] = atA.ask(B.publicRaw, sealed, 0);
  heard(medium, ask);
  await carrier.pump(0);
  assert.deepEqual([...carrier.control.values()].map((entry) => entry.kind), ["challenge"]);
  atA.deliver(carry.reassemble(medium.given), [B.publicRaw], sealed, 0, NOW);
  heard(medium, atA.send(B.publicRaw, session, bytes("hei uten open"), sealed));
  await carrier.pump(0);
  assert.deepEqual(carrier.inbox.map((entry) => new TextDecoder().decode(entry[3])), ["hei uten open"]);
  assert.equal(carrier.control.size, 0, "the challenge is not sent again: the message opened the session");
});

