import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { initIdentity, readIdentity } from "../src/node-identity.js";

const vector = JSON.parse(await readFile(new URL("./vectors.json", import.meta.url), "utf8")).a;
const expected = { key: vector.public, hash: vector.hash, hash_prefix: vector.hash.slice(0, 8) };

async function fixture(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, "aamio-node-identity-"));
  assert.equal(dirname(root), parent);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home: join(root, "home") };
}

test("existing cross-runtime identity is read without changing the key, lock, or state", async (t) => {
  const { home } = await fixture(t);
  await mkdir(home);
  const seedText = vector.seed + "\r\n";
  await writeFile(join(home, "key"), seedText);
  await writeFile(join(home, "owner.lock"), "owner marker");
  await writeFile(join(home, "state.json"), "existing state");
  assert.deepEqual(await readIdentity(home), expected);
  assert.deepEqual(await initIdentity(home), expected);
  assert.equal(await readFile(join(home, "key"), "utf8"), seedText);
  assert.equal(await readFile(join(home, "owner.lock"), "utf8"), "owner marker");
  assert.equal(await readFile(join(home, "state.json"), "utf8"), "existing state");
  assert.deepEqual((await readdir(home)).sort(), ["key", "owner.lock", "state.json"]);
});

test("missing, empty, incomplete and corrupt homes are distinguished without repair", async (t) => {
  const { root, home } = await fixture(t);
  await assert.rejects(readIdentity(home), { code: "home_not_initialized" });
  assert.deepEqual(await readdir(root), []);
  await mkdir(home);
  await assert.rejects(initIdentity(home), { code: "key_unreadable" });
  assert.deepEqual(await readdir(home), []);
  await writeFile(join(home, "owner.lock"), "");
  await assert.rejects(initIdentity(home), { code: "key_unreadable" });
  for (const invalid of ["", "a".repeat(63), vector.seed + "g", "F".repeat(64), "\uFEFF" + vector.seed]) {
    await writeFile(join(home, "key"), invalid);
    for (const action of [readIdentity, initIdentity]) {
      await assert.rejects(action(home), (error) => {
        assert.equal(error.code, "key_unreadable");
        if (invalid) assert.ok(!error.message.includes(invalid));
        return true;
      });
    }
    assert.equal(await readFile(join(home, "key"), "utf8"), invalid);
  }
});

test("racing initializers publish one complete private identity and remove their staging folders", async (t) => {
  const { root, home } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => initIdentity(home)));
  const identity = await readIdentity(home);
  for (const result of results) assert.deepEqual(result, identity);
  assert.deepEqual(Object.keys(identity).sort(), ["hash", "hash_prefix", "key"]);
  assert.match(identity.key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(identity.hash, /^[a-f0-9]{64}$/);
  assert.equal(identity.hash_prefix, identity.hash.slice(0, 8));
  assert.match(await readFile(join(home, "key"), "utf8"), /^[a-f0-9]{64}\n$/);
  assert.deepEqual(await readdir(home), ["key"]);
  assert.deepEqual(await readdir(root), ["home"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, "key"))).mode & 0o777, 0o600);
    return;
  }
  const windows = process.env.SystemRoot || "C:\\Windows";
  const exe = join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
    $ErrorActionPreference = 'Stop'
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $folder = [System.IO.Directory]::GetAccessControl($env:AAMIO_TEST_HOME)
    $file = [System.IO.File]::GetAccessControl([System.IO.Path]::Combine($env:AAMIO_TEST_HOME, 'key'))
    if (-not $folder.AreAccessRulesProtected) { exit 1 }
    foreach ($acl in $folder, $file) {
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $me -or $rules[0].FileSystemRights -ne 'FullControl') { exit 1 }
    }`;
  await promisify(execFile)(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { SystemRoot: windows, AAMIO_TEST_HOME: home }, windowsHide: true, timeout: 15000,
  });
});

test("init reports a fixed error when its parent directory does not exist", async (t) => {
  const { home } = await fixture(t);
  await assert.rejects(initIdentity(join(home, "child")), { code: "home_init_failed" });
});
