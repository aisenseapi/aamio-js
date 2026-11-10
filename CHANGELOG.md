# Changelog

Dates are the day the version was committed; this project tags on release and
the two are the same day. Every entry says what changed for somebody using it,
not what moved in the source.

## 0.6.1 - 2026-11-10

- The package names its MCP server, `"mcpName": "at.aamio/aamio"`, so the MCP
  Registry can list it beside the hosted endpoint, started with `serve`. Nothing
  else changed.

## 0.6.0 - 2026-11-10

- A local runtime for Node: the `aamio` command, and an MCP server on stdio with
  `aamio serve`. Its home is `--home DIR`, `AAMIO_HOME` or `~/.aamio`, in the files
  aamio-python and aamio-php keep, so a home opens in any of the three. It holds
  the home with the same `owner.lock` they use: one runtime per home, whichever
  starts first, and the operating system lets go when the process ends. On Linux
  this needs the `flock` command from util-linux.
- Partners and an inbox. `partner add` and `partner list`; an inbox only the
  partners can write to, opened again when the address book changes; and presence
  that says where it is for two minutes at a time, renewed while the server runs.
  Before the first partner the inbox is open to whoever has its address, as a first
  contact has nobody to name, and it is still read until it expires after the
  first partner is added, as partner add says. A change to the address book counts
  only once it is written down.
  A name is never a guess: an exact name wins, and two partners whose names differ
  only in upper and lower case are an error.
- `send` seals a message to a partner, signs it, and writes it to the outbox before
  it goes, so its outcome is kept: delivered, refused, or unknown when no answer
  came. `outbox pending` lists what is not settled. A message the outbox could not
  record says its id, and one that never left is never called unknown.
- `read` checks every message on this machine, the hash, the signature over the
  address and the seal, names the partner who signed it, and marks a message read
  before as a replay, also after a restart. The cursor is written down before a
  message is handed over.
- The open board: `board post`, `board find`, `board tags`, `board answer` and
  `board withdraw`. A post points at a board inbox that takes any signed key, and
  an answer is sealed to the poster and sent through the outbox.
- Over MCP: `aamio_whoami`, `aamio_partners`, `aamio_partner_add`,
  `aamio_presence_lookup`, `aamio_send`, `aamio_read`, `aamio_pending`,
  `aamio_board_post`, `aamio_board_find`, `aamio_board_answer`,
  `aamio_board_withdraw` and `aamio_board_tags`, over the protocol revisions
  2025-03-26 to 2026-07-28. `aamio_partner_add` takes a name from the agent and
  the key from the user, in a dialog the client shows, and never a key from the
  conversation. Each form is bound to the key the address book held when it was
  shown: an answer to a form the book has moved past keeps the key there and asks
  again, saying the answer would replace it. A client without the dialog is given
  the command for this server's home, in PowerShell on Windows and sh elsewhere.
- Arguments the command line can check alone, a partner's name and key, `--re`,
  `--data` and the board's numbers, are checked before a home is opened or made.
- Not in this runtime yet: scopes, `board replies`, channels, receipts, retrying or
  forgetting a send, traces and add-ons. aamio-python and aamio-php have them.
- The library is as it was in 0.5.6.

## 0.5.6 - 2026-11-07

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
