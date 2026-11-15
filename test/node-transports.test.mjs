/**
 * Transports in the Node runtime (contract 3, phase 2): two homes exchange messages over the local network with
 * aamio.at out of reach.
 *
 * The lan transport from addons/lan runs on 127.0.0.1, each home on a UDP port of its own with the other named as its
 * peer and broadcast off, so nothing leaves the machine. The service is at http://127.0.0.1:9, where nobody answers:
 * what arrives came over the transport. enable reads the transport from its manifest and probes it; the commands bind
 * and unbind and keep the profiles; and two processes, as two machines run them, exchange a message: one reads and
 * waits, or serves, and the other sends.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probe } from "../src/node-addon-process.js";
import { describe as describeAddons, enable } from "../src/node-addons.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import * as transports from "../src/node-transports.js";

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
