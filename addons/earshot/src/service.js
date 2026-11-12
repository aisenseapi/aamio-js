import http from "node:http";
import https from "node:https";
import { VERSION } from "./about.js";
import { Refused } from "./card.js";

/*
 * The two calls to aisenseapi.com: a card to sound, and sound back to bytes.
 *
 *     POST https://aisenseapi.com/services/v1/audio_encode          JSON in, WAV out
 *     POST https://aisenseapi.com/services/v1/audio_decode/MODE     WAV in, JSON out
 *
 * Both are free and need no key. What is encoded and what is recorded go to
 * AI SENSE over HTTPS, and are not kept there, as the pages for the two
 * endpoints say. aisense answers 422 when a recording holds no intact message,
 * 400 when a file is not one it reads, and 429 or 503 with Retry-After when it
 * cannot serve now. An answer that is not what the endpoint documents is
 * unreachable here, never guessed at. The same as aamio-python's
 * aamio_earshot.service and aamio-php's Aamio\Earshot\Service.
 *
 * A redirect is not followed, and the certificate is always verified. Node
 * takes no proxy from the environment here: behind one, aisenseapi.com is not
 * reached, and the local engine does the work and says so.
 */

export const BASE = "https://aisenseapi.com/services/v1";
export const MODES = ["audible", "high", "ultrasound"];
export const DECODE_MODES = ["auto", ...MODES];
// What aisense reads: at most 40 seconds and 8 MiB of PCM16 WAV.
export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
// The longest message aisense makes is about 17 seconds, 1.6 MB of WAV.
export const MAX_SOUND_BYTES = 4 * 1024 * 1024;
export const MAX_JSON_BYTES = 64 * 1024;
export const TIMEOUT = 30;
export const AGENT = "aamio-earshot/" + VERSION;
// What a recording may be, where a test can lower it.
export const limits = { recording: MAX_RECORDING_BYTES };

/** aisenseapi.com did not do it. answered is true when it sent an answer back, so the request, with the card or the recording, had reached it. */
export class Unreachable extends Error {
  constructor(reason, fix, retryAfter = null, answered = false) {
    super(fix);
    this.reason = reason;
    this.fix = fix;
    this.retryAfter = retryAfter;
    this.answered = answered;
  }
}

/** A recording that holds no complete message, as aisenseapi.com or the local codec read it. */
export class NothingHeard extends Error {
  constructor(fix) {
    super(fix);
    this.fix = fix;
  }
}

export { Refused };

export function isWav(data) {
  return Buffer.isBuffer(data) && data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WAVE";
}

// What Node says when a certificate does not verify.
const CERTIFICATE = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "CERT_REJECTED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH",
]);

/**
 * One POST, the answer capped at limit + 1 bytes, as [status, headers,
 * payload]: the headers by their names in lower case. base is for tests, and
 * is HTTPS or the loopback: nothing goes anywhere else in the clear.
 */
export function post(path, body, contentType, limit, { base = BASE, timeout = TIMEOUT } = {}) {
  const url = new URL(base + path);
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    return Promise.reject(new Error("the sound goes over HTTPS, or to 127.0.0.1 in a test, and nowhere else"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    // Whether an answer had begun: the request had been taken by then.
    let answered = false;
    let timer = null;
    const finish = (act, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      act(value);
    };
    const failed = (error) => {
      const why = error?.code || error?.message || "no reason given";
      if (answered) {
        // Reading the answer can fail as well, a timeout or a connection cut
        // halfway, and that is aisenseapi.com unreachable too, not an error
        // out of the add-on: the local engine takes over. It had the request
        // by then.
        finish(reject, new Unreachable("service_unreachable", `aisenseapi.com answered, and the answer broke off: ${why}. Try again.`, null, true));
      } else if (CERTIFICATE.has(error?.code)) {
        finish(reject, new Unreachable("service_unreachable", "The certificate of aisenseapi.com could not be verified on this machine. If the site opens in a browser, this machine's store may have a root Node does not: NODE_EXTRA_CA_CERTS can point Node at a CA bundle. Verification is never switched off."));
      } else {
        finish(reject, new Unreachable("service_unreachable", `aisenseapi.com, which makes and reads the sound, could not be reached: ${why}. Check the network and try again.`));
      }
    };
    let request;
    try {
      request = (secure ? https : http).request(url, {
        method: "POST", agent: false,
        headers: { "Content-Type": contentType, "Content-Length": body.length, "User-Agent": AGENT },
      });
    } catch (error) {
      failed(error);
      return;
    }
    request.on("response", (response) => {
      answered = true;
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
        if (size > limit) {
          // More than the endpoint documents: one byte past the limit is kept, so the caller sees it was.
          finish(resolve, [response.statusCode, response.headers, Buffer.concat(chunks).subarray(0, limit + 1)]);
          request.destroy();
        }
      });
      response.on("end", () => finish(resolve, [response.statusCode, response.headers, Buffer.concat(chunks)]));
      response.on("error", failed);
      response.on("close", () => {
        if (!response.complete) failed(Object.assign(new Error("the connection closed before the answer ended"), { code: "ECONNRESET" }));
      });
    });
    request.on("error", failed);
    timer = setTimeout(() => {
      const late = Object.assign(new Error(`no answer within ${timeout} seconds`), { code: "ETIMEDOUT" });
      failed(late);
      request.destroy(late);
    }, timeout * 1000);
    request.end(body);
  });
}

/** aisense's own error and fix, when its answer carries them. */
function words(payload) {
  let said;
  try {
    said = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return [null, null];
  }
  if (said === null || typeof said !== "object" || Array.isArray(said)) return [null, null];
  return [typeof said.error === "string" ? said.error : null, typeof said.fix === "string" ? said.fix : null];
}

function failure(status, headers, payload, done, refused) {
  const retry = headers?.["retry-after"] ?? null;
  const later = retry ? ` Try again after ${retry} seconds.` : " Try again later.";
  if (status === 429) {
    return new Unreachable("rate_limited", "aisenseapi.com counts requests per address and day, and this address has used its share for now." + later, retry, true);
  }
  if (status === 503) return new Unreachable("service_busy", "aisenseapi.com cannot serve this right now." + later, retry, true);
  if (status >= 400 && status < 500) {
    const [error, fix] = words(payload);
    return new Refused(refused, `aisenseapi.com would not take it: ${error ?? `HTTP ${status}.`} ${fix ?? ""}`.trim());
  }
  return new Unreachable("service_unreachable", `aisenseapi.com answered HTTP ${status}, so nothing was ${done}.` + later, null, true);
}

/** The WAV for a card, made by aisense. send is for tests. */
export async function encode(card, mode, send = post) {
  const body = Buffer.from(JSON.stringify({ data: card, input_encoding: "utf8", mode }), "utf8");
  const [status, headers, payload] = await send("/audio_encode", body, "application/json", MAX_SOUND_BYTES);
  if (status !== 200) throw failure(status, headers, payload, "played", "service_refused");
  if (!isWav(payload) || payload.length > MAX_SOUND_BYTES) {
    throw new Unreachable("service_answered_something_else", "aisenseapi.com answered with something other than the WAV file it documents, so nothing was played. Try again later.", null, true);
  }
  return payload;
}

/** What aisense read in a WAV: data_base64, text, protocol, corrected_bits and mode. NothingHeard when it read no message. */
export async function decode(sound, mode, send = post) {
  const [status, headers, payload] = await send("/audio_decode/" + mode, sound, "audio/wav", MAX_JSON_BYTES);
  if (status === 422) {
    const [error, fix] = words(payload);
    const said = error ? ": " + error.slice(0, 1).toLowerCase() + error.slice(1).replace(/\.+$/, "") : "";
    throw new NothingHeard(`No complete message was heard${said}. ${fix ?? "Record the whole sound, close to the speaker, in a quiet room, and try audible mode."}`);
  }
  if (status !== 200) throw failure(status, headers, payload, "read", "not_readable");
  let said = null;
  try {
    said = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    said = null;
  }
  if (said === null || typeof said !== "object" || Array.isArray(said) || typeof said.data_base64 !== "string") {
    throw new Unreachable("service_answered_something_else", "aisenseapi.com answered with something other than the JSON it documents, so nothing was read. Try again later.", null, true);
  }
  return said;
}
