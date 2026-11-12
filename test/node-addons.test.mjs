// Add-ons in the Node runtime, on contract 2: an npm package in the home's own folder for add-ons, listed from its
// manifest with nothing of it run, enabled by name in the home's addons.json beside the other clients' entries, and
// run in a process of its own for each call, with a deadline and limits on what it may write. The same manifest and
// protocol as aamio-python and aamio-php, and the same cases their tests try.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initIdentity } from "../src/node-identity.js";
import { holdFile } from "../src/node-lock.js";
import { RUNTIME_TOOL_NAMES } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import {
  AddonError, CORE_VERSION, Manifest, RESTART, Refused, addonRoot, allowHost, allowedHosts, describe, disable, enable, enabledNames, forgetHost, hostsFile, installed, loaded, normaliseHost, readManifest,
} from "../src/node-addons.js";
import { MAX_AT_ONCE, MAX_PER_WINDOW, callTool, childEnvironment, limitsOf, parseCommand, probe, run, runCommand, usageOf } from "../src/node-addon-process.js";
import { FakeAamio } from "./fake-aamio.mjs";
import { install, manifestFor, ran } from "./addon-fixture.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const core = { coreTools: RUNTIME_TOOL_NAMES };
const names = async (home) => JSON.parse(await readFile(join(home, "addons.json"), "utf8")).enabled;

// What a test opened in a home, by the home: closed before the home's folder goes, since a held owner.lock cannot be
// removed on Windows.
const opened = new Map();

// A folder that goes when the test is over, with a home in it that is not made yet.
async function place(t) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-addons-"));
  const home = join(root, "home");
  opened.set(home, []);
  t.after(async () => {
    for (const close of opened.get(home)) await close();
    opened.delete(home);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, home };
}

// The same, with the home's identity made: an identity is made only in a folder that is not there, so it comes
// before anything is installed in the home.
async function settled(t) {
  const made = await place(t);
  await initIdentity(made.home);
  return made;
}

// An open runtime on the fake service for a home that has its identity, closed before the folder goes.
async function open(t, home, fake = new FakeAamio()) {
  const runtime = await NodeRuntime.open({ home, host: HOST, fetch: fake.fetch, clock: () => fake.time });
  opened.get(home).push(() => runtime.close());
  return runtime;
}

// One command of the command line, in a process of its own, pointed at nothing that listens.
function cli(home, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "--home", home, ...args], { env: { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

const refusedWith = async (act, words) => {
  await assert.rejects(act, (error) => {
    assert.ok(error instanceof AddonError, `${error?.name}: ${error?.message}`);
    assert.match(error.message, words);
    return true;
  });
};

// ------------------------------------------------------------------ what is installed, and what runs

test("nothing installed is said, and a home that is not there is as it was", async (t) => {
  const { home } = await place(t);
  const said = await describe(home, core);
  assert.deepEqual(said.addons, []);
  assert.match(said.note, /No add-on is installed in this home\. .*once aamio init has given the home its identity, and then enabled by name: npm install --prefix ".*addon-packages.*npm" --ignore-scripts aamio-domain-keys and aamio addon enable domain/);
  assert.deepEqual(await installed(home), []);
  assert.deepEqual(await loaded(home, core), []);
  assert.equal(existsSync(home), false, "listing made nothing");
  const listed = await cli(home, ["addon", "list"]);
  assert.equal(listed.status, 0);
  assert.deepEqual(JSON.parse(listed.stdout).addons, []);
  assert.equal(existsSync(home), false, "and neither did the command line");
  const disabled = await disable(home, "nothing", core);
  assert.equal(disabled.note, "nothing was not enabled; nothing on disk changed.");
  assert.equal(existsSync(home), false);
});

test("an installed add-on is listed from its manifest, and nothing of it runs", async (t) => {
  const { home } = await place(t);
  const { ran: marker } = await install(home, { manifest: manifestFor("demo2", { environment: ["AAMIO_TEST_PASSTHRU"] }) });
  // What another package brought with it, and a package that names no manifest, are not add-ons of this home's.
  await install(home, { distribution: "left-pad-like", declared: null, manifest: null, script: null });
  await install(home, { distribution: "brought-along", name: "brought", listed: false });
  const said = await describe(home, core);
  assert.deepEqual(said.addons, [{ name: "demo2", version: "0.0.2", distribution: "demo2-pkg", enabled: false, contract: 2, environment: ["AAMIO_TEST_PASSTHRU"], fix: "aamio addon enable demo2" }]);
  assert.deepEqual(await ran(marker), [], "nothing of it ran");
  assert.deepEqual(await loaded(home, core), [], "installed is not enabled");
  assert.equal(existsSync(join(home, "addons.json")), false);
  // By its short name it is a command that says so, and runs nothing.
  const tried = await cli(home, ["addon", "demo2", "ping"]);
  assert.equal(tried.status, 2);
  assert.match(tried.stderr, /the add-on demo2 is installed and not enabled\. aamio addon enable demo2 lets it run here\./);
  assert.deepEqual(await ran(marker), []);
});

test("enable probes the add-on and records it beside the other clients' entries, and disable takes it out", async (t) => {
  const { home } = await place(t);
  const { ran: marker } = await install(home);
  // What aamio-python and aamio-php recorded in the same home: theirs to keep.
  await writeFile(join(home, "addons.json"), JSON.stringify({ enabled: ["aamio-domain-keys", "aisenseapi/aamio-qrcast"] }));
  const said = await enable(home, "demo2", { ...core, probe });
  assert.deepEqual(await names(home), ["aamio-domain-keys", "aisenseapi/aamio-qrcast", "npm:demo2-pkg"]);
  assert.deepEqual(await ran(marker), ["probe probe"], "the process ran once, for the probe");
  const row = said.addons[0];
  assert.deepEqual([row.name, row.distribution, row.enabled, row.contract, row.version], ["demo2", "demo2-pkg", true, 2, "0.0.2"]);
  assert.deepEqual(row.commands, ["allow", "badbytes", "bytes", "check", "crash", "fail", "file", "flood", "forget", "garbage", "grumble", "list", "local", "mutter", "noisy", "orphan", "ping", "sleep", "spill"]);
  assert.deepEqual(row.mcp_tools, ["aamio_addon_demo2_ping", "aamio_addon_demo2_check", "aamio_addon_demo2_sleep", "aamio_addon_demo2_bytes"]);
  assert.match(said.note, /^demo2-pkg runs here from now on, in a process of its own for each call\. enable started it once just now, before the choice was recorded/);
  assert.ok(said.note.endsWith(RESTART) && said.note.includes("never the home's key or the rest of your environment") && said.note.includes("It runs with your own file permissions."));
  assert.equal(said.enabled_but_not_installed, undefined, "the other clients' entries are not this runtime's to report");

  // Again: nothing runs, and the note says so. By its package as well as by its short name.
  const again = await enable(home, "demo2-pkg", { ...core, probe });
  assert.match(again.note, /It was enabled already, and nothing of it ran now\./);
  assert.deepEqual(await ran(marker), ["probe probe"]);
  assert.deepEqual(await names(home), ["aamio-domain-keys", "aisenseapi/aamio-qrcast", "npm:demo2-pkg"]);
  assert.deepEqual((await loaded(home, core)).map((manifest) => manifest.NAME), ["demo2"]);

  const gone = await disable(home, "demo2", core);
  assert.equal(gone.note, `demo2 is disabled. ${RESTART}`);
  assert.deepEqual(await names(home), ["aamio-domain-keys", "aisenseapi/aamio-qrcast"]);
  assert.equal(gone.addons[0].enabled, false);
  assert.equal((await disable(home, "demo2", core)).note, "demo2 was not enabled; nothing on disk changed.");
  assert.deepEqual(await ran(marker), ["probe probe"], "disable ran nothing");
});

test("a distribution another client enabled under the same name is another choice", async (t) => {
  const { home } = await place(t);
  const { ran: marker } = await install(home);
  // aamio-python writes the name of a distribution on PyPI: it names other code than the package of npm's.
  await writeFile(join(home, "addons.json"), JSON.stringify({ enabled: ["demo2-pkg", "DEMO2-PKG", "npm:gone-pkg"] }));
  const said = await describe(home, core);
  assert.equal(said.addons[0].enabled, false);
  assert.deepEqual(said.enabled_but_not_installed, ["gone-pkg"], "what this runtime recorded and no longer finds is said");
  assert.deepEqual(await loaded(home, core), []);
  assert.deepEqual(await ran(marker), []);
  await disable(home, "demo2-pkg", core);
  assert.deepEqual(await names(home), ["demo2-pkg", "DEMO2-PKG", "npm:gone-pkg"], "and disabling here leaves the other client's entry");
  await disable(home, "gone-pkg", core);
  assert.deepEqual(await names(home), ["demo2-pkg", "DEMO2-PKG"]);
});

test("enable refuses what cannot be used, records nothing, and the list says what is wrong", async (t) => {
  const cases = [
    [{ manifest: "{ not json" }, /has a manifest, .*aamio-addon\.json, that cannot be read/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), aamio_addon: 3 } }, /is written for contract 3 of aamio's add-ons, and this aamio \(.* for Node\) knows 2/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), aamio_addon: undefined } }, /is written for contract null of aamio's add-ons/, true, 0],
    [{ manifest: manifestFor("list") }, /cannot be called list: that is a command of aamio addon itself/, true, 0],
    [{ manifest: manifestFor("nul") }, /its manifest's name, nul, is one Windows keeps for a device, and it names the add-on's files in the home/, true, 0],
    [{ declared: "../../../outside.json" }, /the manifest its package\.json names under aamioAddon .* is (?:outside the package|not there)/, true, 0],
    [{ declared: 7 }, /the manifest its package\.json names under aamioAddon is not a path inside the package/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), process: { node: "../../outside.js" } } }, /the script its manifest names under process\.node .* is (?:outside the package|not there)/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), process: { node: "missing.js" } } }, /the script its manifest names under process\.node \(missing\.js\) is not there/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), process: { python: "demo2.process" } } }, /its manifest names no JavaScript file to run under process\.node/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), environment: ["AAMIO_HOME"] } }, /environment in its manifest asks for AAMIO_HOME, which no add-on gets/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), environment: ["lower"] } }, /environment in its manifest is not a list of variable names/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), deadline_seconds: 121 } }, /deadline_seconds in its manifest is not a whole number from 1 to 120/, true, 0],
    [{ manifest: manifestFor("demo2", { version: "0.0.3" }) }, /its manifest says version 0\.0\.3 and its package\.json 0\.0\.2/, true, 0],
    [{ manifest: { ...manifestFor("demo2", { hosts: false }), commands: { see: { arguments: [{ name: "site", host: true }] } } } }, /the argument site of the command see is a host, and the manifest has no hosts/, true, 0],
    [{ manifest: { ...manifestFor("demo2"), commands: { allow: {} } } }, /its manifest has a command allow, which aamio provides for an add-on with hosts/, true, 0],
    [{ manifest: { ...manifestFor("demo2", { hosts: false }), tools: [{ name: "aamio_whoami", description: "taken", inputSchema: { type: "object" } }] } }, /the tool aamio_whoami is offered by the core and by demo2-pkg/, false, 0],
    // The manifest is whole, and the process is not the add-on it says.
    [{ probe: { name: "other" } }, /answered the probe as other 0\.0\.2 on contract 2, and its manifest says demo2 0\.0\.2 on contract 2/, false, 1],
    [{ probe: { ok: false } }, /the add-on demo2 did not answer the probe: it answered /, false, 1],
    [{ script: "process.exit(4);\n" }, /the add-on demo2 did not answer the probe: the add-on demo2 exited with code 4 and gave no answer this aamio can read/, false, 0],
  ];
  for (const [how, words, listed, runs] of cases) {
    const { home } = await place(t);
    const { ran: marker } = await install(home, how);
    await refusedWith(() => enable(home, "demo2-pkg", { ...core, probe }), words);
    if (listed) await refusedWith(() => enable(home, "demo2", { ...core, probe }), /no installed add-on is called demo2\. demo2-pkg is installed and cannot be read as an add-on/);
    assert.equal(existsSync(join(home, "addons.json")), false, `${words}: nothing was recorded`);
    assert.equal((await ran(marker)).length, runs, `${words}: the process ran ${runs} time(s)`);
    const said = await describe(home, core);
    assert.equal(said.addons.length, 1);
    assert.equal(said.addons[0].enabled, false);
    if (listed) assert.match(said.addons[0].error, words);
    else assert.equal(said.addons[0].error, undefined);
  }
});

test("a file the package reaches by a link out of itself is not the package's", async (t) => {
  const { root, home } = await place(t);
  const { dir } = await install(home, { script: null });
  await writeFile(join(root, "elsewhere.js"), "process.exit(0);\n");
  try {
    await symlink(join(root, "elsewhere.js"), join(dir, "process.js"), "file");
  } catch (error) {
    // Windows without the right to make links: there is nothing to try.
    t.skip(`no symbolic link could be made here: ${error.code}`);
    return;
  }
  await refusedWith(() => enable(home, "demo2-pkg", { ...core, probe }), /the script its manifest names under process\.node \(process\.js\) is outside the package/);
  // It has no short name to go by, and the refusal says which package could not be read.
  await refusedWith(() => enable(home, "demo2", { ...core, probe }), /no installed add-on is called demo2\. demo2-pkg is installed and cannot be read as an add-on, so it has no short name: aamio addon list says why/);
  assert.match((await describe(home, core)).addons[0].error, /is outside the package/);
  assert.equal(existsSync(join(home, "addons.json")), false);
});

test("two add-ons with one name stop the start with both names, and the choice is the package's", async (t) => {
  const { home } = await place(t);
  const first = await install(home);
  const second = await install(home, { distribution: "@other/demo2", name: "demo2" });
  await refusedWith(() => enable(home, "demo2", { ...core, probe }), /two installed add-ons are called demo2: @other\/demo2 and demo2-pkg\. Enable one by its package name\./);
  const listed = await describe(home, core);
  assert.deepEqual(listed.addons.map((row) => row.fix), ["aamio addon enable @other/demo2", "aamio addon enable demo2-pkg"], "each is enabled by its package when the short name is not its own");
  await enable(home, "demo2-pkg", { ...core, probe });
  await refusedWith(() => enable(home, "@other/demo2", { ...core, probe }), /two add-ons are called demo2: (?:demo2-pkg and @other\/demo2|@other\/demo2 and demo2-pkg)\. Disable or uninstall one/);
  assert.deepEqual(await names(home), ["npm:demo2-pkg"]);
  assert.deepEqual([await ran(first.ran), await ran(second.ran)], [["probe probe"], []], "the second was never started");
  // Written by hand, the two stop the start and say so, and the list still answers.
  await writeFile(join(home, "addons.json"), JSON.stringify({ enabled: ["npm:demo2-pkg", "npm:@other/demo2"] }));
  await refusedWith(() => loaded(home, core), /two add-ons are called demo2/);
  const said = await describe(home, core);
  assert.match(said.error, /two add-ons are called demo2/);
  assert.deepEqual(said.addons.map((row) => [row.enabled, row.loaded]), [[true, false], [true, false]]);
  const started = await cli(home, ["serve"]);
  assert.equal(started.status, 1);
  assert.match(started.stderr, /aamio: two add-ons are called demo2/);
  assert.equal(existsSync(join(home, "key")), false, "the server stopped before it made anything of the home");
  await disable(home, "@other/demo2", core);
  assert.deepEqual((await loaded(home, core)).map((manifest) => manifest.distribution), ["demo2-pkg"]);
});

test("the choice is the home's, and a broken add-on that is enabled is listed and can be taken out", async (t) => {
  const { root, home } = await place(t);
  const other = join(root, "other-home");
  const { dir } = await install(home);
  await install(other);
  await enable(home, "demo2", { ...core, probe });
  assert.deepEqual((await loaded(home, core)).map((manifest) => manifest.NAME), ["demo2"]);
  assert.deepEqual(await loaded(other, core), [], "another home with the same package installed has made no choice");
  assert.equal((await describe(other, core)).addons[0].enabled, false);

  await writeFile(join(dir, "aamio-addon.json"), "{ broken");
  await refusedWith(() => loaded(home, core), /has a manifest, .* that cannot be read/);
  const said = await describe(home, core);
  assert.match(said.error, /that cannot be read/);
  assert.deepEqual([said.addons[0].enabled, said.addons[0].loaded, said.addons[0].name], [true, false, null]);
  assert.match(said.addons[0].error, /aamio addon disable demo2-pkg to go on without it/);
  const listed = await cli(home, ["addon", "list"]);
  assert.equal(listed.status, 1, "the list answers, and says by its exit status that something is wrong");
  assert.match(JSON.parse(listed.stdout).error, /that cannot be read/);
  // It has no short name any more, and goes by its package.
  await disable(home, "demo2-pkg", core);
  assert.deepEqual(await names(home), []);
  assert.deepEqual(await loaded(home, core), []);
});

test("what addons.json says and cannot say, and a list of packages that cannot be read", async (t) => {
  const { home } = await place(t);
  await install(home);
  for (const [text, words] of [["{ nope", /addons\.json could not be read/], [JSON.stringify({ enabled: "demo2" }), /is not a list of enabled add-ons/], [JSON.stringify(["npm:demo2-pkg"]), /is not a list of enabled add-ons/], [JSON.stringify({ enabled: [7] }), /is not a list of enabled add-ons/]]) {
    await writeFile(join(home, "addons.json"), text);
    await refusedWith(() => enabledNames(home), words);
    await refusedWith(() => enable(home, "demo2", { ...core, probe }), words);
    assert.equal(await readFile(join(home, "addons.json"), "utf8"), text, "and it is left as it was");
  }
  await rm(join(home, "addons.json"));
  await enable(home, "demo2", { ...core, probe });
  await writeFile(join(addonRoot(home), "package.json"), "{ nope");
  await refusedWith(() => installed(home), /package\.json could not be read/);
  const said = await describe(home, core);
  assert.match(said.error, /package\.json could not be read/);
  assert.deepEqual(said.enabled_but_not_installed, ["demo2-pkg"]);
  await disable(home, "demo2-pkg", core);
  assert.deepEqual(await names(home), [], "what cannot be found any more is still taken out by its package");
});

test("two changes at once keep both, and a change waits for another and says so", async (t) => {
  const { home } = await place(t);
  await install(home);
  await install(home, { distribution: "second-pkg", name: "second", manifest: manifestFor("second") });
  await Promise.all([enable(home, "demo2", { ...core, probe }), enable(home, "second", { ...core, probe })]);
  assert.deepEqual((await names(home)).sort(), ["npm:demo2-pkg", "npm:second-pkg"]);

  const held = await holdFile(home, join(home, "addons.json.lock"));
  assert.notEqual(held, null);
  try {
    await refusedWith(() => disable(home, "second", { ...core, lock: { wait: 0.3 } }), /addons\.json is being changed by another aamio, which did not finish in 0\.3 seconds\. Nothing changed; try again\./);
  } finally {
    await held.release();
  }
  assert.deepEqual((await names(home)).sort(), ["npm:demo2-pkg", "npm:second-pkg"]);
  await disable(home, "second", core);
  assert.deepEqual(await names(home), ["npm:demo2-pkg"]);
});

test("a manifest says what a command takes, and help comes from it with nothing run", async (t) => {
  const { home } = await place(t);
  const { ran: marker } = await install(home);
  const [row] = await installed(home);
  const manifest = await readManifest(row);
  assert.ok(manifest instanceof Manifest);
  assert.equal(manifest.entry.endsWith("process.js"), true);
  const text = usageOf(manifest);
  assert.match(text, /^Usage: aamio addon demo2 <command> \[arguments\]\n\nA test add-on\.\n/);
  assert.match(text, /\n  check SITE --partner PARTNER\s+a website and a partner\n/);
  assert.match(text, /\n  ping \[--word WORD\]\s+answers pong\n/);
  assert.match(text, /\n  allow HOST\s+put a website on this runtime's list, from your own records\n/);
  assert.deepEqual(parseCommand(manifest, []), { help: true, asked: false });
  assert.deepEqual(parseCommand(manifest, ["ping", "--help"]), { help: true, asked: true });
  const ping = parseCommand(manifest, ["ping", "--word=hei"]);
  assert.deepEqual([ping.command, ping.values, ping.needsRuntime, ping.core], ["ping", { word: "hei" }, true, false]);
  assert.deepEqual(parseCommand(manifest, ["ping"]).values, { word: null });
  assert.deepEqual(parseCommand(manifest, ["check", "--partner", "bob", "example.org"]).values, { site: "example.org", partner: "bob" });
  assert.deepEqual(parseCommand(manifest, ["local", "--", "--odd-name"]).values, { path: "--odd-name" });
  assert.equal(parseCommand(manifest, ["local", "x"]).needsRuntime, false);
  assert.deepEqual([parseCommand(manifest, ["allow", "example.org"]).core, parseCommand(manifest, ["list"]).values], [true, {}]);
  for (const [words, why] of [[["nope"], /has no command nope\. It has: allow, badbytes/], [["ping", "--nope", "x"], /ping does not take --nope/], [["ping", "extra"], /ping takes no arguments and \[--word WORD\]/], [["ping", "--word"], /--word needs a value/],
    [["check", "example.org"], /check needs --partner/], [["check", "--partner", "bob"], /check takes SITE and --partner PARTNER/], [["allow"], /allow takes HOST/]]) {
    assert.throws(() => parseCommand(manifest, words), (error) => error.code === "usage" && why.test(error.message), JSON.stringify(words));
  }
  assert.deepEqual(await ran(marker), []);
});

// ------------------------------------------------------------------ a call is a process

test("a command goes through the process with what the core resolved, and nothing else", async (t) => {
  const { home } = await settled(t);
  const { ran: marker } = await install(home);
  const runtime = await open(t, home);
  const partner = "k".repeat(42) + "A";
  await runtime.partnerAdd("bob", partner);
  const manifest = await readManifest((await installed(home))[0]);
  // What the user's environment holds is not the add-on's to read.
  process.env.AAMIO_TEST_SECRET = "not for the add-on";
  process.env.AAMIO_HOME = home;
  t.after(() => {
    delete process.env.AAMIO_TEST_SECRET;
    delete process.env.AAMIO_HOME;
  });
  const call = (words, options = {}) => runCommand(manifest, parseCommand(manifest, words), options.runtime === undefined ? runtime : options.runtime, options);

  const pong = await call(["ping", "--word", "hei"]);
  assert.equal(pong.code, 0);
  assert.deepEqual(pong.out, {
    pong: true, kind: "command", name: "ping", arguments: { word: "hei" }, subject: null, own_key: null, state_dir: join(home, "addons", "demo2"), deadline_seconds: 2,
    aamio: { version: CORE_VERSION, runtime: "node" }, home_env: null, addons_env: null, addon_env: "2", secret: null, passthru: null,
  });
  assert.equal(existsSync(join(home, "addons", "demo2")), true, "the add-on has a directory of its own");
  assert.equal((await call(["file"])).out.own_key, runtime.keys.public, "the runtime's public key, where the command asks for it");
  const local = await call(["local", "some/path"], { runtime: null });
  assert.deepEqual([local.out.arguments, local.out.state_dir, local.out.own_key], [{ path: "some/path" }, null, null], "a command that needs no home gets none");

  // A website the user has not agreed to, and a name that is nobody's, stop before the process starts.
  const before = (await ran(marker)).length;
  const stopped = await call(["check", "Example.ORG", "--partner", "bob"]);
  assert.deepEqual([stopped.code, stopped.out.status, stopped.out.reason, stopped.out.host], [2, "invalid", "host_not_allowed", "example.org"]);
  assert.match(stopped.out.fix, /The user adds it with aamio addon demo2 allow example\.org, from their own records and never from the message being checked\. Over MCP aamio_addon_demo2_check asks them\./);
  assert.equal((await call(["check", "https://example.org/x", "--partner", "bob"])).out.reason, "invalid_host");
  const allowed = await call(["allow", "Example.org"]);
  assert.deepEqual([allowed.code, allowed.out.host, allowed.out.added, allowed.out.hosts], [0, "example.org", true, ["example.org"]]);
  assert.deepEqual([(await call(["check", "example.org", "--partner", "nobody"])).out.reason, (await call(["check", "example.org", "--partner", "nobody"])).code], ["partner_unavailable", 2]);
  assert.equal((await ran(marker)).length, before, "none of them started the process");
  const checked = await call(["check", "EXAMPLE.org", "--partner", "BOB"]);
  assert.deepEqual(checked.out.arguments, { site: "example.org", partner: "BOB" });
  assert.deepEqual(checked.out.subject, { key: partner, subject_source: "partner", partner: "bob", signature_checked_locally: null }, "the key from the address book, and the book's own spelling of the name");
  assert.deepEqual((await call(["list"])).out, { hosts: ["example.org"] });
  assert.deepEqual((await call(["forget", "example.org"])).out, { host: "example.org", removed: true, hosts: [] });
  assert.equal((await call(["check", "example.org", "--partner", "bob"])).out.reason, "host_not_allowed");

  // The bytes as they are, a refusal with its own code, and what the add-on wrote for the user.
  const bytes = await call(["bytes"]);
  assert.deepEqual([bytes.code, bytes.raw.toString("utf8"), bytes.out], [0, "raw\n", undefined]);
  const heard = [];
  const failed = await call(["fail"], { stderr: (text) => heard.push(text) });
  assert.deepEqual([failed.code, failed.out], [3, { status: "no", fix: "x" }]);
  assert.deepEqual(heard, ["a note from the add-on\n"]);
});

test("a process that sleeps, dies or talks nonsense is an answer, and the next call works", async (t) => {
  const { home } = await place(t);
  await install(home, { manifest: manifestFor("demo2", { deadline: 1 }) });
  const manifest = await readManifest((await installed(home))[0]);
  const started = Date.now();
  const slept = await run(manifest, "command", "sleep", {});
  assert.ok(Date.now() - started < 5000, "the deadline stopped it");
  assert.deepEqual([slept.exit_code, slept.is_error, slept.result.status, slept.result.reason, slept.result.addon], [5, true, "unreachable", "addon_timeout", "demo2"]);
  assert.match(slept.result.fix, /the add-on demo2 did not answer within 1 seconds and was stopped\. Nothing else here was affected\./);
  const crashed = await run(manifest, "command", "crash", {});
  assert.deepEqual([crashed.exit_code, crashed.result.reason], [5, "addon_failed"]);
  assert.match(crashed.result.fix, /the add-on demo2 exited with code 3 and gave no answer this aamio can read\. Reinstall it, or aamio addon disable demo2 to go on without it\./);
  const garbage = await run(manifest, "command", "garbage", {});
  assert.match(garbage.result.fix, /exited with code 0 and gave no answer this aamio can read/);
  const bad = await run(manifest, "command", "badbytes", {});
  assert.match(bad.result.fix, /answered with raw bytes that are not base64/);
  // A script that is not there any more, between the list and the call.
  const missing = await run(Object.assign(Object.create(Object.getPrototypeOf(manifest)), manifest, { entry: join(home, "no-such-script.js") }), "command", "ping", {});
  assert.deepEqual([missing.exit_code, missing.result.reason], [5, "addon_failed"]);
  assert.equal((await run(manifest, "command", "ping", { word: "after" })).result.arguments.word, "after");
});

test("a process that floods is stopped while it runs, and the same limits hold when it exits at once", async (t) => {
  const { home } = await place(t);
  await install(home, { manifest: manifestFor("demo2", { deadline: 10 }) });
  const manifest = await readManifest((await installed(home))[0]);
  const limits = { answer: 4096, stderr: 500 };
  const heard = [];
  const call = (name) => run(manifest, "command", name, {}, { limits, stderr: (text) => heard.push(text) });
  const started = Date.now();
  const flood = await call("flood");
  const noisy = await call("noisy");
  assert.ok(Date.now() - started < 8000, "neither was left to run its five seconds");
  assert.match(flood.result.fix, /the add-on demo2 wrote more than the 4096 bytes an answer may be, and was stopped/);
  assert.match(noisy.result.fix, /the add-on demo2 wrote more than 500 bytes to standard error, and was stopped/);
  // Gone before anybody looked: past the limit is past the limit.
  assert.match((await call("spill")).result.fix, /wrote more than the 4096 bytes an answer may be/);
  assert.match((await call("grumble")).result.fix, /wrote more than 500 bytes to standard error/);
  assert.deepEqual(heard, [], "and nothing a refused process wrote is passed on");
  // Exactly the limit is within it.
  const mutter = await call("mutter");
  assert.deepEqual([mutter.exit_code, mutter.result], [0, { pong: true }]);
  assert.deepEqual(heard, ["y".repeat(500)]);
});

test("a stopped process that left its pipes with another is given up on, and the call is answered", async (t) => {
  const { home } = await place(t);
  await install(home, { manifest: manifestFor("demo2", { deadline: 1 }) });
  const manifest = await readManifest((await installed(home))[0]);
  const started = Date.now();
  const answer = await run(manifest, "command", "orphan", {}, { limits: { stop: 0.5 } });
  assert.ok(Date.now() - started < 4000, `answered after ${Date.now() - started} ms`);
  assert.deepEqual([answer.exit_code, answer.result.reason], [5, "addon_timeout"]);
  assert.equal((await run(manifest, "command", "ping", {})).result.pong, true);
});

test("only the environment the manifest declares is passed, and none of it to the probe", async (t) => {
  const { home } = await place(t);
  await install(home, { manifest: manifestFor("demo2", { environment: ["AAMIO_TEST_PASSTHRU"] }) });
  process.env.AAMIO_TEST_PASSTHRU = "declared";
  process.env.AAMIO_TEST_SECRET = "not for the add-on";
  process.env.AAMIO_ADDONS = "something";
  t.after(() => {
    delete process.env.AAMIO_TEST_PASSTHRU;
    delete process.env.AAMIO_TEST_SECRET;
    delete process.env.AAMIO_ADDONS;
  });
  // The probe refuses when it is given the variable: enable succeeds, so it was not.
  const said = await enable(home, "demo2", { ...core, probe });
  assert.match(said.note, /the proxy variables, which can carry credentials of their own, and AAMIO_TEST_PASSTHRU, which its manifest asks for, and never the home's key/);
  const [manifest] = await loaded(home, core);
  const answer = (await run(manifest, "command", "ping", {})).result;
  assert.deepEqual([answer.passthru, answer.secret, answer.home_env, answer.addons_env, answer.addon_env], ["declared", null, null, null, "2"]);
  const env = childEnvironment(manifest, true, { Path: "p", HTTPS_PROXY: "http://user:word@proxy", https_proxy: "x", NODE_OPTIONS: "--inspect", GITHUB_TOKEN: "t", AAMIO_HOME: home, AAMIO_TEST_PASSTHRU: "d", LANG: "nb_NO.UTF-8" });
  assert.deepEqual(env, { Path: "p", HTTPS_PROXY: "http://user:word@proxy", https_proxy: "x", AAMIO_TEST_PASSTHRU: "d", LANG: "nb_NO.UTF-8", AAMIO_ADDON: "2" });
  assert.deepEqual(Object.keys(childEnvironment(manifest, false, { AAMIO_TEST_PASSTHRU: "d", AAMIO_ADDON: "9" })), ["AAMIO_ADDON"]);
});

test("at most two calls of one add-on at once, and twenty a minute", () => {
  const limits = limitsOf("limits-" + Math.random());
  assert.deepEqual([limits.take(100), limits.take(100), limits.take(100)], [null, null, "addon_busy"]);
  assert.equal(MAX_AT_ONCE, 2);
  limits.giveBack();
  limits.giveBack();
  for (let started = 2; started < MAX_PER_WINDOW; started++) {
    assert.equal(limits.take(100 + started), null);
    limits.giveBack();
  }
  assert.equal(limits.take(130), "addon_rate");
  assert.equal(limits.take(161), null, "a minute after the first ones, there is room again");
  assert.notEqual(limitsOf("another"), limits);
});

test("the list of websites is the core's: one host each, read as it is, and an earlier version's list once", async (t) => {
  const { home } = await settled(t);
  await install(home);
  const runtime = await open(t, home);
  const manifest = await readManifest((await installed(home))[0]);
  for (const bad of ["", "localhost", "example.org.", "https://example.org", "example.org:443", "example.org/path", "1.2.3.4", "exa_mple.org", "xn--bcher-kva.example", "bücher.example", "a b.org", "example.123", 7, null]) {
    assert.throws(() => normaliseHost(bad), (error) => error instanceof Refused && error.reason === "invalid_host", JSON.stringify(bad));
  }
  assert.equal(normaliseHost("WWW.Example.ORG"), "www.example.org");
  // What an earlier version kept in the home is read once, and becomes the list.
  await writeFile(join(home, "old-hosts.json"), JSON.stringify(["firma.example", "kunde.example"]));
  assert.deepEqual(await allowedHosts(runtime, manifest), ["firma.example", "kunde.example"]);
  assert.deepEqual(JSON.parse(await readFile(hostsFile(home, manifest), "utf8")), ["firma.example", "kunde.example"]);
  await writeFile(join(home, "old-hosts.json"), JSON.stringify(["later.example"]));
  assert.deepEqual((await forgetHost(runtime, manifest, "firma.example")).hosts, ["kunde.example"]);
  assert.deepEqual(await allowedHosts(runtime, manifest), ["kunde.example"], "the old file is not read again");
  assert.deepEqual(await allowHost(runtime, manifest, "kunde.example"), { host: "kunde.example", added: false, hosts: ["kunde.example"] });
  // The list is beside the add-on's own directory, not in it.
  assert.equal(hostsFile(home, manifest), join(home, "addons", "demo2.hosts.json"));
  // A list that cannot be read is no list at all, and never an empty one.
  for (const text of ["{ nope", JSON.stringify({ hosts: [] }), JSON.stringify(["Example.org"]), JSON.stringify(["ok.example", 7])]) {
    await writeFile(hostsFile(home, manifest), text);
    await assert.rejects(() => allowedHosts(runtime, manifest), (error) => error instanceof Refused && error.reason === "hosts_unreadable");
    const stopped = await runCommand(manifest, parseCommand(manifest, ["allow", "new.example"]), runtime);
    assert.deepEqual([stopped.code, stopped.out.reason], [2, "hosts_unreadable"]);
    assert.equal(await readFile(hostsFile(home, manifest), "utf8"), text, "and it is not written over");
  }
});

// ------------------------------------------------------------------ the command line

test("a home that cannot take a write says so: the list, the websites and the add-on's own directory", async (t) => {
  const { home } = await settled(t);
  const { ran: marker } = await install(home);
  // The list of enabled add-ons cannot be written: a folder stands where its file of the moment goes.
  await mkdir(`${join(home, "addons.json")}.${process.pid}.tmp`);
  await refusedWith(() => enable(home, "demo2", { ...core, probe }), /addons\.json could not be written: \w+\. Nothing changed; check the disk and the home's permissions, and try again\./);
  await rm(`${join(home, "addons.json")}.${process.pid}.tmp`, { recursive: true });
  assert.deepEqual([existsSync(join(home, "addons.json")), (await describe(home, core)).addons[0].enabled], [false, false], "nothing was recorded, though the probe had answered");
  await enable(home, "demo2", { ...core, probe });

  // A file stands where the home keeps what belongs to add-ons.
  await writeFile(join(home, "addons"), "in the way");
  const runtime = await open(t, home);
  const manifest = (await loaded(home, core))[0];
  const before = (await ran(marker)).length;
  const allowed = await runCommand(manifest, parseCommand(manifest, ["allow", "example.org"]), runtime);
  assert.deepEqual([allowed.code, allowed.out.status, allowed.out.reason], [2, "invalid", "hosts_unwritable"]);
  const ping = await runCommand(manifest, parseCommand(manifest, ["ping"]), runtime);
  assert.deepEqual([ping.code, ping.out.status, ping.out.reason, ping.out.addon], [5, "unreachable", "addon_failed", "demo2"]);
  assert.match(ping.out.fix, /the add-on demo2 has no directory of its own: addons\/demo2 in the home could not be made \(\w+\)\. Nothing of the add-on ran\./);
  const tool = await callTool(manifest, runtime, "aamio_addon_demo2_ping", {});
  assert.deepEqual([tool[1], tool[0].reason], [true, "addon_failed"]);
  assert.equal((await ran(marker)).length, before, "and the process was not started");
  // A command that needs no home needs no directory, and runs.
  assert.equal((await runCommand(manifest, parseCommand(manifest, ["local", "x"]), null)).code, 0);
});

test("an add-on installed in a home that has no identity yet is listed, and enabling it says what to do", async (t) => {
  const { home } = await place(t);
  const { ran: marker } = await install(home);
  const listed = await cli(home, ["addon", "list"]);
  assert.equal(listed.status, 0);
  assert.deepEqual(JSON.parse(listed.stdout).addons.map((row) => [row.name, row.enabled]), [["demo2", false]]);
  const enabled = await cli(home, ["addon", "enable", "demo2"]);
  assert.equal(enabled.status, 2);
  assert.match(enabled.stderr, /has no identity yet, and aamio makes one only in a folder that is not there\. Nothing was enabled\. Move .* aside, run aamio --home ".*" init, move addon-packages/);
  assert.deepEqual([await ran(marker), existsSync(join(home, "addons.json")), existsSync(join(home, "key"))], [[], false, false], "nothing ran, nothing was recorded, and no identity was made");
});

test("the command line lists, enables, runs and disables, and the example add-on answers as its page says", async (t) => {
  const { home } = await settled(t);
  const { ran: marker } = await install(home);
  // The example add-on, as npm install would leave it.
  const hello = join(addonRoot(home), "node_modules", "aamio-addon-hello");
  await cp(fileURLToPath(new URL("../examples/hello", import.meta.url)), hello, { recursive: true });
  const top = JSON.parse(await readFile(join(addonRoot(home), "package.json"), "utf8"));
  top.dependencies["aamio-addon-hello"] = "file:../../aamio-addon-hello-0.1.0.tgz";
  await writeFile(join(addonRoot(home), "package.json"), JSON.stringify(top));

  const listed = await cli(home, ["addon", "list"]);
  assert.equal(listed.status, 0);
  assert.deepEqual(JSON.parse(listed.stdout).addons.map((row) => [row.name, row.distribution, row.enabled, row.contract]), [["hello", "aamio-addon-hello", false, 2], ["demo2", "demo2-pkg", false, 2]]);

  const enabled = await cli(home, ["addon", "enable", "hello"]);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(JSON.parse(enabled.stdout).note, /aamio-addon-hello runs here from now on/);
  assert.equal((await cli(home, ["addon", "enable", "demo2"])).status, 0);
  assert.deepEqual(await names(home), ["npm:aamio-addon-hello", "npm:demo2-pkg"]);
  assert.equal(existsSync(join(home, "state.json")), false, "listing and enabling opened no runtime");

  const wave = await cli(home, ["addon", "hello", "wave", "--to", "Kari"]);
  assert.deepEqual([wave.status, wave.stdout.toString("utf8"), wave.stderr], [0, '{"hello":"Kari"}\n', ""]);
  assert.equal((await cli(home, ["addon", "hello", "wave"])).stdout.toString("utf8"), '{"hello":"world"}\n');

  const help = await cli(home, ["addon", "demo2", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout.toString("utf8"), /^Usage: aamio addon demo2 <command> \[arguments\]/);
  const bare = await cli(home, ["addon", "demo2"]);
  assert.deepEqual([bare.status, bare.stdout.length], [2, 0]);
  assert.match(bare.stderr, /^Usage: aamio addon demo2/);
  const group = await cli(home, ["addon", "--help"]);
  assert.equal(group.status, 0);
  assert.match(group.stdout.toString("utf8"), /^Usage: aamio \[--home DIR\] addon <command>/);
  assert.deepEqual(await ran(marker), ["probe probe"], "help ran nothing");

  const pong = await cli(home, ["addon", "demo2", "ping", "--word", "hei"], { AAMIO_TEST_SECRET: "not for the add-on", AAMIO_HOME: home });
  assert.equal(pong.status, 0, pong.stderr);
  const said = JSON.parse(pong.stdout);
  assert.deepEqual([said.arguments, said.secret, said.home_env, said.state_dir], [{ word: "hei" }, null, null, join(home, "addons", "demo2")]);
  const bytes = await cli(home, ["addon", "demo2", "bytes"]);
  assert.deepEqual([bytes.status, [...bytes.stdout]], [0, [...Buffer.from("raw\n")]], "the bytes as they are, with no line break made into two");
  const failed = await cli(home, ["addon", "demo2", "fail"]);
  assert.deepEqual([failed.status, failed.stdout.toString("utf8"), failed.stderr], [3, '{"status":"no","fix":"x"}\n', "a note from the add-on\n"]);
  const crashed = await cli(home, ["addon", "demo2", "crash"]);
  assert.equal(crashed.status, 5);
  assert.deepEqual([JSON.parse(crashed.stdout).status, JSON.parse(crashed.stdout).reason], ["unreachable", "addon_failed"]);
  const stopped = await cli(home, ["addon", "demo2", "check", "example.org", "--partner", "bob"]);
  assert.deepEqual([stopped.status, JSON.parse(stopped.stdout).reason], [2, "host_not_allowed"]);
  assert.deepEqual(JSON.parse((await cli(home, ["addon", "demo2", "allow", "example.org"])).stdout).hosts, ["example.org"]);
  assert.deepEqual(JSON.parse((await cli(home, ["addon", "demo2", "list"])).stdout), { hosts: ["example.org"] });

  for (const [words, why] of [[["addon", "demo2", "nope"], /has no command nope/], [["addon", "demo2", "ping", "--nope", "x"], /does not take --nope/], [["addon", "other", "ping"], /no add-on called other runs here/],
    [["addon", "enable"], /addon enable takes one add-on/], [["addon", "enable", "other"], /no installed add-on is called other/], [["addon", "list", "more"], /addon list takes no arguments/]]) {
    const wrong = await cli(home, words);
    assert.equal(wrong.status, 2, JSON.stringify(words));
    assert.match(wrong.stderr, why);
    assert.equal(wrong.stdout.length, 0);
  }
  const disabled = await cli(home, ["addon", "disable", "demo2"]);
  assert.equal(disabled.status, 0);
  assert.deepEqual(await names(home), ["npm:aamio-addon-hello"]);
  assert.equal((await cli(home, ["addon", "demo2", "ping"])).status, 2);
});

test("an add-on that is enabled and not installed any more is said by the list and by the server that starts without it", async (t) => {
  const { home } = await settled(t);
  const { dir } = await install(home);
  await enable(home, "demo2", { ...core, probe });
  // Uninstalled, as npm leaves it: the folder gone, and the name out of package.json.
  await rm(dir, { recursive: true, force: true });
  await writeFile(join(addonRoot(home), "package.json"), JSON.stringify({ dependencies: {} }));
  const said = await describe(home, core);
  assert.deepEqual([said.addons, said.enabled_but_not_installed], [[], ["demo2-pkg"]]);
  assert.equal(said.note, undefined, "and the list does not say that nothing is the matter");
  // The server starts, with the core's tools, and says on standard error what it starts without.
  const served = await cli(home, ["serve"]);
  assert.equal(served.status, 0, served.stderr);
  assert.match(served.stderr, /^aamio: the add-on demo2-pkg is enabled in this home and not installed there any more, so its tools are not offered\. Install it again with npm install --prefix ".*" --ignore-scripts demo2-pkg, or take it out with aamio addon disable demo2-pkg\.\n$/);
  assert.equal(served.stdout.length, 0, "standard output is the protocol's alone");
  const tried = await cli(home, ["addon", "demo2", "ping"]);
  assert.equal(tried.status, 2);
  assert.match(tried.stderr, /no add-on called demo2 runs here/);
  await disable(home, "demo2-pkg", core);
  assert.equal((await cli(home, ["serve"])).stderr, "");
});

test("a command that needs no home runs beside a runtime that has it", async (t) => {
  const { home } = await settled(t);
  await install(home);
  await enable(home, "demo2", { ...core, probe });
  const local = await cli(home, ["addon", "demo2", "local", "a/file"]);
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual([JSON.parse(local.stdout).arguments, JSON.parse(local.stdout).state_dir], [{ path: "a/file" }, null]);
  assert.equal(existsSync(join(home, "state.json")), false, "it opened no runtime");
  // With the home held by a runtime, it still runs, and a command that needs the home says the home is in use.
  const runtime = await open(t, home);
  assert.equal((await cli(home, ["addon", "demo2", "local", "again"])).status, 0);
  const busy = await cli(home, ["addon", "demo2", "ping"]);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /another aamio .*is using/);
  assert.equal(runtime.closed, false);
});
