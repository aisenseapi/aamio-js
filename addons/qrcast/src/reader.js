import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Unreadable } from "./errors.js";
import * as programs from "./programs.js";
import { MAX_PIXELS } from "./service.js";

/*
 * Reading the QR codes in a picture on this machine, with zbarimg.
 *
 * Node reads no QR code of its own and this add-on brings no package that
 * does, so zbarimg does it, from zbar-tools on Linux and zbar on macOS, asked
 * for QR codes only, never barcodes. The picture's size is checked first, at
 * most 10 MiB and 25 megapixels as at aisenseapi.com, from its header, before
 * a pixel is decoded. A picture is written to a private folder for zbarimg and
 * deleted at once, and nothing leaves the machine. A camera frame goes the
 * same way as a PGM picture. The same as aamio-php's Reader; aamio-python
 * reads with zxing-cpp instead: the same codes, by another decoder.
 */

export const FORMATS = ["png", "jpeg", "gif", "webp"];
export const TIMEOUT = 20;
export const COMMAND = ["-q", "--raw", "-Sdisable", "-Sqrcode.enable"];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const startsWith = (bytes, head) => bytes.length >= head.length && bytes.subarray(0, head.length).equals(head);

/** png, jpeg, gif or webp from the first bytes of a file, or null. */
export function kindOf(head) {
  if (startsWith(head, PNG)) return "png";
  if (startsWith(head, Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  if (startsWith(head, Buffer.from("GIF87a", "latin1")) || startsWith(head, Buffer.from("GIF89a", "latin1"))) return "gif";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** The first frame header of a JPEG that says a size: [width, height], or null. */
function jpegSize(data) {
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers that stand alone: restarts, the start of the picture and TEM.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      at += 2;
      continue;
    }
    // The end, or the picture's own data: no frame header came before it.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = data.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > data.length) return null;
      return [data.readUInt16BE(at + 7), data.readUInt16BE(at + 5)];
    }
    at += 2 + length;
  }
  return null;
}

/** The size a picture's header says, as [width, height], or null when it says none. */
export function sizeOf(data, kind = kindOf(data.subarray(0, 16))) {
  let size = null;
  if (kind === "png") {
    if (data.length >= 24 && data.toString("latin1", 12, 16) === "IHDR") size = [data.readUInt32BE(16), data.readUInt32BE(20)];
  } else if (kind === "gif") {
    if (data.length >= 10) size = [data.readUInt16LE(6), data.readUInt16LE(8)];
  } else if (kind === "jpeg") {
    size = jpegSize(data);
  } else if (kind === "webp" && data.length >= 30) {
    const form = data.toString("latin1", 12, 16);
    if (form === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      size = [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
    } else if (form === "VP8L" && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      size = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    } else if (form === "VP8X") {
      size = [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
    }
  }
  return size !== null && size[0] >= 1 && size[1] >= 1 ? size : null;
}

export function installHint(platform) {
  if (platform === "darwin") return "On macOS it comes with brew install zbar.";
  if (platform === "win32") return "Windows has no package of it this add-on is tried with; aamio-python reads here with zxing-cpp.";
  return "On Linux it is the zbar-tools package, as apt install zbar-tools.";
}

/** The texts of the QR codes in a picture file's bytes. zbar is for tests. */
export async function read(data, zbar = zbarimg) {
  const kind = kindOf(data.subarray(0, 16));
  if (kind === null) throw new Unreadable("not_a_picture", "This is not a PNG, JPEG, GIF or WebP picture.");
  const size = sizeOf(data, kind);
  if (size === null) throw new Unreadable("not_readable", "The picture could not be opened: its header says no size.");
  if (size[0] * size[1] > MAX_PIXELS) {
    throw new Unreadable("too_big", `The picture is ${size[0]} x ${size[1]} pixels, and at most 25 megapixels are read. Send a smaller picture of the code.`);
  }
  return through(data, "picture." + kind, zbar);
}

/** The texts of the QR codes in one grey frame from the camera, a byte a pixel. */
export async function readFrame(width, height, gray, zbar = zbarimg) {
  return through(Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`, "latin1"), gray]), "frame.pgm", zbar);
}

async function through(data, name, zbar) {
  const folder = programs.folder();
  if (folder === null) {
    throw new Unreadable("not_readable", "No private folder could be made in the temporary directory for the picture. Check the temporary directory.");
  }
  const path = join(folder, name);
  try {
    writeFileSync(path, data, { mode: 0o600 });
    return await zbar(path);
  } finally {
    programs.clean(folder);
  }
}

/** zbarimg on a file: the texts of the QR codes in it, none when it found none. */
export async function zbarimg(path, which = programs.which, run = programs.run, platform = programs.platform()) {
  const program = which("zbarimg");
  if (program === null) {
    throw new Unreadable("no_reader", `zbarimg, which reads the codes here, is not on this machine. ${installHint(platform)} Or read with engine aisense, which sends the picture to aisenseapi.com.`);
  }
  const [code, out, err] = await run([program, ...COMMAND, path], TIMEOUT);
  if (code === 4) return [];
  if (code !== 0) {
    throw new Unreadable("not_readable", `zbarimg could not read the picture${code === null ? ` within ${TIMEOUT} seconds` : ": " + programs.lastLine(err)}.`);
  }
  const texts = [];
  for (const line of out.split(/\r?\n/)) if (line !== "" && !texts.includes(line)) texts.push(line);
  return texts;
}
