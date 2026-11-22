/**
 * The card of earshot and qrcast against card_vectors.json, the file aamio-python's tests/test_card_vectors.py and
 * aamio-php are tested against as well.
 *
 * A card heard and a card seen are one thing: the same text from the same input, and the same reading of the same text,
 * in both add-ons and all three runtimes. The file is made from the reference in aamio-python and copied here as it is; a
 * change to the card is a change to the file, and the other two editions follow it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as earshotCard from "../addons/earshot/src/card.js";
import * as qrcastCard from "../addons/qrcast/src/card.js";

const VECTORS = JSON.parse(readFileSync(new URL("./card_vectors.json", import.meta.url), "utf8"));
const CARDS = { earshot: earshotCard, qrcast: qrcastCard };

const outcome = (card, act) => {
  try {
    return { done: act() };
  } catch (error) {
    if (error instanceof card.Refused) return { refused: error.reason };
    if (error instanceof card.NotUnderstood) return { not_understood: error.reason };
    throw error;
  }
};

for (const [name, card] of Object.entries(CARDS)) {
  test(`${name}: make gives each card of the vectors, or refuses it for the same reason`, () => {
    for (const vector of VECTORS.make) {
      const got = outcome(card, () => card.make(vector.address, vector.name, vector.expires, vector.via, vector.key));
      if ("card" in vector) {
        assert.deepEqual(got, { done: vector.card }, vector.about);
        assert.ok(Buffer.byteLength(got.done, "utf8") === vector.bytes && vector.bytes <= VECTORS.max_bytes, vector.about);
      } else {
        assert.deepEqual(got, { refused: vector.refused }, vector.about);
      }
    }
  });

  test(`${name}: read gives each card of the vectors, or does not understand it for the same reason`, () => {
    for (const vector of VECTORS.read) {
      const got = outcome(card, () => card.read(vector.text));
      assert.deepEqual(got, "card" in vector ? { done: vector.card } : { not_understood: vector.not_understood }, vector.about);
    }
  });
}

test("the vectors cover where a medium is reached, both ways", () => {
  const made = VECTORS.make.filter((vector) => "card" in vector).map((vector) => vector.card);
  assert.ok(made.some((text) => text.includes("v=bt:00:00:5E:00:53:01")) && made.some((text) => text.includes("v=lan:192.168.2.22:47474,internet")));
  const refused = new Set(VECTORS.make.map((vector) => vector.refused));
  for (const reason of ["invalid_via", "key_needed", "card_too_long", "invalid_key", "a_key_not_a_public_key"]) assert.ok(refused.has(reason), reason);
  assert.equal(Math.max(...VECTORS.make.filter((vector) => "card" in vector).map((vector) => vector.bytes)), VECTORS.max_bytes);
  assert.equal(VECTORS.max_bytes, 128);
});
