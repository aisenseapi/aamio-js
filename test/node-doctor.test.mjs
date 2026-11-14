// aamio doctor in the Node runtime, held to what aamio-python's tests hold its own to: tests/test_compatibility.py
// for whether a client and a service fit, and tests/test_the_privacy_check_has_a_second_way.py for who can read the
// home, with icacls standing in when Get-Acl is not there. And doctor on the command line against the fake service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NEEDS, PROTOCOL, USES, compatCheck, homeCheck, windowsAclFindings, windowsRulesIcacls } from "../src/node-doctor.js";
import { FakeAamio } from "./fake-aamio.mjs";
import { serveFake } from "./serve-fake.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const EVERYTHING = [...NEEDS, ...Object.keys(USES)];

test("a service that offers everything this client uses is fully supported, and more than it knows is said", () => {
  const found = compatCheck({ version: "9.9.9", protocol: { version: PROTOCOL, capabilities: [...EVERYTHING, "something-newer"] } });
  assert.deepEqual([found.verdict, found.missing, found.unknown_to_this_client], ["full", [], ["something-newer"]]);
});

test("a capability that is used and not offered is partial, and named with what it is for", () => {
  const found = compatCheck({ version: "0.7.1", protocol: { version: PROTOCOL, capabilities: EVERYTHING.filter((name) => name !== "scopes") } });
  assert.deepEqual([found.verdict, found.missing], ["partial", ["scopes"]]);
  assert.match(found.why, /unlisted posts/);
});

test("another protocol or a missing need is refused with the reason", () => {
  assert.equal(compatCheck({ protocol: { version: PROTOCOL + 1, capabilities: EVERYTHING } }).verdict, "refuse");
  const found = compatCheck({ protocol: { version: PROTOCOL, capabilities: EVERYTHING.filter((name) => name !== "threads") } });
  assert.deepEqual([found.verdict, found.missing], ["refuse", ["threads"]]);
  assert.match(found.why, /cannot work without/);
});

test("a service that declares nothing is partial and never called full", () => {
  for (const descriptor of [{ version: "0.7.0" }, {}, null, { protocol: "1" }, { protocol: { version: 1 } }]) {
    const found = compatCheck(descriptor);
    assert.equal(found.verdict, "partial", JSON.stringify(descriptor));
    assert.match(found.why, /does not declare/);
  }
});

test("the user, SYSTEM and the administrators are not findings, and Everyone is named from its SID", () => {
  const found = windowsAclFindings(["S-1-1-0|ReadAndExecute, Synchronize|Allow", "S-1-5-21-1-2-3-1001|FullControl|Allow", "S-1-5-18|FullControl|Allow",
    "S-1-5-32-544|FullControl|Allow", "S-1-5-11|Read|Deny", "not a rule"], "S-1-5-21-1-2-3-1001");
  assert.deepEqual(found.map((finding) => [finding.who, finding.rights]), [["Everyone", "ReadAndExecute, Synchronize"]]);
  assert.match(found[0].problem, /can be read by others on this machine$/);
});

// icacls standing in for Get-Acl, with what aamio-python's tests give it: a SID from whoami and an export in UTF-16.
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const getAclGone = () => {
  throw Object.assign(new Error("Get-Acl is not there"), { code: "ENOENT" });
};
function withExport(record, { runner } = {}) {
  // The tools are asked by their place in System32, so the command is a whole path.
  const answer = runner ?? ((command) => (basename(command).toLowerCase() === "whoami.exe" ? '"pc\\me","S-1-5-21-1-2-3-1001"\r\n' : ""));
  return (home) => windowsRulesIcacls(home, answer, () => record(basename(home)));
}

test("a complete export from icacls says what Get-Acl says", (t) => {
  const home = mkdtempSync(join(tmpdir(), "aamio-acl-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [dacl, expected] of [["D:", true], ["D:P(D;;FA;;;WD)", true], ["D:AI(A;OICI;FA;;;SY)(A;;FA;;;OW)", true], ["D:PAI(A;;FA;;;WD)", false],
    ["D:ARAI(A;;FA;;;SY)S:P(ML;OINPIO;NW;;;HI)", true]]) {
    const found = homeCheck(home, { platform: "win32", getAcl: getAclGone, icacls: withExport((name) => utf16(`${name}\r\n${dacl}\r\n`)) });
    assert.equal(found.private, expected, `${dacl}: ${JSON.stringify(found)}`);
    assert.match(found.how, /read with icacls after Get-Acl was not available \(FileNotFoundError\)/);
  }
});

test("an export that is cut, ambiguous or of something else is no answer, and never a yes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "aamio-acl-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const failing = (code) => (command) => {
    if (basename(command).toLowerCase() === "whoami.exe") return '"pc\\me","S-1-5-21-1-2-3-1001"\r\n';
    throw Object.assign(new Error("icacls: " + code), { code });
  };
  const records = {
    exit: [null, failing("EFAILED")],
    timeout: [null, failing("ETIMEDOUT")],
    missing: [() => { throw Object.assign(new Error("no export"), { code: "ENOENT" }); }],
    encoding: [() => Buffer.from([0xff, 0xfe, 0x00])],
    empty: [() => utf16("")],
    wrong_target: [() => utf16("some-other-folder\r\nD:(A;;FA;;;SY)\r\n")],
    many_targets: [(name) => utf16(`${name}\r\nD:(A;;FA;;;SY)\r\nother\r\nD:(A;;FA;;;SY)\r\n`)],
    no_dacl: [(name) => utf16(`${name}\r\nO:SY\r\n`)],
    broken_ace: [(name) => utf16(`${name}\r\nD:(A;;FA;;;SY\r\n`)],
    broken_fields: [(name) => utf16(`${name}\r\nD:(A;;FA;;;)\r\n`)],
    unknown_ace: [(name) => utf16(`${name}\r\nD:(ZA;;FA;;;SY)\r\n`)],
    null_dacl: [(name) => utf16(`${name}\r\nD:NO_ACCESS_CONTROL\r\n`)],
    garbage: [(name) => utf16(`${name}\r\nD:this is not a DACL\r\n`)],
  };
  for (const [failure, [record, runner]] of Object.entries(records)) {
    const found = homeCheck(home, { platform: "win32", getAcl: getAclGone, icacls: withExport(record ?? (() => utf16("")), { runner }) });
    assert.equal(found.private, null, `${failure}: ${JSON.stringify(found)}`);
    assert.deepEqual(found.findings, []);
    assert.match(found.how, /^not checked/, failure);
    assert.match(found.fix, /icacls/, "the fix still says what to run");
  }
});

test("a folder that is not there is not checked, and not called private", () => {
  const found = homeCheck(join(tmpdir(), "aamio-no-such-folder-" + process.pid));
  assert.deepEqual([found.private, found.how, found.findings], [null, "not checked: there is no such folder yet", []]);
});

test("on Windows the real access list of a folder is read, and Get-Acl and icacls agree", { skip: process.platform !== "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "aamio-acl-real-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const withGetAcl = homeCheck(home);
  const withIcacls = homeCheck(home, { getAcl: getAclGone });
  assert.match(withIcacls.how, /read with icacls/);
  // Where the PowerShell module behind Get-Acl does not load, as for a user
  // whose policy keeps it out, the check falls back to icacls, as it should,
  // and there is nothing to compare: the test was red there (a check of 13
  // November 2026).
  if (!/read with Get-Acl/.test(withGetAcl.how)) {
    assert.match(withGetAcl.how, /read with icacls after Get-Acl was not available/);
    t.diagnostic("Get-Acl does not load here, so only icacls was read");
    return;
  }
  assert.equal(withIcacls.private, withGetAcl.private, JSON.stringify([withGetAcl, withIcacls]));
  assert.deepEqual(withIcacls.findings.map((finding) => finding.who), withGetAcl.findings.map((finding) => finding.who));
});

test("elsewhere the owner and the mode bits of the folder and every file in it are read", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "aamio-mode-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  chmodSync(home, 0o700);
  mkdirSync(join(home, "archive"), { mode: 0o700 });
  writeFileSync(join(home, "key"), "secret", { mode: 0o600 });
  assert.equal(homeCheck(home).private, true);
  writeFileSync(join(home, "archive", "inbox.jsonl"), "{}\n");
  chmodSync(join(home, "archive", "inbox.jsonl"), 0o644);
  const found = homeCheck(home);
  assert.deepEqual([found.private, found.findings.map((finding) => finding.problem)], [false, ["readable by others (mode 644)"]]);
  assert.equal(found.fix, `chmod -R go-rwx "${home}"`);
});

test("doctor answers as aamio-python and aamio-php do: the service, whether it fits, who can read the home, what is kept", async (t) => {
  const fake = new FakeAamio({ now: Math.floor(Date.now() / 1000) });
  const { cli } = await serveFake(t, fake);
  const dir = mkdtempSync(join(tmpdir(), "aamio-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const said = async (...args) => {
    const done = await cli(home, ...args);
    assert.equal(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  };
  await said("init");
  const answer = await said("doctor");
  assert.deepEqual(Object.keys(answer), ["client", "service", "compatibility", "storage", "archive", "outbox_pending"]);
  assert.deepEqual(answer.client, { name: "aamio-js", version: pkg.version, protocol: PROTOCOL });
  assert.deepEqual([answer.service.reachable, answer.service.healthy, answer.service.status, answer.service.version, answer.service.revision], [true, true, 200, "0.7.43", "fake"]);
  assert.deepEqual([answer.compatibility.verdict, answer.compatibility.missing], ["full", []]);
  assert.deepEqual([answer.storage.home, answer.archive.policy.mode, answer.outbox_pending], [home, "keep", 0]);
  // The service --host names is the one asked, and one that does not answer is said as such, never as a fit.
  const elsewhere = await said("--host", "http://127.0.0.1:9", "doctor");
  assert.deepEqual([elsewhere.service.host, elsewhere.service.reachable, elsewhere.service.healthy, elsewhere.service.status, elsewhere.compatibility.verdict], ["http://127.0.0.1:9", false, false, 0, "unknown"]);
  assert.match(elsewhere.service.problem, /^no answer from \/health, so the service's version and health were not read/);
  // A service that answers /health with 503 is reachable and not healthy, said apart from whether this client fits it,
  // which the descriptor still says. It was said as no answer (a check of 13 November 2026).
  fake.healthStatus = 503;
  const unwell = await said("doctor");
  assert.deepEqual([unwell.service.reachable, unwell.service.healthy, unwell.service.status, unwell.compatibility.verdict], [true, false, 503, "full"]);
  assert.match(unwell.service.problem, /^\/health answered 503 and not 200: the service is reachable and not healthy/);
  fake.healthStatus = 200;
  // What answers 200 at /health and is not aamio's health answer is reachable and not healthy, said with what came. A
  // 200 from a proxy or a login page was said as healthy, beside "answered 200 and not 200" (a check of 13 November 2026).
  // JSON null and a JSON string are answers in JSON, and were said as an empty body and as no JSON (a review of 13
  // November 2026): each of the seven is said as what it is.
  for (const [text, what] of [["<!doctype html><title>Sign in</title>", "a body that is not JSON"], ["", "an empty body"],
    ["null", "JSON that is not aamio's health answer"], ['""', "JSON that is not aamio's health answer"], ['"ok"', "JSON that is not aamio's health answer"],
    ["[]", "JSON that is not aamio's health answer"], ['{"status": "ok"}', "JSON that is not aamio's health answer"]]) {
    fake.healthText = text;
    const page = await said("doctor");
    assert.deepEqual([page.service.reachable, page.service.healthy, page.service.status, "version" in page.service], [true, false, 200, false], text);
    assert.equal(page.service.problem, `/health answered 200 with ${what}, so the service's version and health were not read: check that --host names the aamio service and not a page in front of it`);
  }
  fake.healthText = null;
  // A service that declares no capabilities is partial, never full.
  fake.descriptor = { version: "0.7.0" };
  assert.equal((await said("doctor")).compatibility.verdict, "partial");
});
