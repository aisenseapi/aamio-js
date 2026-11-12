// The QR code the qrcast add-on makes on this machine, and its card: the modules, the mask, the three drawings, and
// the card. Offline. The fingerprints are aamio-python's and aamio-php's too (tests/test_qrcast_symbol.py and
// tests/symbol.inc.php there), and vectors.json was written from aamio-python's edition and held against
// aamio-php's, so a code made by one runtime is the code made by the others, module for module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import * as card from "../src/card.js";
import { NotUnderstood, Refused, TooLong } from "../src/errors.js";
import { PICTURE_PIXELS } from "../src/process.js";
import * as symbol from "../src/symbol.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const ADDRESS = "k7rq2m4xw5tbz3yd6ena";
const LONGEST = "aamio:scope/" + ADDRESS + "?n=stue-tv-" + "a".repeat(24) + "&t=1794150000";
// The fingerprint of each code, sha256 of symbol.fingerprint(): version, mask and every module.
const FINGERPRINTS = [
  [LONGEST, 5, 4, "c80e34254889d0abbbb0e2d68760fec352fd2e458a990790c1f43eea99ffd510"],
  ["aamio:scope/" + ADDRESS, 3, 3, "20f3fbe17a0696a692b92463bce836d06c5d71912232db90355b26103a6f055d"],
  ["aamio:scope/" + ADDRESS + "?n=stue-tv&t=1794150000", 4, 2, "27deb2321902abd642a7730bad86121fc1f1106985e126c834b9a74d580e35d6"],
  ["aamio:" + "z".repeat(207), 10, 1, "2329f3f5446585d68029889d04fcffe6e27d7235d8dcae222eb9a4ffef00cd68"],
];
const bits = (rows) => rows.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

// The chunks of a PNG by name, each with its CRC checked.
function chunksOf(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = {};
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), symbol.crc32(png.subarray(at + 4, at + 8 + length)), `the CRC of ${kind}`);
    chunks[kind] = body;
    at += 12 + length;
  }
  return chunks;
}

test("each code is the one aamio-python and aamio-php make", () => {
  for (const [text, version, mask, fingerprint] of FINGERPRINTS) {
    const code = symbol.encode(text);
    assert.deepEqual([code.version, code.mask, sha(symbol.fingerprint(code))], [version, mask, fingerprint], `${Buffer.byteLength(text)} bytes`);
  }
});

test("every vector written from aamio-python's edition is made the same here: version, mask, modules, drawings and the penalty of each mask", () => {
  assert.equal(vectors.symbols.length, 28);
  for (const row of vectors.symbols) {
    const code = symbol.encode(row.text);
    assert.deepEqual(
      { bytes: Buffer.byteLength(row.text), version: code.version, mask: code.mask, size: code.size, fingerprint: sha(symbol.fingerprint(code)), scanlines_4: sha(symbol.scanlines(code, 4)), svg: sha(symbol.svg(code)), text_drawing: sha(symbol.text(code)) },
      { bytes: row.bytes, version: row.version, mask: row.mask, size: row.size, fingerprint: row.fingerprint, scanlines_4: row.scanlines_4, svg: row.svg, text_drawing: row.text_drawing },
      `${row.bytes} bytes`,
    );
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => symbol.penalty(symbol.encode(row.text, code.version, mask).modules)), row.penalties, `the penalties for ${row.bytes} bytes`);
  }
  // Every version with every mask, for one byte and for as many as the version holds.
  assert.equal(vectors.forced.length, 160);
  for (const row of vectors.forced) {
    assert.equal(sha(symbol.fingerprint(symbol.encode(row.text, row.version, row.mask))), row.fingerprint, `version ${row.version} with mask ${row.mask}`);
  }
  const a = symbol.encode("a", 1, 0);
  assert.equal(symbol.fingerprint(a), vectors.drawings.longest.fingerprint_a_1_0);
  assert.equal(symbol.svg(a), vectors.drawings.longest.svg_text, "the SVG, character for character");
  assert.equal(symbol.text(a), vectors.drawings.longest.text_text, "and the text");
});

test("the drawings are the ones the other runtimes make", () => {
  const code = symbol.encode(LONGEST);
  const scale = Math.max(4, Math.floor(PICTURE_PIXELS / (code.size + 2 * symbol.QUIET)));
  assert.equal(scale, 22);
  assert.equal(scale, vectors.drawings.longest.scale);
  assert.equal(sha(symbol.scanlines(code, 22)), "6f4d72248b97fcaa2d6699d0470fec1e1f6610ecc99316ff7a6e2fc60e0279d2", "the PNG rows, pixel for pixel");
  assert.equal(sha(symbol.scanlines(code, 10)), "6bdbdf892f2108ce4c528108681086e42467fadd49dd6cae9aa1c6782f90d1b0");
  assert.equal(sha(symbol.svg(code)), "f409c9bbe5290eb91ff020223a61d6a3a92c4ade36f0279be3955efc000fe017");
  assert.equal(sha(symbol.text(code)), "eb18d63eff382e15e4aea76c62add5698af8a2cb29c70bd6496ed20fecec88bb");
});

test("one byte is the codewords of the standard, with its Reed-Solomon", () => {
  // Mode 0100, count 00000001, "a", the terminator, then 0xEC and 0x11 by turns.
  const words = [64, 22, 16, ...Array.from({ length: 6 }, () => [236, 17]).flat(), 236];
  assert.deepEqual(symbol.dataCodewords("a", 1), words);
  assert.deepEqual(symbol.dataCodewords(Buffer.from("a"), 1), words, "bytes are taken as they are");
  assert.deepEqual(symbol.parity(words, 10), [252, 160, 39, 162, 98, 107, 50, 59, 111, 28]);
  assert.equal(sha(symbol.fingerprint(symbol.encode("a", 1, 0))), "850bb7579ec61475a94a68e7c87801f2b16c24b0cd4f5e9c8635a749bb3e4b7c");
  assert.equal(symbol.encode("ø").version, 1, "a letter outside ASCII is its two bytes of UTF-8");
  assert.deepEqual(symbol.dataCodewords("ø", 1).slice(0, 4), [0x40, 0x2c, 0x3b, 0x80]);
});

test("the smallest version is taken, and 213 bytes is the most", () => {
  assert.deepEqual([1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85].map((length) => symbol.smallestVersion(length)), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  assert.equal(symbol.smallestVersion(80), 5);
  assert.equal(symbol.encode(LONGEST).size, 37, "the longest card is 37 modules at level M");
  assert.equal(symbol.maxBytes(), 213);
  assert.equal(symbol.encode("x".repeat(213)).version, 10);
  assert.throws(() => symbol.encode("x".repeat(214)), (error) => error instanceof TooLong && error.message.includes("213 bytes at most"));
  assert.throws(() => symbol.encode("x".repeat(50), 2), (error) => error instanceof TooLong && error.message === "50 bytes do not fit a version 2 code at level M.");
  assert.throws(() => symbol.encode("x", 11), TooLong);
  assert.throws(() => symbol.encode("x", 0), TooLong);
});

test("the mask chosen has the lowest penalty, the first on a tie", () => {
  for (const text of [LONGEST, "aamio:scope/" + ADDRESS, "x".repeat(100)]) {
    const chosen = symbol.encode(text);
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => symbol.penalty(symbol.encode(text, chosen.version, mask).modules));
    assert.equal(chosen.mask, scores.indexOf(Math.min(...scores)), text.slice(0, 20));
  }
});

test("the function patterns are where the standard puts them", () => {
  const code = symbol.encode(LONGEST);
  const rows = code.modules;
  const size = code.size;
  const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    assert.deepEqual(bits(rows.slice(y0, y0 + 7).map((row) => row.slice(x0, x0 + 7))), finder);
  }
  assert.deepEqual(rows[6].slice(8, size - 8), Array.from({ length: size - 16 }, (_, i) => (i + 8) % 2 === 0), "the timing pattern");
  assert.equal(rows[size - 8][8], true, "the dark module");
  // The one alignment pattern of version 5, centred on (30, 30).
  assert.deepEqual(bits(rows.slice(28, 33).map((row) => row.slice(28, 33))), ["11111", "10001", "10101", "10001", "11111"]);
});

test("the PNG is one bit a pixel with four modules of white around, and every module is where it belongs", () => {
  const code = symbol.encode(LONGEST);
  const png = symbol.png(code, 10);
  const chunks = chunksOf(png);
  assert.deepEqual(Object.keys(chunks), ["IHDR", "IDAT", "IEND"]);
  const header = chunks.IHDR;
  assert.deepEqual([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[10], header[11], header[12]], [450, 450, 1, 0, 0, 0, 0]);
  const raw = inflateSync(chunks.IDAT);
  assert.ok(raw.equals(symbol.scanlines(code, 10)), "what the PNG holds is the rows the other runtimes pin");
  const stride = 1 + Math.floor((450 + 7) / 8);
  assert.equal(raw.length, stride * 450);
  const pixel = (x, y) => ((raw[y * stride + 1 + Math.floor(x / 8)] >> (7 - (x % 8))) & 1) === 0;
  const sampled = Array.from({ length: 45 }, (_, y) => Array.from({ length: 45 }, (_, x) => pixel(x * 10 + 5, y * 10 + 5)));
  assert.deepEqual(sampled, code.rows(), "every module is ten by ten pixels, the quiet zone included");
  for (let y = 0; y < 450; y++) assert.equal(raw[y * stride], 0, "no filter on any row");
  for (let y = 0; y < 40; y++) for (let x = 0; x < 450; x++) assert.equal(pixel(x, y), false, "four modules of white at the top");
  assert.equal(symbol.crc32(Buffer.from("IEND", "latin1")), 0xae426082, "the CRC is zlib's");
});

test("the SVG and the text give the modules back", () => {
  const code = symbol.encode(LONGEST);
  const drawing = symbol.svg(code);
  assert.ok(drawing.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"') && drawing.includes('shape-rendering="crispEdges"') && drawing.endsWith("</svg>\n"));
  const back = Array.from({ length: 45 }, () => new Array(45).fill(false));
  for (const [, x, y, run] of drawing.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let i = 0; i < Number(run); i++) back[Number(y)][Number(x) + i] = true;
  assert.deepEqual(back, code.rows());
  const lines = symbol.text(code).split("\n").slice(0, -1);
  assert.equal(lines.length, 23);
  assert.ok(lines.every((line) => line.length === 45));
  const rows = [];
  for (const line of lines) {
    rows.push([...line].map((ch) => ch !== symbol.TEXT_FULL && ch !== symbol.TEXT_UPPER));
    rows.push([...line].map((ch) => ch !== symbol.TEXT_FULL && ch !== symbol.TEXT_LOWER));
  }
  assert.deepEqual(rows.slice(0, 45), code.rows());
  assert.deepEqual([...new Set(lines[0])], [symbol.TEXT_FULL], "light is drawn, for a terminal with a dark background");
});

test("the card is made and read as the other editions make and read it, outcome for outcome", () => {
  assert.equal(vectors.cards_made.length, 768);
  for (const [address, name, expires, outcome] of vectors.cards_made) {
    let got;
    try {
      got = { card: card.make(address, name, expires) };
    } catch (error) {
      assert.ok(error instanceof Refused, `${JSON.stringify([address, name, expires])}: ${error}`);
      got = { refused: error.reason };
      assert.equal(error.fix, vectors.refusals[error.reason], "with the same words");
    }
    assert.deepEqual(got, outcome, JSON.stringify([address, name, expires]));
  }
  assert.equal(vectors.cards_read.length, 22);
  for (const row of vectors.cards_read) {
    let got;
    try {
      got = { card: card.read(row.text) };
    } catch (error) {
      assert.ok(error instanceof NotUnderstood, `${JSON.stringify(row.text)}: ${error}`);
      got = { not_understood: error.reason };
    }
    assert.deepEqual(got, "card" in row ? { card: row.card } : { not_understood: row.not_understood }, JSON.stringify(row.text));
  }
  // What a card from elsewhere may carry is not a way into this object.
  for (const text of ["aamio:scope/" + ADDRESS + "?constructor=x", "aamio:scope/" + ADDRESS + "?__proto__=x", "aamio:scope/" + ADDRESS + "?toString=x"]) {
    assert.throws(() => card.read(text), (error) => error instanceof NotUnderstood && error.reason === "not_this_version");
  }
  assert.equal(card.make(ADDRESS, undefined, undefined), "aamio:scope/" + ADDRESS, "an argument left out is one that is not there");
});

test("a key is never shown", () => {
  for (const key of ["abcdefghijklmnopqrstuvwxyz", "0123456789abcdefghijklmnop", "a1".repeat(32)]) {
    assert.throws(() => card.make(key), (error) => error instanceof Refused && error.reason === "a_key_not_an_address" && error.fix.includes("never shown"));
  }
  const longest = card.make(ADDRESS, "R" + "x".repeat(31), 1794150000);
  assert.equal(Buffer.byteLength(longest), 80, "the longest card of this century is 80 bytes");
  assert.equal(symbol.encode(longest).size, 37, "a code of 37 by 37 modules");
});
