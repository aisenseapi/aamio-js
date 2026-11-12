import { isScopeKey, keyHash, scopeAddress } from "./aamio.js";

/*
 * The scopes of the local runtime. A scope keeps board posts unlisted for a
 * group. Here each one has a name, and the name is all a caller passes or
 * sees. The key is the read capability: it stays in scopes.json, and a share
 * hands it to a partner sealed, so no model has to hold it. The address is the
 * write capability and is no secret. Unlisted is not private.
 *
 * scopes.json is the file aamio-python and aamio-php keep, in the same shape:
 * a list of {name, key, address}, with taken_from on a scope that came by
 * invitation, and {removed_share} for an invitation whose scope was removed.
 * A home reads the same in all three.
 *
 * Everything here is a function of what it is given. The runtime holds the
 * list and writes the file.
 */

export const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADDRESS = /^[a-z2-7]{20}$/;
// One invitation as a channel records a message it handed over, seen_from in
// node-runtime.js: the hash of its bytes, and who signed them.
const RECORD = /^[0-9a-f]{64}:(?:[0-9a-f]{16}|-|\?)$/;
// What a scope share says when scopes.json could not be written, and attention
// says why. Shorter than the form a kept share takes, which a share is weighed
// at when that is the longer.
export const SCOPE_NOT_SAVED = "not kept: could not be saved";
// How many invitations whose scope was removed scopes.json remembers. One is
// only read again while its thread lives, and the oldest go first.
export const SCOPE_REMOVED_KEEP = 256;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The write capability of a scope as it goes on a post: 20 characters of a-z and 2-7. */
export function isScopeAddress(text) {
  return typeof text === "string" && ADDRESS.test(text);
}

/** What an invitation is known by, when it is known: the record a channel keeps of the message. */
export function isShareRecord(text) {
  return typeof text === "string" && RECORD.test(text);
}

/** A scope's name as every runtime takes it. Throws invalid_scope. */
export function checkScopeName(name) {
  if (typeof name !== "string" || !SCOPE_NAME.test(name)) {
    throw scopeError("invalid_scope", "a scope name is 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or a digit");
  }
}

/**
 * What a scope made elsewhere is given by, checked where nothing has been
 * opened yet: the key, to read and post, or the address, to post only. Gives
 * the address the scope has. Throws invalid_scope.
 */
export function checkScopeAdd(name, key = null, address = null) {
  checkScopeName(name);
  if (key === null && address === null) throw scopeError("invalid_scope", "give the key, to read and post, or the address, to post only");
  if (key !== null && !isScopeKey(key)) throw scopeError("invalid_scope", "a scope key is 26 to 64 characters of a-z and 0-9. The 20 character address goes in address");
  if (address !== null && !isScopeAddress(address)) throw scopeError("invalid_scope", "a scope address is the 20 characters of a-z and 2-7 that go on a post");
  const derived = key !== null ? scopeAddress(key) : address;
  if (address !== null && derived !== address) throw scopeError("invalid_scope", "that key does not give that address, so one of the two is wrong");
  return derived;
}

/** What a share gives: read, the key, or write, the address alone. Throws invalid_access. */
export function checkAccess(access) {
  if (access !== "read" && access !== "write") {
    throw scopeError("invalid_access", "access is read, which gives the key to read and post, or write, which gives the address to post only");
  }
}

/** An entry of scopes.json that remembers an invitation whose scope was removed, as aamio-python and aamio-php write it. */
export function isRemovedShare(entry) {
  return isObject(entry) && Object.keys(entry).length === 1 && isShareRecord(entry.removed_share);
}

/** The invitations whose scope was removed, among the entries kept aside. */
export function removedShares(aside) {
  return new Set(aside.filter(isRemovedShare).map((entry) => entry.removed_share));
}

/**
 * The entries of scopes.json this runtime can use, and the rest. The rest are
 * never dropped: they go back into the file on every save as they were, so a
 * hand edit with a typo is there to be corrected rather than gone with the
 * key in it. unusable counts the ones that are not a removed invitation, which
 * is remembered among the rest and is no typo to report.
 */
export function usableScopes(entries) {
  const usable = [];
  const aside = [];
  const names = new Set();
  for (const entry of entries) {
    const key = isObject(entry) ? entry.key ?? null : null;
    const fine = isObject(entry) && typeof entry.name === "string" && SCOPE_NAME.test(entry.name) && !names.has(entry.name.toLowerCase())
      && isScopeAddress(entry.address) && (key === null || (isScopeKey(key) && scopeAddress(key) === entry.address));
    if (fine) {
      usable.push(entry);
      names.add(entry.name.toLowerCase());
    } else {
      aside.push(entry);
    }
  }
  return { usable, aside, unusable: aside.filter((entry) => !isRemovedShare(entry)).length };
}

/** The scope with this name, apart from upper and lower case, or null. */
export function scopeCalled(scopes, name) {
  const wanted = String(name).toLowerCase();
  return scopes.find((entry) => entry.name.toLowerCase() === wanted) ?? null;
}

/** A scope as a caller sees it: never with its key. */
export function scopeView(entry) {
  return { name: entry.name, address: entry.address, can_read: Boolean(entry.key) };
}

/**
 * What adding a scope would hold, and the list it would keep, or null for the
 * list when nothing changes. Nothing is kept here. A name already taken by
 * another address is refused, an address held under another name stays under
 * that name, and a key for a scope held to post only adds reading to it.
 */
export function scopeAddPlan(scopes, name, key = null, address = null) {
  const derived = checkScopeAdd(name, key, address);
  const named = scopeCalled(scopes, name);
  if (named !== null && named.address !== derived) {
    throw scopeError("scope_exists", `there is a scope called ${name} already, with another address. Remove it or choose another name`);
  }
  const before = named ?? scopes.find((entry) => entry.address === derived) ?? null;
  if (before === null) {
    const held = { name, key, address: derived };
    return [held, [...scopes, held]];
  }
  if (key !== null && !before.key) {
    // Held to post only until now. The key adds reading.
    const held = { ...before, key };
    return [held, scopes.map((entry) => (entry === before ? held : entry))];
  }
  return [before, null];
}

/**
 * The name a scope from a partner is kept under: the partner's name, a dot
 * and the scope's. A partner names its own scopes, and a name is where posts
 * go. Kept under the bare name, a partner could take review before review was
 * made here, and the posts meant for it would go where that partner reads.
 * The partner's part is made of what a name may hold, cut to 24 characters,
 * and is the start of the key's hash when nothing of the name is left.
 */
export function sharedScopeName(partner, name) {
  checkScopeName(name);
  const prefix = String(partner.name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 24) || keyHash(partner.key).slice(0, 8);
  return `${prefix}.${name}`.slice(0, 64);
}

/** The invitations a scope was taken from, as the file holds them. */
export function takenFrom(entry) {
  return Array.isArray(entry.taken_from) ? entry.taken_from : [];
}

/**
 * The list without one scope, and the rest with the invitations it came from
 * remembered, in one write: the same invitation read again then keeps
 * nothing. The newest SCOPE_REMOVED_KEEP are remembered, and the oldest go.
 */
export function scopeRemovePlan(scopes, aside, entry) {
  let rest = [...aside];
  const removed = removedShares(rest);
  for (const share of takenFrom(entry)) {
    if (!isShareRecord(share) || removed.has(share)) continue;
    rest.push({ removed_share: share });
    removed.add(share);
  }
  const held = rest.filter(isRemovedShare);
  if (held.length > SCOPE_REMOVED_KEEP) {
    const dropped = new Set(held.slice(0, held.length - SCOPE_REMOVED_KEEP));
    rest = rest.filter((item) => !dropped.has(item));
  }
  return [scopes.filter((item) => item !== entry), rest];
}

/** How many bytes a form of a share takes in a message as it is handed over. */
const formBytes = (form) => Buffer.byteLength(JSON.stringify(form), "utf8");

/** The longer of the two forms a share that may be kept can end in: what a message is weighed at before it is known which. */
export function longerForm(shown, unsaved) {
  return formBytes(unsaved) > formBytes(shown) ? unsaved : shown;
}

/**
 * value with the scope's key taken out of every string in it. The key goes to
 * the board in the body of a find and reads the whole scope. Nothing the board
 * answers has to carry it, and what a runtime shows is read by a model: a
 * board that sent it back, or a post that quotes it, is shown without it.
 */
export function withoutScopeKey(value, key) {
  if (typeof value === "string") return value.split(key).join("[scope key]");
  const text = JSON.stringify(value);
  return text.includes(key) ? JSON.parse(text.split(key).join("[scope key]")) : value;
}
