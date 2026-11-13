import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function cli(home, args, input = "") {
  return spawnSync(process.execPath, [bin, ...args], {
    input, encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOME: home },
  });
}

test("help, version and invalid arguments leave the home untouched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "uninitialized");
  const help = cli(home, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /whoami/);
  // As aamio-python and aamio-php say it.
  assert.equal(cli(home, ["--version"]).stdout.trim(), `aamio ${pkg.version}`);
  // A usage error is found before the home is opened: it never takes the home from the process that has it.
  const usage = [["board", "post", "maybe", "title", "text"], ["board", "find", "--wait", "99"], ["board", "answer", "p", "t", "--data", "{"],
    ["send", "bob", "hi", "--data", "{"], ["read", "--limit", "0"], ["lookup", "--wait", "x"], ["board", "post", "need", "title", "text", "--ttl", "5"]];
  const asked = [["--host="], ["--host", "--version"], ["--host", "http://127.0.0.1:9", "--host", "http://127.0.0.1:8", "whoami"], ["init", "--archive", "sometimes"], ["init", "--bogus", "x"], ["doctor", "extra"]];
  for (const args of [["bogus"], ["--home="], ["--home", "--version"], ["serve", "extra"], ...usage, ...asked]) {
    const refused = cli(home, args);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stdout, "");
  }
  assert.equal(existsSync(home), false);
});

test("serve creates an identity in the chosen home and emits only protocol messages", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "with spaces");
  const unusedHome = join(dir, "unused");
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "local-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aamio_whoami", arguments: {} } },
  ];
  const served = cli(unusedHome, ["--home", home, "serve"], lines.map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(served.status, 0, served.stderr);
  const answers = served.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(answers.map(answer => answer.id), [1, 2]);
  assert.equal(answers[0].result.protocolVersion, "2025-11-25");
  const whoami = JSON.parse(answers[1].result.content[0].text);
  // The server holds the home, so its whoami adds the inbox, the host and the
  // tags: no inbox yet, since nothing has been read or sent.
  assert.deepEqual(Object.keys(whoami).sort(), ["hash", "hash_prefix", "host", "inbox", "inbox_expires_at", "key", "tags"]);
  assert.equal(whoami.inbox, null);
  assert.equal(whoami.hash_prefix, whoami.hash.slice(0, 8));
  for (const command of ["whoami", "init"]) {
    const result = cli(home, [command]);
    assert.equal(result.status, 0, result.stderr);
    // init says once, where a person sets the home up, what the home keeps: the service forgets, and this folder
    // does not unless it is told to. And whoami and init answer with what the server answers, as aamio-python and
    // aamio-php do: they answered with the key alone (a check of 13 November 2026).
    const { local_storage: kept, ...shown } = JSON.parse(result.stdout);
    assert.deepEqual(shown, whoami);
    if (command === "whoami") assert.equal(kept, undefined);
    else {
      assert.deepEqual([kept.policy, kept.files, kept.bytes, kept.oldest_at, kept.home], [{ mode: "keep", days: null, max_mb: null }, 0, 0, null, home]);
      assert.match(kept.means, /^Decrypted messages and receipts are kept in archive\/ until you remove them\..*`aamio archive off` stops it\.$/);
      assert.deepEqual(Object.keys(kept.who_can_read), ["home", "private", "how", "findings"].concat(kept.who_can_read.fix ? ["fix"] : []));
      assert.equal(kept.who_can_read.home, home);
    }
  }
  assert.equal(existsSync(unusedHome), false);
});

test("init takes the tags presence publishes and what is kept, and AAMIO_TAGS stands in when the home has none", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aamio-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "tagged");
  const made = cli(home, ["init", "--tags", "stue,test", "--archive", "off"]);
  assert.equal(made.status, 0, made.stderr);
  const answer = JSON.parse(made.stdout);
  assert.deepEqual([answer.tags, answer.inbox, answer.local_storage.policy.mode], [["stue", "test"], null, "off"], "init opens no inbox, so it needs no service");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).tags, ["stue", "test"], "and the tags are the home's from now on");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).archive.mode, "off");
  const env = (extra) => spawnSync(process.execPath, [bin, "whoami"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOME: home, ...extra } });
  assert.deepEqual(JSON.parse(env({ AAMIO_TAGS: "from,env" }).stdout).tags, ["stue", "test"], "the home's own come before AAMIO_TAGS, as in aamio-python");
  const fresh = join(dir, "fresh");
  const fromEnv = spawnSync(process.execPath, [bin, "init"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOME: fresh, AAMIO_TAGS: "from,env" } });
  assert.deepEqual(JSON.parse(fromEnv.stdout).tags, ["from", "env"], "and stand in when it has none");
  const hosted = cli(home, ["--host", "http://127.0.0.1:9", "whoami"]);
  assert.equal(JSON.parse(hosted.stdout).host, "http://127.0.0.1:9", "--host names the service, before AAMIO_HOST");
});
