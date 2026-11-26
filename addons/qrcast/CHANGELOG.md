# Changelog

aamio-qrcast for Node, the add-on. Dates are the day the version was
committed; it is tagged on release, and the two are the same day. Every entry
says what changed for somebody using it. The version is the one the add-on has
for aamio-python and aamio-php, and a number says the same of all three.

## 0.2.1 - 2026-11-27

- The examples, the help and the manifest name the documentation address `00:00:5E:00:53:01` for Bluetooth
  instead of a real adapter's. Nothing else changed; the number is the same in all three runtimes.

## 0.2.0 - 2026-11-19

- The card is Earshot's card of 0.5.0: `--via` (`via` over MCP) names the
  media you prefer answers over, a transport's medium alone or with where you
  are reached on it, and a card that names one carries your public key, from
  `--key` on the command line and the runtime's own over MCP. Over MCP each
  medium gets where this machine is reached on it from the runtime's own
  transports. Only qrcast 0.2.0 and earshot 0.5.0 and newer read such a card;
  without `--via` and `--key` it is the card earlier versions made. Needs
  aamio 0.8.1 for Node.
- A card seen with media and a key says how to bind a transport to it, with
  `aamio partner add` and `aamio transport bind`, with `--address` when the
  card says where, and binds nothing itself.
- Over MCP the reader names the transport to bind: the first medium on the
  card that one of this machine's transports carries, under that transport's
  name, so nobody has to know which transport carries which medium. When none
  does, it says so. On the command line TRANSPORT stands for it, as before.
- Over MCP a medium whose transport on this machine gives no address, as
  sound, goes on the card alone, and the note says why rather than what to
  put right.

## 0.1.3 - 2026-11-14

- zbarimg, ffmpeg and the openers of a picture start by their full path:
  `cmd` from the folder Windows keeps it in, and `open`, `sh` and `xdg-open`
  from the folders `PATH` names by a full path, never the working directory.
  `COMSPEC` is no longer what starts. A `PATH` that began with `.` gave back a
  name relative to wherever the agent ran. winget's link folder is looked in
  only through a `LOCALAPPDATA` that is a full path.

## 0.1.2 - 2026-11-12

- The first version for Node. `aamio addon qrcast card`, `show`, `read` and
  `scan`, and the MCP tools aamio_addon_qrcast_show, aamio_addon_qrcast_read
  and aamio_addon_qrcast_scan, as in aamio-qrcast 0.1.2 for Python and for
  PHP: the same manifest, the same answers and exit codes, and the same card,
  the earshot add-on's, which carries the write address of a scope, exactly 20
  characters, and never a key. The code is made on this machine, at error
  correction level M with a quiet zone of four modules, the same code module
  for module as the other two editions make, and drawn as PNG, SVG or text.
  zbarimg reads pictures and camera frames here, and ffmpeg takes the frames.
  aisenseapi.com makes and reads the code when engine aisense is asked for,
  and is never sent a frame from the camera; when it cannot be reached or
  cannot do it, the work is done here and the answer says whether the card or
  the picture had gone there. The package has no dependencies. On contract 2
  of aamio's add-ons, for aamio 0.7.0 or later for Node.
- The aisense engine goes through a proxy only where Node is told to use one:
  with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` in the environment, on a Node
  that knows the setting, as Node 24 does and Node 20 does not. Otherwise it
  connects directly, and behind a proxy the local engine does the work.
