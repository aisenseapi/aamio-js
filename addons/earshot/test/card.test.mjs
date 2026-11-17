// The card, and the one rule that keeps every key out of the air. Pure, with no network, no speaker and no
// microphone. The same checks as the card tests of aamio-python's tests/test_earshot_process.py and aamio-php's
// addons/earshot/tests/card.inc.php.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as card from "../src/card.js";

const ADDRESS = "k7rq2m4xw5tbz3yd6ena";
const NOW = 1794150000;

const refusedFor = (act) => {
  try {
    act();
  } catch (error) {
    if (error instanceof card.Refused) return error;
    throw error;
  }
  return null;
};

const notUnderstood = (text) => {
  try {
    card.read(text);
  } catch (error) {
    if (error instanceof card.NotUnderstood) return error.reason;
    throw error;
  }
  return null;
};

test("a card is the address, a name and a time, and reads back", () => {
  assert.equal(card.make(ADDRESS), "aamio:scope/" + ADDRESS);
  assert.deepEqual(card.read(card.make(ADDRESS)), { kind: "scope", address: ADDRESS, name: null, expires_at: null });
  const named = card.make(ADDRESS, "rom-42");
  assert.equal(named, "aamio:scope/" + ADDRESS + "?n=rom-42");
  assert.deepEqual(card.read(named), { kind: "scope", address: ADDRESS, name: "rom-42", expires_at: null });
  const timed = card.make(ADDRESS, "rom-42", NOW + 3600);
  assert.equal(timed, `aamio:scope/${ADDRESS}?n=rom-42&t=${NOW + 3600}`);
  assert.equal(card.read(timed).expires_at, NOW + 3600);
  assert.equal(card.read(`aamio:scope/${ADDRESS}?t=${NOW}&n=rom-42`).name, "rom-42", "in either order");
  assert.equal(Buffer.byteLength(card.make(ADDRESS, "R" + "x".repeat(31), NOW)), 80, "the longest card is 80 bytes of the 128 a sound carries");
  assert.equal(card.make(ADDRESS, ""), card.make(ADDRESS), "an empty name is no name");
  assert.equal(card.make(ADDRESS, null, null), card.make(ADDRESS));
});

test("a time that is not Unix seconds is refused", () => {
  for (const wrong of [-1, 12345678, 123456789012, "1794150000", true, 1.5, Number.NaN, 1e21]) {
    const error = refusedFor(() => card.make(ADDRESS, null, wrong));
    assert.equal(error?.reason, "invalid_expiry", String(wrong));
  }
});

test("only a write address of exactly twenty characters goes into a card", () => {
  const cases = [
    ["abcdefghijklmnopqrstuvwxyz", "a_key_not_an_address"],
    ["a1".repeat(32), "a_key_not_an_address"],
    ["0123456789abcdefghijklmnop", "a_key_not_an_address"],
    [ADDRESS.slice(0, 19), "not_a_write_address"],
    [ADDRESS + "a", "not_a_write_address"],
    [ADDRESS.toUpperCase(), "not_a_write_address"],
    ["k7rq2m4xw5tbz3yd6en1", "not_a_write_address"],
    ["k7rq2m4xw5tbz3yd6en8", "not_a_write_address"],
    [ADDRESS + "\n", "not_a_write_address"],
    [" " + ADDRESS, "not_a_write_address"],
    [null, "not_a_write_address"],
    [undefined, "not_a_write_address"],
    [12345, "not_a_write_address"],
    [[ADDRESS], "not_a_write_address"],
  ];
  for (const [given, reason] of cases) {
    const error = refusedFor(() => card.make(given));
    assert.equal(error?.reason, reason, JSON.stringify(given));
    assert.ok(error.fix.includes("aamio scope list"), "the refusal says where the address is found");
  }
});

test("a name that is not a scope name is refused", () => {
  for (const name of ["-rom", "rom 42", "r".repeat(33), "rom/42", "røm", "rom\n", 42]) {
    assert.equal(refusedFor(() => card.make(ADDRESS, name))?.reason, "invalid_name", JSON.stringify(name));
  }
});

test("a card this version does not read is not read in part", () => {
  const reads = [
    [null, "not_an_aamio_card"],
    [undefined, "not_an_aamio_card"],
    ["hello there", "not_an_aamio_card"],
    ["aamio:inbox/" + ADDRESS, "not_an_aamio_card"],
    ["aamio:scope/" + ADDRESS.slice(0, 19), "not_a_write_address"],
    ["aamio:scope/abcdefghijklmnopqrstuvwxyz", "not_a_write_address"],
    ["aamio:scope/" + ADDRESS + "\n", "not_a_write_address"],
    ["aamio:scope/" + ADDRESS + "?h=aamio.la", "not_this_version"],
    ["aamio:scope/" + ADDRESS + "?n=a&h=aamio.la", "not_this_version"],
    ["aamio:scope/" + ADDRESS + "?n=a&n=b", "not_this_version"],
    ["aamio:scope/" + ADDRESS + "?n", "not_this_version"],
    ["aamio:scope/" + ADDRESS + "?", "not_this_version"],
    ["aamio:scope/" + ADDRESS + "?__proto__=x", "not_this_version"],
    ["aamio:scope/" + ADDRESS + "?n=bad name", "invalid_name"],
    ["aamio:scope/" + ADDRESS + "?n=", "invalid_name"],
    ["aamio:scope/" + ADDRESS + "?t=soon", "invalid_expiry"],
    ["aamio:scope/" + ADDRESS + "?t=12345678", "invalid_expiry"],
    ["aamio:scope/" + ADDRESS + "?t=1&t=2", "invalid_expiry"],
    ["aamio:scope/" + ADDRESS + "?t=1794150000&t=1794150000", "not_this_version"],
  ];
  for (const [text, reason] of reads) assert.equal(notUnderstood(text), reason, JSON.stringify(text));
});

// The card of 0.5.0, the same cases as aamio-python's test_earshot_process.py and aamio-php's card.inc.php.
const KEY = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const flipped = KEY.slice(0, -1) + alphabet[alphabet.indexOf(KEY.at(-1)) ^ 1];

test("a card of 0.5.0 says the media and carries the key, and reads back", () => {
  const made = card.make(ADDRESS, "rom-42", NOW + 3600, "lan,internet", KEY);
  assert.equal(made, `aamio:scope/${ADDRESS}?n=rom-42&t=${NOW + 3600}&v=lan,internet&k=${KEY}`);
  assert.equal(Buffer.byteLength(made), 115);
  assert.deepEqual(card.read(made), { kind: "scope", address: ADDRESS, name: "rom-42", expires_at: NOW + 3600, via: ["lan", "internet"], key: KEY });
  assert.equal(card.make(ADDRESS, "rom-42", NOW + 3600, ["lan", "internet"], KEY), made, "via as a list is the same card");
  assert.equal(card.make(ADDRESS, "rom-42", NOW, "internet"), card.make(ADDRESS, "rom-42", NOW));
  assert.equal(card.make(ADDRESS, "rom-42", NOW, []), card.make(ADDRESS, "rom-42", NOW));
  assert.deepEqual(card.read(card.make(ADDRESS, "rom-42", NOW)), { kind: "scope", address: ADDRESS, name: "rom-42", expires_at: NOW }, "without via and key the card is the one of 0.4.0");
  assert.deepEqual(card.read(card.make(ADDRESS, null, null, null, KEY)), { kind: "scope", address: ADDRESS, name: null, expires_at: null, key: KEY });
  assert.deepEqual(card.read(`aamio:scope/${ADDRESS}?v=ble,internet&k=${KEY}`).via, ["ble", "internet"], "a medium this earshot has no transport for is read");
  assert.deepEqual(card.read(`aamio:scope/${ADDRESS}?k=${KEY}&v=sound&t=${NOW}`).via, ["sound"], "in any order");
  const long = refusedFor(() => card.make(ADDRESS, "R" + "x".repeat(31), NOW, "lan,sound,internet", KEY));
  assert.ok(long && long.reason === "card_too_long" && long.fix.includes("147 bytes"), long?.fix);
});

test("a card that names a medium beside internet carries a public key, and never a secret", () => {
  const wrongs = [["lan", null, "key_needed"], [["sound", "internet"], null, "key_needed"], ["lan", "abcdefghijklmnopqrstuvwxyz", "a_key_not_a_public_key"],
    ["lan", "a1".repeat(32), "a_key_not_a_public_key"], ["lan", "a".repeat(43), "a_key_not_a_public_key"], [null, "0123456789abcdefghijklmnop", "a_key_not_a_public_key"],
    ["lan", KEY.slice(0, -1), "invalid_key"], ["lan", KEY + "A", "invalid_key"], ["lan", flipped, "invalid_key"], ["lan", "!".repeat(43), "invalid_key"], ["lan", 12345, "invalid_key"],
    ["LAN", KEY, "invalid_via"], ["lan,lan", KEY, "invalid_via"], ["a,b,c,d", KEY, "invalid_via"], [",lan", KEY, "invalid_via"], ["lan,", KEY, "invalid_via"], ["lan sound", KEY, "invalid_via"],
    [["lan", 5], KEY, "invalid_via"], [5, KEY, "invalid_via"]];
  for (const [via, key, reason] of wrongs) {
    assert.equal(refusedFor(() => card.make(ADDRESS, "rom-42", NOW, via, key))?.reason, reason, JSON.stringify([via, key]));
  }
});

test("a card of 0.5.0 that is not one is not read in part", () => {
  const unread = [["v=", "invalid_via"], ["v=LAN", "invalid_via"], ["v=lan,lan", "invalid_via"], ["v=a,b,c,d", "invalid_via"], ["k=short", "invalid_key"],
    ["k=" + "a".repeat(43), "invalid_key"], ["k=abcdefghijklmnopqrstuvwxyz", "invalid_key"], ["k=" + flipped, "invalid_key"], ["v=lan&v=lan", "not_this_version"], ["v=lan&x=1", "not_this_version"]];
  for (const [query, reason] of unread) assert.equal(notUnderstood(`aamio:scope/${ADDRESS}?${query}`), reason, query);
});

