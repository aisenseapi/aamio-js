// Reading a domain key list from the domain itself, so that a stranger cannot
// turn the read on anyone else.
//
// lists.js is the format. This is the one way this add-on reads a list from a
// website, and it is built for the case where the domain came from a message:
// whatever it names, the read reaches only the public internet, only that
// host, only once and only for a few seconds.
//
// - The domain is a plain host name and nothing else. The address is built
//   here, https://<domain>/.well-known/aamio-keys.json on port 443; no URL is
//   taken from anyone.
// - A local policy can refuse the domain before anything is looked up.
// - Every address the name resolves to must be public. One private, loopback,
//   link-local, shared, reserved, documentation, multicast or translation
//   address among public ones refuses the whole read, so a name cannot hide
//   an internal target behind a public one. An IPv6 address must also be
//   global unicast, inside 2000::/3. The connection goes to an address that
//   was checked, and the name is not looked up again.
// - TLS is checked against the domain, as the browser would: the server name
//   is sent and the certificate must be for it.
// - No proxy, no cookie, no credential, no redirect and no retry. The request
//   carries the host and the fixed path and nothing about the reader: not the
//   key, not the name, not a message.
// - Five seconds for everything, 16 KiB of headers and 16 KiB of body, counted
//   as they arrive rather than as the server announces them. Each address
//   tried gets an even share of the time left, so one that never answers
//   cannot use up the time of the next.
//
// What comes back is a dated observation, never a decision:
//
//     listed       a valid list from this exact domain lists the key, under the name if one was asked
//     not_listed   a valid list that does not
//     no_list      the domain answered 404 or 410 at the exact path
//     unreachable  no answer that could be read: DNS, TLS, the network, the time, or any other status
//     invalid      the domain, the key or the name was refused, an address was not public,
//                  a redirect, the wrong type or encoding, too much, or a list that is not version 1
//
// unreachable is never not_listed, and not_listed is no evidence of fraud.
// listed says what this site listed when it was read, and grants nothing.
//
// The same rules, statuses and reasons as aamio-python's and aamio-php's
// add-on. A process serves one call here, so the cap on lookups at once that
// the Python edition keeps for a server has nothing to cap.
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { DOMAIN_KEYS_MAX_BYTES, DOMAIN_KEYS_PATH, canonicalKey, matchDomainKey, normaliseDomain, validDomainKeyName } from "./lists.js";

export const PORT = 443;
export const DEADLINE_SECONDS = 5;
export const MAX_HEADER_BYTES = 16384;
export const USER_AGENT = "aamio-domain-keys/1";

// Never reached, whatever a name resolves to. Every client shares this list
// through test/domain_fetch_vectors.json. A change to it is a new
// ADDRESS_POLICY there and here.
export const ADDRESS_POLICY = 1;
// Outside it is every IPv6 range that is not handed out as public: IPv4 in any
// old embedding, segment routing, the discard prefixes and whatever the IETF
// has not allocated yet. The denied list still holds inside it.
export const IPV6_GLOBAL = "2000::/3";
export const DENIED_NETWORKS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "::ffff:0.0.0.0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
  "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
];

/**
 * A network as address/prefix, or a single address: [address, prefix, family],
 * or null for anything else. An address is plain IPv4 or IPv6 with no zone.
 */
export function parseNetwork(text) {
  if (typeof text !== "string") return null;
  const [address, prefix, ...more] = text.split("/");
  const family = address.includes("%") ? 0 : isIP(address);
  if (!family || more.length) return null;
  const most = family === 4 ? 32 : 128;
  if (prefix === undefined) return [address, most, family];
  if (!/^[0-9]{1,3}$/.test(prefix) || Number(prefix) > most) return null;
  return [address, Number(prefix), family];
}

// One list for each family, and an address is held against the list of its
// own family alone. A BlockList takes an IPv4 address for the IPv6 address it
// maps to, so ::ffff:0:0/96 in a list of both would keep every IPv4 address
// out.
function blockLists(networks) {
  const lists = { 4: new BlockList(), 6: new BlockList() };
  for (const network of networks) {
    const parsed = parseNetwork(network);
    if (parsed === null) throw new Error("not a network: " + network);
    lists[parsed[2]].addSubnet(parsed[0], parsed[1], parsed[2] === 4 ? "ipv4" : "ipv6");
  }
  return lists;
}

const DENIED = blockLists(DENIED_NETWORKS);
const GLOBAL6 = blockLists([IPV6_GLOBAL]);

/** Whether this is an address a domain key read may connect to. deny adds networks, as address/prefix, that are kept out here. */
export function publicAddress(text, deny = []) {
  if (typeof text !== "string" || text.includes("%")) return false;
  const family = isIP(text);
  if (!family) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (family === 6 && !GLOBAL6[6].check(text, kind)) return false;
  if (DENIED[family].check(text, kind)) return false;
  return !(deny.length && blockLists(deny)[family].check(text, kind));
}

class Stopped extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

const timedOut = () => Object.assign(new Error("the time is up"), { code: "ETIMEDOUT", timeout: true });
const isTimeout = (error) => error?.timeout === true || error?.code === "ETIMEDOUT";
// What the TLS layer says, as against what the socket under it says: a
// certificate that does not fit stops the read, a socket that will not
// connect lets the next address be tried.
const isTls = (error) => typeof error?.code === "string" && (/^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|EPROTO)/.test(error.code) || error.library !== undefined);

const monotonic = () => performance.now() / 1000;

/** The addresses a name resolves to, each once and in the order given, within the time left. The lookup cannot be stopped: one still running when the time is up is left, and its answer is never used. */
function resolveName(host, remaining) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timedOut()), Math.max(remaining, 0.001) * 1000);
    lookup(host, { all: true, verbatim: true }, (error, found) => {
      clearTimeout(timer);
      if (error) return reject(error);
      const addresses = [];
      for (const row of found) if ((row.family === 4 || row.family === 6) && !addresses.includes(row.address)) addresses.push(row.address);
      resolve(addresses);
    });
  });
}

/**
 * A TLS connection to an address that was checked, for the domain: the server
 * name is sent, the certificate must be for it, and one limit holds for the
 * connection and the handshake together. What comes back is the three things
 * a read needs: write, read with a time limit, and close.
 */
function open(address, host, remaining) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const queue = [];
    let ended = false;
    let failure = null;
    let wake = null;
    // The address as it is, so nothing is looked up again, and no proxy: a socket of this process's own.
    const socket = tls.connect({ host: address, port: PORT, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(timedOut());
    }, Math.max(remaining, 0.001) * 1000);
    socket.on("data", (chunk) => {
      queue.push(chunk);
      wake?.();
    });
    socket.on("end", () => {
      ended = true;
      wake?.();
    });
    socket.on("close", () => {
      ended = true;
      wake?.();
    });
    socket.on("error", (error) => {
      failure = error;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
      wake?.();
    });
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        write: (bytes) => new Promise((done, failed) => socket.write(bytes, (error) => (error ? failed(error) : done()))),
        read: (seconds) => new Promise((done, failed) => {
          let waiting = null;
          const settle = () => {
            if (queue.length) done(queue.shift());
            else if (failure) failed(failure);
            else if (ended) done(null);
            else return false;
            clearTimeout(waiting);
            wake = null;
            return true;
          };
          if (settle()) return;
          wake = settle;
          waiting = setTimeout(() => {
            wake = null;
            failed(timedOut());
          }, Math.max(seconds, 0.001) * 1000);
        }),
        close: () => socket.destroy(),
      });
    });
  });
}

/** Status, headers and body, within the limits, or Stopped. */
async function readResponse(connection, deadline, clock) {
  const receive = async () => {
    const left = deadline - clock();
    if (left <= 0) throw new Stopped("unreachable", "timeout");
    try {
      return await connection.read(left);
    } catch (error) {
      if (isTimeout(error)) throw new Stopped("unreachable", "timeout");
      throw error;
    }
  };
  let buffer = Buffer.alloc(0);
  let at;
  while ((at = buffer.indexOf("\r\n\r\n")) < 0) {
    if (buffer.length > MAX_HEADER_BYTES) throw new Stopped("invalid", "header_limit");
    const chunk = await receive();
    if (chunk === null || chunk.length === 0) throw new Stopped("unreachable", "connection_closed");
    buffer = Buffer.concat([buffer, chunk]);
  }
  const head = buffer.subarray(0, at);
  let body = buffer.subarray(at + 4);
  if (head.length > MAX_HEADER_BYTES) throw new Stopped("invalid", "header_limit");
  const lines = head.toString("latin1").split("\r\n");
  const parts = lines[0].split(" ");
  if (parts.length < 2 || !parts[0].startsWith("HTTP/1.") || !/^[0-9]{3}$/.test(parts[1])) throw new Stopped("invalid", "not_http");
  const status = Number(parts[1]);
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : line.slice(0, colon);
    if (colon < 0 || !name || name !== name.trim()) throw new Stopped("invalid", "bad_header");
    headers.set(name.toLowerCase(), line.slice(colon + 1).trim());
  }
  if (status !== 200) return [status, headers, Buffer.alloc(0)];
  for (;;) {
    if (body.length > DOMAIN_KEYS_MAX_BYTES) throw new Stopped("invalid", "body_limit");
    const chunk = await receive();
    if (chunk === null || chunk.length === 0) break;
    body = Buffer.concat([body, chunk]);
  }
  return [status, headers, body];
}

function contentTypeOk(value) {
  const at = value.indexOf(";");
  const kind = at < 0 ? value : value.slice(0, at);
  if (kind.trim().toLowerCase() !== "application/json") return false;
  const rest = (at < 0 ? "" : value.slice(at + 1)).trim().toLowerCase().replaceAll(" ", "");
  return rest === "" || rest === "charset=utf-8";
}

/**
 * Read the list at domain once and say whether it lists key, under name if
 * one is given.
 *
 * domain comes from the reader's own records, never from the message being
 * checked. allowed, when given, is the set of domains this reader agreed to
 * read, and anything else is refused before a lookup. deny adds networks the
 * operator keeps out, such as their own global ranges. resolve and connect
 * replace the network in tests; nothing else should pass them.
 */
export async function check(domain, key, name = null, { allowed = null, deny = [], resolve = resolveName, connect = open, clock = monotonic, now = () => new Date(), deadlineSeconds = DEADLINE_SECONDS } = {}) {
  const result = { domain: typeof domain === "string" ? domain : null, key: typeof key === "string" ? key : null, checked_at: now().toISOString().slice(0, 19) + "Z" };
  if (name !== null) result.requested_name = name;
  const answer = (status, reason, extra = {}) => ({ ...result, status, reason, ...extra });

  const host = normaliseDomain(domain);
  if (host === null) return answer("invalid", "invalid_domain");
  result.domain = host;
  if (!canonicalKey(key)) return answer("invalid", "invalid_subject_key");
  if (name !== null && !validDomainKeyName(name)) return answer("invalid", "invalid_requested_name");
  if (allowed !== null && !allowed.includes(host)) return answer("invalid", "domain_not_allowed");

  const deadline = clock() + deadlineSeconds;
  let addresses;
  try {
    addresses = await resolve(host, deadline - clock());
  } catch (error) {
    if (error instanceof Stopped) return answer(error.status, error.reason);
    return answer("unreachable", isTimeout(error) ? "timeout" : "dns");
  }
  if (!Array.isArray(addresses) || !addresses.length) return answer("unreachable", "dns");
  if (!addresses.every((address) => publicAddress(address, deny))) return answer("invalid", "target_not_public");

  let connection = null;
  let slow = false;
  for (let index = 0; index < addresses.length; index++) {
    const left = deadline - clock();
    if (left <= 0) return answer("unreachable", "timeout");
    // An even share of what is left, so an address that never answers, such
    // as an IPv6 route that goes nowhere, does not take the next one's time.
    try {
      connection = await connect(addresses[index], host, left / (addresses.length - index));
      break;
    } catch (error) {
      if (isTls(error)) return answer("unreachable", "tls");
      if (isTimeout(error)) slow = true;
    }
  }
  if (connection === null) return answer("unreachable", slow ? "timeout" : "connect");

  let status;
  let headers;
  let body;
  try {
    await connection.write(Buffer.from(`GET ${DOMAIN_KEYS_PATH} HTTP/1.0\r\nHost: ${host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nUser-Agent: ${USER_AGENT}\r\nConnection: close\r\n\r\n`, "ascii"));
    [status, headers, body] = await readResponse(connection, deadline, clock);
  } catch (error) {
    if (error instanceof Stopped) return answer(error.status, error.reason);
    if (isTls(error)) return answer("unreachable", "tls");
    return answer("unreachable", isTimeout(error) ? "timeout" : "network");
  } finally {
    try {
      connection.close();
    } catch {
      // Closed already.
    }
  }

  if (status === 404 || status === 410) return answer("no_list", "no_list", { http_status: status });
  // The statuses that point elsewhere. 304 is not one of them: a read that
  // asked for no cache has no business being told nothing changed, and that
  // is no answer rather than a refusal.
  if ([300, 301, 302, 303, 307, 308].includes(status)) return answer("invalid", "redirect_refused", { http_status: status });
  if (status !== 200) return answer("unreachable", "http_status", { http_status: status });
  if (!contentTypeOk(headers.get("content-type") ?? "")) return answer("invalid", "content_type");
  if ((headers.get("content-encoding") ?? "identity").trim().toLowerCase() !== "identity" || headers.has("transfer-encoding")) return answer("invalid", "content_encoding");
  if (headers.has("content-length") && headers.get("content-length").trim() !== String(body.length)) return answer("invalid", "length_mismatch");

  const found = matchDomainKey(new Uint8Array(body), key, name);
  if (found.status === "invalid") return answer("invalid", "invalid_document", { detail: found.detail ?? null });
  const extra = { document_sha256: found.document_sha256 };
  if (found.status === "listed") extra.matched_name = found.matched_name;
  return answer(found.status, found.reason, extra);
}
