import { deflateSync } from "node:zlib";
import { TooLong } from "./errors.js";

/*
 * QR codes made on this machine: byte mode, error correction level M, versions 1 to 10.
 *
 * ISO/IEC 18004. The longest card is 80 bytes, version 5 at level M, 37
 * modules wide; the largest version here, 10, holds 213 bytes. Level M
 * restores about 15 percent of a code, which a screen seen across a room
 * needs, and keeps the modules large: the same card at level H would be
 * version 8, 49 modules wide. The quiet zone around the code is the four
 * modules the standard asks for.
 *
 * Reed-Solomon over GF(256) with the primitive polynomial 0x11d and first
 * consecutive root 0: the field and generator of the earshot add-on's codec,
 * which QR uses too. Of the eight masks, the one with the lowest penalty by
 * the four rules of the standard is used, the first of them on a tie, with the
 * rules counted as ZXing counts them and the area outside the code taken as
 * light.
 *
 * A code is drawn three ways: PNG, one bit a pixel; SVG, the dark modules as
 * one path; and text, two rows of modules to a line of block characters, with
 * the light modules drawn so it reads on a terminal with a dark background.
 * The same as aamio-python's aamio_qrcast.symbol and aamio-php's Symbol,
 * module for module: the fingerprints in the tests of all three are the same.
 */

export const LEVEL = "M";
// M is 00 in the format information: L 01, M 00, Q 11, H 10.
export const LEVEL_BITS = 0;
export const MAX_VERSION = 10;
export const QUIET = 4;

// Per version at level M: error correction codewords per block, and the blocks as [count, data codewords].
export const BLOCKS = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
// The centres of the alignment patterns, rows and columns alike.
export const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const PAD = [0xec, 0x11];
// The penalty weights of the standard.
const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;
const FINDER_LIKE = [true, false, true, true, true, false, true];

export const TEXT_FULL = "█";
export const TEXT_UPPER = "▀";
export const TEXT_LOWER = "▄";
export const TEXT_EMPTY = " ";

// ------------------------------------------------------------------ Reed-Solomon over GF(256)

const EXP = new Array(512).fill(0);
const LOG = new Array(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generator(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const product = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      product[j] ^= g[j];
      product[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = product;
  }
  return g;
}

/** The nsym error correction codewords of a block: the remainder of message times x^nsym by the generator. */
export function parity(message, nsym) {
  const g = generator(nsym);
  const out = [...message, ...new Array(nsym).fill(0)];
  for (let i = 0; i < message.length; i++) {
    const c = out[i];
    if (c !== 0) for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], c);
  }
  return out.slice(message.length);
}

// ------------------------------------------------------------------ data

/** The data codewords of a version at level M. */
export function capacity(version) {
  return BLOCKS[version][1].reduce((total, [count, size]) => total + count * size, 0);
}

function countBits(version) {
  return version < 10 ? 8 : 16;
}

export function fits(length, version) {
  return 4 + countBits(version) + 8 * length <= 8 * capacity(version);
}

export function maxBytes() {
  return Math.floor((8 * capacity(MAX_VERSION) - 4 - countBits(MAX_VERSION)) / 8);
}

export function smallestVersion(length) {
  for (let version = 1; version <= MAX_VERSION; version++) if (fits(length, version)) return version;
  throw new TooLong(`${length} bytes is more than a version ${MAX_VERSION} code at level M holds: ${maxBytes()} bytes at most.`);
}

/** The bytes a code carries: text as UTF-8, bytes as they are. */
function bytesOf(data) {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

/** Mode, count, the bytes, the terminator and the padding, as codewords. */
export function dataCodewords(data, version) {
  const bytes = bytesOf(data);
  const room = 8 * capacity(version);
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, room - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = i; j < i + 8; j++) value = (value << 1) | bits[j];
    words.push(value);
  }
  for (let turn = 0; words.length < capacity(version); turn++) words.push(PAD[turn % 2]);
  return words;
}

/** The data and error correction codewords, split into blocks and interleaved. */
export function codewords(data, version) {
  const [ec, groups] = BLOCKS[version];
  const words = dataCodewords(data, version);
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let k = 0; k < count; k++) {
      blocks.push(words.slice(at, at + size));
      at += size;
    }
  }
  const checks = blocks.map((block) => parity(block, ec));
  const out = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < ec; i++) for (const check of checks) out.push(check[i]);
  return out;
}

// ------------------------------------------------------------------ the matrix

function formatBits(mask) {
  const data = (LEVEL_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

class Grid {
  constructor(version) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  put(x, y, dark) {
    this.dark[y][x] = dark;
    this.reserved[y][x] = true;
  }

  patterns() {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.put(6, i, i % 2 === 0);
      this.put(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            this.put(x, y, ring !== 2 && ring !== 4);
          }
        }
      }
    }
    const centres = ALIGNMENT[this.version];
    const last = centres.length - 1;
    centres.forEach((cy, i) => {
      centres.forEach((cx, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    // Reserved now and drawn again with the mask chosen.
    this.format(0);
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.put(a, b, bit);
        this.put(b, a, bit);
      }
    }
  }

  format(mask) {
    const size = this.size;
    const bits = formatBits(mask);
    const bit = (i) => ((bits >> i) & 1) === 1;
    for (let i = 0; i < 6; i++) this.put(8, i, bit(i));
    this.put(8, 7, bit(6));
    this.put(8, 8, bit(7));
    this.put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.put(8, size - 15 + i, bit(i));
    this.put(8, size - 8, true);
  }

  place(words) {
    const size = this.size;
    const total = words.length * 8;
    let i = 0;
    let right = size - 1;
    while (right >= 1) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (!this.reserved[y][x] && i < total) {
            this.dark[y][x] = ((words[i >> 3] >> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
      right -= 2;
    }
  }

  masked(mask) {
    const size = this.size;
    const out = this.dark.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!this.reserved[y][x] && inverts(mask, x, y)) out[y][x] = !out[y][x];
    return out;
  }
}

function inverts(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Rules 1 and 3 for one row or column. */
function linePenalty(line) {
  let score = 0;
  const size = line.length;
  let run = 1;
  for (let i = 1; i <= size; i++) {
    if (i < size && line[i] === line[i - 1]) {
      run++;
      continue;
    }
    if (run >= 5) score += N1 + run - 5;
    run = 1;
  }
  for (let i = 0; i < size - 6; i++) {
    let like = true;
    for (let k = 0; k < 7 && like; k++) like = line[i + k] === FINDER_LIKE[k];
    if (!like) continue;
    let before = true;
    for (let k = Math.max(0, i - 4); k < i; k++) before = before && !line[k];
    let after = true;
    for (let k = i + 7, end = Math.min(size, i + 11); k < end; k++) after = after && !line[k];
    if (before || after) score += N3;
  }
  return score;
}

export function penalty(dark) {
  const size = dark.length;
  let score = 0;
  for (let y = 0; y < size; y++) score += linePenalty(dark[y]);
  for (let x = 0; x < size; x++) score += linePenalty(dark.map((row) => row[x]));
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const here = dark[y][x];
      if (here === dark[y][x + 1] && here === dark[y + 1][x] && here === dark[y + 1][x + 1]) score += N2;
    }
  }
  let count = 0;
  for (const row of dark) for (const module of row) if (module) count++;
  const total = size * size;
  return score + Math.floor((Math.abs(count * 2 - total) * 10) / total) * N4;
}

/** A QR code: its version, its mask and its modules, row by row, true for dark. */
export class Code {
  constructor(version, mask, modules) {
    this.version = version;
    this.mask = mask;
    this.modules = modules;
    this.size = modules.length;
  }

  /** The modules with a light border of this many modules around. */
  rows(border = QUIET) {
    const width = this.size + 2 * border;
    const light = () => new Array(width).fill(false);
    const edge = new Array(border).fill(false);
    const out = [];
    for (let i = 0; i < border; i++) out.push(light());
    for (const row of this.modules) out.push([...edge, ...row, ...edge]);
    for (let i = 0; i < border; i++) out.push(light());
    return out;
  }
}

/** The QR code for these bytes, in the smallest version unless one is given, with the best mask unless one is given. */
export function encode(data, version = null, mask = null) {
  const bytes = bytesOf(data);
  if (version === null) {
    version = smallestVersion(bytes.length);
  } else if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION || !fits(bytes.length, version)) {
    throw new TooLong(`${bytes.length} bytes do not fit a version ${version} code at level M.`);
  }
  const grid = new Grid(version);
  grid.patterns();
  grid.place(codewords(bytes, version));
  if (mask === null) {
    let best = null;
    for (let candidate = 0; candidate < 8; candidate++) {
      grid.format(candidate);
      const score = penalty(grid.masked(candidate));
      if (best === null || score < best[0]) best = [score, candidate];
    }
    mask = best[1];
  }
  grid.format(mask);
  return new Code(version, mask, grid.masked(mask));
}

// ------------------------------------------------------------------ drawing

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}

/** The CRC of a PNG chunk, as zlib counts it. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** The PNG rows before compression: a filter byte of 0, then one bit a pixel, 0 for dark. */
export function scanlines(symbol, scale, border = QUIET) {
  const lines = [];
  for (const row of symbol.rows(border)) {
    const line = [0];
    let acc = 0;
    let filled = 0;
    for (const dark of row) {
      for (let k = 0; k < scale; k++) {
        acc = (acc << 1) | (dark ? 0 : 1);
        filled++;
        if (filled === 8) {
          line.push(acc);
          acc = 0;
          filled = 0;
        }
      }
    }
    if (filled > 0) line.push((acc << (8 - filled)) & 0xff);
    const packed = Buffer.from(line);
    for (let k = 0; k < scale; k++) lines.push(packed);
  }
  return Buffer.concat(lines);
}

export function png(symbol, scale = 10, border = QUIET) {
  const side = (symbol.size + 2 * border) * scale;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  // One bit a pixel, greyscale, and the three methods the format has one of each of.
  header.writeUInt8(1, 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines(symbol, scale, border), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function svg(symbol, border = QUIET) {
  const rows = symbol.rows(border);
  const side = rows.length;
  let path = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < side) {
      if (row[x]) {
        const start = x;
        while (x < side && row[x]) x++;
        path += `M${start} ${y}h${x - start}v1h-${x - start}z`;
      } else {
        x++;
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="100%" height="100%" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="${path}"/></svg>\n`;
}

export function text(symbol, border = QUIET) {
  const rows = symbol.rows(border);
  const side = rows.length;
  const lines = [];
  for (let y = 0; y < side; y += 2) {
    const top = rows[y];
    const bottom = y + 1 < side ? rows[y + 1] : null;
    let line = "";
    for (let x = 0; x < side; x++) {
      const upper = !top[x];
      const lower = bottom !== null && !bottom[x];
      line += upper && lower ? TEXT_FULL : upper ? TEXT_UPPER : lower ? TEXT_LOWER : TEXT_EMPTY;
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

/** The modules as one line of 0 and 1, row by row, after the version and the mask: the same in all three runtimes. */
export function fingerprint(symbol) {
  let bits = "";
  for (const row of symbol.modules) for (const module of row) bits += module ? "1" : "0";
  return `${symbol.version}:${symbol.mask}:${bits}`;
}
