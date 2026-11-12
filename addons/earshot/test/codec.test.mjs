// The sound codec on this machine, aisense-audio-v2: the same sound aisenseapi.com makes, and read back here.
//
// Offline. The bytes the encoder makes are pinned by their sha256: for "Hello", taken on 8 November 2026 when they
// were byte for byte what aisenseapi.com made, and for a card, as aamio-python's and aamio-php's codecs made them on
// 12 November 2026. A round trip in each mode; Reed-Solomon with errors and with erasures; recordings that are
// noisy, late, at 44.1 kHz and in stereo, built in whole numbers so every edition builds the same room, with what
// the other two editions read in each pinned beside it; and the files the codec turns down, in aisense's words.
// The same checks as aamio-python's tests/test_earshot_codec.py and aamio-php's addons/earshot/tests/card.inc.php.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as codec from "../src/codec.js";

const CARD = Buffer.from("aamio:scope/k7rq2m4xw5tbz3yd6ena?n=rom-42&t=1794200000");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// sha256 of encode("Hello", mode): what aisenseapi.com made for "Hello" on 8 November 2026, byte for byte.
const HELLO = {
  audible: "e3f6cabcf2fc98de4efdc5b69e3e2914fd061537a15f8ad3d651aa18e42ae4b3",
  high: "27678826b7765fdf9ce2be8a8b48a2209c9ea5453c5bda0c8ebce47e85aeac2b",
  ultrasound: "487cf8493ed3e6a72daadae4d4c74ff6ba97a8768f938f22ff745220c6f9e2ac",
};
// sha256 of encode(CARD, mode), as aamio-python's codec.encode and aamio-php's Codec::encode made it.
const CARD_SOUND = {
  audible: "7428aa417cdb7f4ec7aef436a6e4de85fa9a4fb823ab7cd0b68bdac8042e2b5d",
  high: "1005f17f0be5fc1e0b07e788696578f44582a5833fc2d92afb19398f25d936a9",
  ultrasound: "fe9197247feedc25244c6fd2a01c0d1a509cb3b301d4c753c661ae15f70532ce",
};

/**
 * A recording as a room gives it, in whole numbers so that every edition builds the same one: the card at a third of
 * its level and late, an echo 31 ms behind at four tenths, and noise from a generator of thirty-two bits. In stereo
 * the card is in the second channel and the first holds noise alone. A card that starts 3.37 s into 12 s runs past
 * the end, so its last bytes are lost and Reed-Solomon has to mend them.
 */
function room(mode, { seconds = 12, rate = 48000, late = 3370, noise = 3000, stereo = false, seed = 8 } = {}) {
  const made = codec.encode(CARD, mode);
  let clean = [];
  for (let at = 44; at < made.length; at += 2) clean.push(made.readInt16LE(at));
  if (rate !== 48000) {
    const fewer = [];
    const count = Math.floor(clean.length * 147 / 160);
    for (let i = 0; i < count; i++) fewer.push(clean[Math.min(Math.floor(i * 160 / 147), clean.length - 1)]);
    clean = fewer;
  }
  const total = seconds * rate;
  const start = Math.floor(late * rate / 1000);
  const signal = new Array(total).fill(0);
  for (let i = 0; i < clean.length; i++) if (start + i < total) signal[start + i] += Math.trunc(clean[i] * 35 / 100);
  const delay = Math.floor(31 * rate / 1000);
  for (let i = total - 1; i >= delay; i--) signal[i] += Math.trunc(signal[i - delay] * 4 / 10);
  let state = seed >>> 0;
  const draw = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % (2 * noise + 1) - noise;
  };
  const pcm = Buffer.alloc(total * (stereo ? 4 : 2));
  for (let i = 0; i < total; i++) {
    const value = Math.max(-32768, Math.min(32767, signal[i] + draw()));
    if (stereo) {
      pcm.writeInt16LE(draw(), 4 * i);
      pcm.writeInt16LE(value, 4 * i + 2);
    } else {
      pcm.writeInt16LE(value, 2 * i);
    }
  }
  return codec.wav(pcm, rate, stereo ? 2 : 1);
}

// Each room, the sha256 of the recording, and what is read in it: the same sum and the same reading as
// aamio-python's and aamio-php's codecs gave for the room built the same way, on 12 November 2026.
const ROOMS = [
  ["audible in a room", "audible", {}, "d47dab288f6d9cdbb8be4f1eb07c7462211e4c1ad82a47d7dd6a55ce9c0ac661", "audible", 22],
  ["high in a room", "high", {}, "cf6546bc7ce929516a2847633cb9746e362aff4b00bf1c2f621e026e74c36ad8", "high", 22],
  ["ultrasound in a room", "ultrasound", {}, "874ee52379d9cce3a7c11884233514bf5c5e2ea577120d49823861488f890424", "ultrasound", 24],
  ["audible under three times the noise", "audible", { noise: 9000 }, "b23d0fdccd2957a7ddca84272783199ba5e0fbcb0876a82c0f38969b94aaa160", "audible", 22],
  ["audible at 44.1 kHz", "audible", { rate: 44100 }, "445950320a15f82e02a81159bf3886d0e6290a6a8b9902d932a9dae4f9f60575", "audible", 22],
  // Taken down to 44.1 kHz by dropping samples, the ultrasound folds into the range below it, and is read there.
  ["ultrasound at 44.1 kHz", "ultrasound", { rate: 44100 }, "792bf589d5d90a8842901ea8fcbda7008d895a6f1ce094992b040331a5f76aae", "high", 22],
  ["stereo, the card in one channel", "audible", { stereo: true }, "6ab42758635ca7aec239d8e8465a3b3b5593a2a45098e3ab617bb729ec2692bd", "audible", 22],
  ["40 seconds, the card late and whole", "ultrasound", { seconds: 40, late: 26900 }, "bc0afbfda6035f4894d451d61988e377216757c948a80c2aea8d12ae5584b7c4", "ultrasound", 0],
];

test("the encoder makes what aisense made, byte for byte, in all three ranges", () => {
  for (const mode of codec.MODES) {
    const made = codec.encode(Buffer.from("Hello"), mode);
    assert.equal(sha256(made), HELLO[mode], mode);
    assert.equal(made.toString("latin1", 0, 4), "RIFF");
    assert.equal(made.toString("latin1", 8, 12), "WAVE");
    assert.equal(made.length, 439724);
  }
});

test("and what the other two editions make for a card", () => {
  for (const mode of codec.MODES) assert.equal(sha256(codec.encode(CARD, mode)), CARD_SOUND[mode], mode);
  assert.throws(() => codec.encode(CARD, "loud"), RangeError);
  assert.throws(() => codec.encode(CARD, "__proto__"), RangeError);
});

test("the packet is the header, the payload, the CRC and their parity", () => {
  const packet = codec.packetBytes(Buffer.from("Hello"));
  assert.equal(packet.toString("hex"), "41530305a3465a4fab9008d748656c6c6fa49f027eea265836471d0fa69817b9f91be0dfbf");
  assert.equal(packet.subarray(0, 4).toString("hex"), "41530305");
  assert.equal(packet.length, 12 + 5 + 4 + codec.bodyParity(5));
  assert.deepEqual([codec.bodyParity(1), codec.bodyParity(12), codec.bodyParity(128)], [16, 18, 32]);
  const wire = codec.symbols(Buffer.from("Hello"));
  assert.deepEqual(wire.slice(0, 32), codec.PREAMBLE);
  assert.deepEqual(wire.slice(32, 40), codec.MARKER);
  assert.equal(wire.length, 32 + 8 * 3 + 4 * packet.length);
  for (const wrong of [Buffer.alloc(0), Buffer.alloc(129, 0x78)]) assert.throws(() => codec.packetBytes(wrong), RangeError);
  assert.equal(codec.crc32(Buffer.from("123456789")), 0xcbf43926, "the CRC is zlib's");
});

test("a card reads back in each mode, and auto finds the mode", () => {
  for (const mode of codec.MODES) {
    const made = codec.encode(CARD, mode);
    assert.ok(codec.decode(made, mode).data.equals(CARD), mode);
    const got = codec.decode(made, "auto");
    assert.deepEqual([got.data.toString("utf8"), got.mode, got.corrected_bits, got.protocol, got.sample_rate, got.duration_seconds], [CARD.toString("utf8"), mode, 0, "aisense-audio-v2", 48000, 9.46]);
  }
  assert.throws(() => codec.decode(codec.encode(CARD, "audible"), "loud"), RangeError);
  // The longest message and the shortest.
  for (const payload of [Buffer.from([0x41]), Buffer.from(Array.from({ length: 128 }, (_, i) => (i * 7) & 0xff))]) {
    assert.ok(codec.decode(codec.encode(payload, "audible"), "audible").data.equals(payload), `${payload.length} byte(s)`);
  }
});

test("Reed-Solomon mends errors, and more with erasures", () => {
  const message = Buffer.from(Array.from({ length: 40 }, (_, i) => i));
  const code = Buffer.from(codec.rsEncode(message, 16));
  assert.ok(codec.rsDecode(code, 16).equals(message));
  for (const position of [0, 5, 17, 33, 44, 55, 3, 9]) code[position] ^= 0x5a;
  assert.ok(codec.rsDecode(code, 16).equals(message), "eight errors, half the parity");
  code[20] ^= 1;
  assert.equal(codec.rsDecode(code, 16), null, "nine are one too many without erasures");
  assert.ok(codec.rsDecode(code, 16, [0, 5, 17, 33, 44, 55, 3, 9, 20]).equals(message), "known places mend up to the whole parity");
  assert.equal(codec.rsDecode(Buffer.alloc(10), 16), null, "a message no longer than its parity is not one");
});

test("a recording as a room gives it is read, as the other two editions read the same room", () => {
  for (const [label, mode, options, sum, heardIn, corrected] of ROOMS) {
    const recording = room(mode, options);
    assert.equal(sha256(recording), sum, `${label}: the room is the one the other editions built`);
    const got = codec.decode(recording, "auto");
    assert.notEqual(got, null, label);
    assert.deepEqual([got.data.toString("utf8"), got.mode, got.corrected_bits], [CARD.toString("utf8"), heardIn, corrected], label);
  }
});

// The card with count symbols from symbol first silenced: a dropout in the room.
function silenced(first, count) {
  const made = Buffer.from(codec.encode(CARD, "audible"));
  const cut = 44 + 2 * Math.trunc(0.25 * 48000) + 2 * 960 * first;
  made.fill(0, cut, cut + 2 * 960 * count);
  return made;
}

test("nothing in a recording is null, and a damaged card is mended or never half read", () => {
  assert.equal(codec.decode(codec.wav(Buffer.alloc(2 * 48000 * 3)), "auto"), null, "silence");
  const mended = codec.decode(silenced(112, 40), "audible");
  assert.ok(mended.data.equals(CARD) && mended.corrected_bits > 0, "ten bytes of the body lost: Reed-Solomon mends them, and says it did");
  assert.equal(codec.decode(silenced(112, 200), "audible"), null, "fifty lost is past the parity, and the CRC lets nothing half through");
});

test("a file the codec does not read is turned down in aisense's words", () => {
  const cases = [
    [Buffer.from("ID3 not a wav at all, though long enough to be one".repeat(2)), "uncompressed PCM16"],
    [codec.wav(Buffer.alloc(100), 22050, 1), "44100 or 48000"],
    [codec.wav(Buffer.alloc(2 * 41 * 48000)), "at most 40 seconds"],
    [codec.wav(Buffer.alloc(2 * 480)).subarray(0, -2), "does not match its RIFF header"],
    [Buffer.alloc(codec.MAX_WAV_BYTES + 1), "larger than 8 MiB"],
    [codec.wav(Buffer.alloc(3)), "Truncated WAV chunk"],
    [codec.wav(Buffer.alloc(2 * 480), 48000, 3), "mono or stereo"],
  ];
  for (const [data, words] of cases) {
    assert.throws(() => codec.decode(data, "auto"), (error) => error instanceof codec.BadRecording && error.message.includes(words), words);
  }
});

// PCM under a WAVE_FORMAT_EXTENSIBLE header, as many recorders write it.
function extensible(pcm, { rate = 48000, channels = 1, subtype = codec.PCM_SUBTYPE, valid = 16, size = 22 } = {}) {
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * 2, 8);
  fmt.writeUInt16LE(channels * 2, 12);
  fmt.writeUInt16LE(16, 14);
  fmt.writeUInt16LE(size, 16);
  fmt.writeUInt16LE(valid, 18);
  fmt.writeUInt32LE(channels === 1 ? 4 : 3, 20);
  subtype.copy(fmt, 24);
  const length = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value, 0);
    return bytes;
  };
  const body = Buffer.concat([Buffer.from("WAVEfmt ", "latin1"), length(fmt.length), fmt, Buffer.from("data", "latin1"), length(pcm.length), pcm]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), length(body.length), body]);
}

test("the extensible header over 16-bit PCM is read as the plain one", () => {
  const classic = codec.encode(CARD, "audible");
  const pcm = classic.subarray(44);
  assert.deepEqual(codec.decode(extensible(pcm), "auto"), codec.decode(classic, "auto"), "the same samples under either header, the same card");
  assert.ok(codec.classicWav(extensible(pcm)).equals(classic), "for aisense, the plain header over the same samples");
  assert.equal(codec.classicWav(classic), classic, "and a plain one is given as it is");
  const stereo = Buffer.alloc(2 * pcm.length);
  for (let at = 0; at < pcm.length; at += 2) {
    pcm.copy(stereo, 2 * at, at, at + 2);
    pcm.copy(stereo, 2 * at + 2, at, at + 2);
  }
  assert.ok(codec.decode(extensible(stereo, { channels: 2 }), "auto").data.equals(CARD));
  const float = Buffer.from(codec.PCM_SUBTYPE);
  float[0] = 3;
  for (const [odd, what] of [[extensible(pcm, { subtype: float }), "a float subtype"], [extensible(pcm, { valid: 12 }), "12 of 16 bits"], [extensible(pcm, { size: 0 }), "no extension"]]) {
    assert.throws(() => codec.decode(odd, "auto"), (error) => error instanceof codec.BadRecording && error.message.includes("Use PCM16 WAV"), what);
    assert.equal(codec.classicWav(odd), odd, "and aisense gets it as it came, to judge for itself");
  }
});

test("a half is rounded away from zero, as PHP rounds it", () => {
  assert.deepEqual([2.5, -2.5, 0.5, -0.5, 1.4999, -1.4999, 3.0].map(codec.phpRound), [3, -3, 1, -1, 1, -1, 3]);
});
