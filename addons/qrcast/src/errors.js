// What can stop a call, each with a reason the answer carries and, where the
// caller can do something about it, the words that say what.

/** Input refused, here before anything was made or sent, or by aisenseapi.com in its own words. */
export class Refused extends Error {
  constructor(reason, fix) {
    super(fix);
    this.reason = reason;
    this.fix = fix;
  }
}

/** Something seen that is not a card this version reads. */
export class NotUnderstood extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** A picture in which aisenseapi.com found no code. */
export class NothingSeen extends Error {
  constructor(fix) {
    super(fix);
    this.fix = fix;
  }
}

/**
 * aisenseapi.com, the screen or the camera could not do it now. answered is
 * true when aisenseapi.com sent an answer back, so the request, with the card
 * or the picture, had reached it.
 */
export class Unreachable extends Error {
  constructor(reason, fix, retryAfter = null, answered = false) {
    super(fix);
    this.reason = reason;
    this.fix = fix;
    this.retryAfter = retryAfter;
    this.answered = answered;
  }
}

/** A picture the reader here cannot open, or no reader here at all. */
export class Unreadable extends Error {
  constructor(reason, fix) {
    super(fix);
    this.reason = reason;
    this.fix = fix;
  }
}

/** More bytes than a version 10 code at level M holds. */
export class TooLong extends Error {}
