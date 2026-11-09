// owner.lock from Node, against Node, aamio-python and aamio-php on one home: each keeps the others out, whichever
// starts first, and the next takes the home over once the owner is killed. Python and PHP are found beside this
// checkout, or through AAMIO_TEST_PYTHON and AAMIO_TEST_PHP (a JSON list: the program and its options); a test
// whose runtime is not found here says so and is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initIdentity } from "../src/node-identity.js";
import { holdOwnerLock, OWNER_LOCK, PID_FILE, takeHome } from "../src/node-lock.js";

const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const workspace = fileURLToPath(new URL("../../", import.meta.url));
const pythonSource = process.env.AAMIO_PYTHON_SRC || join(workspace, "aamio-python", "src");
const phpBootstrap = process.env.AAMIO_PHP_BOOTSTRAP || join(workspace, "aamio-php", "tests", "bootstrap.php");
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lock-test", version: "1" } } };

function command(variable, fallback) {
  if (process.env[variable]) {
    const parsed = JSON.parse(process.env[variable]);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return fallback;
}

const python = command("AAMIO_TEST_PYTHON", [process.platform === "win32" ? "python" : "python3"]);
const php = command("AAMIO_TEST_PHP", ["php"]);

function works(program, args) {
  const ran = spawnSync(program[0], [...program.slice(1), ...args], { encoding: "utf8", timeout: 30_000 });
  return ran.status === 0;
}

const pythonHere = existsSync(join(pythonSource, "aamio", "runtime.py")) && works(python, ["-c", "import sys, nacl.signing; sys.exit(0 if sys.version_info >= (3, 10) else 3)"]);
const phpHere = existsSync(phpBootstrap) && works(php, ["-r", "exit(function_exists('sodium_crypto_sign_seed_keypair') ? 0 : 3);"]);

// A runtime that says held once it holds the home, and lets go of it when its standard input ends.
const PYTHON_HOLDER = "import sys; sys.path.insert(0, sys.argv[1]); from aamio.runtime import Runtime; r = Runtime(home=sys.argv[2]); print('held', flush=True); sys.stdin.readline(); r.close()";
const PHP_HOLDER = "require $argv[1]; $r = new Aamio\\Runtime(home: $argv[2]); fwrite(STDOUT, \"held\\n\"); fflush(STDOUT); fgets(STDIN); $r->close();";

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "home");
  await initIdentity(path);
  return path;
}

/** A process that holds the home once ready resolves; exited resolves with its code and what it wrote to stderr. */
function start(program, args, isReady, input = "") {
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  let err = "";
  let readyNow;
  let failNow;
  const ready = new Promise((resolve, reject) => { readyNow = resolve; failNow = reject; });
  // A holder that is meant to be refused is waited on through exited alone.
  ready.catch(() => {});
  child.stdout.on("data", (chunk) => { out += chunk; if (isReady(out)) readyNow(); });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => {
    failNow(new Error(`ended with ${code ?? signal} before it held the home: ${err.trim()}`));
    resolve({ code, signal, stderr: err, stdout: out });
  }));
  // A failed assertion or a contender admitted by mistake must not hang the test runner.
  const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.once("close", () => clearTimeout(deadline));
  if (input) child.stdin.write(input);
  return { child, ready, exited };
}

const nodeServer = (path) => start(process.execPath, [bin, "--home", path, "serve"], (out) => out.includes('"id":1'), JSON.stringify(INITIALIZE) + "\n");
const pythonRuntime = (path) => start(python[0], [...python.slice(1), "-c", PYTHON_HOLDER, pythonSource, path], (out) => out.includes("held"));
const phpRuntime = (path) => start(php[0], [...php.slice(1), "-d", "display_errors=stderr", "-r", PHP_HOLDER, "--", phpBootstrap, path], (out) => out.includes("held"));

async function eventually(attempt, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function kill(holder) {
  holder.child.kill("SIGKILL");
  await holder.exited;
}

test("a home is taken once in this process, and the pid file names its holder", async (t) => {
  const path = await home(t);
  const previous = join(path, "lock.tmp");
  await writeFile(previous, "previous temporary file");
  const owner = await takeHome(path);
  const written = JSON.parse(await readFile(join(path, PID_FILE), "utf8"));
  assert.equal(written.pid, process.pid);
  assert.equal(written.os_lock, true);
  assert.equal(typeof written.at, "number");
  assert.equal(typeof written.host, "string");
  await assert.rejects(takeHome(path), { code: "home_in_use", message: /in this process/ });
  await owner.release();
  assert.equal(existsSync(join(path, PID_FILE)), false, "the pid file goes before the lock");
  assert.equal(existsSync(join(path, OWNER_LOCK)), true, "owner.lock is never removed");
  const again = await takeHome(path);
  await again.release();
  assert.equal(await readFile(previous, "utf8"), "previous temporary file");
});

test("a second Node server is refused, and takes the home once the first is killed", async (t) => {
  const path = await home(t);
  const first = nodeServer(path);
  await first.ready;
  const second = nodeServer(path);
  const refused = await second.exited;
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /another aamio \(pid \d+\) is using/);
  assert.equal(refused.stdout, "", "a refused server says nothing on the protocol");
  await assert.rejects(takeHome(path), { code: "home_in_use" });
  await kill(first);
  const owner = await eventually(() => takeHome(path));
  await owner.release();
  const third = nodeServer(path);
  await third.ready;
  third.child.stdin.end();
  assert.equal((await third.exited).code, 0, "a server whose input ends lets go and ends well");
  assert.equal(existsSync(join(path, PID_FILE)), false);
});

for (const [name, runtime, here] of [["aamio-python", pythonRuntime, pythonHere], ["aamio-php", phpRuntime, phpHere]]) {
  test(`${name} and Node keep each other out of one home, in both orders, and the next takes over from a killed owner`, { skip: here ? false : `${name} source, interpreter or required extension is unavailable` }, async (t) => {
    const path = await home(t);
    const other = runtime(path);
    await other.ready;
    const node = nodeServer(path);
    const refused = await node.exited;
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /is using/);
    await kill(other);
    const owner = await eventually(() => takeHome(path));
    await owner.release();

    const server = nodeServer(path);
    await server.ready;
    const shut = runtime(path);
    const out = await shut.exited;
    assert.notEqual(out.code, 0, `${name} took a home that Node holds: ${out.stdout}`);
    assert.doesNotMatch(out.stdout, /held/);
    // On Windows the older clients cannot open the file Node holds and say so; elsewhere they find it locked.
    assert.match(out.stderr, /another aamio|cannot establish exclusive ownership/);
    await kill(server);
    const next = await eventually(async () => {
      const attempt = runtime(path);
      await attempt.ready;
      return attempt;
    });
    next.child.stdin.end();
    assert.equal((await next.exited).code, 0);
  });
}

test("a pid file from a client before owner.lock keeps the home while its process lives", async (t) => {
  const path = await home(t);
  const older = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => older.kill("SIGKILL"));
  await writeFile(join(path, PID_FILE), JSON.stringify({ pid: older.pid, at: Math.floor(Date.now() / 1000), host: "https://aamio.at" }));
  await assert.rejects(takeHome(path), { code: "home_in_use", message: new RegExp(`pid ${older.pid}`) });
  assert.equal(JSON.parse(await readFile(join(path, PID_FILE), "utf8")).pid, older.pid, "a refused runtime leaves the pid file alone");
  await writeFile(join(path, PID_FILE), JSON.stringify({ pid: older.pid, at: 1, host: "https://aamio.at", os_lock: true }));
  const owner = await takeHome(path);
  await owner.release();
  older.kill("SIGKILL");
  await new Promise((resolve) => older.once("exit", resolve));
  await writeFile(join(path, PID_FILE), JSON.stringify({ pid: older.pid, at: 1, host: "https://aamio.at" }));
  const after = await takeHome(path);
  await after.release();
});

test("on Linux, without the flock command the home is not taken, and the answer says what to install", { skip: process.platform === "linux" ? false : "the flock command is Linux's" }, async (t) => {
  const path = await home(t);
  await assert.rejects(holdOwnerLock(path, { flock: join(path, "no-such-flock") }), { code: "lock_unavailable", message: /util-linux/ });
});

test("on Linux, Node still owns the lock after flock exits", { skip: process.platform !== "linux" }, async (t) => {
  const path = await home(t);
  const wrapper = join(path, "test-flock");
  await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$$" > "$0.pid"\nexec flock "$@"\n', { mode: 0o700 });
  const holder = await holdOwnerLock(path, { flock: wrapper });
  try {
    const helperPid = Number(await readFile(wrapper + ".pid", "utf8"));
    assert.throws(() => process.kill(helperPid, 0), { code: "ESRCH" });
    assert.equal(await holdOwnerLock(path), null);
  } finally {
    await holder.release();
  }
  const next = await holdOwnerLock(path);
  await next.release();
});

test("on Linux, a generic flock failure is reported as unavailable", { skip: process.platform !== "linux" }, async (t) => {
  const path = await home(t);
  await assert.rejects(holdOwnerLock(path, { flock: "false" }), { code: "lock_unavailable" });
  const owner = await takeHome(path);
  await owner.release();
});
