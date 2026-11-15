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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import { delimiter, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keys } from "../src/aamio.js";
import * as carry from "../src/carry.js";
import { CarryState, mark, profile } from "../src/node-carry-state.js";
import { Carrier } from "../src/node-carrier.js";
import { Reassembly, TransportFailed, TransportProcess, environment } from "../src/node-transport-host.js";

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
