// The add-on's process: one request of contract 2 in, one answer out. The core has settled the website and the key
// before the process starts, so what is tried here is what the add-on does with them: the answer, its exit code and
// its words, for every way a check can go, with a network that is a fake. The cases are the ones aamio-python tries
// in tests/test_domain_process.py, and the words are compared with aamio-python's own when its source is beside
// this package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT, NAME, VERSION, handle } from "../src/handle.js";
import { makeDomainKeys } from "../src/lists.js";
import { EXIT_CODES, NOT_CONTACTED, NOT_UNDER_THAT_LABEL, STATEMENTS, TLS_NOTE, denyNetworks } from "../src/policy.js";

const KEY = "c3lrmIg_bOnE-fQyMRpxvqoeXAhkBGqDHCD9LXKWSnc";
const OTHER = "wK1BJa9cuHn7Y7QPC_4EQ6X_jtCbgbMbR6pqT-VGmmA";
const PUBLIC = "93.184.216.34";
const WHEN = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const LIST = Buffer.from(makeDomainKeys([{ key: KEY, name: "support" }]));
const entry = fileURLToPath(new URL("../process.js", import.meta.url));
const PARTNER = { key: KEY, subject_source: "partner", partner: "Kari", signature_checked_locally: null };

function http(status = 200, body = LIST) {
  return Buffer.concat([Buffer.from(`HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n`, "latin1"), body]);
}

// A network that answers as told, and records whether it was asked at all.
function network(chunks, { addresses = [PUBLIC], connectError = null, environment = "" } = {}) {
  const seen = { resolved: 0, connected: 0 };
  const left = [...chunks];
  return {
    seen,
    environment,
    now: () => WHEN,
    resolve: async () => {
      seen.resolved += 1;
      return addresses;
    },
    connect: async () => {
      seen.connected += 1;
      if (connectError) throw connectError;
      return { write: async () => {}, read: async () => (left.length ? left.shift() : null), close: () => {} };
    },
  };
}

const request = (kind, name, given = {}, more = {}) => ({ aamio_addon: 2, kind, name, arguments: given, subject: null, own_key: null, state_dir: null, deadline_seconds: 30, aamio: { version: "test", runtime: "node" }, ...more });
const check = (given, subject = PARTNER, net = network([http()])) => handle(request("command", "check", given, { subject }), net);

test("the probe answers as the manifest says", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../aamio-addon.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(await handle(request("probe", "probe")), { exit_code: 0, is_error: false, result: { ok: true, name: "domain", version: manifest.version, aamio_addon: 2 } });
  assert.deepEqual([NAME, VERSION, CONTRACT, pkg.version, manifest.process.node, pkg.aamioAddon], ["domain", manifest.version, 2, manifest.version, "process.js", "./aamio-addon.json"]);
  assert.deepEqual(pkg.dependencies, undefined, "the package brings nothing with it");
  for (const file of ["aamio-addon.json", "process.js", "src/fetch.js", "src/handle.js", "src/lists.js", "src/policy.js"]) assert.ok(pkg.files.includes(file), file);
});

test("the manifest is aamio-python's, with the script for Node beside the other two", (t) => {
  const there = new URL("../../../../aamio-python/addons/domain-keys/src/aamio_domain_keys/aamio-addon.json", import.meta.url);
  if (!existsSync(there)) return t.skip("no aamio-python checkout beside this one");
  const theirs = JSON.parse(readFileSync(there, "utf8"));
  const mine = JSON.parse(readFileSync(new URL("../aamio-addon.json", import.meta.url), "utf8"));
  assert.deepEqual(mine.process, { ...theirs.process, node: "process.js" });
  assert.deepEqual({ ...mine, process: theirs.process }, theirs);
});

test("file is your public key as the list a website publishes, byte for byte, and the note goes to the user", async () => {
  const said = await handle(request("command", "file", { name: "support" }, { own_key: KEY }));
  assert.deepEqual([said.exit_code, said.is_error, "result" in said], [0, false, false]);
  assert.deepEqual(Buffer.from(said.raw, "base64"), LIST);
  assert.equal(said.stderr, "aamio: this holds your public key and nothing secret. Publish it at https://YOUR-DOMAIN/.well-known/aamio-keys.json, with no login and no redirect, on a domain you already control.");
  const plain = await handle(request("command", "file", { name: null }, { own_key: KEY }));
  assert.deepEqual(Buffer.from(plain.raw, "base64"), Buffer.from(makeDomainKeys([{ key: KEY }])));
  // A complaint goes to the user and not to standard output, where a redirect would publish it.
  const bad = await handle(request("command", "file", { name: "Not A Label" }, { own_key: KEY }));
  assert.deepEqual([bad.exit_code, bad.is_error, bad.result, "raw" in bad], [2, true, null, false]);
  assert.deepEqual(JSON.parse(bad.stderr), { error: "invalid_name", fix: "--name is a label of 1 to 64 characters of a-z, 0-9, dot, underscore and dash." });
  assert.equal((await handle(request("command", "file", {}, { own_key: null }))).exit_code, 2);
});

test("validate reads one file and no domain", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "aamio-domain-process-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "list.json"), LIST);
  assert.deepEqual(await handle(request("command", "validate", { file: join(folder, "list.json") })), { exit_code: 0, is_error: false, result: { format_valid: true, keys: 1, source: "local_file", domain_checked: false } });
  assert.deepEqual(await handle(request("command", "validate", { file: join(folder, "none.json") })), { exit_code: 2, is_error: true, result: { error: "local_file_unreadable" } });
});

test("a check says what the website listed, in words that come from why", async () => {
  const net = network([http()]);
  const listed = await check({ domain: "Example.org", name: null }, PARTNER, net);
  assert.deepEqual([listed.exit_code, listed.is_error], [0, false]);
  assert.deepEqual(listed.result, {
    domain: "example.org", key: KEY, checked_at: "2026-11-07T12:00:00Z", status: "listed", reason: "key_listed", document_sha256: listed.result.document_sha256, matched_name: "support",
    subject_source: "partner", partner: "Kari", signature_checked_locally: null, statement: STATEMENTS.listed,
  });
  assert.deepEqual(net.seen, { resolved: 1, connected: 1 });
  // The same through the tool, with the key behind a message.
  const message = { key: KEY, subject_source: "message", message_sha256: "a".repeat(64), signature_checked_locally: true };
  const tool = await handle(request("tool", "aamio_addon_domain_check", { domain: "example.org", message: "a".repeat(64) }, { subject: message }), network([http()]));
  assert.deepEqual([tool.exit_code, tool.result.status, tool.result.subject_source, tool.result.message_sha256, tool.result.signature_checked_locally], [0, "listed", "message", "a".repeat(64), true]);

  const absent = await check({ domain: "example.org" }, { ...PARTNER, key: OTHER });
  // The exit code tells a script which answer it was; an answer that was read is no error over MCP.
  assert.deepEqual([absent.exit_code, absent.is_error, absent.result.status, absent.result.statement], [3, false, "not_listed", STATEMENTS.not_listed]);
  const label = await check({ domain: "example.org", name: "billing" });
  assert.deepEqual([label.exit_code, label.result.status, label.result.requested_name, label.result.statement], [3, "not_listed", "billing", NOT_UNDER_THAT_LABEL]);
  const none = await check({ domain: "example.org" }, PARTNER, network([http(404, Buffer.alloc(0))]));
  assert.deepEqual([none.exit_code, none.result.status, none.result.http_status, none.result.statement], [4, "no_list", 404, STATEMENTS.no_list]);
  const down = await check({ domain: "example.org" }, PARTNER, network([http(503, Buffer.alloc(0))]));
  assert.deepEqual([down.exit_code, down.result.status, down.result.reason, down.result.statement], [5, "unreachable", "http_status", STATEMENTS.unreachable]);
  const nonsense = await check({ domain: "example.org" }, PARTNER, network([http(200, Buffer.from("{}"))]));
  assert.deepEqual([nonsense.exit_code, nonsense.result.status, nonsense.result.reason, nonsense.result.statement], [2, "invalid", "invalid_document", STATEMENTS.invalid]);
  const tls = await check({ domain: "example.org" }, PARTNER, network([], { connectError: Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" }) }));
  assert.deepEqual([tls.exit_code, tls.result.reason, tls.result.note], [5, "tls", TLS_NOTE]);
  const inside = network([http()], { addresses: ["10.0.0.5"] });
  const kept = await check({ domain: "example.org" }, PARTNER, inside);
  assert.deepEqual([kept.exit_code, kept.result.status, kept.result.reason, kept.result.statement, inside.seen.connected], [2, "invalid", "target_not_public", NOT_CONTACTED, 0]);
  assert.deepEqual(EXIT_CODES, { listed: 0, not_listed: 3, no_list: 4, unreachable: 5, invalid: 2 });
  for (const said of [listed, absent, label, none, down, nonsense, tls, kept]) assert.equal("fix" in said.result, false, "what was read is an answer, and no refusal");
});

test("what is refused here is refused before anything is looked up, and says what to do", async () => {
  const cases = [
    [{ domain: "https://example.org" }, PARTNER, "invalid_domain", /A domain is a plain host name of two labels or more/],
    [{ domain: "example.org", name: "Not A Label" }, PARTNER, "invalid_requested_name", /name is the label on the list/],
    [{ domain: "example.org" }, null, "subject_missing", /A check needs the key aamio resolves from the address book or from a signature it checked itself/],
    [{ domain: "example.org" }, { subject_source: "partner", partner: "Kari" }, "subject_missing", /none came with this call/],
    [{ domain: "example.org" }, { ...PARTNER, key: "short" }, "subject_missing", /none came with this call/],
  ];
  for (const [given, subject, reason, fix] of cases) {
    const net = network([http()]);
    const said = await check(given, subject, net);
    assert.deepEqual([said.exit_code, said.is_error, said.result.status, said.result.reason, net.seen.resolved], [2, true, "invalid", reason, 0], reason);
    assert.match(said.result.fix, fix);
    assert.equal("checked_at" in said.result || "statement" in said.result, false, "nothing was read, so it carries no time and no statement");
  }
  const refused = (await check({ domain: "example.org", name: "Not A Label" })).result;
  assert.deepEqual([refused.domain, refused.partner, refused.subject_source, refused.key, refused.requested_name], ["example.org", "Kari", "partner", KEY, "Not A Label"]);
});

test("the operator's keep-out list holds, and one that does not parse stops every check", async () => {
  const blocked = network([http()], { environment: "198.51.100.0/24, 93.184.216.0/24" });
  const kept = await check({ domain: "example.org" }, PARTNER, blocked);
  assert.deepEqual([kept.result.status, kept.result.reason, kept.result.statement, blocked.seen.connected], ["invalid", "target_not_public", NOT_CONTACTED, 0]);
  const elsewhere = await check({ domain: "example.org" }, PARTNER, network([http()], { environment: "198.51.100.0/24,2001:db8::/32," }));
  assert.equal(elsewhere.result.status, "listed");
  for (const bad of ["nonsense", "93.184.216.0/24,nope", "1.2.3.4/40", "example.org"]) {
    const net = network([http()], { environment: bad });
    const said = await check({ domain: "example.org" }, PARTNER, net);
    assert.deepEqual([said.exit_code, said.result.status, said.result.reason, net.seen.resolved], [2, "invalid", "domain_deny_invalid", 0], bad);
    assert.match(said.result.fix, /AAMIO_DOMAIN_DENY holds something that is not a network, so no website is read until it is put right/);
  }
  assert.deepEqual(denyNetworks(""), []);
  assert.deepEqual(denyNetworks(" 203.0.113.0/24 , 2001:db8::/32 "), ["203.0.113.0/24", "2001:db8::/32"]);
});

test("what is not this add-on's, or not on its contract, is said so", async () => {
  const other = await handle(request("command", "nope"));
  assert.deepEqual([other.exit_code, other.is_error, other.result.error], [2, true, "the add-on domain has no command called nope"]);
  assert.equal((await handle(request("tool", "aamio_addon_domain_nope"))).result.error, "the add-on domain has no tool called aamio_addon_domain_nope");
  for (const bad of [null, [], "text", { ...request("probe", "probe"), aamio_addon: 3 }, {}]) {
    const said = await handle(bad);
    assert.deepEqual([said.exit_code, said.is_error], [2, true]);
    assert.match(said.result.error, /this add-on speaks contract 2 of aamio's add-ons, and the request is not on it/);
  }
});

test("the words are aamio-python's, sentence for sentence", (t) => {
  const there = new URL("../../../../aamio-python/addons/domain-keys/src/aamio_domain_keys/policy.py", import.meta.url);
  if (!existsSync(there)) return t.skip("no aamio-python checkout beside this one");
  // Python writes a long sentence as pieces side by side; put together, each sentence here is in its source.
  const theirs = readFileSync(there, "utf8").replaceAll("\r\n", "\n").replace(/"\s*\n\s*"/g, "");
  for (const words of [...Object.values(STATEMENTS), NOT_UNDER_THAT_LABEL, NOT_CONTACTED]) assert.ok(theirs.includes(words), words);
});

// The script itself, as the core starts it.
function start(given, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", AAMIO_ADDON: "2", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
    child.stdin.end(typeof given === "string" ? given : JSON.stringify(given));
  });
}

test("the script answers one request and ends with the answer's exit code", async () => {
  const probed = await start(request("probe", "probe"));
  assert.deepEqual([probed.code, probed.err, JSON.parse(probed.out).result.ok], [0, "", true]);
  const garbage = await start("not json");
  assert.deepEqual([garbage.code, JSON.parse(garbage.out).exit_code, JSON.parse(garbage.out).is_error], [2, 2, true]);
  const file = await start(request("command", "file", { name: "support" }, { own_key: KEY }));
  assert.deepEqual([file.code, Buffer.from(JSON.parse(file.out).raw, "base64").equals(LIST)], [0, true]);
  // The operator's keep-out list comes to the process through its environment, and one that does not parse stops
  // the check there, before any lookup.
  const denied = await start(request("command", "check", { domain: "example.org", name: null }, { subject: PARTNER }), { AAMIO_DOMAIN_DENY: "not-a-network" });
  assert.deepEqual([denied.code, JSON.parse(denied.out).result.reason], [2, "domain_deny_invalid"]);
  const refused = await start(request("command", "check", { domain: "example.org" }, { subject: null }));
  assert.deepEqual([refused.code, JSON.parse(refused.out).result.reason], [2, "subject_missing"]);
});
