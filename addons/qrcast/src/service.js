import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NothingSeen, Refused, Unreachable } from "./errors.js";

/*
 * The two calls to aisenseapi.com, for whoever asks for the aisense engine: a
 * card to a code, and a picture back to text.
 *
 *     POST https://aisenseapi.com/services/v1/qrcode_encode    JSON in, JSON with a PNG out
 *     POST https://aisenseapi.com/services/v1/qrcode_decode    a picture in, as multipart/form-data, JSON out
 *
 * Both are free and need no key. The card and the picture go to AI SENSE over
 * HTTPS. aisense makes its code at error correction level H, blue and
 * softened, with two modules of quiet zone, so the same card is a larger code
 * with smaller modules than this add-on's own. It reads a picture with zbarimg
 * and answers every code it finds, QR codes and barcodes alike, one to a line.
 *
 * aisense answers 400 both when a picture holds no code and when it cannot
 * read the picture at all, so its sentence "No QR code or barcode was found"
 * is what tells the two apart; a 422, as audio_decode answers for no message,
 * is taken for no code too. It answers 413 for a picture over 10 MiB or 25
 * megapixels, 415 for a format it does not read, and 429 or 503 with
 * Retry-After when it cannot serve now. A picture goes as multipart: JSON
 * bodies stop at 256 KB there, less than a photo. An answer that is not what
 * the endpoint documents is unreachable here, never guessed at. The same as
 * aamio-python's aamio_qrcast.service and aamio-php's Service.
 */

export const VERSION = JSON.parse(readFileSync(new URL("../aamio-addon.json", import.meta.url), "utf8")).version;
export const BASE = "https://aisenseapi.com/services/v1";
export const MAX_IMAGE_BYTES = 10485760;
// What a test may lower: the most bytes of a picture that are read.
export const limits = { maxImageBytes: MAX_IMAGE_BYTES };
export const MAX_PIXELS = 25000000;
export const MAX_JSON_BYTES = 1048576;
export const TIMEOUT = 30;
export const AGENT = "aamio-qrcast/" + VERSION;
export const NOTHING = "No QR code or barcode was found";
export const TYPES = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// What Node says when a certificate does not hold.
const CERTIFICATE = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** aisense's JSON, read from the first brace: PHP warnings can come before it. */
function json(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const said = JSON.parse(text.slice(start));
    return isObject(said) ? said : null;
  } catch {
    return null;
  }
}

/** aisense's own error and fix, when its answer carries them. */
function words(payload) {
  const said = json(payload) ?? {};
  return [typeof said.error === "string" ? said.error : null, typeof said.fix === "string" ? said.fix : null];
}

function failure(status, headers, payload, done, refused) {
  const retry = headers?.["retry-after"] ?? null;
  const later = retry !== null ? ` Try again after ${retry} seconds.` : " Try again later.";
  if (status === 429) return new Unreachable("rate_limited", "aisenseapi.com counts requests per address and day, and this address has used its share for now." + later, retry, true);
  if (status === 503) return new Unreachable("service_busy", "aisenseapi.com cannot serve this right now." + later, retry, true);
  if (status >= 400 && status < 500) {
    const [error, fix] = words(payload);
    return new Refused(refused, `aisenseapi.com would not take it: ${error ?? `HTTP ${status}.`} ${fix ?? ""}`.trim());
  }
  return new Unreachable("service_unreachable", `aisenseapi.com answered HTTP ${status}, so nothing was ${done}.` + later, null, true);
}

/** The PNG of aisense's code for a card. send is for tests. */
export async function encode(card, send = post) {
  const [status, headers, payload] = await send("/qrcode_encode", JSON.stringify({ data: card }), "application/json", MAX_JSON_BYTES);
  if (status !== 200) throw failure(status, headers, payload, "made", "service_refused");
  const said = json(payload);
  const image = said !== null && typeof said.qrcode_image === "string" && BASE64.test(said.qrcode_image) ? Buffer.from(said.qrcode_image, "base64") : null;
  if (image === null || image.length < PNG.length || !image.subarray(0, PNG.length).equals(PNG)) {
    throw new Unreachable("service_answered_something_else", "aisenseapi.com answered with something other than the PNG it documents, so nothing was made. Try again later, or use the local engine.", null, true);
  }
  return image;
}

/** Every code aisense read in a picture, one text each. NothingSeen when it found none. send is for tests. */
export async function decode(picture, kind, send = post) {
  const edge = "aamio-qrcast-" + randomBytes(12).toString("hex");
  const head = `--${edge}\r\nContent-Disposition: form-data; name="qrcode_image"; filename="picture.${kind}"\r\nContent-Type: ${TYPES[kind] ?? "application/octet-stream"}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, "latin1"), picture, Buffer.from(`\r\n--${edge}--\r\n`, "latin1")]);
  const [status, headers, payload] = await send("/qrcode_decode", body, "multipart/form-data; boundary=" + edge, MAX_JSON_BYTES);
  if (status === 400 || status === 422) {
    const [error, fix] = words(payload);
    // 422 is how audio_decode says it heard no message, and what qrcode_decode may say one day.
    if (status === 422 || (error !== null && error.startsWith(NOTHING))) {
      throw new NothingSeen("aisense found no code in the picture. " + (fix ?? "Send a sharper, larger or straighter picture of the code."));
    }
  }
  if (status !== 200) throw failure(status, headers, payload, "read", "not_readable");
  const said = json(payload);
  if (said === null || typeof said.qrcode_content !== "string") {
    throw new Unreachable("service_answered_something_else", "aisenseapi.com answered with something other than the JSON it documents, so nothing was read. Try again later, or use the local engine.", null, true);
  }
  return said.qrcode_content.split("\n").map((line) => line.replace(/\r+$/, "")).filter((line) => line !== "");
}

/** What went wrong with a request that got no answer, in a few words. */
function reasonOf(error) {
  const cause = error?.cause ?? error;
  return String(cause?.code || cause?.message || error?.name || "no reason given");
}

/**
 * One POST over HTTPS, the answer capped at limit bytes: its status, its
 * headers by their names in lower case, and its body. No redirect is
 * followed: a card or a picture goes to the address asked for or nowhere.
 * base and fetch are for tests.
 */
export async function post(path, body, type, limit, { base = BASE, fetch: fetcher = globalThis.fetch, timeout = TIMEOUT } = {}) {
  if (typeof fetcher !== "function") {
    throw new Unreachable("no_fetch", "This Node has no fetch, which the aisense engine needs. Use Node 20 or later, or the local engine.");
  }
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, timeout * 1000);
  try {
    let response;
    try {
      response = await fetcher(base + path, { method: "POST", body, headers: { "Content-Type": type, "User-Agent": AGENT }, redirect: "manual", signal: stop.signal });
    } catch (error) {
      const reason = reasonOf(error);
      if (!timedOut && CERTIFICATE.test(reason)) {
        throw new Unreachable("service_unreachable", "The certificate of aisenseapi.com could not be verified on this machine. If the site opens in a browser, Node may lack the root: NODE_EXTRA_CA_CERTS can point it at a CA bundle. Verification is never switched off.");
      }
      throw new Unreachable("service_unreachable", `aisenseapi.com could not be reached: ${timedOut ? `no answer within ${timeout} seconds` : reason}. Check the network and try again, or use the local engine.`);
    }
    const headers = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    // Reading the answer can fail as well, a timeout or a connection cut
    // halfway, and that is aisenseapi.com unreachable too, not an error out of
    // the add-on: the local engine takes over. It had the request by then.
    const parts = [];
    let received = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > limit) break;
          parts.push(Buffer.from(chunk));
        }
      }
    } catch (error) {
      throw new Unreachable("service_unreachable", `aisenseapi.com answered, and the answer broke off: ${timedOut ? `nothing more within ${timeout} seconds` : reasonOf(error)}. Try again, or use the local engine.`, null, true);
    }
    if (received > limit) {
      stop.abort();
      throw new Unreachable("service_answered_something_else", "aisenseapi.com answered with more than it documents, so nothing was used. Try again later.", null, true);
    }
    return [response.status, headers, Buffer.concat(parts)];
  } finally {
    clearTimeout(timer);
  }
}
