// The words an answer comes with, and the one check this add-on does.
//
// lists.js is the format and fetch.js is the read. Which key is compared and
// which websites may be read at all is the core's: it resolves a partner or a
// verified message to a key, keeps the user's list of websites, asks the user
// in a form over MCP, and holds the limits per add-on. This module gets a host
// the user agreed to and a subject with a key, reads once, and says what it
// found in words that come from why it came and not from the status alone.
//
// AAMIO_DOMAIN_DENY adds networks that are never read, comma separated, for
// an operator's own global ranges; an entry that does not parse stops the
// check rather than leave a range open.
//
// A result is a dated observation and it changes nothing: no partner, no
// allowlist, no permission and nothing in the outbox. The core treats it as
// text. The words are aamio-python's and aamio-php's, sentence for sentence.
import { canonicalKey, normaliseDomain, validDomainKeyName } from "./lists.js";
import * as fetching from "./fetch.js";

// One exit code per answer, so a script need not read the JSON to tell a key
// that is not listed from a list it could not read.
export const EXIT_CODES = { listed: 0, not_listed: 3, no_list: 4, unreachable: 5, invalid: 2 };

export const STATEMENTS = {
  listed: "This exact website listed this key at the time of this check. That is all it says: not who holds the key and not what they may do, and nothing changed here because of it.",
  not_listed: "This website's list did not have this key at the time of this check. That is no evidence of fraud: a key rotated out or the wrong domain look the same.",
  no_list: "This website publishes no key list at the exact address, so it says nothing about this key.",
  unreachable: "The list could not be read, so nothing is known about this key. This is not the same as not listed.",
  invalid: "What this website answered could not be used as a list, so nothing is known about this key.",
};

// The two answers a status alone would describe wrongly. A match says
// not_listed for a key under another label too, on purpose, since a check for
// a label is a check for that label, and target_not_public stops before any
// connection, so no website answered anything.
export const NOT_UNDER_THAT_LABEL = "This website's list did not have this key under the label asked for at the time of this check. It may hold the key under " +
  "another label, and a check with no name shows that. That is no evidence of fraud: a key rotated out, the wrong label or the wrong domain look the same.";
export const NOT_CONTACTED = "This website was not contacted: an address its name points to is not a public one, or is on a network kept out here. So nothing is known about this key.";

// A site whose certificate fails here may be fine everywhere else: Node
// carries its own roots and does not read the system's store unless it is
// told to.
export const TLS_NOTE = "The certificate could not be verified on this machine. If the site opens in a browser, this machine's store may hold " +
  "a root Node does not: NODE_EXTRA_CA_CERTS can point Node at a CA bundle, and verification is never switched off.";

/** Stopped on this machine, before anything was read. fix says what to do instead. */
export class Refused extends Error {
  constructor(reason, fix, status = "invalid") {
    super(reason);
    this.reason = reason;
    this.fix = fix;
    this.status = status;
  }
}

/** What a Refused looks like as an answer. Nothing was read, so it carries no time and no statement. */
export function refusal(refused, host = null, subject = null, name = null) {
  const answer = { status: refused.status, reason: refused.reason, domain: host, fix: refused.fix };
  if (subject) {
    for (const [field, value] of Object.entries(subject)) if (field !== "key") answer[field] = value;
    answer.key = subject.key ?? null;
  }
  if (name !== null) answer.requested_name = name;
  return answer;
}

/** The networks an operator keeps out, from AAMIO_DOMAIN_DENY. */
export function denyNetworks(value = process.env.AAMIO_DOMAIN_DENY) {
  const networks = [];
  for (const part of String(value ?? "").split(",")) {
    const network = part.trim();
    if (!network) continue;
    if (fetching.parseNetwork(network) === null) {
      throw new Refused("domain_deny_invalid", "AAMIO_DOMAIN_DENY holds something that is not a network, so no website is read until it is put right. It takes a comma separated list such as 203.0.113.0/24,2001:db8::/32.");
    }
    networks.push(network);
  }
  return networks;
}

/** An answer in words, from why it came and what was asked and not from its status alone. */
export function statement(found, name = null) {
  if (found.reason === "target_not_public") return NOT_CONTACTED;
  if (found.status === "not_listed" && name !== null) return NOT_UNDER_THAT_LABEL;
  return STATEMENTS[found.status];
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Read the list at a website the user agreed to, once, and say whether it
 * lists the subject's key.
 *
 * subject is what the core resolved: key, subject_source and what goes with
 * it. Refused before anything is looked up: a bad domain or name, no subject,
 * or a keep-out list that does not parse. network is passed to the read, for
 * tests.
 */
export async function check(domain, subject, name = null, network = {}) {
  let host = null;
  let deny;
  try {
    host = normaliseDomain(domain);
    if (host === null) {
      throw new Refused("invalid_domain", "A domain is a plain host name of two labels or more, as example.org, with no https://, port or path. www.example.org and example.org are different places. Internationalised names are not read yet.");
    }
    if (name !== null && !validDomainKeyName(name)) {
      throw new Refused("invalid_requested_name", "name is the label on the list: 1 to 64 characters of a-z, 0-9, dot, underscore and dash. Leave it out to look for the key under any label.");
    }
    if (!isObject(subject) || !canonicalKey(subject.key)) {
      throw new Refused("subject_missing", "A check needs the key aamio resolves from the address book or from a signature it checked itself; none came with this call.");
    }
    deny = denyNetworks(network.environment);
  } catch (refused) {
    if (!(refused instanceof Refused)) throw refused;
    return refusal(refused, host, isObject(subject) ? subject : null, name);
  }
  const { environment, ...rest } = network;
  const found = await fetching.check(host, subject.key, name, { ...rest, allowed: [host], deny });
  const answer = { ...found };
  for (const [field, value] of Object.entries(subject)) if (field !== "key") answer[field] = value;
  answer.statement = statement(found, name);
  if (found.reason === "tls") answer.note = TLS_NOTE;
  return answer;
}
