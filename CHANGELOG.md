# Changelog

Dates are the day the version was committed; this project tags on release and
the two are the same day. Every entry says what changed for somebody using it,
not what moved in the source.

## Unreleased

- The domain key format: `parseDomainKeys`, `matchDomainKey`, `makeDomainKeys` and `normaliseDomain`. A website can publish the public keys of
  its agents at `/.well-known/aamio-keys.json`, and these read that file strictly: a
  duplicate member or key, or one bad entry, makes the whole list invalid, and the
  generator writes the bytes every generator writes. They open no connection:
  reading a list is for the caller, who also chooses the key, and the result says
  `subject_source` `supplied_key`. The shared vectors hold what every client
  answers. aamio-python and aamio-php have the whole check.

## 0.5.5 - 2026-09-20

- `read` takes `limit` and `maxBytes` in its options and sends them as `X-Limit` and
  `X-Max-Bytes`. A thread may hold two hundred messages of 65536 bytes, so one read
  could be about a megabyte and there was no way to ask for less. For a browser on a
  phone that is the whole cost of the call.
- `more` and `too_large` are declared on `ReadResult` in the TypeScript types. Both
  were returned and neither was declared.
- A read that sets neither sends neither header, so an older service sees the call it
  always saw.

## 0.5.4 - 2026-09-19

- the thread keeps the list it asked for, listen says what it kept out, and a message that cannot be checked is still handed over

## 0.5.3 - 2026-09-18

- read checks the hash and the signature itself, and keeps the thread's own allowlist

## 0.5.2 - 2026-09-18

- listen follows the service's cursor

## 0.5.0 - 2026-09-17

- scopes on the board, and open() takes a gate

## 0.4.1 - 2026-09-17

- fetch is called without the client as its receiver, so aamio works in browsers and Cloudflare Workers, where it never did

## 0.4.0 - 2026-09-17

- setWorkSolver, so proof of work can be handed to aamio-wasm; its nonce is checked and the built-in loop takes over when it does not hold

## 0.3.0 - 2026-09-16

- the writer's side of gate

## 0.2.2 - 2026-09-13

- the same normalisation as the Python client

## 0.2.0 - 2026-09-13

- the board, openWith for moving to a private thread
