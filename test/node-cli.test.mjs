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
  assert.equal(cli(home, ["--version"]).stdout.trim(), pkg.version);
  // A usage error is found before the home is opened: it never takes the home from the process that has it.
  const usage = [["board", "post", "maybe", "title", "text"], ["board", "find", "--wait", "99"], ["board", "answer", "p", "t", "--data", "{"],
    ["send", "bob", "hi", "--data", "{"], ["read", "--limit", "0"], ["lookup", "--wait", "x"], ["board", "post", "need", "title", "text", "--ttl", "5"]];
  for (const args of [["bogus"], ["--home="], ["--home", "--version"], ["serve", "extra"], ...usage]) {
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
  const identity = { key: whoami.key, hash: whoami.hash, hash_prefix: whoami.hash_prefix };
  assert.equal(identity.hash_prefix, identity.hash.slice(0, 8));
  for (const command of ["whoami", "init"]) {
    const result = cli(home, [command]);
    assert.equal(result.status, 0, result.stderr);
    // init says once, where a person sets the home up, what the home keeps: the service forgets, and this folder
    // does not unless it is told to.
    const { local_storage: kept, ...shown } = JSON.parse(result.stdout);
    assert.deepEqual(shown, identity);
    if (command === "whoami") assert.equal(kept, undefined);
    else {
      assert.deepEqual([kept.policy, kept.files, kept.bytes, kept.oldest_at, kept.home], [{ mode: "keep", days: null, max_mb: null }, 0, 0, null, home]);
      assert.match(kept.means, /^Decrypted messages and receipts are kept in archive\/ until you remove them\..*`aamio archive off` stops it\.$/);
    }
  }
  assert.equal(existsSync(unusedHome), false);
});
