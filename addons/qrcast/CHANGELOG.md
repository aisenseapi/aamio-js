# Changelog

aamio-qrcast for Node, the add-on. Dates are the day the version was
committed; it is tagged on release, and the two are the same day. Every entry
says what changed for somebody using it. The version is the one the add-on has
for aamio-python and aamio-php, and a number says the same of all three.

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
