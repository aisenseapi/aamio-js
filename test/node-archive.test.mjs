// Stage 4 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): the archive. What was read, sent
// and posted is kept decrypted in archive/, one file per channel and one record per line, under the policy in
// config.json, as aamio-python and aamio-php keep it: keep when the home has made no choice, off, or so many days.
// Against the fake aamio in memory. The same files read by the other two runtimes are in
// code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keys, newScopeKey, sha256hex } from "../src/aamio.js";
import { DEFAULT_POLICY, appendRecord, archiveName, archiveNames, archiveStatus, archivedRecords, describePolicy, isSafeLabel, parsePolicy, pruneArchive, readPolicy } from "../src/node-archive.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage4-archive-"));
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
  const open = async (home, options = {}) => {
    const runtime = await NodeRuntime.open({ home, host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time, ...options });
    opened.push(runtime);
    return runtime;
  };
  return { ...made, root, open };
}

/** Two homes that are each other's partners, each with its inbox open: receiver in a, sender in b. */
async function pair(t, fake, options = {}) {
  const { a: homeA, b: homeB, open, root } = await fixture(t, fake, "a", "b");
  const receiver = await open(homeA, options);
  const sender = await open(homeB, options);
  await receiver.partnerAdd("sender", sender.keys.public);
  await sender.partnerAdd("receiver", receiver.keys.public);
  await receiver.read();
  await sender.read();
  return { receiver, sender, homeA, homeB, open, root };
}

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

const lines = async (home, name) => (existsSync(join(home, "archive", name + ".jsonl")) ? (await readFile(join(home, "archive", name + ".jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const states = async (runtime) => (await runtime.attentionTaken()).map((note) => note.state);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const failed = async (act) => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  return null;
};

// ------------------------------------------------------------------ the policy and the files

test("the archive's policy is keep, off or so many days, read from config.json as the other runtimes write it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aamio-node-stage4-policy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await readPolicy(home), { mode: "keep", days: null, max_mb: null }, "no file means keep, which is what a home without a choice has");
  const written = [
    [{ archive: { mode: "off", days: null, max_mb: null } }, { mode: "off", days: null, max_mb: null }],
    [{ archive: { mode: "days", days: 30, max_mb: 2.5 } }, { mode: "days", days: 30, max_mb: 2.5 }],
    [{ archive: { mode: "keep", days: null, max_mb: 10 }, another: "choice" }, { mode: "keep", days: null, max_mb: 10 }],
    // days with no number of days is no choice of days, and one nobody can use is none at all.
    [{ archive: { mode: "days", days: 0 } }, DEFAULT_POLICY], [{ archive: { mode: "days", days: "30" } }, DEFAULT_POLICY], [{ archive: { mode: "forever" } }, DEFAULT_POLICY],
    [{ archive: "off" }, DEFAULT_POLICY], [{ archive: { mode: "keep", max_mb: -1 } }, DEFAULT_POLICY], [["off"], DEFAULT_POLICY], ["not json {", DEFAULT_POLICY],
  ];
  for (const [config, policy] of written) {
    await writeFile(join(home, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
    assert.deepEqual(await readPolicy(home), { ...policy }, JSON.stringify(config));
  }

  assert.deepEqual(parsePolicy("keep"), { mode: "keep", days: null, max_mb: null });
  assert.deepEqual(parsePolicy(" OFF "), { mode: "off", days: null, max_mb: null });
  assert.deepEqual(parsePolicy("days:30", 50), { mode: "days", days: 30, max_mb: 50 });
  for (const wrong of ["", "days", "days:0", "days:-1", "days:1.5", "days:x", "30", "forever", null, undefined]) assert.throws(() => parsePolicy(wrong), { code: "invalid_archive" }, String(wrong));
  for (const size of [0, -1, Number.NaN, Infinity, "10"]) assert.throws(() => parsePolicy("keep", size), { code: "invalid_archive" }, String(size));

  assert.match(describePolicy(parsePolicy("off")), /^Nothing decrypted is written to this machine\./);
  assert.equal(describePolicy(parsePolicy("days:7", 5)), "Decrypted messages and receipts are kept in archive/ for 7 days and never more than 5 MB, oldest first out, then removed. The service itself keeps nothing past a thread's expiry: this archive is yours, on this machine.");
  assert.match(describePolicy(parsePolicy("keep")), /kept in archive\/ until you remove them\. .*`aamio archive days:30` gives it a lifetime, `aamio archive off` stops it\.$/);
});

test("a channel's records go in a file inside the archive, whatever the channel is called", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aamio-node-stage4-names-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const label of ["inbox", "inbox-1800000000", "board-1800000000-1", "with-0a1b2c3d", "tender.2026_Q4", "A"]) {
    assert.equal(isSafeLabel(label), true, label);
    assert.equal(archiveName(label), label);
  }
  // A label another runtime let through: a path, a device, a stream, a name the file system would change.
  const unsafe = ["../outside-the-archive", "../../outside-the-home", "deep/er", "back\\slash", "with:colon", "con", "NUL", "nul.txt", "COM1", "lpt9.log", "trailing.", ".hidden", "", " ", "a b", "x".repeat(65), "tab\t", "new\nline", "ünïcode", "*", "a?b"];
  for (const label of unsafe) {
    assert.equal(isSafeLabel(label), false, JSON.stringify(label));
    const name = archiveName(label);
    assert.match(name, /^channel-[0-9a-f]{16}$/, JSON.stringify(label));
    assert.equal(name, "channel-" + sha256hex(label).slice(0, 16), "the same label, the same file");
    await appendRecord(home, name, { kind: "received", at: 1, label });
  }
  for (const not of [null, undefined, 7, ["inbox"], {}]) assert.equal(isSafeLabel(not), false);
  // Everything landed in the archive folder, and nothing beside it.
  assert.deepEqual((await readdir(home)).sort(), ["archive"]);
  assert.equal((await archiveNames(home)).length, new Set(unsafe).size);
  assert.deepEqual((await archivedRecords(home, archiveName("../../outside-the-home"), "received")).map((record) => record.label), ["../../outside-the-home"]);
});

test("a record is appended whole, private, after a line a crash cut short, and read back by its kind", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aamio-node-stage4-append-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await archiveNames(home), [], "an archive that is not there has no files");
  assert.deepEqual(await archivedRecords(home, "inbox", "received"), [], "and a file that is not there has no records");
  await appendRecord(home, "inbox", { kind: "received", at: 10, body: { text: "blåbær 🫐" } });
  await appendRecord(home, "inbox", { kind: "receipt", at: 11 });
  const path = join(home, "archive", "inbox.jsonl");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600, "decrypted text is the owner's alone");
    assert.equal((await stat(join(home, "archive"))).mode & 0o777, 0o700);
  }
  // A crash in the middle of a write leaves a last line with no end.
  await writeFile(path, (await readFile(path, "utf8")) + "{\"kind\":\"received\",\"at\":12,\"body\":{\"te");
  await appendRecord(home, "inbox", { kind: "received", at: 13, body: { text: "after the crash" } });
  const text = await readFile(path, "utf8");
  assert.ok(text.endsWith("\n") && text.split("\n").length === 5, "the next record starts on a line of its own");
  assert.deepEqual((await archivedRecords(home, "inbox", "received")).map((record) => [record.at, record.body.text]), [[10, "blåbær 🫐"], [13, "after the crash"]], "and the line cut short is passed over, alone");
  assert.deepEqual((await archivedRecords(home, "inbox", "receipt")).map((record) => record.at), [11]);
  assert.deepEqual(await archiveNames(home), ["inbox"]);
  const status = await archiveStatus(home, parsePolicy("keep"));
  assert.deepEqual([status.files, status.bytes, status.oldest_at, status.policy.mode], [1, Buffer.byteLength(text), 10, "keep"]);
});

test("pruning removes what is past its days and the oldest past the ceiling, keeps what it cannot date, and leaves each file whole", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aamio-node-stage4-prune-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const day = 86400;
  const now = 1_800_000_000;
  const fill = async () => {
    await rm(join(home, "archive"), { recursive: true, force: true });
    for (const age of [40, 20, 5]) await appendRecord(home, "inbox", { kind: "received", at: now - age * day, text: `inbox ${age}` });
    for (const age of [35, 1]) await appendRecord(home, "sent", { kind: "sent", at: now - age * day, text: `sent ${age}` });
    await appendRecord(home, "board", { kind: "posted", text: "no time on it" });
    await writeFile(join(home, "archive", "inbox.jsonl"), (await readFile(join(home, "archive", "inbox.jsonl"), "utf8")) + "not a record at all\n");
  };
  const texts = async (name) => (await readFile(join(home, "archive", name + ".jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => (line.startsWith("{") ? JSON.parse(line).text : line));

  await fill();
  assert.deepEqual(await pruneArchive(home, parsePolicy("keep"), { now }), { removed: 0, bytes: (await archiveStatus(home, DEFAULT_POLICY)).bytes }, "keep removes nothing");
  const gone = await pruneArchive(home, parsePolicy("days:30"), { now });
  assert.equal(gone.removed, 2);
  assert.deepEqual(await texts("inbox"), ["inbox 20", "inbox 5", "not a record at all"], "what cannot be told old is not thrown away as old");
  assert.deepEqual(await texts("sent"), ["sent 1"]);
  assert.deepEqual(await texts("board"), ["no time on it"]);
  assert.equal(gone.bytes, (await archiveStatus(home, DEFAULT_POLICY)).bytes);
  assert.deepEqual((await readdir(join(home, "archive"))).sort(), ["board.jsonl", "inbox.jsonl", "sent.jsonl"], "and nothing is left beside the files");

  // A ceiling: the oldest go first, across the files, until what is left fits.
  await fill();
  const all = (await archiveStatus(home, DEFAULT_POLICY)).bytes;
  const oldest = Buffer.byteLength(JSON.stringify({ kind: "received", at: now - 40 * day, text: "inbox 40" }) + "\n");
  const second = Buffer.byteLength(JSON.stringify({ kind: "sent", at: now - 35 * day, text: "sent 35" }) + "\n");
  const capped = await pruneArchive(home, { mode: "keep", days: null, max_mb: (all - oldest - 1) / (1024 * 1024) }, { now });
  assert.deepEqual([capped.removed, capped.bytes], [2, all - oldest - second]);
  assert.deepEqual([await texts("inbox"), await texts("sent")], [["inbox 20", "inbox 5", "not a record at all"], ["sent 1"]]);

  // Everything: the whole archive, and how many records that was.
  await fill();
  assert.deepEqual(await pruneArchive(home, DEFAULT_POLICY, { now, everything: true }), { removed: 7, bytes: 0 });
  assert.deepEqual(await archiveNames(home), []);
  assert.deepEqual(await pruneArchive(home, parsePolicy("days:1"), { now }), { removed: 0, bytes: 0 }, "an empty archive is pruned to nothing");
});

// ------------------------------------------------------------------ what a home keeps

test("what is read, sent and posted is written down decrypted, and each message says that it was", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, homeB } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "kept on both sides", data: { n: 1 } });
  const [got] = await receiver.read();
  assert.deepEqual([got.archived, "archive_off" in got], [true, false]);

  // The reader's file for the channel: the message as it was handed over, with the thread's instance.
  const [row] = await lines(homeA, "inbox");
  const { archived, ...handed } = got;
  assert.deepEqual(row, { ...handed, kind: "received", instance: receiver.channel("inbox").instance });
  assert.equal(row.body.text, "kept on both sides");
  // The sender's: what was sent, to whom and how it ended, with the body in the clear.
  const [record] = await lines(homeB, "sent");
  assert.deepEqual([record.kind, record.to, record.w, record.status, record.message_id, record.outcome, record.seq, record.sha256], ["sent", "receiver", sent.w, 201, sent.message_id, "delivered", 1, sent.sha256]);
  assert.deepEqual([record.body.text, record.body.data, record.body.reply_to], ["kept on both sides", { n: 1 }, sender.channel("inbox").w]);
  assert.equal(sent.archive_error, undefined);
  if (process.platform !== "win32") assert.equal((await stat(join(homeA, "archive", "inbox.jsonl"))).mode & 0o777, 0o600);

  // A send that was turned away is written down as that.
  fake.failNext(403);
  const refused = await failed(() => sender.send("receiver", { text: "turned away" }));
  assert.equal(refused.code, "send_failed");
  assert.deepEqual((await lines(homeB, "sent")).map((r) => [r.status, r.outcome, r.body.text]), [[201, "delivered", "kept on both sides"], [403, "refused", "turned away"]]);

  // The board: a post, an answer to it, the answer as it arrives, and a withdrawal.
  const posted = await receiver.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  const answered = await sender.boardAnswer(posted.post.id, { text: "I can" });
  const [answer] = await receiver.read();
  assert.equal(answer.archived, true);
  await receiver.boardWithdraw(posted.post.id);
  assert.deepEqual((await lines(homeA, "board")).map((r) => [r.kind, r.post?.id ?? r.id ?? r.body?.post]), [["posted", posted.post.id], ["received", posted.post.id], ["withdrawn", posted.post.id]]);
  const [mine] = await lines(homeB, "board");
  assert.deepEqual([mine.kind, mine.post, mine.w, mine.status, mine.message_id, mine.outcome, mine.body.text], ["answered", posted.post.id, posted.inbox, 201, answered.message_id, "delivered", "I can"]);

  // A receipt is kept with the channel it is for.
  const receipt = await receiver.receipt("inbox");
  const kept = (await lines(homeA, "inbox")).filter((r) => r.kind === "receipt");
  assert.deepEqual(kept.map((r) => [r.result.root, r.result.count]), [[receipt.root, 1]]);
  assert.equal(receipt.archive_error, undefined);
});

test("a scope that is shared is written down by its name and never with its key", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, homeB } = await pair(t, fake);
  await sender.scopeNew("team");
  const key = sender.scopeKey("team").key;
  await sender.scopeShare("team", "receiver", "read");
  const [got] = await receiver.read();
  assert.equal(got.body.data.aamio_scope.kept, true);
  // The sender's archive says what was shared and with whom. The receiver's has the message as it was handed over.
  assert.deepEqual((await lines(homeB, "sent")).map((r) => r.body.data), [{ aamio_scope: { name: "team", access: "read" } }]);
  assert.deepEqual((await lines(homeA, "inbox")).map((r) => r.body.data.aamio_scope.name), ["sender.team"]);
  for (const home of [homeA, homeB]) {
    for (const name of await archiveNames(home)) assert.ok(!(await readFile(join(home, "archive", name + ".jsonl"), "utf8")).includes(key), `${name} in ${home}`);
  }
});

test("a message is written down before the cursor is, and once: a read that cannot be saved hands nothing over and keeps the record", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  await sender.send("receiver", { text: "read twice, written once" });
  failSaving(receiver, "state.json");
  assert.deepEqual(await receiver.read(), []);
  assert.deepEqual(await states(receiver), ["not_saved"]);
  assert.deepEqual((await lines(homeA, "inbox")).map((r) => r.body.text), ["read twice, written once"], "what arrived and was opened is on the disk although the cursor is not");
  const [got] = await receiver.read();
  assert.deepEqual([got.body.text, got.replay, got.archived], ["read twice, written once", false, true]);
  assert.equal((await lines(homeA, "inbox")).length, 1, "the process that wrote it down does not write it down again");

  // A process of its own cannot know, and writes the row again. Whoever lists the archive knows one delivery by its
  // address, its thread's instance and its seq.
  await sender.send("receiver", { text: "across two processes" });
  failSaving(receiver, "state.json");
  assert.deepEqual(await receiver.read(), []);
  await receiver.close();
  const again = await open(homeA);
  const [late] = await again.read();
  assert.deepEqual([late.body.text, late.replay, late.archived], ["across two processes", false, true]);
  const rows = (await lines(homeA, "inbox")).filter((r) => r.body.text === "across two processes");
  assert.deepEqual(rows.map((r) => [r.w, r.instance, r.seq]), [[late.w, again.channel("inbox").instance, late.seq], [late.w, again.channel("inbox").instance, late.seq]]);
});

test("an archive that cannot be written costs the record and nothing else: the message is handed over, the send delivered, the post made", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  // A file where the folder should be, in both homes: no record can be written there.
  for (const home of [homeA, homeB]) await writeFile(join(home, "archive"), "not a folder");
  const receiver = await open(homeA);
  const sender = await open(homeB);
  await receiver.partnerAdd("sender", sender.keys.public);
  await sender.partnerAdd("receiver", receiver.keys.public);
  await receiver.read();

  const sent = await sender.send("receiver", { text: "delivered, not written down" });
  assert.deepEqual([sent.seq, typeof sent.archive_error], [1, "string"]);
  assert.equal(sender.outbox[sent.message_id].status, "delivered");
  assert.ok((await sender.attentionTaken()).some((note) => note.state === "archive_failed" && note.what.startsWith(`the send ${sent.message_id} could not be written to the archive: `)));

  const got = await receiver.read();
  assert.deepEqual(got.map((m) => [m.body.text, m.archived, "archive_off" in m]), [["delivered, not written down", false, false]]);
  const said = (await receiver.attentionTaken()).filter((note) => note.state === "archive_failed");
  assert.equal(said.length, 1);
  assert.match(said[0].what, /^message 1 was handed over and could not be written to the archive: .*The archive does not have it\.$/);
  assert.equal(receiver.channel("inbox").after, 1, "the cursor moves past it: the archive is a record of the delivery, not the delivery");
  assert.deepEqual(await receiver.read(), []);

  // A post, an answer and a withdrawal that are done say so, with what could not be recorded beside them.
  const posted = await receiver.boardPost({ kind: "need", title: "made", text: "and not written down" });
  assert.equal(typeof posted.archive_error, "string");
  assert.equal(fake.posts.size, 1, "the post is on the board, once");
  const answered = await sender.boardAnswer(posted.post.id, { text: "delivered" });
  assert.deepEqual([answered.seq, typeof answered.archive_error], [1, "string"]);
  const withdrawn = await receiver.boardWithdraw(posted.post.id);
  assert.deepEqual([withdrawn.deleted, typeof withdrawn.archive_error, fake.posts.size], [true, "string", 0]);
  const receipt = await receiver.receipt("inbox");
  assert.deepEqual([receipt.count, typeof receipt.archive_error], [1, "string"]);
  // And a send that failed says both.
  fake.failNext(429);
  const refused = await failed(() => sender.send("receiver", { text: "turned away" }));
  assert.deepEqual([refused.code, refused.status, typeof refused.archive_error], ["send_failed", 429, "string"]);
});

test("with the archive off nothing decrypted is written, each message says so, and the home's choice is read by the next process", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, homeB, open } = await pair(t, fake);
  // The choice is the home's, written where the other runtimes read it, beside what the file held.
  await writeFile(join(homeA, "config.json"), JSON.stringify({ kept_by_another_version: { a: 1 } }));
  const status = await receiver.archiveSet(parsePolicy("off"));
  assert.deepEqual([status.policy, status.files], [{ mode: "off", days: null, max_mb: null }, 0]);
  assert.match(status.means, /^Nothing decrypted is written to this machine\./);
  assert.deepEqual(JSON.parse(await readFile(join(homeA, "config.json"), "utf8")), { kept_by_another_version: { a: 1 }, archive: { mode: "off", days: null, max_mb: null } });

  await sender.send("receiver", { text: "read, and kept nowhere" });
  const [got] = await receiver.read();
  assert.deepEqual([got.body.text, got.archived, got.archive_off], ["read, and kept nowhere", false, true]);
  assert.deepEqual(await states(receiver), [], "nothing went wrong, and nothing is said to have");
  await receiver.send("sender", { text: "sent, and kept nowhere" });
  assert.deepEqual(await archiveNames(homeA), []);
  await receiver.close();
  const again = await open(homeA);
  assert.equal(again.archiveEnabled, false, "the next process keeps nothing either");
  await sender.send("receiver", { text: "the next process" });
  assert.deepEqual((await again.read()).map((m) => [m.archived, m.archive_off]), [[false, true]]);
  assert.deepEqual(await archiveNames(homeA), []);
  assert.equal((await again.archiveStatus()).note, undefined, "nothing was kept before, and nothing is said to be");

  // For one process, whatever the home says: --no-archive on the command line.
  await sender.close();
  const once = await open(homeB, { archive: false });
  assert.deepEqual([once.archivePolicy.mode, once.archiveEnabled], ["keep", false]);
  const before = await lines(homeB, "sent");
  await once.send("receiver", { text: "not written down this once" });
  assert.deepEqual(await lines(homeB, "sent"), before);
  // And back on, by the home's choice, for the process after it.
  assert.deepEqual((await again.archiveSet(parsePolicy("keep"))).policy.mode, "keep");
  await once.send("receiver", { text: "kept again" });
  assert.deepEqual((await again.read()).map((m) => [m.body.text, m.archived]), [["not written down this once", true], ["kept again", true]]);

  // A choice that cannot be written is not made.
  failSaving(again, "config.json");
  const unsaved = await failed(() => again.archiveSet(parsePolicy("off")));
  assert.equal(unsaved.code, "not_saved");
  assert.deepEqual([again.archiveEnabled, (await readPolicy(homeA)).mode], [true, "keep"]);

  // Off stops the writing and removes nothing. What was kept before is still there, and the answer says so.
  const off = await again.archiveSet(parsePolicy("off"));
  assert.equal(off.files, 1);
  assert.equal(off.note, `Nothing more is written. What was kept before the archive was turned off is still in archive/: 1 file(s), ${off.bytes} bytes. aamio archive prune --all removes it.`);
  const emptied = await again.archivePrune({ everything: true });
  assert.deepEqual([emptied.removed, emptied.files, emptied.note], [2, 0, undefined]);
});

test("a home that keeps its archive so many days, or so many megabytes, prunes it when it is opened", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  await sender.send("receiver", { text: "an old message" });
  await receiver.read();
  const status = await receiver.archiveSet(parsePolicy("days:2"));
  assert.deepEqual([status.policy, status.files, status.oldest_at], [{ mode: "days", days: 2, max_mb: null }, 1, fake.time]);
  await receiver.close();
  fake.time += 3 * 86400;
  const again = await open(homeA);
  assert.deepEqual(await lines(homeA, "inbox"), [], "three days later the message is past its two");
  assert.deepEqual(await again.read(), []);
  await sender.read();
  await sender.send("receiver", { text: "a new message" });
  assert.deepEqual((await again.read()).map((m) => m.archived), [true]);
  assert.deepEqual((await lines(homeA, "inbox")).map((r) => r.body.text), ["a new message"]);
  // The command's own answer: what went, and what is left. With everything, all of it.
  const pruned = await again.archivePrune();
  assert.deepEqual([pruned.removed, pruned.files, pruned.policy.days], [0, 1, 2]);
  const emptied = await again.archivePrune({ everything: true });
  assert.deepEqual([emptied.removed, emptied.files, emptied.bytes], [1, 0, 0]);

  // An archive that cannot be pruned is said: it keeps growing, in the clear.
  await again.close();
  await rm(join(homeA, "archive"), { recursive: true, force: true });
  await mkdir(join(homeA, "archive", "inbox.jsonl"), { recursive: true });
  const stuck = await open(homeA);
  const said = (await stuck.attentionTaken()).filter((note) => note.state === "unpruned");
  assert.equal(said.length, 1);
  assert.match(said[0].what, /^the archive was not pruned: .*It keeps growing/);
});

test("what a message weighs counts the archive's mark at its longer value, so a budget holds whatever the archive does", async (t) => {
  for (const mode of ["keep", "off", "broken"]) {
    // Two messages waiting on a home of its own, with the archive kept, off, or impossible to write.
    const waiting = async () => {
      const fake = new FakeAamio();
      // A service without read limits sends everything, so the budget that holds is the one kept here.
      fake.ignoreBudget = true;
      const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
      if (mode === "broken") await writeFile(join(homeA, "archive"), "not a folder");
      const receiver = await open(homeA, mode === "off" ? { archive: false } : {});
      const sender = await open(homeB);
      await receiver.partnerAdd("sender", sender.keys.public);
      await sender.partnerAdd("receiver", receiver.keys.public);
      await receiver.read();
      await sender.send("receiver", { text: "the first of two" });
      await sender.send("receiver", { text: "the second of two" });
      return receiver;
    };
    const whole = await (await waiting()).read();
    assert.equal(whole.length, 2);
    // As weighed: the mark false, and archive_off where nothing is kept.
    const weighed = whole.map((m) => bytes({ ...m, archived: false }));
    const one = await (await waiting()).read({ maxBytes: weighed[0] + weighed[1] - 1 });
    assert.deepEqual(one.map((m) => m.seq), [1], `${mode}: one byte short of both hands over one`);
    assert.ok(bytes(one[0]) <= weighed[0]);
    const both = await (await waiting()).read({ maxBytes: weighed[0] + weighed[1] });
    assert.deepEqual(both.map((m) => m.seq), [1, 2], `${mode}: and the exact size hands over both`);
    assert.ok(bytes(both[0]) + bytes(both[1]) <= weighed[0] + weighed[1]);
    assert.deepEqual(both.map((m) => [m.archived, m.archive_off ?? null]), mode === "keep" ? [[true, null], [true, null]] : mode === "off" ? [[false, true], [false, true]] : [[false, null], [false, null]]);
  }
});

test("a channel another runtime named with a path in it is written down inside the archive, under a name of its own", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, root, open } = await pair(t, fake);
  // As aamio-python and aamio-php open a channel today: the label as it was given, with a path in it.
  const label = "../../outside-the-home";
  const thread = await receiver.client.open({ ttl: 600, allow: [sender.keys.public] });
  receiver.state.channels.push({ label, read_key: thread.id, w: thread.w, expire_at: thread.expireAt, allow: [sender.keys.public], after: 0, created_at: null, instance: null, gone: false, muted: false, seen: [], seen_from: [] });
  await receiver.saveState();
  await receiver.close();
  const again = await open(homeA);
  sender.state.peers[thread.w] = again.keys.public;
  await sender.send(thread.w, { text: "a private line" });
  const [got] = await again.read();
  assert.deepEqual([got.channel, got.body.text, got.archived], [label, "a private line", true]);
  const name = archiveName(label);
  assert.deepEqual((await lines(homeA, name)).map((r) => [r.channel, r.body.text]), [[label, "a private line"]]);
  // Nothing was written outside the archive: not beside the home, and not beside its folder.
  assert.deepEqual((await readdir(root)).sort(), ["a", "b"]);
  assert.ok(!(await readdir(homeA)).some((file) => file.endsWith(".jsonl")));
  assert.ok((await archiveNames(homeA)).every((file) => /^[A-Za-z0-9._-]+$/.test(file)));
  const receipt = await again.receipt(label);
  assert.equal(receipt.count, 1);
  assert.deepEqual((await lines(homeA, name)).map((r) => r.kind), ["received", "receipt"]);
});

test("channels past their time leave the home, and the inbox and the board inbox stay until a new one takes their place", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  await receiver.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  const named = await receiver.client.open({ ttl: 600 });
  receiver.state.channels.push({ label: "tender", read_key: named.id, w: named.w, expire_at: named.expireAt, allow: [], after: 0, created_at: null, instance: null, gone: false, muted: false, seen: ["a".repeat(64)], seen_from: [] });
  await receiver.saveState();
  const labels = (runtime) => runtime.state.channels.map((channel) => channel.label);
  assert.deepEqual(labels(receiver), ["inbox", "board", "tender"]);
  await receiver.close();

  // Past the tender's time, and inside the two minutes its receipt can still be taken in: it is still there.
  fake.time += 600 + 60;
  let again = await open(homeA);
  assert.deepEqual(labels(again), ["inbox", "board", "tender"]);
  await again.close();
  // Past that: gone from the home when it is opened, and from the file at the next save.
  fake.time += 120;
  again = await open(homeA);
  assert.deepEqual(labels(again), ["inbox", "board"]);
  assert.deepEqual((await JSON.parse(await readFile(join(homeA, "state.json"), "utf8"))).channels.map((channel) => channel.label), ["inbox", "board", "tender"], "opening a home writes nothing");

  // The inbox and the board inbox outlive their time in the home: a command can say that the address closed, and when.
  fake.time += 3600;
  await again.close();
  again = await open(homeA);
  assert.deepEqual(labels(again), ["inbox", "board"]);
  assert.equal(again.boardReplyAddress().open, false);
  // A read opens a new inbox, the old one takes a name of its own, and is gone at the next look.
  await again.read();
  assert.deepEqual(labels(again), ["board", "inbox"]);
  assert.deepEqual((await JSON.parse(await readFile(join(homeA, "state.json"), "utf8"))).channels.map((channel) => channel.label), ["board", "inbox"]);
  // In a process that stays up as well: a post opens a new board inbox, the old one takes a name of its own, and
  // each read lets go of what is past its time.
  await again.boardPost({ kind: "need", title: "another", text: "and a new board inbox" });
  assert.equal(labels(again).filter((label) => label.startsWith("board-")).length, 1);
  await again.read();
  assert.deepEqual(labels(again).sort(), ["board", "inbox"]);
  assert.equal(again.boardReplyAddress().open, true);
  void sender;
});

// ------------------------------------------------------------------ a file of the home with a mark in front
//
// An editor on Windows may save a file with a byte order mark in front. The state was read past it, and the rest
// of the home was not. The three runtimes read the home's own files past the mark; the same home is opened by each
// of them in code/php/tools/check-node-exchange.py.

const MARK = Buffer.from([0xef, 0xbb, 0xbf]);

async function marked(path) {
  const raw = await readFile(path);
  assert.ok(raw.length > 0 && !raw.subarray(0, 3).equals(MARK), path);
  await writeFile(path, Buffer.concat([MARK, raw]));
  return raw;
}

test("a file of the home with a byte order mark in front is read past the mark, as the other two runtimes read it", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  await receiver.scopeNew("team");
  await sender.send("receiver", { text: "written down before the mark" });
  assert.equal((await receiver.read()).length, 1);
  const posted = await receiver.boardPost({ kind: "need", title: "kept by node", text: "who answers?", ttl: 600 });
  await receiver.send("sender", { text: "one in the outbox" });
  const held = (runtime) => [runtime.keys.public, runtime.partnerList(), runtime.scopeList(), Object.keys(runtime.outbox), runtime.state.channels.map((channel) => [channel.label, channel.w]), Object.keys(runtime.traces)];
  const before = held(receiver);
  assert.ok(before[3].length === 1 && before[5].length === 1, "there is something in the outbox and in the trace");
  await receiver.close();

  const files = ["partners.json", "scopes.json", "state.json", "outbox.json", "trace.json", join("archive", "inbox.jsonl"), join("archive", "board.jsonl")];
  const raw = {};
  for (const name of files) raw[name] = await marked(join(homeA, name));

  const again = await open(homeA);
  assert.deepEqual(held(again), before, "the key, the partners, the scopes, the outbox, the channels and the trace the home had");
  assert.deepEqual(await states(again), [], "and nothing is said, since nothing was lost");
  // The archive's first line is a record like the rest, with its time, so a lifetime reaches it.
  assert.deepEqual((await archivedRecords(homeA, "board", "posted")).map((record) => record.post.id), [posted.post.id]);
  let all = 0;
  for (const name of await readdir(join(homeA, "archive"))) all += (await readFile(join(homeA, "archive", name), "utf8")).split("\n").filter(Boolean).length;
  assert.ok(all >= 2);
  // What is saved next is written without the mark.
  await again.partnerAdd("third", Keys.generate().public);
  assert.equal((await readFile(join(homeA, "partners.json"))).subarray(0, 3).equals(MARK), false);
  await again.close();
  const gone = await pruneArchive(homeA, { mode: "days", days: 1, max_mb: null }, { now: fake.time + 10 * 86400 });
  assert.equal(gone.removed, all, "every record is past its day, the first of each file too");

  // Only the mark is passed. Two of them is not what the file holds.
  await writeFile(join(homeA, "partners.json"), Buffer.concat([MARK, MARK, Buffer.from("{}")]));
  assert.equal((await failed(() => open(homeA))).code, "state_unreadable");
  await writeFile(join(homeA, "partners.json"), raw["partners.json"]);
  // A file that holds the mark and nothing else is an empty file, as the other two runtimes read it.
  await writeFile(join(homeA, "partners.json"), MARK);
  const emptied = await open(homeA);
  assert.deepEqual(emptied.partnerList(), []);
  await emptied.close();
  await writeFile(join(homeA, "partners.json"), raw["partners.json"]);
  // And the key is not read past a mark: it holds the seed and nothing else, here as in the other two.
  await marked(join(homeA, "key"));
  assert.equal((await failed(() => open(homeA))).code, "key_unreadable");
});

test("a policy file with a mark in front is still the choice that was made: nothing is written down", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender, homeA, open } = await pair(t, fake);
  await receiver.archiveSet(parsePolicy("off"));
  await receiver.close();
  await marked(join(homeA, "config.json"));
  assert.equal((await readPolicy(homeA)).mode, "off");
  const again = await open(homeA);
  await sender.send("receiver", { text: "not to be written down" });
  assert.deepEqual((await again.read()).map((m) => [m.body.text, m.archived, m.archive_off]), [["not to be written down", false, true]]);
  assert.equal(existsSync(join(homeA, "archive", "inbox.jsonl")), false);
  // A file that is not JSON at all is no choice, as before: only the mark is passed.
  await writeFile(join(homeA, "config.json"), Buffer.concat([MARK, Buffer.from("{ nope")]));
  assert.equal((await readPolicy(homeA)).mode, "keep");
});

test("a file of the home that is not UTF-8 is not read as if it were: the policy, and the archive's lines", async (t) => {
  const fake = new FakeAamio();
  const { receiver, homeA } = await pair(t, fake);
  await receiver.archiveSet(parsePolicy("off"));
  await receiver.close();
  // A policy file with one byte that is not UTF-8 holds no choice anyone can read, as aamio-python and aamio-php read it.
  await writeFile(join(homeA, "config.json"), Buffer.concat([Buffer.from('{"archive":{"mode":"off","days":null,"max_mb":null},"note":"caf'), Buffer.from([0xe9]), Buffer.from('"}')]));
  assert.equal((await readPolicy(homeA)).mode, "keep");

  // A line that is not UTF-8 is no record when the archive is read, and is kept byte for byte when it is pruned.
  const folder = join(homeA, "archive");
  await mkdir(folder, { recursive: true });
  const odd = Buffer.concat([Buffer.from('{"kind":"received","at":1,"body":{"text":"caf'), Buffer.from([0xe9]), Buffer.from('"}}\n')]);
  const old = Buffer.from('{"kind":"received","at":1,"body":{"text":"old"}}\n');
  const fresh = Buffer.from(JSON.stringify({ kind: "received", at: fake.time, body: { text: "fresh" } }) + "\n");
  await writeFile(join(folder, "test.jsonl"), Buffer.concat([odd, old, fresh]));
  assert.deepEqual((await archivedRecords(homeA, "test", "received")).map((record) => record.body.text), ["old", "fresh"]);
  const gone = await pruneArchive(homeA, { mode: "days", days: 1, max_mb: null }, { now: fake.time + 10 });
  assert.equal(gone.removed, 1, "the old record goes");
  assert.ok((await readFile(join(folder, "test.jsonl"))).equals(Buffer.concat([odd, fresh])), "and the line that is not UTF-8 is kept as it was, not written back changed");
});
