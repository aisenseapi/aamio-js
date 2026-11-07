/**
 * The domain key format: the vectors every client that takes it up shares, the
 * same file aamio-python keeps. Nothing here touches the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { InvalidDomainKeys, canonicalKey, domainKeysUrl, makeDomainKeys, matchDomainKey, normaliseDomain, parseDomainKeys } from "../src/aamio.js";

const FILE = new URL("./domain_keys_vectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(FILE, "utf8"));
const bytes = (text) => new TextEncoder().encode(text);

test("the vectors are the ones aamio-python keeps", (t) => {
  const there = new URL("../../aamio-python/tests/domain_keys_vectors.json", import.meta.url);
  if (!existsSync(there)) return t.skip("no aamio-python checkout beside this one");
  // Compared without what a checkout does to line breaks.
  assert.equal(readFileSync(there, "utf8").replaceAll("\r\n", "\n"), readFileSync(FILE, "utf8").replaceAll("\r\n", "\n"));
});

for (const row of vectors.documents) {
  test("document: " + row.case, () => {
    const raw = row.text !== undefined ? bytes(row.text) : Uint8Array.from(Buffer.from(row.b64, "base64"));
    if (row.valid) assert.equal(parseDomainKeys(raw).length, row.keys);
    else assert.throws(() => parseDomainKeys(raw), InvalidDomainKeys);
  });
}

for (const row of vectors.matches) {
  test("match: " + row.case, () => {
    const found = matchDomainKey(bytes(row.text), row.key, row.name ?? null);
    assert.equal(found.status, row.status);
    if (row.reason !== undefined) assert.equal(found.reason, row.reason);
    if ("matched_name" in row) assert.equal(found.matched_name, row.matched_name);
    assert.equal(found.document_sha256, row.document_sha256);
    assert.equal(found.subject_source, "supplied_key", "the key was the caller's, and the result has to say so");
  });
}

test("domains", () => {
  for (const [given, expected] of vectors.domains.valid) assert.equal(normaliseDomain(given), expected);
  for (const given of vectors.domains.invalid) assert.equal(normaliseDomain(given), null, JSON.stringify(given));
  assert.equal(normaliseDomain(null), null);
  assert.equal(normaliseDomain(7), null);
  assert.equal(domainKeysUrl("Example.ORG"), "https://example.org/.well-known/aamio-keys.json");
  assert.equal(domainKeysUrl("https://example.org"), null);
});

test("the generator writes the bytes every generator writes, and refuses what the parser would", () => {
  for (const row of vectors.generated) assert.equal(new TextDecoder().decode(makeDomainKeys(row.entries)), row.text);
  for (const row of vectors.refused) assert.throws(() => makeDomainKeys(row.entries), InvalidDomainKeys, row.case);
});

test("a list is read from bytes, so an encoding cannot go missing on the way", () => {
  assert.throws(() => parseDomainKeys('{"aamio_keys":1,"keys":[]}'), (error) => error.reason === "not_bytes");
});

test("an invalid document says why without its content", () => {
  const found = matchDomainKey(bytes('{"aamio_keys":2,"keys":[],"x":"secret text"}'), "29VTeOqp8srcy1SyPZ3NtHy9XBnLf4h7D2LDrCzo7S4");
  assert.deepEqual([found.reason, found.detail], ["invalid_document", "unsupported_version"]);
  assert.equal(canonicalKey("CogegzJHFnSuSTOXEiM5bQ98Dt6qOS7VeFXN8Azj0bl"), false);
});
