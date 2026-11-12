// Stage 4 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): board replies. A command is a
// process of its own, so the answers to a post are what this run read and what the archive holds from before. Against
// the fake aamio in memory. The rule for what one delivery is, row for row, is aamio-python's
// (tests/test_board_reply_window.py there), and the same home read by all three is in
// code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keys, sha256hex, threadSigningInput } from "../src/aamio.js";
import { appendRecord, archiveNames } from "../src/node-archive.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";
import { serveFake } from "./serve-fake.mjs";

const HOST = "https://fake.aamio";

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage4-replies-"));
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

/** A poster and two who answer, none of them partners: a board is where those who have not met find each other. */
async function board(t, fake, options = {}) {
  const { a: homeA, b: homeB, c: homeC, open, root } = await fixture(t, fake, "a", "b", "c");
  const poster = await open(homeA, options);
  const first = await open(homeB);
  const second = await open(homeC);
  return { poster, first, second, homeA, homeB, homeC, open, root };
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

/** One message put on a thread by hand: sealed or in the clear, signed by these keys. */
async function put(fake, w, text, signer) {
  const answer = await fake.fetch(`${HOST}/${w}`, { method: "POST", body: text, headers: { "X-Key": signer.public, "X-Sig": signer.sign(threadSigningInput(w, text)) } });
  assert.equal(answer.status, 201, await answer.clone().text());
  return answer.json();
}

const texts = (replies) => replies.map((m) => m.body.text);
const states = async (runtime) => (await runtime.attentionTaken()).map((note) => note.state);
const archived = async (home, name) => (await readFile(join(home, "archive", name + ".jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

// ------------------------------------------------------------------ this run and the runs before it

test("a new process finds an answer an earlier one read, also after the board inbox has expired, and says that the address is closed", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, homeA, open } = await board(t, fake);
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  const answered = await first.boardAnswer(posted.post.id, { text: "I can, tonight" });

  // This run: the board inboxes are read, and the answer is listed as it was handed over.
  assert.deepEqual(texts(await poster.boardPoll()), ["I can, tonight"]);
  const here = await poster.boardReplies();
  assert.deepEqual(here.map((m) => [m.body.text, m.body.post, m.sender, m.verified, m.encrypted, m.archived, m.from_archive ?? false]), [["I can, tonight", posted.post.id, "unknown key", true, true, true, false]]);
  assert.equal(poster.boardRepliesLeftOut, 0);
  const closes = poster.channel("board").expire_at;
  assert.deepEqual(poster.boardReplyAddress(), { w: posted.inbox, open: true, expires_at: closes, seconds_left: closes - fake.time });
  await poster.close();

  // The next run read nothing itself: what it lists is what the archive holds, and it says so.
  let again = await open(homeA);
  assert.deepEqual(await again.boardPoll(), []);
  const before = await again.boardReplies();
  assert.deepEqual(before.map((m) => [m.body.text, m.sha256, m.from_key, m.from_archive]), [["I can, tonight", answered.sha256, first.keys.public, true]]);
  assert.deepEqual(await states(again), []);
  await again.close();

  // Two hours on the thread is long gone at the service, and the answer is still found. The address is said to be
  // closed, and since when: an empty list would not have meant that nobody wrote back.
  fake.time += 7200;
  again = await open(homeA);
  assert.deepEqual(await again.boardPoll(), [], "there is nothing left to ask");
  assert.deepEqual(texts(await again.boardReplies(posted.post.id)), ["I can, tonight"]);
  const address = again.boardReplyAddress();
  assert.deepEqual([address.w, address.open, address.expires_at], [posted.inbox, false, closes]);
  assert.equal(address.why, `The address you answered from closed ${fake.time - closes} s ago. Anything sent to it after that was refused at the door, so an empty result here does not mean nobody wrote back.`);
  assert.ok(fake.time - closes > 3600);
  // A home that never had a board inbox says that instead.
  const { a: other, open: openOther } = await fixture(t, fake, "a");
  assert.deepEqual((await openOther(other)).boardReplyAddress(), { w: null, open: false, why: "No board inbox on this machine. One is opened when you answer or post." });
});

test("with a post, the answers that name it wherever they arrived; without one, what came to a board inbox and what names a post", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, second } = await board(t, fake);
  const one = await poster.boardPost({ kind: "need", title: "the first", text: "who can help with this?" });
  const two = await poster.boardPost({ kind: "offer", title: "the second", text: "and who wants that?" });
  await first.boardAnswer(one.post.id, { text: "first, about the first" });
  await second.boardAnswer(one.post.id, { text: "second, about the first" });
  await second.boardAnswer(two.post.id, { text: "second, about the second" });
  // One that names no post, on the board inbox: still somebody answering.
  const stranger = Keys.generate();
  await put(fake, one.inbox, stranger.seal(poster.keys.public, JSON.stringify({ text: "names no post", reply_to: "a".repeat(20) })), stranger);
  // A partner on the inbox: one message that names the first post, and one that is no answer at all.
  await poster.partnerAdd("first", first.keys.public);
  await first.partnerAdd("poster", poster.keys.public);
  await poster.read();
  await first.send("poster", { text: "on the inbox, about the first", data: { n: 1 } });
  await put(fake, poster.channel("inbox").w, first.keys.seal(poster.keys.public, JSON.stringify({ text: "also about the first", post: one.post.id })), first.keys);
  await poster.read();

  const about = await poster.boardReplies(one.post.id);
  assert.deepEqual(about.map((m) => [m.channel, m.body.text]), [["board", "first, about the first"], ["board", "second, about the first"], ["inbox", "also about the first"]], "by the post it names, on whatever channel");
  assert.equal(poster.boardRepliesLeftOut, 3);
  const everything = await poster.boardReplies();
  assert.deepEqual(texts(everything).sort(), ["also about the first", "first, about the first", "names no post", "second, about the first", "second, about the second"]);
  assert.equal(poster.boardRepliesLeftOut, 1, "the one on the inbox that names no post is left out, and counted");
  // Oldest first, by the time each arrived and then by its place in its thread.
  assert.deepEqual(everything.map((m) => m.at), [...everything.map((m) => m.at)].sort((a, b) => a - b));
  assert.deepEqual(await states(poster), [], "nothing to say when the list is not empty");

  // Nothing answers a post, and something else is there: an empty list is not an empty inbox, and it says so.
  assert.deepEqual(await poster.boardReplies("p".repeat(20)), []);
  const said = (await poster.attentionTaken()).filter((note) => note.state === "filtered");
  assert.deepEqual(said.map((note) => [note.channel, note.what]), [["board replies", `Nothing here answers post ${"p".repeat(20)}, but 6 other message(s) are on your channels. Run board replies without a post, or read, to see them.`]]);
});

test("a board command leaves the inbox where it is: what waits there is still there for read", async (t) => {
  const fake = new FakeAamio();
  const { poster, first } = await board(t, fake);
  await poster.partnerAdd("first", first.keys.public);
  await first.partnerAdd("poster", poster.keys.public);
  await poster.read();
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  await first.send("poster", { text: "waiting on the inbox" });
  await first.boardAnswer(posted.post.id, { text: "an answer on the board" });
  const before = fake.requests.length;
  assert.deepEqual(texts(await poster.boardPoll()), ["an answer on the board"]);
  assert.deepEqual(fake.requests.slice(before), [`GET /${posted.inbox}`], "one read, of the board inbox, and no inbox opened or presence published for it");
  assert.equal(poster.channel("inbox").after, 0, "the inbox's cursor stands");
  // Only what is on the inbox is there and nothing looks like an answer: said, with where to look.
  const { a: quiet, open } = await fixture(t, fake, "a");
  const reader = await open(quiet);
  await reader.partnerAdd("first", first.keys.public);
  await first.partnerAdd("reader", reader.keys.public);
  await reader.read();
  await first.send("reader", { text: "a plain message" });
  await reader.read();
  assert.deepEqual(await reader.boardReplies(), []);
  assert.equal(reader.boardRepliesLeftOut, 1);
  assert.deepEqual((await reader.attentionTaken()).map((note) => note.what), ["1 message(s) are here and none of them looks like a board answer, because they name no post and did not arrive on a board inbox. Run read to see them."]);
  // And read hands over what waited, once.
  assert.deepEqual(texts(await poster.read()), ["waiting on the inbox"]);
  assert.deepEqual(texts(await poster.boardReplies()), ["an answer on the board"]);
});

test("a board inbox that was replaced is still read while it lasts, and its answers are found after it has left the home", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, second, homeA, open } = await board(t, fake);
  const early = await poster.boardPost({ kind: "need", title: "early", text: "an early post", ttl: 3600 });
  // Close to the end of the hour the board inbox has five minutes left, too few for a new post, and a new one is
  // opened beside it.
  fake.time += 3300;
  const late = await poster.boardPost({ kind: "need", title: "late", text: "a late post", ttl: 600 });
  assert.notEqual(late.inbox, early.inbox);
  assert.deepEqual(poster.state.channels.map((channel) => channel.label), [`board-${poster.state.channels[0].expire_at}`, "board"]);
  // An answer to the address the early post gave out, and one to the new.
  await first.boardAnswer(late.post.id, { text: "to the new inbox" });
  await put(fake, early.inbox, second.keys.seal(poster.keys.public, JSON.stringify({ post: early.post.id, text: "to the old inbox", reply_to: "b".repeat(20) })), second.keys);
  assert.deepEqual(texts(await poster.boardPoll()).sort(), ["to the new inbox", "to the old inbox"], "both generations are asked");
  assert.deepEqual((await archiveNames(homeA)).filter((name) => name.startsWith("board")).length, 2, "each keeps its own file");
  await poster.close();

  // Past the old inbox's time and its two minutes of grace: it has left the home, and its file has not.
  fake.time += 500;
  const again = await open(homeA);
  assert.deepEqual(again.state.channels.map((channel) => channel.label), ["board"]);
  assert.deepEqual(texts(await again.boardReplies()).sort(), ["to the new inbox", "to the old inbox"]);
  assert.deepEqual(texts(await again.boardReplies(early.post.id)), ["to the old inbox"]);
});

// ------------------------------------------------------------------ one delivery, one row

test("one delivery is one row: read again after a read that could not be saved, it is listed once, as it first came", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, second, homeA, open } = await board(t, fake);
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  await first.boardAnswer(posted.post.id, { text: "the same words" });
  // Another signer, the same words: another delivery, and another row.
  await second.boardAnswer(posted.post.id, { text: "the same words" });

  // Written down, and the cursor could not be: nothing is handed over, and the archive has both.
  failSaving(poster, "state.json");
  assert.deepEqual(await poster.boardPoll(), []);
  assert.deepEqual(texts(await poster.boardReplies()), ["the same words", "the same words"], "what arrived and was opened is listed although read has not handed it over");
  assert.deepEqual((await poster.boardReplies()).map((m) => m.from_archive), [true, true]);
  // Read again by the same process: handed over, not written down a second time, and listed once each.
  assert.equal((await poster.boardPoll()).length, 2);
  assert.equal((await archived(homeA, "board")).filter((row) => row.kind === "received").length, 2);
  const once = await poster.boardReplies();
  assert.deepEqual(once.map((m) => [m.body.text, m.from_key, m.replay]), [["the same words", first.keys.public, false], ["the same words", second.keys.public, false]]);

  // Across two processes the second cannot know and writes the rows again: still one row for each delivery, and
  // the row that stands is the one written down first, with the mark it first came with.
  const third = Keys.generate();
  await put(fake, posted.inbox, third.seal(poster.keys.public, JSON.stringify({ post: posted.post.id, text: "a third answer" })), third);
  failSaving(poster, "state.json");
  assert.deepEqual(await poster.boardPoll(), []);
  await poster.close();
  const again = await open(homeA);
  assert.deepEqual(texts(await again.boardPoll()), ["a third answer"]);
  assert.equal((await archived(homeA, "board")).filter((row) => row.kind === "received" && row.body.text === "a third answer").length, 2);
  const listed = await again.boardReplies();
  assert.deepEqual(listed.map((m) => [m.body.text, m.replay, m.from_archive ?? false]), [["the same words", false, true], ["the same words", false, true], ["a third answer", false, true]]);

  // The cursor lost for good: everything comes again, marked a replay, and the list still shows each as it first came.
  again.channel("board").after = 0;
  const reread = await again.boardPoll();
  assert.deepEqual(reread.map((m) => m.replay), [true, true, true]);
  assert.deepEqual((await again.boardReplies()).map((m) => [m.body.text, m.replay]), [["the same words", false], ["the same words", false], ["a third answer", false]]);
});

test("rows an earlier version wrote without the thread's instance are told by what they show, and never merged with one that has it", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, homeA } = await board(t, fake);
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  await first.boardAnswer(posted.post.id, { text: "an answer" });
  const [got] = await poster.boardPoll();
  const [row] = (await archived(homeA, "board")).filter((entry) => entry.kind === "received");
  assert.equal(typeof row.instance, "string");
  // The same message as an earlier version of a client wrote it down: no instance on the row.
  const { instance, ...older } = row;
  await appendRecord(homeA, "board", older);
  // And a row of another delivery, without an instance, twice: two rows that show the same are both kept, since
  // nothing says they are one.
  const elsewhere = { ...older, w: "c".repeat(20), seq: 9, sha256: sha256hex("another"), body: { post: posted.post.id, text: "from before instances" } };
  await appendRecord(homeA, "board", elsewhere);
  await appendRecord(homeA, "board", elsewhere);
  const listed = await poster.boardReplies(posted.post.id);
  assert.deepEqual(listed.map((m) => [m.body.text, typeof m.instance, m.from_archive ?? false]), [["an answer", "string", false], ["an answer", "undefined", true], ["from before instances", "undefined", true], ["from before instances", "undefined", true]],
    "the known limit: a home last written by a version from before instances can list one answer twice");
  void got;
});

// ------------------------------------------------------------------ when nothing is kept

test("with the archive off, a run lists what it read itself and the next run lists nothing: no history is kept behind the choice", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, homeA, open } = await board(t, fake, { archive: false });
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  await first.boardAnswer(posted.post.id, { text: "read, and kept nowhere" });
  const [got] = await poster.boardPoll();
  assert.deepEqual([got.archived, got.archive_off], [false, true]);
  assert.deepEqual((await poster.boardReplies()).map((m) => [m.body.text, m.archived, m.from_archive ?? false]), [["read, and kept nowhere", false, false]], "the run that read it has it, in memory");
  assert.deepEqual(await archiveNames(homeA), [], "and nothing of it is on the disk");
  await poster.close();
  const again = await open(homeA, { archive: false });
  assert.deepEqual(await again.boardPoll(), []);
  assert.deepEqual(await again.boardReplies(), [], "the next run was told to keep nothing, and has nothing");
  assert.equal(again.boardRepliesLeftOut, 0);
  assert.equal(again.boardReplyAddress().open, true, "the address is open: this is no answer yet, not nobody could");
  assert.deepEqual(await states(again), []);

  // What an earlier run did write down, when the archive was on, is still read with it off: it stays the record of
  // what arrived until it is pruned.
  await again.close();
  const kept = await open(homeA);
  await first.boardAnswer(posted.post.id, { text: "written down this time" });
  assert.deepEqual(texts(await kept.boardPoll()), ["written down this time"]);
  await kept.close();
  const off = await open(homeA, { archive: false });
  assert.deepEqual((await off.boardReplies()).map((m) => [m.body.text, m.from_archive]), [["written down this time", true]]);
});

test("an archive that cannot be read is said, and what this run read is still listed", async (t) => {
  const fake = new FakeAamio();
  const { poster, first, homeA } = await board(t, fake);
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  await first.boardAnswer(posted.post.id, { text: "in memory, and in a file" });
  await poster.boardPoll();
  // A folder where a channel's file should be: it is there, and it cannot be read.
  await rm(join(homeA, "archive", "board.jsonl"));
  await mkdir(join(homeA, "archive", "inbox-of-old.jsonl"));
  await writeFile(join(homeA, "archive", "board.jsonl"), "{\"kind\":\"received\",\"cut short");
  assert.deepEqual(texts(await poster.boardReplies()), ["in memory, and in a file"], "a line that is no record is passed over, and the copy in memory stands");
  assert.deepEqual(await states(poster), []);
  await rm(join(homeA, "archive"), { recursive: true });
  await writeFile(join(homeA, "archive"), "not a folder");
  assert.deepEqual(texts(await poster.boardReplies()), ["in memory, and in a file"]);
  const said = (await poster.attentionTaken()).filter((note) => note.state === "unread");
  assert.equal(said.length, 1);
  assert.match(said[0].what, /^the archive could not be listed \(.+\), so answers written down earlier are not in this result$/);
});

// ------------------------------------------------------------------ on the command line

test("on the command line: board replies reads the board inboxes, lists the answers of this run and the runs before, and says what it left out", async (t) => {
  const fake = new FakeAamio({ now: Math.floor(Date.now() / 1000) });
  const { poster, first, second, homeA } = await board(t, fake);
  await poster.partnerAdd("first", first.keys.public);
  await first.partnerAdd("poster", poster.keys.public);
  await poster.read();
  const one = await poster.boardPost({ kind: "need", title: "the first", text: "who can help?" });
  const two = await poster.boardPost({ kind: "need", title: "the second", text: "and with this?" });
  await first.boardAnswer(one.post.id, { text: "about the first" });
  await poster.close();
  const { cli } = await serveFake(t, fake);
  const said = (run) => {
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };

  const now = said(await cli(homeA, "board", "replies"));
  assert.deepEqual(Object.keys(now), ["replies", "left_out", "reply_address", "attention"]);
  assert.deepEqual([now.replies.map((m) => [m.body.text, m.archived]), now.left_out, now.reply_address.open, now.reply_address.w, now.attention], [[["about the first", true]], 0, true, one.inbox, []]);

  // More arrives: an answer to the second post, and a plain message on the inbox that no board command reads.
  await second.boardAnswer(two.post.id, { text: "about the second" });
  await first.send("poster", { text: "a plain line on the inbox" });
  const later = said(await cli(homeA, "board", "replies", "--post", one.post.id));
  assert.deepEqual(Object.keys(later), ["replies", "left_out", "reply_address", "note", "others_on_the_board_inbox", "attention"]);
  assert.deepEqual([later.replies.map((m) => [m.body.text, m.from_archive]), later.left_out, later.others_on_the_board_inbox], [[["about the first", true]], 1, 1]);
  assert.equal(later.note, "1 message(s) on your inboxes are not listed here, because they name no post of yours and did not arrive on a board inbox. aamio read shows every message.");
  const none = said(await cli(homeA, "board", "replies", "--post", "p".repeat(20)));
  assert.deepEqual([none.replies, none.left_out, none.others_on_the_board_inbox, none.attention.map((note) => note.state)], [[], 2, 2, ["filtered"]]);
  // The inbox was left alone by all three: read hands the plain message over now, for the first time.
  const read = said(await cli(homeA, "read"));
  assert.deepEqual(read.messages.map((m) => [m.channel, m.body.text, m.replay]), [["inbox", "a plain line on the inbox", false]]);
  const all = said(await cli(homeA, "board", "replies", "--wait", "1"));
  assert.deepEqual([all.replies.map((m) => m.body.text), all.left_out], [["about the first", "about the second"], 1]);

  // With nothing kept, by the home's choice: a run lists what it read itself and no more.
  assert.equal(said(await cli(homeA, "archive", "off")).policy.mode, "off");
  assert.equal(said(await cli(homeA, "archive", "prune", "--all")).files, 0);
  await first.boardAnswer(one.post.id, { text: "after the archive was turned off" });
  assert.deepEqual(said(await cli(homeA, "board", "replies")).replies.map((m) => [m.body.text, m.archive_off]), [["after the archive was turned off", true]]);
  assert.deepEqual(said(await cli(homeA, "board", "replies")).replies, []);
  // And for one command, whatever the home says.
  assert.equal(said(await cli(homeA, "archive", "keep")).policy.mode, "keep");
  await first.boardAnswer(one.post.id, { text: "read with --no-archive" });
  assert.deepEqual(said(await cli(homeA, "--no-archive", "board", "replies")).replies.map((m) => [m.body.text, m.archive_off]), [["read with --no-archive", true]]);
  assert.deepEqual(said(await cli(homeA, "board", "replies")).replies, []);
  const status = said(await cli(homeA, "archive"));
  assert.deepEqual([status.policy.mode, status.files], ["keep", 0]);
});
