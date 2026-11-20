#!/usr/bin/env node
// aamio over the local network, for Node: a transport under contract 3 that sends each frame as one UDP datagram.
//
// The same protocol as aamio_lan.transport in aamio-python and transport.php in aamio-php, so any of them can talk to
// any other. A frame to nobody in particular goes to the broadcast address of the network and to the peers named in
// AAMIO_LAN_PEERS; a frame to an address goes to that address alone. An address is lan:<ip>:<port>. Each datagram is
// "AL1", eight bytes that name this process, and the frame: a transport drops what it sent itself, which a broadcast
// brings back to it, and anything that is not of this kind. The core seals and verifies; the network sees that frames go.
// A frame is answered once the operating system has said how each datagram of it went: sent when it took at least one,
// and an error when it took none.
//
// The port is opened after hello, and never when hello says probe: enable then only sees that this starts and
// describes itself. A port that cannot be opened, as one another program holds, is said as down and tried again every
// two seconds, and said as up with room once it opens. Each ready says where this machine is reached, here: the address
// it listens on, or with 0.0.0.0 its own addresses on the network, as they were when the port opened, at most four, so a
// card can carry one and a partner can bind it. Standard error is UTF-8, as contract 3 asks, as Node writes it to a pipe.
//
//   AAMIO_LAN_PORT       the UDP port this transport listens on, 47474 if left out
//   AAMIO_LAN_BIND       the address it listens on, 0.0.0.0 if left out
//   AAMIO_LAN_BROADCAST  where a frame to nobody in particular goes, 255.255.255.255 if left out, none for nowhere
//   AAMIO_LAN_PEERS      host:port of other transports it also sends such frames to, comma separated

import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";

const NAME = "lan";
const VERSION = "0.2.0";
const MAGIC = Buffer.from("AL1");
const CREDIT = 32;
const MAX_FRAME = 1200;
const RETRY_MS = 2000;
const HERE_MOST = 4;

/**
 * A port from 1 to 65535, from its decimal digits, or null. Out of range, a port went to the socket: in Node the frame's
 * send failed, in Python the transport ended, and in PHP the datagram went to another port and said sent (a review of
 * 20 November 2026). Port 0 asks the system to choose, and a ready would then name a port nobody can reach.
 */
function portOf(text) {
  if (typeof text !== "string" || !/^[0-9]+$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= 65535 ? number : null;
}

/**
 * text as Python's repr writes it, so the line that leaves a peer out is the same as aamio-python's: in single quotes, or
 * in double ones when it holds a single quote and no double, with what is not printable escaped.
 */
function quoted(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const named = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" };
  return quote + text.replace(/[\\']|(?! )[\p{C}\p{Z}]/gu, (c) => {
    if (c === "'") return quote === "'" ? "\\'" : c;
    if (named[c]) return named[c];
    const code = c.codePointAt(0);
    const [mark, width] = code < 0x100 ? ["x", 2] : code < 0x10000 ? ["u", 4] : ["U", 8];
    return `\\${mark}${code.toString(16).padStart(width, "0")}`;
  }) + quote;
}

const port = portOf((process.env.AAMIO_LAN_PORT ?? "47474").trim());
if (port === null) {
  process.stderr.write("aamio-lan: AAMIO_LAN_PORT must be a port from 1 to 65535\n");
  process.exit(1);
}
const bind = process.env.AAMIO_LAN_BIND ?? "0.0.0.0";
const broadcastSetting = (process.env.AAMIO_LAN_BROADCAST ?? "255.255.255.255").trim();
const broadcast = ["", "none"].includes(broadcastSetting.toLowerCase()) ? null : broadcastSetting;
const me = randomBytes(8);
let socket = null;
let stopping = false;
let saidDown = false;
let sendsRead = 0;
// Frames read whose answer waits for what the operating system says of their datagrams.
let unanswered = 0;
let retry = null;
// Where this machine is reached, as lan:<ip>:<port>, found when the port opened.
let here = [];

const say = (message) => process.stdout.write(JSON.stringify(message) + "\n");

/** The address a route out of this machine would leave from, found without sending anything, or null. */
function routeAddress() {
  return new Promise((resolve) => {
    let probe;
    const done = (address) => {
      try {
        probe.close();
      } catch {
        // Closed already.
      }
      resolve(address);
    };
    try {
      probe = createSocket("udp4");
      probe.unref();
      probe.on("error", () => done(null));
      setTimeout(() => done(null), 1000).unref();
      // Nothing goes: connect on UDP only picks the interface a route would take. Without a route it fails, and says so here.
      probe.connect(9, "10.254.254.254", (error) => {
        let address = null;
        try {
          address = error ? null : probe.address().address;
        } catch {
          address = null;
        }
        done(address);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Where this machine is reached: the address the port is bound to, or with 0.0.0.0 its own IPv4 addresses, the one a
 * route out would use first, without loopback and link-local ones, at most HERE_MOST, as lan:<ip>:<port>.
 */
async function addresses() {
  if (!["0.0.0.0", ""].includes(bind)) return [`lan:${bind}:${port}`];
  const found = [];
  const first = await routeAddress();
  if (first !== null) found.push(first);
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal) found.push(entry.address);
    }
  } catch {
    // No list of interfaces: the route's address, if any, is what there is.
  }
  const mine = [];
  for (const ip of found) {
    if (mine.includes(ip) || ip === "0.0.0.0" || ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
    mine.push(ip);
  }
  return mine.slice(0, HERE_MOST).map((ip) => `lan:${ip}:${port}`);
}

const peers = [];
for (const part of (process.env.AAMIO_LAN_PEERS ?? "").split(",").map((text) => text.trim()).filter(Boolean)) {
  const at = part.lastIndexOf(":");
  const peerPort = portOf(part.slice(at + 1));
  if (at <= 0 || peerPort === null) process.stderr.write(`aamio-lan: ${quoted(part)} is no host:port with a port from 1 to 65535, and is left out\n`);
  else peers.push([part.slice(0, at), peerPort]);
}

function open() {
  retry = null;
  if (stopping) return;
  const made = createSocket({ type: "udp4", reuseAddr: false });
  let bound = false;
  made.on("error", (error) => {
    if (stopping) return;
    if (!bound) {
      // The port could not be opened: said once, and tried again.
      if (!saidDown) {
        say({ t: "status", state: "down", reason: `port ${port} on ${bind} could not be opened: ${error.message}` });
        saidDown = true;
      }
      made.close();
      retry = setTimeout(open, RETRY_MS);
      return;
    }
    // A transport that can no longer hear says so (B3), rather than go quiet as if the network were.
    say({ t: "status", state: "down", reason: `the network cannot be heard: ${error.message}` });
  });
  made.on("message", (data, from) => {
    if (data.length < MAGIC.length + 8 + 10 || !data.subarray(0, 3).equals(MAGIC) || data.subarray(3, 11).equals(me)) return;
    const frame = data.subarray(11);
    if (frame.length > MAX_FRAME) return;
    say({ t: "received", from: `lan:${from.address}:${from.port}`, frame: frame.toString("base64url") });
  });
  made.bind({ port, address: bind, exclusive: true }, async () => {
    bound = true;
    made.setBroadcast(true);
    // Where this machine is reached, as it is when the port opens; no frame is given to it before the ready below.
    here = await addresses();
    socket = made;
    if (saidDown) say({ t: "status", state: "up", reason: `port ${port} is open` });
    saidDown = false;
    ready();
  });
}

function targets(to) {
  if (to !== null && to !== undefined) {
    const parts = String(to).split(":");
    // Another medium, no host or a port out of range is refused here, and never reaches the socket.
    const toPort = parts.length === 3 && parts[0] === "lan" && parts[1] ? portOf(parts[2]) : null;
    if (toPort === null) throw new Error("bad address");
    return [[parts[1], toPort]];
  }
  const found = [...peers];
  if (broadcast !== null) found.push([broadcast, port]);
  return found;
}

/**
 * A frame given to the network, and done told how it went, once: sent when the operating system took at least one
 * datagram of it, and an error when it took none. The answer waits for what the operating system says of each datagram:
 * said at once, a frame no datagram of which went was called sent (the follow-up check of 15 November 2026). A datagram
 * the operating system took is on the network, and that is all sent says: only a receipt says the partner has it.
 */
function send(message, done) {
  const frame = Buffer.from(String(message.frame ?? ""), "base64url");
  if (socket === null) return done({ t: "error", id: message.id, code: "down", message: "the port is not open" });
  if (frame.length > MAX_FRAME) return done({ t: "error", id: message.id, code: "too_large", message: `the frame is larger than ${MAX_FRAME} bytes` });
  let found;
  try {
    found = targets(message.to);
  } catch {
    return done({ t: "error", id: message.id, code: "bad_address", message: "an address is lan:<ip>:<port>, with a port from 1 to 65535" });
  }
  if (found.length === 0) return done({ t: "error", id: message.id, code: "nowhere", message: "no broadcast and no peers: a frame to nobody in particular has nowhere to go" });
  const datagram = Buffer.concat([MAGIC, me, frame]);
  let left = found.length;
  let gone = 0;
  const went = (host, peerPort, error) => {
    if (error) process.stderr.write(`aamio-lan: a frame to ${host}:${peerPort} did not go: ${error.message}\n`);
    else gone += 1;
    left -= 1;
    if (left > 0) return;
    done(gone > 0 ? { t: "sent", id: message.id } : { t: "error", id: message.id, code: "send_failed", message: "the frame could not be given to the network" });
  };
  for (const [host, peerPort] of found) {
    try {
      socket.send(datagram, peerPort, host, (error) => went(host, peerPort, error));
    } catch (error) {
      // Refused before it was tried, as by a socket that has closed: that datagram did not go either.
      went(host, peerPort, error);
    }
  }
}

/** Room for as many frames as the operating system is not still busy with, and once the port is open, where this machine is reached (contract 3, B3). */
function ready() {
  const said = { t: "ready", credit: Math.max(0, CREDIT - unanswered), sends_read: sendsRead };
  if (socket !== null && here.length) said.here = here;
  say(said);
}

function finish() {
  if (stopping) return;
  stopping = true;
  if (retry) clearTimeout(retry);
  if (socket) socket.close(() => process.exit(0));
  else process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.t === "hello") {
    say({ t: "describe", name: NAME, version: VERSION, aamio_addon: 3, medium: "lan",
      properties: { max_frame_up: MAX_FRAME, max_frame_down: MAX_FRAME, rate_up: 1000000, rate_down: 1000000, direction: "duplex",
        addressing: "device", link_ack: false, airtime: null, metadata_visible_to: "range", medium_encrypts: false } });
    if (message.probe !== true) open();
  } else if (message.t === "send") {
    sendsRead += 1;
    unanswered += 1;
    send(message, (answer) => {
      unanswered -= 1;
      say(answer);
      ready();
    });
  } else if (message.t === "stop") {
    lines.close();
    finish();
  }
  // cancel: a datagram is with the operating system as soon as it is given, so nothing is left to cancel
});
lines.on("close", finish);
