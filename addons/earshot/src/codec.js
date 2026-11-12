/*
 * aisense-audio-v2 on this machine: the sound aisenseapi.com makes and reads,
 * made and read here instead.
 *
 * A port of aisense's own implementation, func_audio_v2.php and the WAV
 * reading of func_audio_codec.php (aisense-free-public-rest-apis,
 * code/pro-api/libs), so a card can be played and heard with nothing leaving
 * the machine. It makes the same sound as aisense byte for byte, and each
 * reads the other's. The same as aamio-python's aamio_earshot.codec and
 * aamio-php's Aamio\Earshot\Codec.
 *
 * Each 20 ms symbol carries two bits as one of four tones, and every symbol
 * position uses its own set of four, cycling through three sets, so the echo
 * of the two symbols before is never a candidate for the current one. Each
 * mode has twelve tones on a 200 Hz grid: audible 800 to 3000 Hz, high 14.0
 * to 16.2 kHz, ultrasound 18.0 to 20.2 kHz. The packet is a 32-symbol
 * preamble, an 8-symbol timing marker before every 16 bytes, and the bytes,
 * four symbols each, most significant pair first: header "AS", version 3 and
 * the payload length with 8 Reed-Solomon bytes, then the payload and a CRC32
 * of header and payload with 16 + 2 * floor((n + 4) / 16) Reed-Solomon bytes.
 * Reed-Solomon over GF(256), with the primitive polynomial 0x11d and first
 * consecutive root 0.
 *
 * The decoder brings each band to complex baseband with a third-order CIC
 * decimator, finds the preamble with a sliding DFT, learns each tone's
 * received level from it, finds every timing marker again for clock drift,
 * reads each symbol in its own set and keeps how sure it was, and tries
 * Reed-Solomon on errors alone, then with the least sure bytes erased.
 * Nothing is returned unless the CRC holds. Plain JavaScript: no dependency,
 * no network.
 */

export const SAMPLE_RATE = 48000;
export const SYMBOL_SECONDS = 0.020;
export const PREAMBLE = [0, 3, 0, 3, 1, 2, 1, 2, 3, 1, 0, 2, 0, 1, 3, 2, 1, 0, 2, 3, 2, 0, 3, 1, 3, 2, 0, 1, 2, 1, 3, 0];
export const MARKER = [3, 0, 2, 0, 1, 3, 1, 2];
export const MAX_BYTES = 128;
export const MAX_WAV_BYTES = 8388608;
export const MAX_SECONDS = 40;
export const PROTOCOL = "aisense-audio-v2";
export const VERSION = 3;
export const SETS = {
  audible: [[800, 1400, 2200, 3000], [1000, 1800, 2400, 2800], [1200, 1600, 2000, 2600]],
  high: [[14000, 14600, 15200, 15800], [14200, 14800, 15400, 16000], [14400, 15000, 15600, 16200]],
  ultrasound: [[18000, 18600, 19200, 19800], [18200, 18800, 19400, 20000], [18400, 19000, 19600, 20200]],
};
export const MODES = ["audible", "high", "ultrasound"];
export const BLOCK = 16;
export const HEADER_PARITY = 8;
export const LEVEL = 0.55;
export const RAMP_SECONDS = 0.002;
export const LEAD_SECONDS = 0.25;
export const WINDOW_START = 0.25;
export const WINDOW_SECONDS = 0.010;
export const DECIMATION = 16;

/** A file this codec does not read, with aisense's words for it. */
export class BadRecording extends Error {}

/** PHP's round() to a whole number: halves away from zero, where Math.round takes a negative half towards zero. */
export function phpRound(x) {
  return x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
}

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

function div(a, b) {
  if (b === 0) throw new RangeError("Reed-Solomon division by zero.");
  if (a === 0) return 0;
  return EXP[((LOG[a] - LOG[b]) % 255 + 255) % 255];
}

/** Polynomials with the highest power first. */
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

/** Polynomials with the lowest power first, for the decoder. */
function polyMulLow(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    if (p[i]) {
      for (let j = 0; j < q.length; j++) r[i + j] ^= mul(p[i], q[j]);
    }
  }
  return r;
}

function polyAddLow(p, q) {
  const n = Math.max(p.length, q.length);
  const r = new Array(n);
  for (let i = 0; i < n; i++) r[i] = (i < p.length ? p[i] : 0) ^ (i < q.length ? q[i] : 0);
  return r;
}

function polyEvalLow(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
  return y;
}

function generator(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, EXP[i]]);
  return g;
}

/** The message followed by nsym parity bytes. */
export function rsEncode(message, nsym) {
  const g = generator(nsym);
  const length = message.length;
  const out = new Array(length + nsym).fill(0);
  for (let i = 0; i < length; i++) out[i] = message[i];
  for (let i = 0; i < length; i++) {
    const c = out[i];
    if (c) {
      for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], c);
    }
  }
  const coded = Buffer.alloc(length + nsym);
  for (let i = 0; i < length; i++) coded[i] = message[i];
  for (let i = length; i < length + nsym; i++) coded[i] = out[i];
  return coded;
}

function syndromes(msg, nsym) {
  const s = new Array(nsym);
  for (let i = 0; i < nsym; i++) s[i] = polyEval(msg, EXP[i]);
  return s;
}

/**
 * The corrected message without parity, or null: up to nsym / 2 byte errors,
 * more with known erasures (2 * errors + erasures <= nsym).
 */
export function rsDecode(data, nsym, erasures = []) {
  const msg = Array.from(data);
  const n = msg.length;
  const known = [...new Set(erasures)].sort((a, b) => a - b);
  const ne = known.length;
  if (ne > nsym || n <= nsym) return null;
  const s = syndromes(msg, nsym);
  if (Math.max(...s) === 0) return Buffer.from(msg.slice(0, n - nsym));
  let loc = [1];
  for (const pos of known) loc = polyMulLow(loc, [1, EXP[n - 1 - pos]]);
  let lam = loc.slice();
  let b = loc.slice();
  let bigL = ne;
  for (let r = ne; r < nsym; r++) {
    let delta = 0;
    for (let j = 0; j < lam.length; j++) {
      if (r - j >= 0) delta ^= mul(lam[j], s[r - j]);
    }
    b = [0, ...b];
    if (delta) {
      const scaled = b.map((c) => mul(delta, c));
      if (2 * bigL <= r + ne) {
        const next = polyAddLow(lam, scaled);
        b = lam.map((c) => div(c, delta));
        lam = next;
        bigL = r + 1 + ne - bigL;
      } else {
        lam = polyAddLow(lam, scaled);
      }
    }
  }
  while (lam.length > 1 && lam[lam.length - 1] === 0) lam.pop();
  const errs = lam.length - 1;
  if (2 * (errs - ne) + ne > nsym) return null;
  const positions = [];
  for (let pos = 0; pos < n; pos++) {
    if (polyEvalLow(lam, EXP[(255 - (n - 1 - pos)) % 255]) === 0) positions.push(pos);
  }
  if (positions.length !== errs) return null;
  const omega = polyMulLow(s, lam).slice(0, nsym);
  const dlam = [];
  for (let i = 1; i < lam.length; i++) dlam.push(i % 2 === 1 ? lam[i] : 0);
  for (const pos of positions) {
    const xk = EXP[n - 1 - pos];
    const xinv = EXP[(255 - (n - 1 - pos)) % 255];
    const den = polyEvalLow(dlam, xinv);
    if (den === 0) return null;
    msg[pos] ^= mul(xk, div(polyEvalLow(omega, xinv), den));
  }
  if (Math.max(...syndromes(msg, nsym)) !== 0) return null;
  return Buffer.from(msg.slice(0, n - nsym));
}

// ------------------------------------------------------------------ the packet and the sound

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

/** CRC-32 as zlib and PHP's crc32b give it, as an unsigned number. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function bodyParity(length) {
  return 16 + 2 * Math.floor((length + 4) / 16);
}

function crcBytes(header, payload) {
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([header, payload])), 0);
  return sum;
}

export function packetBytes(payload) {
  const length = payload.length;
  if (length < 1 || length > MAX_BYTES) throw new RangeError("Provide between 1 and 128 bytes.");
  const data = Buffer.from(payload);
  const header = Buffer.from([0x41, 0x53, VERSION, length]);
  const body = Buffer.concat([data, crcBytes(header, data)]);
  return Buffer.concat([rsEncode(header, HEADER_PARITY), rsEncode(body, bodyParity(length))]);
}

/** The wire symbols, values 0 to 3; symbol position k sounds in set k % 3. */
export function symbols(payload) {
  const data = packetBytes(payload);
  const out = PREAMBLE.slice();
  for (let i = 0; i < data.length; i++) {
    if (i % BLOCK === 0) out.push(...MARKER);
    const b = data[i];
    out.push((b >> 6) & 3, (b >> 4) & 3, (b >> 2) & 3, b & 3);
  }
  return out;
}

export function wav(pcm, rate = SAMPLE_RATE, channels = 1) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(pcm.length + 36, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/**
 * The WAV for 1 to 128 bytes in one of the three modes: mono 16-bit PCM at
 * 48 kHz, as aisense makes it. The arithmetic is written in the order the
 * other editions write it, so each sample is the same number rounded the
 * same way.
 */
export function encode(payload, mode = "audible") {
  if (!Object.hasOwn(SETS, mode)) throw new RangeError("Mode must be audible, high or ultrasound.");
  const sets = SETS[mode];
  const wire = symbols(payload);
  const rate = SAMPLE_RATE;
  const n = phpRound(SYMBOL_SECONDS * rate);
  const ramp = Math.trunc(RAMP_SECONDS * rate);
  const envelope = new Array(n).fill(1.0);
  for (let i = 0; i < ramp; i++) envelope[i] = envelope[n - 1 - i] = 0.5 - 0.5 * Math.cos(Math.PI * i / ramp);
  const tones = new Map();
  for (const chosen of sets) {
    for (const frequency of chosen) {
      const tone = Buffer.alloc(2 * n);
      for (let i = 0; i < n; i++) {
        tone.writeUInt16LE(phpRound(LEVEL * envelope[i] * Math.sin(2 * Math.PI * frequency * i / rate) * 32767) & 0xffff, 2 * i);
      }
      tones.set(frequency, tone);
    }
  }
  const quiet = Buffer.alloc(2 * Math.trunc(LEAD_SECONDS * rate));
  const parts = [quiet];
  for (let position = 0; position < wire.length; position++) parts.push(tones.get(sets[position % 3][wire[position]]));
  parts.push(quiet);
  return wav(Buffer.concat(parts));
}

// ------------------------------------------------------------------ reading a recording

const PCM = 1;
const EXTENSIBLE = 0xfffe;
/** KSDATAFORMAT_SUBTYPE_PCM, 00000001-0000-0010-8000-00aa00389b71, as its bytes lie in a file. */
export const PCM_SUBTYPE = Buffer.from("0100000000001000800000aa00389b71", "hex");

/**
 * The format of a WAV and where its samples lie, with the checks aisense
 * makes. One header more is taken than aisense takes: WAVE_FORMAT_EXTENSIBLE,
 * which many recorders write, when its subtype is PCM and every one of the 16
 * bits is used. The samples after it are the same as after a plain PCM
 * header, and extensible says so, for classicWav to give aisense the plain
 * one.
 */
function layout(data) {
  const size = data.length;
  if (size > MAX_WAV_BYTES) throw new BadRecording("WAV is larger than 8 MiB.");
  if (size < 44 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WAVE") {
    throw new BadRecording("Provide an uncompressed PCM16 WAV recording.");
  }
  if (data.readUInt32LE(4) + 8 !== size) throw new BadRecording("WAV length does not match its RIFF header.");
  let fmt = null;
  let chunk = null;
  let count = 0;
  let offset = 12;
  while (offset < size) {
    count += 1;
    if (count > 64) throw new BadRecording("WAV contains too many chunks.");
    if (offset + 8 > size) throw new BadRecording("Truncated WAV chunk header.");
    const tag = data.toString("latin1", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (length > size - start || start + length + (length & 1) > size) throw new BadRecording("Truncated WAV chunk.");
    if (tag === "fmt ") {
      if (fmt !== null || length < 16) throw new BadRecording("Invalid or duplicate WAV format chunk.");
      fmt = {
        format: data.readUInt16LE(start), channels: data.readUInt16LE(start + 2), rate: data.readUInt32LE(start + 4),
        bytesPerSecond: data.readUInt32LE(start + 8), align: data.readUInt16LE(start + 12), bits: data.readUInt16LE(start + 14), extensible: false,
      };
      if (fmt.format === EXTENSIBLE && length >= 40 && data.readUInt16LE(start + 16) >= 22 && data.readUInt16LE(start + 18) === fmt.bits
        && data.subarray(start + 24, start + 40).equals(PCM_SUBTYPE)) {
        fmt.format = PCM;
        fmt.extensible = true;
      }
    } else if (tag === "data") {
      if (chunk !== null) throw new BadRecording("Duplicate WAV data chunk.");
      chunk = { start, length };
    }
    offset = start + length + (length & 1);
  }
  if (fmt === null || chunk === null || fmt.format !== PCM || fmt.bits !== 16 || ![1, 2].includes(fmt.channels) || ![44100, 48000].includes(fmt.rate)) {
    throw new BadRecording("Use PCM16 WAV, mono or stereo, at 44100 or 48000 Hz.");
  }
  const stride = fmt.channels * 2;
  if (fmt.align !== stride || fmt.bytesPerSecond !== fmt.rate * stride || chunk.length % stride !== 0) throw new BadRecording("Invalid WAV sample alignment.");
  const samples = chunk.length / stride;
  if (samples < 1 || samples > MAX_SECONDS * fmt.rate) throw new BadRecording("Recording must contain at most 40 seconds of audio.");
  return { fmt, chunk, samples };
}

/**
 * The same recording under the plain PCM header, for aisense, which reads no
 * other: a WAVE_FORMAT_EXTENSIBLE file of 16-bit PCM is written again with
 * format 1 and its samples untouched. Any other file comes back as it was,
 * for aisense to judge.
 */
export function classicWav(data) {
  let found;
  try {
    found = layout(data);
  } catch (error) {
    if (!(error instanceof BadRecording)) throw error;
    return data;
  }
  if (!found.fmt.extensible) return data;
  return wav(Buffer.from(data.subarray(found.chunk.start, found.chunk.start + found.chunk.length)), found.fmt.rate, found.fmt.channels);
}

/**
 * The samples of the stronger channel and the recording's shape, with the
 * same checks aisense makes and the one header more that layout takes.
 */
export function parseWav(data) {
  const { fmt, chunk, samples } = layout(data);
  let channel = 0;
  if (fmt.channels === 2) {
    // A stereo microphone can put the useful signal in only one channel: use
    // the stronger one, without the phase cancellation of a naive mix.
    const energy = [0.0, 0.0];
    for (let sample = 0; sample < samples; sample += 211) {
      for (const side of [0, 1]) {
        const value = data.readInt16LE(chunk.start + sample * 4 + side * 2);
        energy[side] += value * value;
      }
    }
    channel = energy[1] > energy[0] ? 1 : 0;
  }
  const stride = fmt.channels * 2;
  const values = new Int16Array(samples);
  for (let i = 0, at = chunk.start + channel * 2; i < samples; i++, at += stride) values[i] = data.readInt16LE(at);
  return { samples: values, sample_rate: fmt.rate, channel, duration_seconds: samples / fmt.rate };
}

/** One band at complex baseband: mixed down by its centre and decimated by 16 with a third-order CIC filter. */
function baseband(samples, rate, centre) {
  const d = DECIMATION;
  const period = Math.floor(rate / 100);
  if (period * 100 !== rate || centre % 100 !== 0) throw new RangeError("The baseband needs a rate and centre on a 100 Hz grid.");
  const tr = new Float64Array(period);
  const ti = new Float64Array(period);
  for (let k = 0; k < period; k++) {
    tr[k] = Math.cos(-2 * Math.PI * centre * k / rate);
    ti[k] = Math.sin(-2 * Math.PI * centre * k / rate);
  }
  let i1r = 0.0, i1i = 0.0, i2r = 0.0, i2i = 0.0, i3r = 0.0, i3i = 0.0;
  let c1r = 0.0, c1i = 0.0, c2r = 0.0, c2i = 0.0, c3r = 0.0, c3i = 0.0;
  const total = Math.floor(samples.length / d);
  const zr = new Float64Array(total);
  const zi = new Float64Array(total);
  let made = 0;
  let idx = 0;
  let phase = 0;
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    i1r += s * tr[idx];
    i1i += s * ti[idx];
    idx += 1;
    if (idx === period) idx = 0;
    i2r += i1r;
    i2i += i1i;
    i3r += i2r;
    i3i += i2i;
    phase += 1;
    if (phase === d) {
      phase = 0;
      const t1r = i3r - c1r;
      const t1i = i3i - c1i;
      c1r = i3r;
      c1i = i3i;
      const t2r = t1r - c2r;
      const t2i = t1i - c2i;
      c2r = t1r;
      c2i = t1i;
      zr[made] = t2r - c3r;
      zi[made] = t2i - c3i;
      made += 1;
      c3r = t2r;
      c3i = t2i;
    }
  }
  return { zr, zi, fs: rate / d };
}

/** Tone powers of 10 ms windows at the given baseband start indexes. */
function powers(zr, zi, twiddle, starts) {
  const out = [];
  const n = zr.length;
  for (const start of starts) {
    const row = [];
    for (const [wr, wi] of twiddle) {
      let ar = 0.0;
      let ai = 0.0;
      for (let m = 0; m < wr.length; m++) {
        const k = start + m;
        if (k < 0 || k >= n) continue;
        const c = wr[m];
        const s = wi[m];
        ar += zr[k] * c - zi[k] * s;
        ai += zr[k] * s + zi[k] * c;
      }
      row.push(ar * ar + ai * ai);
    }
    out.push(row);
  }
  return out;
}

/** The band's tones, their index per set, and the DFT twiddles of a 10 ms window at the baseband rate. */
function plan(mode, fs) {
  const sets = SETS[mode];
  const tones = sets.flat().sort((a, b) => a - b);
  const index = new Map(tones.map((f, i) => [f, i]));
  const centre = (tones[0] + tones[tones.length - 1]) / 2;
  const length = phpRound(WINDOW_SECONDS * fs);
  const twiddle = tones.map((f) => {
    const wr = new Float64Array(length);
    const wi = new Float64Array(length);
    for (let m = 0; m < length; m++) {
      wr[m] = Math.cos(-2 * Math.PI * (f - centre) * m / fs);
      wi[m] = Math.sin(-2 * Math.PI * (f - centre) * m / fs);
    }
    return [wr, wi];
  });
  return { sets, tones, centre, length, twiddle, setIndex: sets.map((chosen) => chosen.map((f) => index.get(f))) };
}

/** Packet starts, best first: the preamble scored through a sliding DFT at every fourth baseband sample. */
function candidates(zr, zi, fs, band, keep = 6) {
  const length = band.length;
  const sym = SYMBOL_SECONDS * fs;
  const hop = 4;
  const count = band.tones.length;
  const rc = new Float64Array(count);
  const rs = new Float64Array(count);
  const leaveC = new Float64Array(count);
  const leaveS = new Float64Array(count);
  let exact = false;
  for (let j = 0; j < count; j++) {
    const a = 2 * Math.PI * (band.tones[j] - band.centre) / fs;
    rc[j] = Math.cos(a);
    rs[j] = Math.sin(a);
    // The sample leaving the window has turned through a * length since it
    // entered: at 48 kHz a whole number of cycles, at 44.1 kHz it must be
    // turned back.
    leaveC[j] = Math.cos(a * length);
    leaveS[j] = Math.sin(a * length);
    if (Math.abs(leaveC[j] - 1.0) > 1e-9 || Math.abs(leaveS[j]) > 1e-9) exact = true;
  }
  const offset = PREAMBLE.map((_, i) => phpRound(((i + WINDOW_START) * sym + length - 1) / hop));
  const expected = PREAMBLE.map((value, i) => band.setIndex[i % 3][value]);
  const span = offset[offset.length - 1] + 1;
  let ring = 1;
  while (ring < span + 2) ring <<= 1;
  const mask = ring - 1;
  const share = new Array(ring);
  for (let i = 0; i < ring; i++) share[i] = new Float64Array(count);
  const xr = new Float64Array(count);
  const xi = new Float64Array(count);
  let best = [];
  let floor = 0.5;
  const n = zr.length;
  let row = 0;
  const groups = band.setIndex;
  const p = new Float64Array(count);
  for (let k = 0; k < n; k++) {
    const nr = zr[k];
    const ni = zi[k];
    // The sample that leaves the window as this one enters it.
    let leftR = 0.0;
    let leftI = 0.0;
    if (k >= length) {
      leftR = zr[k - length];
      leftI = zi[k - length];
    }
    if (exact) {
      for (let j = 0; j < count; j++) {
        const br = xr[j] + nr - (leftR * leaveC[j] - leftI * leaveS[j]);
        const bi = xi[j] + ni - (leftR * leaveS[j] + leftI * leaveC[j]);
        xr[j] = br * rc[j] - bi * rs[j];
        xi[j] = br * rs[j] + bi * rc[j];
      }
    } else {
      const ar = nr - leftR;
      const ai = ni - leftI;
      for (let j = 0; j < count; j++) {
        const br = xr[j] + ar;
        const bi = xi[j] + ai;
        xr[j] = br * rc[j] - bi * rs[j];
        xi[j] = br * rs[j] + bi * rc[j];
      }
    }
    if (k % hop !== 0) continue;
    for (let j = 0; j < count; j++) p[j] = xr[j] * xr[j] + xi[j] * xi[j];
    const shares = new Float64Array(count);
    for (const members of groups) {
      const total = p[members[0]] + p[members[1]] + p[members[2]] + p[members[3]] + 1e-30;
      for (const t of members) shares[t] = p[t] / total;
    }
    share[row & mask] = shares;
    const first = row - span + 1;
    if (first >= 0) {
      let score = 0.0;
      for (let i = 0; i < offset.length; i++) score += share[(first + offset[i]) & mask][expected[i]];
      score /= offset.length;
      if (score > floor) {
        const start = first * hop;
        let merged = false;
        for (let b = 0; b < best.length; b++) {
          if (Math.abs(best[b][0] - start) < sym / 2) {
            if (score > best[b][1]) best[b] = [start, score];
            merged = true;
            break;
          }
        }
        if (!merged) {
          best.push([start, score]);
          if (best.length > keep) {
            best.sort((a, b) => b[1] - a[1]);
            best.pop();
            floor = Math.max(0.5, best[best.length - 1][1]);
          }
        }
      }
    }
    row += 1;
  }
  best = best.slice().sort((a, b) => b[1] - a[1]);
  return best;
}

function bitsChanged(a, b) {
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

/** Reed-Solomon on errors alone, then with the least sure bytes erased: the message and the bits it changed, or null. */
function correct(code, nsym, margins) {
  let got = rsDecode(code, nsym);
  if (got === null) {
    const order = margins.map((_, i) => i).sort((a, b) => margins[a] - margins[b]);
    for (const k of [Math.floor(nsym / 4), Math.floor(nsym / 2), Math.floor((3 * nsym) / 4), nsym]) {
      got = rsDecode(code, nsym, order.slice(0, k));
      if (got !== null) break;
    }
  }
  if (got === null) return null;
  return { message: got, bits: bitsChanged(code, rsEncode(got, nsym)) };
}

/** The packet at one candidate start, or null. */
function readPacket(zr, zi, fs, band, start) {
  const sym = SYMBOL_SECONDS * fs;
  const frac = WINDOW_START;
  const { twiddle, setIndex } = band;

  const read = (at, position, count, gain) => {
    const starts = [];
    for (let i = 0; i < count; i++) starts.push(phpRound(at + (i + frac) * sym));
    const rows = powers(zr, zi, twiddle, starts);
    return rows.map((row, i) => {
      const v = setIndex[(position + i) % 3].map((t) => row[t] / gain[t]);
      const total = v[0] + v[1] + v[2] + v[3] + 1e-30;
      return v.map((x) => x / total);
    });
  };

  const score = (at, position, values, gain) => {
    const rows = read(at, position, values.length, gain);
    let s = 0.0;
    for (let i = 0; i < values.length; i++) s += rows[i][values[i]];
    return s / values.length;
  };

  const flat = new Array(band.tones.length).fill(1.0);
  let bestStart = start;
  let bestScore = score(start, 0, PREAMBLE, flat);
  for (const shift of [-3, -2, -1, 1, 2, 3]) {
    const s = score(start + shift, 0, PREAMBLE, flat);
    if (s > bestScore) {
      bestStart = start + shift;
      bestScore = s;
    }
  }
  if (bestScore < 0.5) return null;
  // Each tone's received level while it was the one sent in the preamble.
  const starts = PREAMBLE.map((_, i) => phpRound(bestStart + (i + frac) * sym));
  const rows = powers(zr, zi, twiddle, starts);
  const heard = band.tones.map(() => []);
  PREAMBLE.forEach((value, i) => {
    const t = setIndex[i % 3][value];
    heard[t].push(rows[i][t]);
  });
  let gain = heard.map((values) => {
    if (!values.length) return 1.0;
    const sorted = values.slice().sort((a, b) => a - b);
    return Math.max(sorted[Math.floor(sorted.length / 2)], 1e-30);
  });
  const median = gain.slice().sort((a, b) => a - b)[Math.floor(gain.length / 2)];
  gain = gain.map((g) => g / median);

  const state = { at: bestStart + PREAMBLE.length * sym, position: PREAMBLE.length, index: 0 };

  const readBytes = (want) => {
    const out = [];
    const margins = [];
    for (let done = 0; done < want; done++) {
      if (state.index % BLOCK === 0) {
        let best = state.at;
        let bestS = -1.0;
        for (let ms = -16.0; ms <= 16.0; ms += 0.5) {
          const cand = state.at + ms * 0.001 * fs;
          const s = score(cand, state.position, MARKER, gain);
          if (s > bestS) {
            best = cand;
            bestS = s;
          }
        }
        state.at = best + MARKER.length * sym;
        state.position += MARKER.length;
      }
      let value = 0;
      let margin = 1.0;
      for (const r of read(state.at, state.position, 4, gain)) {
        const order = [0, 1, 2, 3].sort((a, b) => r[b] - r[a]);
        value = (value << 2) | order[0];
        margin = Math.min(margin, r[order[0]] - r[order[1]]);
      }
      out.push(value);
      margins.push(margin);
      state.at += 4 * sym;
      state.position += 4;
      state.index += 1;
    }
    return { bytes: Buffer.from(out), margins };
  };

  const head = readBytes(4 + HEADER_PARITY);
  const header = correct(head.bytes, HEADER_PARITY, head.margins);
  if (header === null || header.message[0] !== 0x41 || header.message[1] !== 0x53 || header.message[2] !== VERSION) return null;
  const length = header.message[3];
  if (length < 1 || length > MAX_BYTES) return null;
  const parity = bodyParity(length);
  const body = readBytes(length + 4 + parity);
  const corrected = correct(body.bytes, parity, body.margins);
  if (corrected === null) return null;
  const payload = corrected.message.subarray(0, length);
  if (!crcBytes(header.message, payload).equals(corrected.message.subarray(length, length + 4))) return null;
  return { data: Buffer.from(payload), corrected_bits: header.bits + corrected.bits };
}

/** The first intact packet in one band of a parsed recording, or null. */
export function decodeBand(recording, mode) {
  const band = plan(mode, recording.sample_rate / DECIMATION);
  const { zr, zi, fs } = baseband(recording.samples, recording.sample_rate, band.centre);
  for (const [start] of candidates(zr, zi, fs, band)) {
    const result = readPacket(zr, zi, fs, band, start);
    if (result !== null) return { ...result, mode, protocol: PROTOCOL, sample_rate: recording.sample_rate, duration_seconds: recording.duration_seconds };
  }
  return null;
}

/**
 * What a WAV carries, as aisense answers it: data, corrected_bits, mode,
 * protocol, sample_rate, duration_seconds; or null when no intact packet is
 * in it. BadRecording for a file it does not read.
 */
export function decode(data, mode = "auto") {
  if (mode !== "auto" && !MODES.includes(mode)) throw new RangeError("Mode must be auto, audible, high or ultrasound.");
  const recording = parseWav(data);
  for (const name of mode === "auto" ? MODES : [mode]) {
    const result = decodeBand(recording, name);
    if (result !== null) return result;
  }
  return null;
}
