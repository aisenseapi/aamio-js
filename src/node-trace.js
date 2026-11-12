import { isKey } from "./aamio.js";

/*
 * The conversation trace of the local runtime: what was sent to each
 * counterpart and what came back, as hashes and shapes, never content.
 * trace.json is the file aamio-python and aamio-php keep too, in the same
 * shape, so a home reads the same in all three: a book per public key, with
 * the last fifty sends, the last fifty arrivals, and the last message from
 * them that was read and opened here, which the next message to them names as
 * seen.
 *
 * Everything here is a function of what it is given. The runtime holds the
 * books and writes the file.
 */

export const TRACE_KEEP = 50;
export const TRACE_KEYS = 100;
// How many field names a row keeps, and how long a name may be. The names of a
// message that arrived are its sender's to choose: one message of the largest
// size can carry thousands of them, fifty such from one key were megabytes in a
// file that is written again at every read, and a board inbox takes any signed
// key. The fields this runtime and the other two write are a handful of short
// names, so what is cut is only what was made to be long.
export const TRACE_FIELDS = 32;
export const TRACE_FIELD_CHARS = 64;

const HASH = /^[0-9a-f]{64}$/;

/** The sha256 of a message as the service gives it: 64 lowercase hex characters. */
export function isMessageHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// What a row of the trace may hold, and of what kind. trace.json is this
// runtime's own file and is still read as if anyone could have written it: a
// nested field of the wrong type once reached the code that records a send,
// after the message had gone, and the caller heard an error about a message
// that was delivered (aamio-python, 25 September 2026).
export const TRACE_SENT_FIELDS = {
  message_id: "string", at: "int", w: "string", status: "int", outcome: "string", seq: "int", sha256: "hash",
  sealed: "bool", bytes: "int", fields: "list", text_chars: "int", re: "hash", seen: "hash",
};
export const TRACE_RECEIVED_FIELDS = {
  at: "int", channel: "string", w: "string", seq: "int", sha256: "hash", encrypted: "bool", format: "string",
  error: "string", fields: "list", text_chars: "int", re: "hash", seen: "hash",
};
export const TRACE_READ_FIELDS = { sha256: "hash", seq: "int", w: "string", at: "int" };

function traceValue(kind, value) {
  if (kind === "hash") return isMessageHash(value) ? value : null;
  if (kind === "list") return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length <= TRACE_FIELD_CHARS).sort().slice(0, TRACE_FIELDS) : null;
  if (kind === "int") return Number.isInteger(value) ? value : null;
  if (kind === "bool") return typeof value === "boolean" ? value : null;
  return typeof value === "string" ? value : null;
}

/** One row of a trace as the runtimes write it: the fields they know, each of the kind they write or null. */
export function traceRow(row, fields) {
  if (!isObject(row)) return null;
  const out = {};
  for (const [name, kind] of Object.entries(fields)) if (name in row) out[name] = traceValue(kind, row[name]);
  return out;
}

/** Rows as the file held them. A row without what names it, the message id of a send or the hash of what arrived, says nothing and is left out. */
function traceRows(found, fields, keep, required) {
  const rows = Array.isArray(found) ? found.map((item) => traceRow(item, fields)) : [];
  return rows.filter((row) => row !== null && row[required] !== null && row[required] !== undefined).slice(-keep);
}

/** trace.json as the runtimes write it, whatever the file held: a book per key, rows of a known shape, within the bounds. */
export function normalizeTraces(traces, keep = TRACE_KEEP, keys = TRACE_KEYS) {
  const books = {};
  for (const [key, book] of isObject(traces) ? Object.entries(traces) : []) {
    if (!isKey(key) || !isObject(book)) continue;
    const last = traceRow(book.last_read, TRACE_READ_FIELDS);
    books[key] = {
      sent: traceRows(book.sent, TRACE_SENT_FIELDS, keep, "message_id"),
      received: traceRows(book.received, TRACE_RECEIVED_FIELDS, keep, "sha256"),
      last_read: last && last.sha256 ? last : null,
      active: Number.isInteger(book.active) ? book.active : 0,
    };
  }
  const names = Object.keys(books);
  for (const stale of names.sort((a, b) => books[a].active - books[b].active).slice(0, Math.max(0, names.length - keys))) delete books[stale];
  return books;
}

/**
 * One counterpart's record, with each message sent next to what came back
 * about it. A claim is exact. A verified message from them whose seen names a
 * sha256 says their runtime read and opened that message, and nothing more: not
 * the ones sent before it, not another channel's. A message nothing names is
 * unknown, never unread.
 */
export function traceView(book, limit) {
  const sentRows = (Array.isArray(book?.sent) ? book.sent : []).filter(isObject);
  const receivedRows = (Array.isArray(book?.received) ? book.received : []).filter(isObject);
  const claimed = new Set(receivedRows.filter((row) => isMessageHash(row.seen)).map((row) => row.seen));
  const answered = new Set(receivedRows.filter((row) => isMessageHash(row.re)).map((row) => row.re));
  const mine = new Map(sentRows.filter((row) => isMessageHash(row.sha256)).map((row) => [row.sha256, row]));
  const delivered = sentRows.filter((row) => row.status === 201 && isMessageHash(row.sha256));
  const noClaim = delivered.filter((row) => !claimed.has(row.sha256)).map((row) => row.message_id ?? null);
  const sent = sentRows.slice(-limit).map((record) => {
    const stored = record.status === 201 && isMessageHash(record.sha256) ? record.sha256 : null;
    return { ...record, seen_by_them: stored !== null && claimed.has(stored) ? true : null, answered_by_them: stored !== null && answered.has(stored) ? true : null };
  });
  const received = receivedRows.slice(-limit).map((record) => {
    const row = { ...record };
    for (const [field, as] of [["re", "answers"], ["seen", "acknowledges"]]) {
      if (!isMessageHash(record[field])) continue;
      const ours = mine.get(record[field]);
      row[as] = ours ? { seq: ours.seq ?? null, sha256: ours.sha256, at: ours.at ?? null } : { sha256: record[field], note: "no confirmed send in this record has this sha256" };
    }
    return row;
  });
  const elsewhere = [...claimed].filter((hash) => !mine.has(hash));
  return { sent, received, no_read_claim: noClaim, note: traceNote(sentRows, receivedRows, delivered, noClaim, elsewhere) };
}

/**
 * What the record says, in words, and no more than it says. A send the service
 * did not confirm is not a send it did not store: the answer can be lost after
 * the message was stored, and whoever is told it was not stored sends the text
 * again as new bytes, which is a second message. The words are aamio-python's.
 */
export function traceNote(sent, received, delivered, noClaim, elsewhere) {
  if (!sent.length) return "Nothing sent to them is recorded here.";
  const named = received.some((row) => isMessageHash(row.seen));
  const turnedAway = sent.filter((row) => row.outcome === "refused" && row.status !== 201).length;
  const unsettled = sent.length - delivered.length - turnedAway;
  let note;
  if (!delivered.length) {
    note = "No message here has an answer from the service that confirms it was stored.";
  } else if (!named) {
    const said = received.length ? "Nothing from them has named a message of yours as read" : "Nothing has come back from them";
    note = said + ", so each is unknown, not unread. A client that does not send seen says nothing, and neither does one "
      + "that cannot open what it gets: every message here is sealed to their key, so a reader without it sees an "
      + "envelope and no text. The sha256 of each message is what the service stored, byte for byte; ask them for "
      + "the sha256 they read.";
  } else {
    note = `${delivered.length} delivered, and their runtime says it read and opened ${delivered.length - noClaim.length} of them.`;
    if (noClaim.length) {
      note += ` For ${noClaim.length} there is no claim kept here: that is unknown, not unread, since each message from them names only `
        + "the last of yours it had read when it was written, and this record keeps fifty each way.";
    }
  }
  if (elsewhere.length) {
    note += ` They named ${elsewhere.length} message(s) this record cannot match to a send the service confirmed: older than this record, `
      + "sent from elsewhere, or sent from here without an answer that confirmed it.";
  }
  if (unsettled) {
    note += ` For ${unsettled} no answer settled whether the service stored it, so it may be stored already. Check each one's status `
      + "and outcome first, and if it must go again, retry it from the outbox: the same bytes are marked a replay "
      + "where the first arrived, and new bytes would be a second message.";
  }
  if (turnedAway) note += ` The service turned away ${turnedAway}; the status of each says why.`;
  if (named) note += " A claim covers the one message it names. It says their runtime opened it, not that anyone understood it or acted on it.";
  return note;
}
