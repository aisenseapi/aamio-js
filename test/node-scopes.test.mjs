// Stage 3 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): scopes and the scoped board,
// against the fake aamio in memory. scopes.json is the file aamio-python and aamio-php keep: the same over the real
// service, with those two runtimes on the same home, is in code/php/tools/check-node-exchange.py. Every scope key
// here is made for the test, and each test looks for it in everything a caller is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Keys, isScopeKey, keyHash, newScopeKey, scopeAddress, sha256hex, threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime, seenRecord } from "../src/node-runtime.js";
import { SCOPE_NOT_SAVED, SCOPE_REMOVED_KEEP, checkAccess, checkScopeAdd, isRemovedShare, scopeAddPlan, sharedScopeName, usableScopes, withoutScopeKey } from "../src/node-scopes.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";
import { serveFake } from "./serve-fake.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage3-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const made = {};
  for (const name of names) {
    made[name] = join(root, name);
    await initIdentity(made[name]);
  }
  const open = async (home) => {
    const runtime = await NodeRuntime.open({ home, host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  return { ...made, root, open };
}

/** Two homes that are each other's partners, each with its inbox open: receiver in a, sender in b. */
async function pair(t, fake) {
  const { a: homeA, b: homeB, open, root } = await fixture(t, fake, "a", "b");
  const receiver = await open(homeA);
  const sender = await open(homeB);
  await receiver.partnerAdd("sender", sender.keys.public);
  await sender.partnerAdd("receiver", receiver.keys.public);
  await receiver.read();
  await sender.read();
  return { receiver, sender, homeA, homeB, open, root };
}

/** Saves of this file fail with ENOSPC, this many times. */
function failSaving(runtime, file, times = 1) {
  const real = runtime.saveJson.bind(runtime);
  runtime.saveJson = async (name, value) => {
    if (name === file && times > 0) {
      times--;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return real(name, value);
  };
}

/** Everything that leaves this process for the fake, as it is sent. */
function tap(fake) {
  const wire = [];
  const real = fake.fetch;
  fake.fetch = (url, init = {}) => {
    wire.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: typeof init.body === "string" ? init.body : "" });
    return real(url, init);
  };
  return wire;
}

/** One message put on a thread by hand: sealed or in the clear, signed by these keys or by nobody. */
async function put(fake, w, text, signer = null) {
  const headers = signer ? { "X-Key": signer.public, "X-Sig": signer.sign(threadSigningInput(w, text)) } : {};
  const answer = await fake.fetch(`${HOST}/${w}`, { method: "POST", body: text, headers });
  assert.equal(answer.status, 201, await answer.clone().text());
  return answer.json();
}

const onDisk = async (home, file) => JSON.parse(await readFile(join(home, file), "utf8"));
const sends = (fake) => fake.requests.filter((line) => line.startsWith("POST /") && !line.startsWith("POST /p/")).length;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const states = async (runtime) => (await runtime.attentionTaken()).map((note) => note.state);

const failed = async (act) => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  return null;
};

async function call(runtime, name, args) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const request = { jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } };
  await serveMcp({ home: runtime.home, version: "test", runtime, input: Readable.from([JSON.stringify(request) + "\n"]), output });
  return [JSON.parse(text.trim()), text];
}

// ------------------------------------------------------------------ what a scope is made of

test("the partner's part of a scope's name is made of what a name may hold", () => {
  const key = Keys.generate().public;
  for (const [partner, prefix] of [["Bea Ødegård", "Bea-deg-rd"], ["--x..y__", "x..y"], ["0", "0"], ["李明", null], ["a".repeat(30), "a".repeat(24)]]) {
    const first = prefix ?? keyHash(key).slice(0, 8);
    assert.equal(sharedScopeName({ name: partner, key }, "team"), `${first}.team`);
    assert.equal(sharedScopeName({ name: partner, key }, "t".repeat(64)), `${first}.${"t".repeat(64)}`.slice(0, 64));
  }
  for (const name of ["not a name", "", ".hidden", "x".repeat(65), "line\n", 7, null, undefined, ["team"]]) {
    assert.throws(() => sharedScopeName({ name: "alice", key }, name), { code: "invalid_scope" }, JSON.stringify(name));
  }
});

test("scopes.json is read entry by entry: what cannot be used is kept aside as it was", () => {
  const key = newScopeKey();
  const other = newScopeKey();
  const record = seenRecord("a".repeat(64), Keys.generate().public);
  const entries = [
    { name: "team", key, address: scopeAddress(key), taken_from: [record], a_field_from_later: 1 },
    // The name again, apart from upper and lower case: a name is where posts go, and it names one scope.
    { name: "TEAM", key: other, address: scopeAddress(other) },
    { name: "post-only", key: null, address: scopeAddress(other) },
    { name: "not a name", address: scopeAddress(other) },
    { name: "mismatch", key, address: scopeAddress(other) },
    { name: "typo", key: "short", address: scopeAddress(key) },
    { name: "no-address", key },
    "a line of text", null, 7, [],
    { removed_share: record },
    { removed_share: record, and: "more" },
    { removed_share: "not a record" },
  ];
  const { usable, aside, unusable } = usableScopes(entries);
  assert.deepEqual(usable, [entries[0], entries[2]]);
  assert.deepEqual(aside, entries.filter((entry) => !usable.includes(entry)), "in the order they stood");
  assert.equal(unusable, aside.length - 1, "a removed invitation is remembered among the rest, and is no typo to report");
  // The record of an invitation is the one a channel keeps of a message: signed, unsigned, or kept without its signer.
  for (const tag of [record, seenRecord("b".repeat(64), null), "c".repeat(64) + ":?"]) assert.equal(isRemovedShare({ removed_share: tag }), true, tag);
  for (const not of [{ removed_share: "c".repeat(64) }, { removed_share: record + "0" }, { removed_share: 7 }, { removed_share: record, name: "x" }, [record], null]) assert.equal(isRemovedShare(not), false, JSON.stringify(not));
});

test("a scope made elsewhere is added by its key or by its address, and a name is never taken by another address", () => {
  const key = newScopeKey();
  const address = scopeAddress(key);
  const other = newScopeKey();
  let [held, keep] = scopeAddPlan([], "team", null, address);
  assert.deepEqual([held, keep], [{ name: "team", key: null, address }, [{ name: "team", key: null, address }]]);
  // The key for a scope held to post only adds reading to it, under the name it has.
  let scopes = keep;
  [held, keep] = scopeAddPlan(scopes, "another-name", key);
  assert.deepEqual([held, keep], [{ name: "team", key, address }, [{ name: "team", key, address }]]);
  assert.deepEqual(scopes, [{ name: "team", key: null, address }], "and nothing is changed where it was planned");
  // Held already: nothing changes, whichever name asks, and an address never takes the key away.
  scopes = keep;
  assert.deepEqual(scopeAddPlan(scopes, "TEAM", key), [scopes[0], null]);
  assert.deepEqual(scopeAddPlan(scopes, "again", null, address), [scopes[0], null]);
  assert.throws(() => scopeAddPlan(scopes, "team", other), { code: "scope_exists", message: /there is a scope called team already, with another address\. Remove it or choose another name/ });

  const refused = [
    [["team"], /give the key, to read and post, or the address, to post only/],
    [["team", "short"], /a scope key is 26 to 64 characters of a-z and 0-9\. The 20 character address goes in address/],
    [["team", address], /a scope key is 26 to 64 characters/],
    [["team", 7], /a scope key is 26 to 64 characters/],
    [["team", null, key], /a scope address is the 20 characters of a-z and 2-7 that go on a post/],
    [["team", null, 7], /a scope address is the 20 characters/],
    [["team", key, scopeAddress(other)], /that key does not give that address, so one of the two is wrong/],
    [["a name", key], /a scope name is 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or a digit/],
    [["", key], /a scope name/], [["x".repeat(65), key], /a scope name/], [[".x", key], /a scope name/], [["x\n", key], /a scope name/], [[7, key], /a scope name/],
  ];
  for (const [args, why] of refused) {
    assert.throws(() => checkScopeAdd(...args), (error) => error.code === "invalid_scope" && why.test(error.message), JSON.stringify(args));
  }
  assert.equal(checkScopeAdd("team", key, address), address);
  for (const access of ["both", "", "READ", null, undefined, 1]) assert.throws(() => checkAccess(access), { code: "invalid_access" }, String(access));
  assert.equal(withoutScopeKey(`a board that sent ${key} back`, key), "a board that sent [scope key] back");
  assert.deepEqual(withoutScopeKey({ posts: [{ text: key, tags: [`x${key}y`] }], [key]: 1 }, key), { posts: [{ text: "[scope key]", tags: ["x[scope key]y"] }], "[scope key]": 1 });
});

// ------------------------------------------------------------------ kept in the home

test("a new scope keeps its key on this machine only, and survives a restart", async (t) => {
  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  let runtime = await open(home);
  const made = await runtime.scopeNew("team");
  assert.deepEqual(Object.keys(made), ["name", "address", "can_read"]);
  const [kept] = await onDisk(home, "scopes.json");
  assert.deepEqual([kept.name, kept.address, isScopeKey(kept.key), kept.key.length, scopeAddress(kept.key)], ["team", made.address, true, 26, made.address]);
  assert.ok(!JSON.stringify([made, runtime.scopeList(), runtime.whoami()]).includes(kept.key), "what a caller is given names the scope and never holds its key");
  assert.deepEqual(runtime.scopeList(), [{ name: "team", address: made.address, can_read: true }]);
  if (process.platform !== "win32") assert.equal((await stat(join(home, "scopes.json"))).mode & 0o777, 0o600, "the file that holds keys is the owner's alone");
  assert.equal(fake.requests.length, 0, "and nothing of it went anywhere");

  // A name is one scope's, apart from upper and lower case, and the command line alone is shown a key.
  assert.equal((await failed(() => runtime.scopeNew("TEAM"))).code, "scope_exists");
  assert.equal((await failed(() => runtime.scopeNew("not a name"))).code, "invalid_scope");
  assert.deepEqual(runtime.scopeKey("Team"), { name: "team", key: kept.key, address: made.address });
  assert.throws(() => runtime.scopeKey("missing"), { code: "unknown_scope", message: /no scope called missing here\. The scope list shows the ones this runtime holds/ });

  // A scope that could not be written down is not made, and says so.
  failSaving(runtime, "scopes.json");
  const unsaved = await failed(() => runtime.scopeNew("second"));
  assert.equal(unsaved.code, "not_saved");
  assert.match(unsaved.message, /scopes\.json could not be written \(ENOSPC\), so scope second was not made/);
  assert.deepEqual(runtime.scopeList(), [made]);
  assert.deepEqual(await onDisk(home, "scopes.json"), [kept]);

  await runtime.close();
  runtime = await open(home);
  assert.deepEqual(runtime.scopeList(), [made]);
  assert.deepEqual(await runtime.scopeRemove("TEAM"), { removed: "team" });
  assert.deepEqual(await onDisk(home, "scopes.json"), [], "made here and never taken from an invitation, so there is none to remember");
  assert.equal((await failed(() => runtime.scopeRemove("team"))).code, "unknown_scope");
});

test("a scopes file that cannot be read stops the runtime and is left as it was", async (t) => {
  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  for (const broken of ["not json {", "{}", "\"a text\"", "�\u0000 [", "[{\"name\": \"cut off\""]) {
    await writeFile(join(home, "scopes.json"), broken);
    const stopped = await failed(() => open(home));
    assert.equal(stopped?.code, "state_unreadable", broken);
    assert.match(stopped.message, /scopes\.json .* nothing is saved over it/);
    assert.equal(await readFile(join(home, "scopes.json"), "utf8"), broken, "a save is how a broken file becomes a lost one, with the key in it");
  }
  // An empty file is a file with no scopes in it.
  await writeFile(join(home, "scopes.json"), "");
  assert.deepEqual((await open(home)).scopeList(), []);
});

test("an entry this runtime cannot use stays in the file as it was, and is said", async (t) => {
  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  const key = newScopeKey();
  const typo = { name: "review team", key: newScopeKey(), address: "tooshort" };
  const record = seenRecord("a".repeat(64), Keys.generate().public);
  const file = [typo, { name: "team", key, address: scopeAddress(key) }, "a note to self", { removed_share: record }];
  await writeFile(join(home, "scopes.json"), JSON.stringify(file));
  const runtime = await open(home);
  assert.deepEqual(runtime.scopeList(), [{ name: "team", address: scopeAddress(key), can_read: true }]);
  const said = (await runtime.attentionTaken()).filter((note) => note.state === "scopes_unusable");
  assert.deepEqual(said.map((note) => note.what), ["scopes.json: 2 entries are not scopes this runtime can use, and stay in the file as they are"]);
  const made = await runtime.scopeNew("second");
  const after = await onDisk(home, "scopes.json");
  assert.deepEqual(after.slice(0, 2).map((scope) => scope.name), ["team", "second"]);
  assert.deepEqual(after.slice(2), [typo, "a note to self", { removed_share: record }], "the key in the entry with the typo is still there to be corrected");
  assert.equal(after[1].address, made.address);
});

// ------------------------------------------------------------------ the board, in a scope

test("an address alone posts but does not read until the key arrives", async (t) => {
  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  const writer = await open(home);
  const key = newScopeKey();
  const address = scopeAddress(key);
  assert.deepEqual(await writer.scopeAdd("review", { address }), { name: "review", address, can_read: false });
  const posted = await writer.boardPost({ kind: "need", title: "a draft", text: "ready for review", scope: "review" });
  assert.deepEqual([posted.scope, posted.post.scope], ["review", address]);
  const unread = await failed(() => writer.boardFind({ scope: "review" }));
  assert.equal(unread.code, "scope_write_only");
  assert.match(unread.message, /scope review is held to post only\. Reading it takes the key, which a partner can share with access read/);
  assert.throws(() => writer.scopeKey("review"), { code: "scope_write_only" });
  assert.equal(fake.finds.length, 0, "nothing was asked of the board");

  // The key adds reading, under the name the scope has here, whichever name it is given under.
  assert.deepEqual(await writer.scopeAdd("another-name", { key }), { name: "review", address, can_read: true });
  const page = await writer.boardFind({ scope: "REVIEW" });
  assert.deepEqual([page.posts.map((post) => post.id), page.scope, page.scope_name], [[posted.post.id], address, "review"]);
  assert.ok(!JSON.stringify(page).includes(key));
  // Another address under a name that is taken is refused, and the scope stays as it was.
  const taken = await failed(() => writer.scopeAdd("review", { key: newScopeKey() }));
  assert.equal(taken.code, "scope_exists");
  assert.deepEqual(writer.scopeList(), [{ name: "review", address, can_read: true }]);
  // A name that is not here costs nothing: no inbox is opened for a post that cannot be made.
  const before = fake.requests.length;
  assert.equal((await failed(() => writer.boardPost({ kind: "need", title: "x", text: "y", scope: "missing" }))).code, "unknown_scope");
  assert.equal((await failed(() => writer.boardFind({ scope: "missing" }))).code, "unknown_scope");
  assert.equal(fake.requests.length, before);
});

test("a post in a scope carries the address inside what is signed, is on no public listing, and the key goes only in the body of a find", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const member = await open(homeA);
  const outsider = await open(homeB);
  const wire = tap(fake);
  const made = await member.scopeNew("team");
  const key = member.scopeKey("team").key;
  const posted = await member.boardPost({ kind: "offer", title: "chapter 3", text: "the draft is ready", tags: ["chapter-03"], scope: "team" });
  await outsider.boardPost({ kind: "offer", title: "for everyone", text: "on the public board", tags: ["public"] });

  // Inside the signed body: the board checked the signature over these bytes, and nobody can post them without the address.
  const sent = wire.find((request) => request.method === "POST" && request.url === BOARD + "/" && request.body.includes("chapter 3"));
  assert.equal(JSON.parse(sent.body).scope, made.address);
  assert.equal(fake.posts.get(posted.post.id).scope, made.address);

  // Unlisted: not in a find of the public board, not served by its id, and not among the tags.
  assert.deepEqual((await outsider.boardFind()).posts.map((post) => post.title), ["for everyone"]);
  assert.equal(await outsider.boardGet(posted.post.id), null);
  assert.deepEqual((await outsider.boardTags()).tags.map((tag) => tag.tag), ["public"]);
  const blind = await failed(() => outsider.boardAnswer(posted.post.id, { text: "found it anyway" }));
  assert.equal(blind.code, "unknown_post");
  assert.match(blind.message, /A post in a scope is found with the scope's name/);

  // Read with the key, which names the scope it read, and holds the scope's posts and no others.
  const page = await member.boardFind({ scope: "team", tags: ["chapter-03"] });
  assert.deepEqual([page.posts.map((post) => post.id), page.scope, page.scope_name], [[posted.post.id], made.address, "team"]);
  assert.deepEqual((await member.boardFind({ scope: "team", kind: "need" })).posts, []);
  assert.deepEqual((await member.boardFind()).posts.map((post) => post.title), ["for everyone"], "and a find without the name reads the public board");

  // The key left this machine in the body of the finds of the scope, and in nothing else: no address, no header, no post.
  const withKey = wire.filter((request) => JSON.stringify(request).includes(key));
  assert.ok(withKey.length >= 2);
  for (const request of withKey) {
    assert.deepEqual([request.method, request.url], ["POST", BOARD + "/find"]);
    assert.equal(JSON.parse(request.body).scope_key, key);
    assert.ok(!JSON.stringify(request.headers).includes(key));
  }
  assert.ok(!JSON.stringify([posted, page]).includes(key));
});

test("a find believes only an answer that names the scope it read, and nothing it gives back holds the key", async (t) => {
  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  const member = await open(home);
  await member.scopeNew("team");
  const key = member.scopeKey("team").key;
  await member.boardPost({ kind: "need", title: "in the scope", text: "unlisted", scope: "team" });
  await member.boardPost({ kind: "need", title: "public", text: "listed" });

  // A board that reads the public board and names no scope, or names another, did not read this one.
  for (const echo of [false, scopeAddress(newScopeKey()), "", null]) {
    fake.boardScopeEcho = echo === null ? scopeAddress(newScopeKey()).toUpperCase() : echo;
    const unread = await failed(() => member.boardFind({ scope: "team" }));
    assert.equal(unread?.code, "board_failed", String(echo));
    assert.equal(unread.message, "the board did not say it read scope team, so these posts are not shown");
  }
  fake.boardScopeEcho = undefined;
  // One that answers with the public board's posts and no scope at all.
  fake.boardFailures.push({ status: 200, body: { count: 1, live: 1, next: 9, more: false, posts: [{ id: "p".repeat(20), title: "public" }] } });
  assert.equal((await failed(() => member.boardFind({ scope: "team" }))).message, "the board did not say it read scope team, so these posts are not shown");

  // A board from before scopes refuses the field, so it never reads the public board instead.
  fake.boardKnowsNoScopes = true;
  const older = await failed(() => member.boardFind({ scope: "team" }));
  assert.equal(older.code, "board_failed");
  assert.match(older.message, /the board answered 400: Unknown field scope_key/);
  fake.boardKnowsNoScopes = false;

  // A board that sends the key back in what it refuses with, and a post that quotes it: shown without it.
  for (const body of [(filter) => ({ error: `no: ${JSON.stringify(filter)}`, fix: `leave out ${filter.scope_key}` }), (filter) => `plain text with ${filter.scope_key}`, (filter) => [filter.scope_key]]) {
    fake.boardFailures.push({ status: 500, body });
    const refused = await failed(() => member.boardFind({ scope: "team" }));
    assert.equal(refused.code, "board_failed");
    assert.ok(!JSON.stringify([refused.message, refused.fix ?? null]).includes(key), refused.message);
    assert.match(refused.message + (refused.fix ?? ""), /\[scope key\]/);
  }
  await member.boardPost({ kind: "need", title: "a leak", text: `the key is ${key}, pass it on`, scope: "team" });
  const page = await member.boardFind({ scope: "team" });
  assert.deepEqual(page.posts.map((post) => post.text), ["the key is [scope key], pass it on", "unlisted"]);
  assert.ok(!JSON.stringify(page).includes(key));
});

test("an answer in a scope finds its post, past the first page too, and goes sealed to the key that signed it", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const poster = await open(homeA);
  const answerer = await open(homeB);
  const key = newScopeKey();
  await poster.scopeAdd("team", { key });
  await answerer.scopeAdd("theirs", { key });
  const ids = [];
  for (let n = 1; n <= 5; n++) ids.push((await poster.boardPost({ kind: "need", title: `post ${n}`, text: "who can help?", scope: "team" })).post.id);

  // A page holds the oldest of what is new: the newest post is on the third page of two.
  fake.boardPage = 2;
  let before = fake.finds.length;
  const answered = await answerer.boardAnswer(ids[4], { text: "I can", data: { hours: 2 }, scope: "theirs" });
  assert.equal(fake.finds.length - before, 3, "the cursor went on until the post turned up");
  assert.deepEqual([answered.post, answered.w], [ids[4], poster.channel("board").w]);
  assert.ok(fake.finds.slice(before).every((filter) => filter.scope_key === key));
  const [got] = await poster.read();
  assert.deepEqual([got.channel, got.body.post, got.body.text, got.verified, got.encrypted, got.from_key], ["board", ids[4], "I can", true, true, answerer.keys.public]);
  assert.ok(fake.threads.get(poster.channel("board").w).messages[0].sealed, "sealed to the key that signed the post, so only the poster reads it");

  // An id that is not in the scope, and one the pages run out before.
  before = fake.finds.length;
  const absent = await failed(() => answerer.boardAnswer("n".repeat(20), { text: "anyone?", scope: "theirs" }));
  assert.equal(absent.code, "unknown_post");
  assert.match(absent.message, /no live post with id n{20} in scope theirs/);
  assert.equal(fake.finds.length - before, 4, "every page was asked, and the one after the last came back empty");
  for (let n = 6; n <= 52; n++) ids.push((await poster.boardPost({ kind: "need", title: `post ${n}`, text: "who can help?", scope: "team" })).post.id);
  fake.boardPage = 1;
  before = fake.finds.length;
  assert.equal((await failed(() => answerer.boardAnswer(ids[51], { text: "too far", scope: "theirs" }))).code, "unknown_post");
  assert.equal(fake.finds.length - before, 50, "fifty pages, and then it stops");
  // A board whose cursor does not move is asked once.
  fake.boardFailures.push({ status: 200, body: { count: 1, live: 1, next: 0, more: true, posts: [{ id: "x".repeat(20) }], scope: scopeAddress(key) } });
  before = fake.finds.length;
  assert.equal((await failed(() => answerer.boardAnswer(ids[51], { text: "stuck", scope: "theirs" }))).code, "unknown_post");
  assert.equal(fake.finds.length - before, 1);
  assert.equal(sends(fake), 1, "and nothing was sent for a post that was not found");
});

// ------------------------------------------------------------------ shared with a partner

test("a scope is shared only with a partner and never with an address, sealed, and the partner keeps it under the sharer's name", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, homeB } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  await sender.scopeAdd("post-only", { address: scopeAddress(newScopeKey()) });

  // An address is learned from the board and from messages, so it can be anyone's: a post asking for a scope would get it.
  const inbox = receiver.channel("inbox").w;
  await sender.lookup(["receiver"]);
  assert.equal(sender.state.peers[inbox], receiver.keys.public, "even an address this runtime knows the key of");
  const before = sends(fake);
  for (const [args, code, why] of [
    [["team", inbox, "read"], "unknown_partner", /a scope is shared only with a partner in your address book, by name\. Never with an address, which can be anyone's/],
    [["team", "nobody", "read"], "unknown_partner", /only with a partner/],
    [["team", Keys.generate().public, "read"], "unknown_partner", /only with a partner/],
    [["team", "receiver", "both"], "invalid_access", /access is read, which gives the key to read and post, or write, which gives the address to post only/],
    [["missing", "receiver", "read"], "unknown_scope", /no scope called missing here/],
    [["post-only", "receiver", "read"], "scope_write_only", /scope post-only is held to post only, so it can only be shared with access write/],
  ]) {
    const refused = await failed(() => sender.scopeShare(...args));
    assert.equal(refused?.code, code, JSON.stringify(args));
    assert.match(refused.message, why);
  }
  assert.equal(sends(fake), before, "nothing was sent for any of them");

  const wire = tap(fake);
  const shared = await sender.scopeShare("team", "receiver", "read");
  assert.deepEqual([shared.to, shared.w, shared.scope, shared.access, typeof shared.message_id, shared.seq], ["receiver", inbox, "team", "read", "string", 1]);
  // Sealed: the key is in nothing that left this machine in the clear, and in no file of this home but scopes.json.
  assert.ok(!JSON.stringify([wire, shared]).includes(key));
  for (const file of ["outbox.json", "trace.json", "state.json", "partners.json"]) assert.ok(!(await readFile(join(homeB, file), "utf8")).includes(key), file);
  assert.deepEqual(sender.trace("receiver").sent.map((row) => row.fields), [["data", "from", "reply_to", "text"]]);

  const [got] = await receiver.read();
  assert.deepEqual(got.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address });
  assert.equal(got.body.text, "Scope team, shared to read and post.");
  assert.ok(!JSON.stringify([got, await receiver.attentionTaken(), receiver.scopeList(), receiver.trace("sender")]).includes(key), "whoever reads the message never sees the key in it");
  assert.deepEqual(receiver.scopeList(), [{ name: "sender.team", address: made.address, can_read: true }]);
  // In the file, with the invitation it came by, as aamio-python and aamio-php write it.
  assert.deepEqual(await onDisk(homeA, "scopes.json"), [{ name: "sender.team", key, address: made.address, taken_from: [seenRecord(got.sha256, sender.keys.public)] }]);
  for (const file of ["state.json", "trace.json"]) assert.ok(!(await readFile(join(homeA, file), "utf8")).includes(key), file);
  // And it works: what one posts in it the other finds.
  const posted = await receiver.boardPost({ kind: "need", title: "in the shared scope", text: "who reads this?", scope: "sender.team" });
  assert.deepEqual((await sender.boardFind({ scope: "team" })).posts.map((post) => post.id), [posted.post.id]);

  // Write gives the address alone, by the partner's key as well as by its name. The key later adds reading to the
  // scope held, under the name it has, with both invitations beside it.
  const drafts = await sender.scopeNew("drafts");
  const draftsKey = sender.scopeKey("drafts").key;
  await sender.scopeShare("drafts", receiver.keys.public, "write");
  const [second] = await receiver.read();
  assert.deepEqual(second.body.data.aamio_scope, { shared_as: "drafts", can_read: false, kept: true, name: "sender.drafts", address: drafts.address });
  assert.equal(second.body.text, "Scope drafts, shared to post only.");
  assert.equal((await failed(() => receiver.boardFind({ scope: "sender.drafts" }))).code, "scope_write_only");
  assert.ok(!(await readFile(join(homeA, "scopes.json"), "utf8")).includes(draftsKey), "a share to post only never held the key");
  await sender.scopeShare("drafts", "receiver", "read");
  const [third] = await receiver.read();
  assert.deepEqual(third.body.data.aamio_scope, { shared_as: "drafts", can_read: true, kept: true, name: "sender.drafts", address: drafts.address });
  const held = (await onDisk(homeA, "scopes.json")).find((scope) => scope.name === "sender.drafts");
  assert.deepEqual([held.key, held.taken_from], [draftsKey, [seenRecord(second.sha256, sender.keys.public), seenRecord(third.sha256, sender.keys.public)]]);
  // Shared again and held as it is: kept, and nothing more to write but the invitation.
  await sender.scopeShare("drafts", "receiver", "write");
  const [fourth] = await receiver.read();
  assert.deepEqual(fourth.body.data.aamio_scope, { shared_as: "drafts", can_read: true, kept: true, name: "sender.drafts", address: drafts.address });
  assert.ok(!JSON.stringify([second, third, fourth]).includes(draftsKey));
});

test("a partner cannot take a name before it is made here", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  await sender.scopeNew("review");
  await sender.scopeShare("review", "receiver", "read");
  const [got] = await receiver.read();
  assert.equal(got.body.data.aamio_scope.name, "sender.review");
  const made = await receiver.scopeNew("review");
  assert.notEqual(made.address, got.body.data.aamio_scope.address);
  assert.deepEqual(receiver.scopeList().map((scope) => scope.name), ["sender.review", "review"]);
  // Posts meant for review go to the scope made here, not where the partner reads.
  const posted = await receiver.boardPost({ kind: "need", title: "for my own review", text: "not for the partner", scope: "review" });
  assert.equal(posted.post.scope, made.address);
  assert.deepEqual((await sender.boardFind({ scope: "review" })).posts, []);
});

test("a scope from a stranger, in the clear or unsigned is not kept, and the key still leaves the message", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const key = newScopeKey();
  const stranger = Keys.generate();
  // A board inbox takes any signed key: a stranger reaches the runtime there.
  await receiver.boardPost({ kind: "need", title: "anyone", text: "write to me" });
  const board = receiver.channel("board").w;
  const inbox = receiver.channel("inbox").w;
  const share = (name) => JSON.stringify({ from: "abcd1234", text: `Scope ${name}`, data: { aamio_scope: { name, key } } });
  await put(fake, board, stranger.seal(receiver.keys.public, share("from-a-stranger")), stranger);
  await put(fake, inbox, share("in-the-clear"), sender.keys);
  // Unsigned, to an inbox that takes signed messages only: the service turns it away, so it never arrives.
  assert.equal((await fake.fetch(`${HOST}/${board}`, { method: "POST", body: share("unsigned"), headers: {} })).status, 403);
  // Sealed and signed by the partner, on the board inbox: the channel does not matter, who signed and whether it was sealed do.
  await put(fake, board, sender.keys.seal(receiver.keys.public, share("on-the-board")), sender.keys);
  // And one the service let through against the inbox's list, a stranger's, sealed: this runtime's own check keeps it out.
  const smuggled = stranger.seal(receiver.keys.public, share("against-the-list"));
  const thread = fake.threads.get(inbox);
  thread.messages.push({ seq: thread.messages.length + 1, at: fake.time, body: smuggled, sha256: sha256hex(smuggled), from: stranger.public, verified: true, sealed: true, sig: stranger.sign(threadSigningInput(inbox, smuggled)) });

  const got = await receiver.read();
  const said = got.map((m) => [m.channel, m.body.data?.aamio_scope?.shared_as, m.body.data?.aamio_scope?.kept]);
  assert.deepEqual(said, [["inbox", "in-the-clear", false], ["board", "from-a-stranger", false], ["board", "on-the-board", true]]);
  for (const m of got.slice(0, 2)) {
    assert.deepEqual(m.body.data.aamio_scope, { shared_as: m.body.data.aamio_scope.shared_as, can_read: true, kept: false, note: "not kept: a scope is only taken when it comes sealed from a partner in your address book" });
  }
  const notes = await receiver.attentionTaken();
  assert.deepEqual(notes.filter((note) => note.state === "kept_out").map((note) => note.channel), ["inbox"], "the one against the list is not handed over at all, and nothing of it is kept");
  assert.ok(!JSON.stringify([got, notes]).includes(key));
  assert.deepEqual(receiver.scopeList().map((scope) => scope.name), ["sender.on-the-board"]);
  for (const file of ["state.json", "trace.json"]) assert.ok(!(await readFile(join(homeA, file), "utf8")).includes(key), file);
});

test("a key in aamio_scope is taken out whatever its shape and wherever it sits, and a share that says too little is not kept", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  const key = newScopeKey();
  const inbox = receiver.channel("inbox").w;
  const bodies = [
    [{ text: "t", aamio_scope: { name: "team", key } }, null],
    [{ text: "t", data: { aamio_scope: key } }, "not kept: data.aamio_scope is an object with name, and key or address"],
    [{ text: "t", data: { aamio_scope: [key] } }, "not kept: data.aamio_scope is an object with name, and key or address"],
    [{ text: "t", aamio_scope: key, data: { aamio_scope: `team ${key}` } }, "not kept: data.aamio_scope is an object with name, and key or address"],
    [{ text: "t", data: { aamio_scope: { name: "not a name", key } } }, "not kept: a scope name is 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or a digit"],
    [{ text: "t", data: { aamio_scope: { key } } }, "not kept: a scope name is 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or a digit"],
    [{ text: "t", data: { aamio_scope: { name: "team", key: key.slice(0, 20) } } }, "not kept: a scope key is 26 to 64 characters of a-z and 0-9. The 20 character address goes in address"],
    [{ text: "t", data: { aamio_scope: { name: "team", key: [key] } } }, "not kept: a scope key is 26 to 64 characters of a-z and 0-9. The 20 character address goes in address"],
    [{ text: "t", data: { aamio_scope: { name: "team" } } }, "not kept: give the key, to read and post, or the address, to post only"],
    [{ text: "t", data: { aamio_scope: { name: "team", address: key } } }, "not kept: a scope address is the 20 characters of a-z and 2-7 that go on a post"],
    // The key decides when both are given, as in aamio-python: the address beside it is not looked at.
    [{ text: "t", data: { aamio_scope: { name: "both", key, address: "not an address" } } }, true],
  ];
  for (const [body] of bodies) await put(fake, inbox, sender.keys.seal(receiver.keys.public, JSON.stringify(body)), sender.keys);
  const got = await receiver.read();
  assert.equal(got.length, bodies.length);
  for (const [n, [body, note]] of bodies.entries()) {
    if ("aamio_scope" in body) assert.deepEqual(got[n].body.aamio_scope, { kept: false, note: "not kept: a scope is shared in data.aamio_scope" });
    if (note === true) assert.equal(got[n].body.data.aamio_scope.kept, true);
    else if (note !== null) assert.deepEqual([got[n].body.data.aamio_scope.kept, got[n].body.data.aamio_scope.note], [false, note], JSON.stringify(body).replace(key, "KEY"));
  }
  assert.ok(!JSON.stringify(got).includes(key.slice(0, 20)), "not the key, and not a part of it");
  assert.deepEqual(receiver.scopeList().map((scope) => scope.name), ["sender.both"]);
});

// ------------------------------------------------------------------ removed stays removed

test("the same message again does not bring a removed scope back, and a new invitation is taken", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  const shared = await sender.scopeShare("team", "receiver", "read");
  const [first] = await receiver.read();
  assert.equal(first.body.data.aamio_scope.kept, true);
  const record = seenRecord(first.sha256, sender.keys.public);
  assert.deepEqual(await receiver.scopeRemove("sender.team"), { removed: "sender.team" });
  // Remembered in the form the other runtimes read and write: one entry, one field, the record of the message.
  assert.deepEqual(await onDisk(homeA, "scopes.json"), [{ removed_share: record }]);
  assert.match(record, /^[0-9a-f]{64}:[0-9a-f]{16}$/);

  // The stored bytes once more, as a retry sends them.
  const inbox = receiver.channel("inbox").w;
  await put(fake, inbox, sender.outbox[shared.message_id].envelope, sender.keys);
  const [again] = await receiver.read();
  assert.deepEqual([again.replay, again.body.data.aamio_scope], [true, { shared_as: "team", can_read: true, kept: false, note: "not kept again: this message arrived before, and a scope removed since stays removed" }]);
  assert.deepEqual(receiver.scopeList(), []);
  assert.ok(!JSON.stringify(again).includes(key));

  // The same bytes on a thread opened again, where the channel no longer knows them: the invitation itself is remembered.
  receiver.channel("inbox").seen = [];
  receiver.channel("inbox").seen_from = [];
  await put(fake, inbox, sender.outbox[shared.message_id].envelope, sender.keys);
  const [third] = await receiver.read();
  assert.deepEqual([third.replay, third.body.data.aamio_scope], [false, { shared_as: "team", can_read: true, kept: false, note: "not kept again: this invitation was taken here before, and its scope was removed since. A scope removed stays removed: ask for it to be shared again" }]);
  assert.deepEqual(receiver.scopeList(), []);

  // A new invitation is another message, and is taken.
  await sender.scopeShare("team", "receiver", "read");
  const [fresh] = await receiver.read();
  assert.deepEqual(fresh.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address });
  const file = await onDisk(homeA, "scopes.json");
  assert.deepEqual(file, [{ name: "sender.team", key, address: made.address, taken_from: [seenRecord(fresh.sha256, sender.keys.public)] }, { removed_share: record }]);
});

test("an invitation read again after a read that could not be written down keeps the scope once, and a scope removed in between stays removed", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  await sender.scopeShare("team", "receiver", "read");
  // The scope is written before the cursor is. The cursor cannot be written: nothing is handed over, and the scope is held.
  failSaving(receiver, "state.json");
  assert.deepEqual(await receiver.read(), []);
  assert.deepEqual(await states(receiver), ["not_saved"]);
  assert.deepEqual(receiver.scopeList(), [{ name: "sender.team", address: made.address, can_read: true }]);
  // Read again, the message is handed over for the first time, and says what is true: held, and recorded once.
  const [got] = await receiver.read();
  assert.deepEqual([got.replay, got.body.data.aamio_scope], [false, { shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address }]);
  assert.deepEqual((await onDisk(homeA, "scopes.json"))[0].taken_from, [seenRecord(got.sha256, sender.keys.public)]);

  // The same with the scope removed between the two reads: the invitation is remembered with the removal.
  await sender.scopeNew("second");
  const secondKey = sender.scopeKey("second").key;
  await sender.scopeShare("second", "receiver", "read");
  failSaving(receiver, "state.json");
  assert.deepEqual(await receiver.read(), []);
  assert.deepEqual(receiver.scopeList().map((scope) => scope.name), ["sender.team", "sender.second"]);
  await receiver.scopeRemove("sender.second");
  const [late] = await receiver.read();
  assert.deepEqual([late.replay, late.body.data.aamio_scope.kept], [false, false]);
  assert.match(late.body.data.aamio_scope.note, /^not kept again: this invitation was taken here before, and its scope was removed since/);
  assert.deepEqual(receiver.scopeList().map((scope) => scope.name), ["sender.team"]);
  assert.ok(!JSON.stringify([got, late]).includes(key) && !JSON.stringify(late).includes(secondKey));
});

test("scopes.json as the other runtimes wrote it is read as it is, and remembers the newest removed invitations and no more", async (t) => {
  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  const key = newScopeKey();
  const signer = Keys.generate().public;
  const record = (n) => seenRecord(n.toString(16).padStart(64, "0"), signer);
  // Three hundred remembered, a note in the middle of them, and a scope that came by two invitations.
  const removed = Array.from({ length: 300 }, (_, n) => ({ removed_share: record(n) }));
  const file = [...removed.slice(0, 150), "a note to self", ...removed.slice(150), { name: "alice.team", key, address: scopeAddress(key), taken_from: [record(1000), record(7), record(1001), "not a record"], added_by: "another runtime" }];
  await writeFile(join(home, "scopes.json"), JSON.stringify(file));
  const runtime = await open(home);
  assert.deepEqual(runtime.scopeList(), [{ name: "alice.team", address: scopeAddress(key), can_read: true }]);
  assert.deepEqual(await states(runtime), ["scopes_unusable"], "the note to self is said, the remembered invitations are not");
  await runtime.scopeRemove("alice.team");
  const after = await onDisk(home, "scopes.json");
  const kept = after.filter(isRemovedShare).map((entry) => entry.removed_share);
  assert.equal(kept.length, SCOPE_REMOVED_KEEP);
  // Two new ones, since one of the three was remembered already: the oldest forty-six went.
  assert.deepEqual(kept, [...Array.from({ length: 254 }, (_, n) => record(n + 46)), record(1000), record(1001)]);
  assert.deepEqual(after.filter((entry) => !isRemovedShare(entry)), ["a note to self"]);
  assert.deepEqual(runtime.scopeList(), []);
});

// ------------------------------------------------------------------ when the file cannot be written

test("a share that cannot be saved is not kept, says so, and the rest of the batch arrives", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  await sender.scopeShare("team", "receiver", "read");
  await sender.send("receiver", { text: "and the next message" });
  failSaving(receiver, "scopes.json");
  const got = await receiver.read();
  assert.deepEqual(got.map((m) => m.seq), [1, 2]);
  // On the message in the form it was weighed at, and why in attention.
  assert.deepEqual(got[0].body.data.aamio_scope, { shared_as: "team", can_read: true, kept: false, note: SCOPE_NOT_SAVED });
  const said = (await receiver.attentionTaken()).filter((note) => note.state === "scope_not_saved");
  assert.deepEqual(said.map((note) => [note.channel, note.what]), [["inbox", "message 1 shared scope team, and scopes.json could not be written: ENOSPC: no space left on device. The scope is not kept."]]);
  assert.deepEqual(receiver.scopeList(), []);
  assert.equal(existsSync(join(homeA, "scopes.json")), false);
  assert.ok(!JSON.stringify([got, said]).includes(key));
  // The message was handed over, so the same bytes again are a replay: the partner shares it again, as the note asks.
  await sender.scopeShare("team", "receiver", "read");
  const [again] = await receiver.read();
  assert.deepEqual(again.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address });
});

test("a share is weighed in the longer of the forms it can end in, and one that does not fit the budget is not taken", async (t) => {
  // What each of the two messages weighs as it is handed over, measured once on a home of its own.
  const measure = async () => {
    const fake = new FakeAamio();
    // A service without read limits sends everything, so the budget that holds is the one kept here.
    fake.ignoreBudget = true;
    const { receiver, sender, homeA } = await pair(t, fake);
    const made = await sender.scopeNew("team");
    await sender.send("receiver", { text: "an ordinary message first" });
    await sender.scopeShare("team", "receiver", "read");
    return { fake, receiver, sender, homeA, made };
  };
  const first = await measure();
  const whole = await first.receiver.read();
  assert.deepEqual(whole.map((m) => m.body.data?.aamio_scope?.kept), [undefined, true]);
  // As a message is weighed: with the archive's mark at its longer value, false.
  const [plain, kept] = whole.map((m) => bytes({ ...m, archived: false }));
  const unsaved = bytes({ ...whole[1], archived: false, body: { ...whole[1].body, data: { aamio_scope: { shared_as: "team", can_read: true, kept: false, note: SCOPE_NOT_SAVED } } } });
  assert.ok(unsaved < kept, "the form that says it could not be saved is the shorter one");

  // One byte short of both, on a home where scopes.json cannot be written. Weighed as it would end, the shorter form
  // fits and the share was handed over; weighed at the longer, it stays at the service, and nothing is taken of it.
  const second = await measure();
  failSaving(second.receiver, "scopes.json", 99);
  const budget = plain + kept - 1;
  assert.ok(plain + unsaved <= budget);
  const got = await second.receiver.read({ maxBytes: budget });
  assert.deepEqual(got.map((m) => m.body.text), ["an ordinary message first"]);
  assert.deepEqual(await states(second.receiver), ["more"], "nothing is said of a share that was not taken");
  assert.equal(second.receiver.channel("inbox").after, 1);
  assert.deepEqual(second.receiver.scopeList(), []);
  // With room for it, and still no disk: handed over within the budget it was weighed against.
  const [late] = await second.receiver.read({ maxBytes: kept });
  assert.deepEqual(late.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: false, note: SCOPE_NOT_SAVED });
  assert.ok(bytes(late) <= kept);
  assert.deepEqual(await states(second.receiver), ["scope_not_saved"]);

  // And with a disk: the budget that fits the share exactly hands it over, kept.
  const third = await measure();
  const both = await third.receiver.read({ maxBytes: plain + kept });
  assert.deepEqual(both.map((m) => m.body.data?.aamio_scope?.kept), [undefined, true]);
  assert.ok(bytes(both[0]) + bytes(both[1]) <= plain + kept);
});

test("an invitation for a scope held already is recorded with it, and one that cannot be recorded is said in attention", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  // Held from before, by hand, under a name of this home's own.
  await receiver.scopeAdd("mine", { key });
  await sender.scopeShare("team", "receiver", "read");
  const [got] = await receiver.read();
  assert.deepEqual(got.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: true, name: "mine", address: made.address });
  assert.deepEqual(await onDisk(homeA, "scopes.json"), [{ name: "mine", key, address: made.address, taken_from: [seenRecord(got.sha256, sender.keys.public)] }]);

  // The record cannot be written: the scope is shown as it is held, and attention says what was not recorded.
  await sender.scopeShare("team", "receiver", "write");
  failSaving(receiver, "scopes.json");
  const [second] = await receiver.read();
  assert.deepEqual(second.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: true, name: "mine", address: made.address });
  const said = (await receiver.attentionTaken()).filter((note) => note.state === "scope_share_not_recorded");
  assert.equal(said.length, 1);
  assert.equal(said[0].what, "message 2 shared scope team, which is held here already as mine, and the invitation could not be recorded with it in scopes.json: ENOSPC: no space left on device. The scope stays as it is. Removing it will not remember this invitation, so the same message read again after that would bring the scope back.");
  assert.equal((await onDisk(homeA, "scopes.json"))[0].taken_from.length, 1);
  assert.ok(!JSON.stringify([got, second, said]).includes(key));
});

test("when neither the scope nor the cursor can be written, nothing is handed over, nothing is said of the share, and the next read keeps it", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  await sender.scopeShare("team", "receiver", "read");
  failSaving(receiver, "scopes.json");
  failSaving(receiver, "state.json");
  assert.deepEqual(await receiver.read(), []);
  assert.deepEqual(await states(receiver), ["not_saved"], "a share that was not handed over is not said to have been lost");
  assert.deepEqual(receiver.scopeList(), []);
  assert.equal(receiver.channel("inbox").after, 0);
  const [got] = await receiver.read();
  assert.deepEqual([got.replay, got.body.data.aamio_scope], [false, { shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address }]);
  assert.deepEqual(await states(receiver), []);
  assert.equal((await onDisk(homeA, "scopes.json")).length, 1);
});

test("a scope kept from a share is there after a restart, as it was, and a change that cannot be written changes nothing", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  await sender.scopeShare("team", "receiver", "read");
  await receiver.read();
  const before = await readFile(join(homeA, "scopes.json"), "utf8");
  const listed = receiver.scopeList();
  await receiver.close();
  let again = await open(homeA);
  assert.deepEqual(again.scopeList(), listed);
  assert.deepEqual(await again.read(), [], "and the message that brought it is not read again");
  assert.equal(await readFile(join(homeA, "scopes.json"), "utf8"), before, "opening a home and reading in it writes nothing to the file");

  // Adding, and removing: the file as it was, the list as it was, and what went wrong said.
  const other = newScopeKey();
  failSaving(again, "scopes.json");
  const unkept = await failed(() => again.scopeAdd("elsewhere", { key: other }));
  assert.equal(unkept.code, "not_saved");
  assert.match(unkept.message, /scopes\.json could not be written \(ENOSPC\), so scope elsewhere was not kept/);
  assert.ok(!unkept.message.includes(other));
  failSaving(again, "scopes.json");
  const still = await failed(() => again.scopeRemove("sender.team"));
  assert.equal(still.code, "not_saved");
  assert.match(still.message, /so scope sender\.team is still held/);
  assert.deepEqual(again.scopeList(), listed);
  assert.equal(await readFile(join(homeA, "scopes.json"), "utf8"), before);
  await again.close();
  again = await open(homeA);
  assert.deepEqual(again.scopeList(), listed);
  // And it still reads the scope: the key is the one that was shared.
  const posted = await sender.boardPost({ kind: "need", title: "after the restart", text: "still there?", scope: "team" });
  assert.deepEqual((await again.boardFind({ scope: "sender.team" })).posts.map((post) => post.id), [posted.post.id]);
  assert.equal(made.address, listed[0].address);
});

test("a name a share would take that is another scope's here is not taken, and the message says which", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  // Made here by hand, under the very name a share from this partner would get.
  const mine = await receiver.scopeNew("sender.team");
  await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  await sender.scopeShare("team", "receiver", "read");
  const [got] = await receiver.read();
  assert.deepEqual(got.body.data.aamio_scope, { shared_as: "team", can_read: true, kept: false, note: "not kept: there is a scope called sender.team already, with another address. Remove it or choose another name" });
  assert.deepEqual(receiver.scopeList(), [mine], "the scope made here is the one the name stands for");
  assert.ok(!JSON.stringify(got).includes(key));
});

test("two channels in one read: a share on the one whose cursor cannot be written waits, and what the other gave is handed over", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA } = await pair(t, fake);
  const made = await sender.scopeNew("team");
  const posted = await receiver.boardPost({ kind: "need", title: "anyone", text: "write to me" });
  await sender.scopeShare("team", "receiver", "read");
  await sender.boardAnswer(posted.post.id, { text: "on the board inbox" });
  // The inbox is read first, and its cursor is the write that fails. The board inbox's write then saves the whole state.
  failSaving(receiver, "state.json");
  const first = await receiver.read();
  assert.deepEqual(first.map((m) => [m.channel, m.body.text]), [["board", "on the board inbox"]]);
  assert.deepEqual(await states(receiver), ["not_saved"]);
  const saved = await onDisk(homeA, "state.json");
  assert.deepEqual(saved.channels.map((channel) => [channel.label, channel.after]), [["inbox", 0], ["board", 1]], "the state the second write saved holds the first channel as it was");
  // The scope was written before the cursor was tried, and the share comes with the next read, once.
  assert.deepEqual(receiver.scopeList(), [{ name: "sender.team", address: made.address, can_read: true }]);
  const second = await receiver.read();
  assert.deepEqual(second.map((m) => [m.channel, m.replay, m.body.data.aamio_scope.kept]), [["inbox", false, true]]);
  assert.deepEqual(await receiver.read(), []);
  assert.equal((await onDisk(homeA, "scopes.json"))[0].taken_from.length, 1);
});

// ------------------------------------------------------------------ over the local server

test("over MCP the tools speak in names and never hand out a key", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, homeB } = await pair(t, fake);
  const transcript = [];
  const tool = async (runtime, name, args = {}) => {
    const [answer, text] = await call(runtime, name, args);
    transcript.push(text);
    return answer.error ? answer : answer.result;
  };
  const tools = (await tool(sender, "tools/list")).tools;
  assert.equal(tools.length, 24);
  for (const name of ["aamio_scopes", "aamio_scope_new", "aamio_scope_add", "aamio_scope_share", "aamio_scope_remove"]) assert.ok(tools.some((entry) => entry.name === name), name);
  assert.ok(!tools.some((entry) => /scope_key|key$/.test(entry.name)), "no tool shows a key: that is the command line's alone");
  for (const name of ["aamio_board_post", "aamio_board_find", "aamio_board_answer"]) assert.equal(tools.find((entry) => entry.name === name).inputSchema.properties.scope.type, "string", name);

  const made = (await tool(sender, "aamio_scope_new", { name: "team" })).structuredContent;
  assert.deepEqual(Object.keys(made), ["name", "address", "can_read"]);
  const elsewhere = newScopeKey();
  const added = (await tool(sender, "aamio_scope_add", { name: "elsewhere", key: elsewhere })).structuredContent;
  assert.deepEqual(added, { name: "elsewhere", address: scopeAddress(elsewhere), can_read: true });
  assert.deepEqual((await tool(sender, "aamio_scopes")).structuredContent, { scopes: [made, added] });
  const shared = await tool(sender, "aamio_scope_share", { name: "team", to: "receiver", access: "read" });
  assert.equal(shared.isError, false, JSON.stringify(shared));
  assert.deepEqual([shared.structuredContent.scope, shared.structuredContent.access, shared.structuredContent.to], ["team", "read", "receiver"]);

  const read = (await tool(receiver, "aamio_read")).structuredContent;
  assert.deepEqual(read.messages[0].body.data.aamio_scope, { shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address });
  const posted = (await tool(receiver, "aamio_board_post", { kind: "need", title: "in the scope", text: "who reads this?", scope: "sender.team" })).structuredContent;
  assert.equal(posted.scope, "sender.team");
  assert.deepEqual((await tool(sender, "aamio_board_find", {})).structuredContent.posts, [], "on no public listing");
  const found = (await tool(sender, "aamio_board_find", { scope: "team" })).structuredContent;
  assert.deepEqual([found.posts.map((post) => post.id), found.scope_name], [[posted.post.id], "team"]);
  const answered = await tool(sender, "aamio_board_answer", { post: posted.post.id, text: "I do", scope: "team" });
  assert.equal(answered.isError, false, JSON.stringify(answered));
  assert.deepEqual((await tool(receiver, "aamio_read")).structuredContent.messages.map((m) => [m.channel, m.body.text]), [["board", "I do"]]);
  const blind = await tool(sender, "aamio_board_answer", { post: posted.post.id, text: "without the name" });
  assert.deepEqual([blind.isError, blind.structuredContent.error_code], [true, "unknown_post"]);
  assert.deepEqual((await tool(sender, "aamio_scope_remove", { name: "elsewhere" })).structuredContent, { removed: "elsewhere" });

  // What is wrong is said, in the answer or as a protocol error, and the next call is answered.
  for (const [name, args, code] of [
    ["aamio_scope_new", { name: "not a name" }, "invalid_scope"], ["aamio_scope_new", { name: "TEAM" }, "scope_exists"], ["aamio_scope_add", { name: "x" }, "invalid_scope"],
    ["aamio_scope_add", { name: "x", key: "short" }, "invalid_scope"], ["aamio_scope_share", { name: "team", to: receiver.channel("inbox").w, access: "read" }, "unknown_partner"],
    ["aamio_scope_remove", { name: "missing" }, "unknown_scope"], ["aamio_board_find", { scope: "missing" }, "unknown_scope"], ["aamio_board_post", { kind: "need", title: "x", text: "y", scope: "missing" }, "unknown_scope"],
  ]) {
    const refused = await tool(sender, name, args);
    assert.deepEqual([refused.isError, refused.structuredContent.error_code], [true, code], `${name} ${JSON.stringify(args)}`);
  }
  for (const [name, args] of [["aamio_scope_new", {}], ["aamio_scope_new", { name: 7 }], ["aamio_scope_share", { name: "team", to: "receiver", access: "both" }], ["aamio_scope_share", { name: "team", to: "receiver" }], ["aamio_scopes", { name: "team" }], ["aamio_scope_add", { name: "x", key: elsewhere, show: true }], ["aamio_board_find", { scope: 7 }]]) {
    assert.equal((await tool(sender, name, args)).error?.code, -32602, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual((await tool(sender, "aamio_scopes")).structuredContent, { scopes: [made] });

  // Nothing the server said holds a key: not the one made here, not the one a caller passed in, not on either side.
  const keys = [...(await onDisk(homeB, "scopes.json")), ...(await onDisk(homeA, "scopes.json"))].map((scope) => scope.key).filter(Boolean);
  assert.ok(keys.length >= 2);
  for (const key of [...keys, elsewhere]) assert.ok(!transcript.join("\n").includes(key));
});

// ------------------------------------------------------------------ on the command line

test("on the command line: a scope is made, shared, posted in, found, answered and removed, and only scope key shows a key", async (t) => {
  const fake = new FakeAamio({ now: Math.floor(Date.now() / 1000) });
  const { receiver, sender, homeA, homeB } = await pair(t, fake);
  await sender.close();
  await receiver.close();
  const { cli } = await serveFake(t, fake);
  const output = [];
  const said = (run) => {
    assert.equal(run.status, 0, run.stderr);
    output.push(run.stdout, run.stderr);
    return JSON.parse(run.stdout);
  };
  const made = said(await cli(homeB, "scope", "new", "team"));
  assert.deepEqual(Object.keys(made), ["name", "address", "can_read"]);
  assert.deepEqual(said(await cli(homeB, "scope", "list")), { scopes: [made] });
  const shared = said(await cli(homeB, "scope", "share", "team", "receiver", "--access", "read"));
  assert.deepEqual([shared.to, shared.scope, shared.access], ["receiver", "team", "read"]);

  const read = said(await cli(homeA, "read"));
  assert.deepEqual(read.messages.map((m) => m.body.data.aamio_scope), [{ shared_as: "team", can_read: true, kept: true, name: "sender.team", address: made.address }]);
  assert.deepEqual(said(await cli(homeA, "scope", "list")), { scopes: [{ name: "sender.team", address: made.address, can_read: true }] });
  const posted = said(await cli(homeA, "board", "post", "need", "a draft", "ready for review", "--scope", "sender.team"));
  assert.equal(posted.scope, "sender.team");
  assert.deepEqual(said(await cli(homeB, "board", "find")).posts, [], "on no public listing");
  const found = said(await cli(homeB, "board", "find", "--scope", "team"));
  assert.deepEqual([found.posts.map((post) => post.id), found.scope_name], [[posted.post.id], "team"]);
  said(await cli(homeB, "board", "answer", posted.post.id, "looks good", "--scope", "team"));
  assert.deepEqual(said(await cli(homeA, "read")).messages.map((m) => [m.channel, m.body.text, m.body.post]), [["board", "looks good", posted.post.id]]);

  // By its address a scope is held to post only. What is wrong is said as JSON on standard output, as aamio-python and
  // aamio-php say it, with nothing on standard error.
  const other = scopeAddress(newScopeKey());
  assert.deepEqual(said(await cli(homeB, "scope", "add", "elsewhere", "--address", other)), { name: "elsewhere", address: other, can_read: false });
  for (const [args, why] of [[["scope", "key", "elsewhere"], /scope elsewhere is held to post only, so there is no key here/], [["scope", "new", "TEAM"], /there is a scope called TEAM already/], [["scope", "key", "missing"], /no scope called missing here/],
    [["board", "find", "--scope", "elsewhere"], /held to post only\. Reading it takes the key/], [["scope", "share", "team", "nobody", "--access", "read"], /only with a partner in your address book/]]) {
    const refused = await cli(homeB, ...args);
    assert.deepEqual([refused.status, refused.stderr], [1, ""], args.join(" "));
    const told = JSON.parse(refused.stdout);
    assert.equal(typeof told.error_code, "string", args.join(" "));
    assert.match(told.error, why);
    output.push(refused.stdout, refused.stderr);
  }

  // Nothing above showed a key. The one command that does is asked for one by a person, to pass on by hand.
  const keys = [...(await onDisk(homeB, "scopes.json")), ...(await onDisk(homeA, "scopes.json"))].map((scope) => scope.key).filter(Boolean);
  assert.equal(keys.length, 2);
  for (const key of keys) assert.ok(!output.join("\n").includes(key));
  const shown = JSON.parse((await cli(homeB, "scope", "key", "team")).stdout);
  assert.deepEqual([shown.name, shown.address, scopeAddress(shown.key)], ["team", made.address, made.address]);

  assert.deepEqual(said(await cli(homeB, "scope", "remove", "team")), { removed: "team" });
  assert.deepEqual(said(await cli(homeB, "scope", "list")), { scopes: [{ name: "elsewhere", address: other, can_read: false }] });
});

test("on the command line: what can be seen to be wrong about a scope is refused before the home is opened or made", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage3-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unused = join(root, "never-made");
  const key = newScopeKey();
  const wrong = [
    ["scope"], ["scope", "nothing"], ["scope", "new"], ["scope", "new", "not a name"], ["scope", "new", "a", "b"], ["scope", "list", "extra"], ["scope", "key"], ["scope", "remove"],
    ["scope", "add", "x"], ["scope", "add", "x", "--key", "short"], ["scope", "add", "x", "--address", "short"], ["scope", "add", "x", "--key", key, "--address", scopeAddress(newScopeKey())], ["scope", "add", "not a name", "--key", key],
    ["scope", "share", "a"], ["scope", "share", "a", "b"], ["scope", "share", "a", "b", "--access", "both"], ["scope", "share", "not a name", "b", "--access", "read"], ["scope", "share", "a", "b", "--access"],
    ["board", "post", "need", "t", "x", "--scope", "not a name"], ["board", "find", "--scope", ""], ["board", "answer", "p", "t", "--scope", "a b"], ["board", "tags", "--scope", "team"],
  ];
  for (const args of wrong) {
    const refused = spawnSync(process.execPath, [bin, "--home", unused, ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9" } });
    assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stderr}`);
    assert.equal(refused.stdout, "");
    assert.ok(!refused.stderr.includes(key), "and a key typed wrongly is not written back");
  }
  assert.equal(existsSync(unused), false);
});
