// The package as aamio finds and runs it: what npm would install, in the folder for add-ons of a scratch home, listed
// from its manifest, enabled, and called through the core's command line and its MCP server, each call a process of
// the add-on's own. Offline: only what needs no network and no sound is called, the card, the local engine with a
// file in and a file out, and what is refused before anything is sent. The core is the one this package lies in,
// aamio-js; where it is not there, as in an installed copy of the package alone, these are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../../../bin/aamio.js", import.meta.url));
const python = fileURLToPath(new URL("../../../../aamio-python/addons/earshot/src/aamio_earshot/aamio-addon.json", import.meta.url));
const core = existsSync(bin) ? false : "the core is not beside this package";
const pkg = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(here, "aamio-addon.json"), "utf8"));
const ADDRESS = "k7rq2m4xw5tbz3yd6ena";
const SCOPE_KEY = "abcdefghijklmnopqrstuvwxyz";
const READ_KEY = "0123456789abcdefghijklmnop";
// The core is pointed at nothing that listens: no command here needs the service.
const ENV = { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9", AAMIO_VERIFYUM: "http://127.0.0.1:9" };

function cli(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "--home", home, ...args], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      let said = null;
      try {
        said = JSON.parse(stdout);
      } catch {
        said = null;
      }
      resolve({ status, stdout, stderr: Buffer.concat(err).toString("utf8"), said });
    });
  });
}

// A home with its identity, and this package in its folder for add-ons as npm install leaves one: the files the
// package ships, and the folder's own package.json naming it.
async function installed(t) {
  const root = await mkdtemp(join(tmpdir(), "aamio-earshot-host-"));
  // What the test started on the home is ended first: a server holds the home's lock, and a held lock cannot be
  // removed on Windows.
  const closing = [];
  t.after(async () => {
    for (const close of closing) await close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const home = join(root, "home");
  const made = await cli(home, ["init"]);
  assert.equal(made.status, 0, made.stderr);
  const folder = join(home, "addon-packages", "npm");
  const target = join(folder, "node_modules", pkg.name);
  for (const file of ["package.json", ...pkg.files]) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await cp(join(here, file), join(target, file));
  }
  await writeFile(join(folder, "package.json"), JSON.stringify({ private: true, dependencies: { [pkg.name]: pkg.version } }, null, 2));
  return { root, home, target, closing };
}

test("the package ships every file its process loads, and names no dependency", async () => {
  assert.deepEqual([pkg.name, pkg.type, pkg.aamioAddon, pkg.engines.node], ["aamio-earshot", "module", "./aamio-addon.json", ">=20"]);
  assert.equal(pkg.dependencies, undefined, "nothing is installed with it");
  assert.equal(pkg.version, manifest.version, "the package and its manifest say the same version");
  assert.equal(manifest.process.node, "process.js");
  for (const file of pkg.files) assert.ok(existsSync(join(here, file)), `${file} is in the package`);
  // Every file the process loads, followed from its entry, is one the package ships.
  const seen = new Set();
  const follow = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(join(here, file), "utf8");
    for (const [, target] of text.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      await follow(join(dirname(file), target).replaceAll("\\", "/"));
    }
  };
  await follow(manifest.process.node);
  assert.deepEqual([...seen].filter((file) => !pkg.files.includes(file)), []);
  assert.deepEqual([...seen].sort(), ["process.js", "src/about.js", "src/audio.js", "src/card.js", "src/codec.js", "src/process.js", "src/service.js"]);
});

test("the manifest is the Python edition's, with the script Node runs added", { skip: existsSync(python) ? false : "the Python edition is not beside this package" }, async () => {
  const theirs = JSON.parse(await readFile(python, "utf8"));
  const mine = structuredClone(manifest);
  delete mine.process.node;
  assert.deepEqual(mine, theirs);
});

test("the core lists earshot from its manifest without running it, and enables it", { skip: core }, async (t) => {
  const { home } = await installed(t);
  const listed = await cli(home, ["addon", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.said.addons, [{
    name: "earshot", version: pkg.version, distribution: "aamio-earshot", enabled: false, contract: 2, environment: ["XDG_RUNTIME_DIR", "PULSE_SERVER"], fix: "aamio addon enable earshot",
  }]);
  const tried = await cli(home, ["addon", "earshot", "card", ADDRESS]);
  assert.equal(tried.status, 2, "installed is not enabled");
  const enabled = await cli(home, ["addon", "enable", "earshot"]);
  assert.equal(enabled.status, 0, enabled.stderr);
  const row = enabled.said.addons[0];
  assert.deepEqual([row.name, row.enabled, row.contract, row.version], ["earshot", true, 2, pkg.version]);
  assert.deepEqual(row.commands, ["broadcast", "card", "decode", "listen"]);
  assert.deepEqual(row.mcp_tools, ["aamio_addon_earshot_broadcast", "aamio_addon_earshot_listen", "aamio_addon_earshot_decode"]);
  assert.ok(enabled.said.note.includes("XDG_RUNTIME_DIR, PULSE_SERVER, which its manifest asks for"), "enable says which variables it asks for");
  const help = await cli(home, ["addon", "earshot", "--help"]);
  assert.equal(help.status, 0);
  for (const words of ["Usage: aamio addon earshot <command>", "card ADDRESS [--name NAME] [--valid-for VALID_FOR]", "A card carries the write address of a scope", "decode FILE [--mode MODE] [--engine ENGINE]"]) {
    assert.ok(help.stdout.includes(words), words);
  }
});

test("the commands run in a process of their own, and the local engine makes and reads a card with no network", { skip: core }, async (t) => {
  const { root, home } = await installed(t);
  assert.equal((await cli(home, ["addon", "enable", "earshot"])).status, 0);
  const before = Math.floor(Date.now() / 1000);
  const made = await cli(home, ["addon", "earshot", "card", ADDRESS, "--name", "rom-42"]);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.said.card, `aamio:scope/${ADDRESS}?n=rom-42&t=${made.said.expires_at}`);
  assert.ok(made.said.expires_at - before >= 3600 && made.said.expires_at - before < 3700, "good for an hour by the real clock");
  const key = await cli(home, ["addon", "earshot", "broadcast", SCOPE_KEY]);
  assert.deepEqual([key.status, key.said.reason], [2, "a_key_not_an_address"], "a key is refused before anything is sent");
  const missing = await cli(home, ["addon", "earshot", "decode", join(root, "missing.wav")]);
  assert.deepEqual([missing.status, missing.said.reason], [2, "no_such_file"]);
  const long = await cli(home, ["addon", "earshot", "listen", "--seconds", "99"]);
  assert.deepEqual([long.status, long.said.reason], [2, "invalid_seconds"], "a length out of bounds opens no microphone");
  assert.equal(existsSync(join(home, "addons", "earshot")), false, "and no command made a directory in the home");

  const out = join(root, "cli-local.wav");
  const written = await cli(home, ["addon", "earshot", "broadcast", ADDRESS, "--name", "rom-42", "--engine", "local", "--out", out]);
  assert.equal(written.status, 0, written.stderr + written.stdout);
  assert.deepEqual([written.said.status, written.said.engine, written.said.file, written.said.mode, written.said.duration_seconds], ["written", "local", out, "audible", 9.5]);
  const heard = await cli(home, ["addon", "earshot", "decode", out, "--engine", "local"]);
  assert.equal(heard.status, 0, heard.stderr + heard.stdout);
  assert.deepEqual([heard.said.status, heard.said.engine, heard.said.mode, heard.said.corrected_bits], ["heard", "local", "audible", 0]);
  assert.deepEqual(heard.said.card, { kind: "scope", address: ADDRESS, name: "rom-42", expires_at: written.said.expires_at });
  assert.ok(heard.said.next.startsWith(`aamio scope add rom-42 --address ${ADDRESS}, then aamio board post offer TITLE TEXT --scope rom-42`), "the next step in the command line's words");
  const again = await cli(home, ["addon", "earshot", "broadcast", ADDRESS, "--engine", "local", "--out", out]);
  assert.deepEqual([again.status, again.said.reason], [2, "out_exists"]);
});

// The client end of the core's MCP server over its standard input and output.
function serve(home) {
  const child = spawn(process.execPath, [bin, "--home", home, "serve"], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let rest = "";
  let ids = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rest += chunk;
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  return {
    ask(method, params = {}) {
      const id = ++ids;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method}: ${Buffer.concat(errors).toString("utf8")}`)), 60_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    // The server ends when its input does. One that does not is stopped, so no test leaves a process behind.
    end: () => new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill(), 10_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    }),
  };
}

test("over MCP the tools come from the manifest, a key is refused by the process, and a file is read", { skip: core }, async (t) => {
  const { root, home, closing } = await installed(t);
  assert.equal((await cli(home, ["addon", "enable", "earshot"])).status, 0);
  const out = join(root, "mcp-local.wav");
  assert.equal((await cli(home, ["addon", "earshot", "broadcast", ADDRESS, "--name", "rom-42", "--engine", "local", "--out", out])).status, 0);
  const server = serve(home);
  closing.push(() => server.end());
  await server.ask("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const tools = new Map((await server.ask("tools/list")).result.tools.map((tool) => [tool.name, tool]));
  const broadcast = tools.get("aamio_addon_earshot_broadcast");
  assert.equal(broadcast.inputSchema.properties.address.pattern, "^[a-z2-7]{20}$");
  assert.ok(broadcast.description.includes("never a key"));
  assert.equal(tools.get("aamio_addon_earshot_listen").annotations.readOnlyHint, true);
  assert.deepEqual(tools.get("aamio_addon_earshot_decode"), manifest.tools[2], "the tool as its manifest has it");
  assert.equal(tools.has("aamio_addon_earshot_card"), false, "card is a command and not a tool");

  let reply = (await server.ask("tools/call", { name: "aamio_addon_earshot_broadcast", arguments: { address: READ_KEY } })).result;
  assert.deepEqual([reply.isError, reply.structuredContent.status, reply.structuredContent.reason], [true, "invalid", "a_key_not_an_address"]);
  reply = (await server.ask("tools/call", { name: "aamio_addon_earshot_listen", arguments: { seconds: 5, loud: true } })).result;
  assert.deepEqual([reply.isError, reply.structuredContent.given], [true, ["loud"]], "an argument the schema does not have is refused by the core");
  reply = (await server.ask("tools/call", { name: "aamio_addon_earshot_decode", arguments: { file: out, engine: "local" } })).result;
  assert.deepEqual([reply.isError, reply.structuredContent.status, reply.structuredContent.engine, reply.structuredContent.card.name], [false, "heard", "local", "rom-42"]);
  assert.ok(reply.structuredContent.next.startsWith(`aamio_scope_add with name rom-42 and address ${ADDRESS}`), "the next step in the tools' words");
  reply = (await server.ask("tools/call", { name: "aamio_addon_earshot_listen", arguments: { seconds: 4 } })).result;
  assert.deepEqual([reply.isError, reply.structuredContent.reason], [true, "invalid_seconds"]);
  // The core's own tools answer beside them.
  reply = (await server.ask("tools/call", { name: "aamio_whoami", arguments: {} })).result;
  assert.equal(reply.isError, false);
});
