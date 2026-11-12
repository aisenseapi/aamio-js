// The domain key format in the add-on: the vectors every client shares, the same file aamio-python keeps, and the
// format code itself, which is the aamio package's own. Nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidDomainKeys, canonicalKey, checkFile, domainKeysUrl, makeDomainKeys, matchDomainKey, normaliseDomain, parseDomainKeys } from "../src/lists.js";

const FILE = new URL("./domain_keys_vectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(FILE, "utf8"));
const bytes = (text) => new TextEncoder().encode(text);
const KEY = "c3lrmIg_bOnE-fQyMRpxvqoeXAhkBGqDHCD9LXKWSnc";

test("the vectors are the ones aamio-python keeps", (t) => {
  const there = new URL("../../../../aamio-python/tests/domain_keys_vectors.json", import.meta.url);
  if (!existsSync(there)) return t.skip("no aamio-python checkout beside this one");
  // Compared without what a checkout does to line breaks.
  assert.equal(readFileSync(there, "utf8").replaceAll("\r\n", "\n"), readFileSync(FILE, "utf8").replaceAll("\r\n", "\n"));
});

test("the format code is the aamio package's own, as its source has it", (t) => {
  const there = new URL("../../../src/aamio.js", import.meta.url);
  if (!existsSync(there)) return t.skip("no aamio-js source beside this package");
  const sdk = readFileSync(there, "utf8").replaceAll("\r\n", "\n");
  const mine = readFileSync(new URL("../src/lists.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const theirs = sdk.slice(sdk.indexOf("export const DOMAIN_KEYS_VERSION = 1;"), sdk.indexOf("export const threadSigningInput")).trimEnd();
  const copy = mine.slice(mine.indexOf("// ---- from aamio-js/src/aamio.js ----\n") + "// ---- from aamio-js/src/aamio.js ----\n".length, mine.indexOf("// ---- end of what is from aamio-js/src/aamio.js ----")).trimEnd();
  assert.ok(theirs.length > 5000);
  assert.equal(copy, theirs, "src/lists.js is made again from src/aamio.js when the format code there changes");
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
  assert.equal(canonicalKey("CogegzJHFnSuSTOXEiM5bQ98Dt6qOS7VeFXN8Azj0bl"), false, "a last character carrying bits past the 32 bytes is not the key");
});

test("a local file is checked against the format, and never taken for a domain read", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "aamio-domain-lists-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "good.json"), makeDomainKeys([{ key: KEY, name: "support" }]));
  await writeFile(join(folder, "bad.json"), '{"aamio_keys": 2, "keys": []}');
  await writeFile(join(folder, "big.json"), Buffer.alloc(20000, 0x20));
  assert.deepEqual(await checkFile(join(folder, "good.json")), [{ format_valid: true, keys: 1, source: "local_file", domain_checked: false }, 0]);
  assert.deepEqual(await checkFile(join(folder, "bad.json")), [{ format_valid: false, reason: "invalid_document", detail: "unsupported_version", source: "local_file", domain_checked: false }, 2]);
  assert.deepEqual(await checkFile(join(folder, "big.json")), [{ format_valid: false, reason: "invalid_document", detail: "body_limit", source: "local_file", domain_checked: false }, 2]);
  for (const path of [join(folder, "missing.json"), folder, "", null, 7]) assert.deepEqual(await checkFile(path), [{ error: "local_file_unreadable" }, 2], String(path));
});
