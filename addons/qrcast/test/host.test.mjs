// The real package, through the core: installed in a home as npm leaves it, with the files package.json names and
// no others, listed from its manifest with nothing of it run, enabled with the probe, and each command in a process
// of its own. Offline: the home is one of the test's own, the core is pointed at nothing that listens, and no call
// asks for the aisense engine, the screen or the camera. Skipped where the core is not beside the package, as when
// the package is tried from its tarball.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import * as programs from "../src/programs.js";
import * as symbol from "../src/symbol.js";

const core = fileURLToPath(new URL("../../../", import.meta.url));
const bin = join(core, "bin", "aamio.js");
const here = fileURLToPath(new URL("../", import.meta.url));
const pack = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const skip = existsSync(bin) && existsSync(join(core, "src", "node-addons.js")) ? false : "the core is not beside the package";
const ADDRESS = "k7rq2m4xw5tbz3yd6ena";
const SCOPE_KEY = "abcdefghijklmnopqrstuvwxyz";
const READ_KEY = "0123456789abcdefghijklmnop";
const sha = (data) => createHash("sha256").update(data).digest("hex");

// One command of the core's command line, in a process of its own.
function cli(home, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "--home", home, ...args], { env: { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9" }, stdio: ["ignore", "pipe", "pipe"] });
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
        // Help, or nothing: not JSON.
      }
      resolve({ status, stdout, stderr: Buffer.concat(err).toString("utf8"), said });
    });
  });
}

// The IDAT of a PNG, inflated: the rows before compression.
function rowsOf(png) {
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") return inflateSync(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return null;
}

test("the core lists qrcast from its manifest, enables it with the probe, and runs each command in a process of its own", { skip }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aamio-qrcast-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = join(root, "home");
  // The home has its identity before anything is installed in it.
  const made = await cli(home, "init");
  assert.equal(made.status, 0, made.stderr);

  // As npm install leaves it: the files package.json names, and the folder's own package.json naming the package.
  const folder = join(home, "addon-packages", "npm");
  const installed = join(folder, "node_modules", pack.name);
  for (const name of ["package.json", ...pack.files]) {
    mkdirSync(dirname(join(installed, name)), { recursive: true });
    copyFileSync(join(here, name), join(installed, name));
  }
  writeFileSync(join(folder, "package.json"), JSON.stringify({ private: true, dependencies: { [pack.name]: pack.version } }));

  let listed = await cli(home, "addon", "list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.said.addons, [{
    name: "qrcast", version: pack.version, distribution: "aamio-qrcast", enabled: false, contract: 2,
    environment: ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"], fix: "aamio addon enable qrcast",
  }], "from the manifest alone");
  const before = await cli(home, "addon", "qrcast", "card", ADDRESS);
  assert.equal(before.status, 2);
  assert.match(before.stderr, /the add-on qrcast is installed and not enabled/);

  const enabled = await cli(home, "addon", "enable", "qrcast");
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.said.note, /^aamio-qrcast runs here from now on, in a process of its own for each call\. enable started it once just now/);
  assert.ok(enabled.said.note.includes("and DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS, XAUTHORITY, which its manifest asks for"));
  listed = await cli(home, "addon", "list");
  const row = listed.said.addons[0];
  assert.deepEqual([row.enabled, row.version, row.commands, row.mcp_tools], [true, pack.version, ["card", "read", "scan", "show"], ["aamio_addon_qrcast_show", "aamio_addon_qrcast_read", "aamio_addon_qrcast_scan"]]);

  const help = await cli(home, "addon", "qrcast", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: aamio addon qrcast <command> \[arguments\]\n\nThe commands under aamio addon qrcast\.\n/);
  assert.ok(help.stdout.includes("aamio addon qrcast show ADDRESS [--name NAME] [--valid-for SECONDS] [--out FILE] [--engine ENGINE]"));
  assert.ok(help.stdout.includes("read FILE [--engine ENGINE]"));

  const card = await cli(home, "addon", "qrcast", "card", ADDRESS, "--name", "stue-tv");
  assert.equal(card.status, 0, card.stderr);
  assert.deepEqual([card.said.status, card.said.bytes], ["card", 55]);
  assert.match(card.said.card, new RegExp(`^aamio:scope/${ADDRESS}\\?n=stue-tv&t=[0-9]{10}$`));
  assert.ok(Math.abs(card.said.expires_at - (Math.floor(Date.now() / 1000) + 3600)) < 120, "good for an hour");
  assert.deepEqual((await cli(home, "addon", "qrcast", "card", ADDRESS, "--valid-for", "0")).said.card, "aamio:scope/" + ADDRESS);

  // show --out runs in a process of its own and sends nothing: the code is the one made here, pixel for pixel.
  const written = join(root, "cli-card.png");
  const shown = await cli(home, "addon", "qrcast", "show", ADDRESS, "--name", "stue-tv", "--out", written);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual([shown.said.status, shown.said.engine, shown.said.file, shown.said.format, shown.said.code], ["written", "local", written, "png", { version: 4, modules: 33, error_correction: "M", quiet_zone: 4 }]);
  assert.ok(shown.said.expires_at - Math.floor(Date.now() / 1000) > 3500);
  const png = readFileSync(written);
  assert.equal(png.length, shown.said.bytes);
  assert.equal(sha(rowsOf(png)), sha(symbol.scanlines(symbol.encode(shown.said.card), 24)));
  for (const [ending, drawing] of [[".svg", symbol.svg], [".txt", symbol.text]]) {
    const out = join(root, "cli-card" + ending);
    const said = (await cli(home, "addon", "qrcast", "show", ADDRESS, "--valid-for", "0", "--out", out)).said;
    assert.deepEqual([said.status, said.format], ["written", ending === ".svg" ? "svg" : "text"]);
    assert.equal(readFileSync(out, "utf8"), drawing(symbol.encode("aamio:scope/" + ADDRESS)));
  }
  const again = await cli(home, "addon", "qrcast", "show", ADDRESS, "--out", written);
  assert.deepEqual([again.status, again.said.reason], [2, "out_exists"]);
  assert.ok(readFileSync(written).equals(png), "and what was there is as it was");

  // read reads it back where zbarimg is on this machine, and says what to do where it is not.
  const read = await cli(home, "addon", "qrcast", "read", written);
  if (programs.which("zbarimg") !== null) {
    assert.deepEqual([read.status, read.said.status, read.said.card.name, read.said.card.address, read.said.engine], [0, "seen", "stue-tv", ADDRESS, "local"], read.stdout);
  } else {
    assert.deepEqual([read.status, read.said.status, read.said.reason, read.said.engine], [5, "unreachable", "no_reader", "local"], read.stdout);
    assert.ok(read.said.fix.includes("Or read with engine aisense"));
  }
  const missing = await cli(home, "addon", "qrcast", "read", join(root, "no-such-picture.png"));
  assert.deepEqual([missing.status, missing.said.reason], [2, "no_such_file"]);

  // A key is refused there before anything is drawn, and a length out of bounds opens no camera.
  const key = await cli(home, "addon", "qrcast", "show", SCOPE_KEY);
  assert.deepEqual([key.status, key.said.reason], [2, "a_key_not_an_address"]);
  const bounds = await cli(home, "addon", "qrcast", "scan", "--seconds", "99");
  assert.deepEqual([bounds.status, bounds.said.reason], [2, "invalid_seconds"]);
  const unknown = await cli(home, "addon", "qrcast", "scan", "--engine", "aisense");
  assert.equal(unknown.status, 2, "scan has no engine on the command line either: the camera is read here only");
  assert.match(unknown.stderr, /scan does not take --engine/);
  assert.equal(existsSync(join(home, "addons", "qrcast")), false, "no command made a directory in the home: the add-on needs nothing of it");
  assert.equal(existsSync(join(home, "state.json")), false, "and none opened the runtime");

  // The tools come from the manifest, with their schemas and hints, and a call is settled by the process.
  const { loaded } = await import("../../../src/node-addons.js");
  const { callTool } = await import("../../../src/node-addon-process.js");
  const { RUNTIME_TOOL_NAMES } = await import("../../../src/node-mcp.js");
  const [manifest] = await loaded(home, { coreTools: RUNTIME_TOOL_NAMES });
  const tools = Object.fromEntries(manifest.tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.aamio_addon_qrcast_show.inputSchema.properties.address.pattern, "^[a-z2-7]{20}$");
  assert.ok(tools.aamio_addon_qrcast_show.description.includes("never a key"));
  assert.equal(tools.aamio_addon_qrcast_scan.annotations.readOnlyHint, true);
  const [refused, isError] = await callTool(manifest, { home }, "aamio_addon_qrcast_show", { address: READ_KEY });
  assert.deepEqual([isError, refused.status, refused.reason], [true, "invalid", "a_key_not_an_address"], "over MCP a key is refused by the process");
  const [extra, wrong] = await callTool(manifest, { home }, "aamio_addon_qrcast_scan", { seconds: 5, engine: "aisense" });
  assert.deepEqual([wrong, extra.given], [true, ["engine"]], "and scan has no engine: the camera is read here only");
  const out = join(root, "tool-card.txt");
  const [wrote, failed] = await callTool(manifest, { home }, "aamio_addon_qrcast_show", { address: ADDRESS, valid_for: 0, out });
  assert.deepEqual([failed, wrote.status, wrote.format, wrote.engine], [false, "written", "text", "local"]);
  assert.equal(readFileSync(out, "utf8"), symbol.text(symbol.encode("aamio:scope/" + ADDRESS)));

  const disabled = await cli(home, "addon", "disable", "qrcast");
  assert.equal(disabled.status, 0);
  assert.equal((await cli(home, "addon", "qrcast", "card", ADDRESS)).status, 2);
});
