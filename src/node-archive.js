import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sha256hex } from "./aamio.js";

/*
 * What the local runtime keeps of what was said, and for how long. The
 * service forgets a thread when it expires. A home does not, unless it is told
 * to: archive/ holds what was read, sent and posted, decrypted, one file per
 * channel and one JSON record per line. It is the archive aamio-python and
 * aamio-php keep, in the same files, under the same policy in config.json:
 * keep, which is what a home without a choice has, off, or so many days, with
 * a ceiling on size. "Ephemeral" is about the network.
 *
 * Everything here works on the files of a home it is given. The runtime
 * decides when to write and what a failure means.
 */

export const ARCHIVE_MODES = ["keep", "off", "days"];
export const DEFAULT_POLICY = Object.freeze({ mode: "keep", days: null, max_mb: null });

// What a channel may be called when its name is also a file's: letters,
// digits, dots, dashes and underscores, starting with a letter or a digit.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Names Windows takes for a device, with or without an extension after them.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function archiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Whether a label can be a file's name as it is: nothing in it leaves the folder or names a device. */
export function isSafeLabel(label) {
  return typeof label === "string" && SAFE_NAME.test(label) && !DEVICE.test(label) && !label.endsWith(".");
}

/**
 * The file a channel's records go in, without its extension. The label, when
 * it can be a file's name. A label that cannot, one another runtime let
 * through with a path or a device in it, is kept under a name made of its
 * hash, inside the folder: written as it stood, ../../notes put what was read
 * on that channel outside the home, in a file no policy ever pruned.
 */
export function archiveName(label) {
  return isSafeLabel(label) ? label : "channel-" + sha256hex(String(label)).slice(0, 16);
}

/**
 * The text of a file of the home, past a byte order mark at its start. An
 * editor on Windows may leave one in front of a file that is whole otherwise.
 * The state the runtime keeps was read past it, and the rest of the home was
 * not: a policy file with a mark was read as no choice at all, so an archive
 * told to keep nothing was kept again, and nothing said so (a check of 12
 * November 2026). The three runtimes read the home's own files past the mark.
 * The key is not one of them: it holds the seed and nothing else. And what
 * comes from outside the home, a message, a card, an add-on's answer, is read
 * as it is.
 */
export const pastMark = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * A file of the home as text, past one byte order mark, or an error when it
 * is not UTF-8. Read with replacement characters, a policy file with one
 * stray byte was a choice here and no choice in the other two runtimes, and
 * a record written back by a prune came back changed (a check of 12 November
 * 2026). The decoder drops one mark itself.
 */
export async function homeText(path) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
}

/** The lines of a file as bytes, the first one past a byte order mark, each with the text it holds when that is UTF-8. */
async function rawLines(path) {
  let bytes = await readFile(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  const lines = [];
  let start = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    if (end === -1) end = bytes.length;
    const raw = bytes.subarray(start, end);
    let text = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      text = null;
    }
    lines.push({ raw, text });
    start = end + 1;
  }
  return lines;
}

/** The archive policy of a home. No file, or one that says nothing usable, means keep, which is what every version did. */
export async function readPolicy(home) {
  let stored = null;
  try {
    const config = JSON.parse(await homeText(join(home, "config.json")));
    stored = isObject(config) ? config.archive : null;
  } catch {
    stored = null;
  }
  const policy = { ...DEFAULT_POLICY };
  if (isObject(stored) && ARCHIVE_MODES.includes(stored.mode)) {
    policy.mode = stored.mode;
    if (Number.isInteger(stored.days) && stored.days > 0) policy.days = stored.days;
    if (typeof stored.max_mb === "number" && Number.isFinite(stored.max_mb) && stored.max_mb > 0) policy.max_mb = stored.max_mb;
  }
  if (policy.mode === "days" && !policy.days) policy.mode = "keep";
  return policy;
}

/** keep, off or days:N, as typed on the command line, with a ceiling in megabytes when one is given. Throws invalid_archive. */
export function parsePolicy(text, maxMb = null) {
  const said = String(text ?? "").trim().toLowerCase();
  const policy = { ...DEFAULT_POLICY };
  const days = /^days:([0-9]{1,6})$/.exec(said);
  if (said === "keep" || said === "off") policy.mode = said;
  else if (days && Number(days[1]) > 0) Object.assign(policy, { mode: "days", days: Number(days[1]) });
  else throw archiveError("invalid_archive", `the archive is keep, off or days:N with N a whole number of days, not ${JSON.stringify(said)}`);
  if (maxMb !== null && maxMb !== undefined) {
    if (typeof maxMb !== "number" || !Number.isFinite(maxMb) || maxMb <= 0) throw archiveError("invalid_archive", "--max-mb is a size above zero");
    policy.max_mb = maxMb;
  }
  return policy;
}

/** One sentence a person or a model can act on. The words are aamio-python's. */
export function describePolicy(policy) {
  // The ceiling holds each time the archive is tidied, not at every write:
  // under one of 128 bytes a row of 415 stayed until the next tidying, where
  // this said never more than (the fifth release check of 14 November 2026).
  const size = policy.max_mb ? ` Each time it is tidied, when a runtime starts and at most once an hour after, the oldest go first until it holds no more than ${policy.max_mb} MB, so in between it can hold more.` : "";
  if (policy.mode === "off") {
    return "Nothing decrypted is written to this machine. The key, the read keys of open threads and the outbox with sealed bytes still are, since the runtime cannot work without them.";
  }
  if (policy.mode === "days") {
    return `Decrypted messages and receipts are kept in archive/ for ${policy.days} days, then removed.${size} The service itself keeps nothing past a thread's expiry: this archive is yours, on this machine.`;
  }
  return `Decrypted messages and receipts are kept in archive/ until you remove them.${size} The service itself keeps nothing past a thread's expiry: this archive is yours, on this machine. \`aamio archive days:30\` gives it a lifetime, \`aamio archive off\` stops it.`;
}

/** After a rename the new name is on disk only when the folder is. Windows has no such call for a folder, and journals the rename. */
async function syncFolder(folder) {
  if (process.platform === "win32") return;
  try {
    const handle = await open(folder, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The files are in place. Only that the folder outlives a power cut is not known.
  }
}

/**
 * One record at the end of a channel's file, private from its first byte and
 * on the disk before this returns. A crash in the middle of a write leaves a
 * last line with no end: appended to as it was, the next record became part
 * of that line, and a reader passed over both.
 */
export async function appendRecord(home, name, record) {
  const folder = join(home, "archive");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, name + ".jsonl");
  let torn = false;
  try {
    const existing = await open(path, "r");
    try {
      const { size } = await existing.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await existing.read(last, 0, 1, size - 1);
        torn = last[0] !== 10;
      }
    } finally {
      await existing.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile((torn ? "\n" : "") + JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The lines of a file as they are, each with the time its record gives, or
 * null when it gives none. A line that is not UTF-8 gives none, and is kept
 * byte for byte: what cannot be told old is not thrown away as old, and not
 * written back changed either.
 */
async function linesOf(path) {
  const found = [];
  for (const { raw, text } of await rawLines(path)) {
    if (text !== null && !text.trim()) continue;
    if (text === null && !raw.length) continue;
    let at = null;
    try {
      const record = text === null ? null : JSON.parse(text);
      if (isObject(record) && typeof record.at === "number" && Number.isFinite(record.at)) at = record.at;
    } catch {
      at = null;
    }
    found.push({ at, line: Buffer.concat([raw, Buffer.from("\n")]) });
  }
  return found;
}

/** The files of the archive, by the name before .jsonl, sorted. An archive that is not there has none. */
export async function archiveNames(home) {
  let names;
  try {
    names = await readdir(join(home, "archive"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length)).sort();
}

/**
 * The records of one kind a file holds, oldest first. A file that is not
 * there holds none: an empty archive is a home that was told to keep nothing,
 * or has read nothing yet. A line that is no record is passed over.
 */
export async function archivedRecords(home, name, kind) {
  let lines;
  try {
    lines = await rawLines(join(home, "archive", name + ".jsonl"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return [];
    throw error;
  }
  const found = [];
  for (const { text } of lines) {
    // A line that is not UTF-8 is no record, as one cut short by a crash is not.
    if (text === null || !text.trim()) continue;
    try {
      const record = JSON.parse(text);
      if (isObject(record) && record.kind === kind) found.push(record);
    } catch {
      // A line cut short by a crash, or not written by a runtime: it is no record.
    }
  }
  return found;
}

/**
 * Removes what the policy no longer keeps: records past their days, and the
 * oldest ones past the ceiling. A record that cannot be dated is kept: what
 * cannot be told old is not thrown away as old. Each file that changes is
 * written beside itself and renamed over, so a crash in the middle leaves the
 * old file whole. With everything, the whole archive goes. Gives how many
 * records went and how many bytes are left.
 */
export async function pruneArchive(home, policy, { now = Date.now() / 1000, everything = false } = {}) {
  const folder = join(home, "archive");
  const names = await archiveNames(home);
  if (!names.length) return { removed: 0, bytes: 0 };
  let removed = 0;
  if (everything) {
    for (const name of names) {
      const path = join(folder, name + ".jsonl");
      removed += (await linesOf(path)).length;
      await unlink(path);
    }
    await syncFolder(folder);
    return { removed, bytes: 0 };
  }
  const horizon = policy.mode === "days" && policy.days ? now - policy.days * 86400 : null;
  const kept = new Map();
  const before = new Map();
  for (const name of names) {
    const all = await linesOf(join(folder, name + ".jsonl"));
    before.set(name, all.length);
    kept.set(name, all.filter((record) => !(horizon !== null && record.at !== null && record.at < horizon)));
    removed += all.length - kept.get(name).length;
  }
  const ceiling = policy.max_mb ? Math.floor(policy.max_mb * 1024 * 1024) : null;
  if (ceiling !== null) {
    let total = 0;
    const oldest = [];
    for (const [name, records] of kept) {
      for (const [index, record] of records.entries()) {
        const size = record.line.length;
        total += size;
        oldest.push({ at: record.at ?? now, name, index, size });
      }
    }
    oldest.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.index - b.index);
    const gone = new Map();
    for (const record of oldest) {
      if (total <= ceiling) break;
      total -= record.size;
      if (!gone.has(record.name)) gone.set(record.name, new Set());
      gone.get(record.name).add(record.index);
      removed += 1;
    }
    for (const [name, indexes] of gone) kept.set(name, kept.get(name).filter((_, index) => !indexes.has(index)));
  }
  let left = 0;
  for (const [name, records] of kept) {
    const text = Buffer.concat(records.map((record) => record.line));
    left += text.length;
    if (records.length === before.get(name)) continue;
    const path = join(folder, name + ".jsonl");
    const temporary = join(folder, `${name}.jsonl.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  if (removed) await syncFolder(folder);
  return { removed, bytes: left };
}

/** What the archive holds now, and what the policy means, in the shape aamio-python's archive command answers. */
export async function archiveStatus(home, policy) {
  let files = 0;
  let bytes = 0;
  let oldest = null;
  for (const name of await archiveNames(home)) {
    const path = join(home, "archive", name + ".jsonl");
    files += 1;
    bytes += (await stat(path)).size;
    for (const record of await linesOf(path)) {
      if (record.at !== null && (oldest === null || record.at < oldest)) oldest = record.at;
    }
  }
  return { policy, means: describePolicy(policy), files, bytes, oldest_at: oldest === null ? null : Math.floor(oldest) };
}
