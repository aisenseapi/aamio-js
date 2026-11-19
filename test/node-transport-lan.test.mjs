/**
 * The transport over the local network (addons/lan), for Node, on 127.0.0.1 through the host of contract 3.
 *
 * Two carriers, each with its own lan transport on a UDP port of its own and the other named as its peer, broadcast
 * off so nothing leaves 127.0.0.1. A probe opens no port, a port another program holds is down until it opens, and
 * then up with room; a message goes each way with its receipt, readable and sealed; a datagram of another kind is
 * dropped; and a frame is called sent only when the operating system took a datagram of it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keys } from "../src/aamio.js";
import { CarryState, profile } from "../src/node-carry-state.js";
import { Carrier } from "../src/node-carrier.js";
import { TransportProcess, environment } from "../src/node-transport-host.js";

const lanDir = fileURLToPath(new URL("../addons/lan/", import.meta.url));
const script = join(lanDir, "transport.js");
// The version the transport describes itself as, read where it is set: describe must name the manifest's.
const LAN_VERSION = JSON.parse(readFileSync(join(lanDir, "aamio-addon.json"), "utf8")).version;
const A = Keys.fromSeedHex("01".repeat(32));
const B = Keys.fromSeedHex("02".repeat(32));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function lanProcess(port, peer, folder) {
  const base = Object.fromEntries(["PATH", "SYSTEMROOT", "TEMP", "TMP"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const env = environment(["AAMIO_LAN_PORT", "AAMIO_LAN_BIND", "AAMIO_LAN_BROADCAST", "AAMIO_LAN_PEERS"],
    { ...base, AAMIO_LAN_PORT: String(port), AAMIO_LAN_BIND: "127.0.0.1", AAMIO_LAN_BROADCAST: "none", AAMIO_LAN_PEERS: `127.0.0.1:${peer}` });
  return new TransportProcess("lan", LAN_VERSION, [process.execPath, script], folder, env, { describeSeconds: 30 });
}

/** Events until condition holds of them, all of them kept; null when it did not within seconds. */
async function waitFor(transport, condition, seconds = 10) {
  const events = [];
  const until = Date.now() + seconds * 1000;
  while (!condition(transport, events)) {
    if (Date.now() >= until) return null;
    events.push(...(await transport.poll(50)));
  }
  return events;
}

async function started(port, peer, folder) {
  const transport = lanProcess(port, peer, folder);
  await transport.start("0.0.0-test", "node", folder);
  await waitFor(transport, (t) => t.room() > 0);
  return transport;
}

test("the manifest is a transport under contract 3, the same file in the three runtimes", () => {
  const manifest = JSON.parse(readFileSync(join(lanDir, "aamio-addon.json"), "utf8"));
  assert.equal(manifest.aamio_addon, 3);
  assert.equal(manifest.transport.start.node, "transport.js");
  const python = fileURLToPath(new URL("../../aamio-python/addons/lan/src/aamio_lan/aamio-addon.json", import.meta.url));
  const php = fileURLToPath(new URL("../../aamio-php/addons/lan/aamio-addon.json", import.meta.url));
  for (const other of [python, php]) {
    let text = null;
    try {
      text = readFileSync(other, "utf8");
    } catch {
      continue;
    }
    assert.equal(text, readFileSync(join(lanDir, "aamio-addon.json"), "utf8"), other);
  }
});

test("a probe describes itself, opens no port and gives no room", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "aamio-lan-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [port, peer] = await freePorts(2);
  const transport = lanProcess(port, peer, folder);
  try {
    await transport.start("0.0.0-test", "node", folder, { probe: true });
    assert.equal(transport.medium, "lan");
    await sleep(1000);
    const events = await transport.poll(100);
    assert.equal(transport.room(), 0);
    assert.ok(!events.some((event) => event[0] === "status"), JSON.stringify(events));
    const mine = createSocket("udp4");
    await new Promise((resolve, reject) => {
      mine.once("error", reject);
      mine.bind(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => mine.close(resolve));
  } finally {
    await transport.stop();
  }
});

test("a port another program holds is down until it opens, and then up with room", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "aamio-lan-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [port, peer] = await freePorts(2);
  const holder = createSocket({ type: "udp4", reuseAddr: false });
  await new Promise((resolve) => holder.bind({ port, address: "127.0.0.1", exclusive: true }, resolve));
  let held = true;
  const transport = lanProcess(port, peer, folder);
  try {
    await transport.start("0.0.0-test", "node", folder);
    const down = await waitFor(transport, (_, seen) => seen.some((event) => event[0] === "status" && event[1] === "down"));
    assert.ok(down, "said down");
    assert.ok(transport.room() <= 0);
    assert.match(down.find((event) => event[0] === "status")[2], /could not be opened/);
    await new Promise((resolve) => holder.close(resolve));
    held = false;
    const up = await waitFor(transport, (t2) => t2.room() > 0);
    assert.ok(up && up.some((event) => event[0] === "status" && event[1] === "up"), JSON.stringify(up));
  } finally {
    if (held) await new Promise((resolve) => holder.close(resolve));
    await transport.stop();
  }
});

for (const mode of ["readable", "sealed"]) {
  test(`${mode}: a message each way over the local network with its receipt`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "aamio-lan-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const [portA, portB] = await freePorts(2);
    const radios = [await started(portA, portB, folder), await started(portB, portA, folder)];
    try {
      const chosen = profile({ mode });
      const atA = new Carrier(new CarryState(A, join(folder, "a.json")), radios[0], chosen, [B.publicRaw], { retrySeconds: 1, askRetrySeconds: 3 });
      const atB = new Carrier(new CarryState(B, join(folder, "b.json")), radios[1], chosen, [A.publicRaw], { retrySeconds: 1, askRetrySeconds: 3 });
      const pumpUntil = async (condition) => {
        const until = Date.now() + 30_000;
        while (!condition()) {
          assert.ok(Date.now() < until, JSON.stringify([atA.refused, atB.refused]));
          await atA.pump(10);
          await atB.pump(10);
        }
      };
      atA.open(B.publicRaw);
      await pumpUntil(() => atA.openSession(B.publicRaw) !== null);
      const sent = atA.send(B.publicRaw, atA.openSession(B.publicRaw), new TextEncoder().encode("hei over nettet"));
      await pumpUntil(() => atA.confirmed(sent) && atB.inbox.length > 0);
      atB.open(A.publicRaw);
      await pumpUntil(() => atB.openSession(A.publicRaw) !== null);
      const reply = atB.send(A.publicRaw, atB.openSession(A.publicRaw), new TextEncoder().encode("svar over nettet"));
      await pumpUntil(() => atB.confirmed(reply) && atA.inbox.length > 0);
      assert.deepEqual(atB.inbox.map((entry) => new TextDecoder().decode(entry[3])), ["hei over nettet"]);
      assert.deepEqual(atA.inbox.map((entry) => new TextDecoder().decode(entry[3])), ["svar over nettet"]);
      assert.deepEqual([atA.refused, atB.refused], [[], []], "a transport drops what it sent itself");
      assert.ok(atA.handedOver(sent) && atB.handedOver(reply), "every frame of each was handed over, as the transport said");
    } finally {
      for (const radio of radios) await radio.stop();
    }
  });
}

test("a datagram of another kind is dropped, and one of this kind comes with its address", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "aamio-lan-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [port, peer] = await freePorts(2);
  const transport = await started(port, peer, folder);
  try {
    const other = createSocket("udp4");
    await new Promise((resolve) => other.send(Buffer.from("not aamio at all, just noise on the port"), port, "127.0.0.1", resolve));
    await new Promise((resolve) => other.send(Buffer.concat([Buffer.from("AL1"), Buffer.alloc(8), Buffer.from("AF"), Buffer.alloc(20)]), port, "127.0.0.1", resolve));
    await new Promise((resolve) => other.close(resolve));
    const heard = await waitFor(transport, (_, seen) => seen.some((event) => event[0] === "received"), 5);
    const received = (heard ?? []).filter((event) => event[0] === "received");
    assert.equal(received.length, 1);
    assert.ok(Buffer.from(received[0][2]).equals(Buffer.concat([Buffer.from("AF"), Buffer.alloc(20)])));
    assert.match(received[0][1], /^lan:127\.0\.0\.1:/);
  } finally {
    await transport.stop();
  }
});

// ------------------------------------------------------------------ the follow-up check of 2026-11-15, finding 9

test("follow-up finding 9: a frame is sent only when the operating system took a datagram of it, and an error when it took none", async (t) => {
  // sent was said before the operating system had answered, so a frame none of whose datagrams went was called sent.
  // test/lan-send-fails.mjs, loaded into the transport's process, makes every datagram to one port fail as a full buffer
  // does: a failure put in, not one this machine has.
  const folder = mkdtempSync(join(tmpdir(), "aamio-lan-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const [port, refused, taken] = await freePorts(3);
  const listener = createSocket("udp4");
  const arrived = [];
  listener.on("message", (data) => arrived.push(data));
  await new Promise((resolve) => listener.bind(taken, "127.0.0.1", resolve));
  const base = Object.fromEntries(["PATH", "SYSTEMROOT", "TEMP", "TMP"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const env = environment(["AAMIO_LAN_PORT", "AAMIO_LAN_BIND", "AAMIO_LAN_BROADCAST", "AAMIO_LAN_PEERS"],
    { ...base, AAMIO_LAN_PORT: String(port), AAMIO_LAN_BIND: "127.0.0.1", AAMIO_LAN_BROADCAST: "none", AAMIO_LAN_PEERS: `127.0.0.1:${refused},127.0.0.1:${taken}` });
  env.AAMIO_TEST_SEND_FAILS = String(refused);
  const said = [];
  const transport = new TransportProcess("lan", LAN_VERSION, [process.execPath, "--import", new URL("./lan-send-fails.mjs", import.meta.url).href, script], folder, env,
    { describeSeconds: 30, log: (line) => said.push(line) });
  try {
    await transport.start("0.0.0-test", "node", folder);
    assert.ok(await waitFor(transport, (t2) => t2.room() > 0), "no room");
    const frame = Buffer.concat([Buffer.from("AF"), Buffer.alloc(20, 7)]);
    const answered = async (to) => {
      const id = transport.send(frame, to);
      assert.ok(await waitFor(transport, (t2) => t2.status(id) !== "waiting"), `no answer for a frame to ${to}`);
      return [transport.status(id), transport.frames.get(id).reason ?? null];
    };
    assert.deepEqual(await answered(`lan:127.0.0.1:${refused}`), ["not_sent", "send_failed"], "no datagram went, so the frame is not sent, with the reason");
    assert.deepEqual(await answered(`lan:127.0.0.1:${taken}`), ["sent", null]);
    assert.deepEqual(await answered(null), ["sent", null], "to nobody in particular, one peer refused and one taken: a datagram went");
    assert.deepEqual(await answered("lan:127.0.0.1:0"), ["not_sent", "send_failed"], "a port no datagram can go to is that frame's error, and not the end of the transport");
    assert.ok(await waitFor(transport, (t2) => t2.room() === 32), "the room comes back with the answers");
    const until = Date.now() + 5000;
    while ((arrived.length < 2 || !said.some((line) => line.includes("ENOBUFS"))) && Date.now() < until) await sleep(20);
    assert.equal(arrived.length, 2, "what was called sent went to the port that takes datagrams, and nothing else did");
    assert.ok(arrived.every((data) => data.subarray(11).equals(frame)));
    assert.ok(said.some((line) => line.includes(`a frame to 127.0.0.1:${refused} did not go`) && line.includes("ENOBUFS")), JSON.stringify(said));
  } finally {
    await transport.stop();
    await new Promise((resolve) => listener.close(resolve));
  }
});
