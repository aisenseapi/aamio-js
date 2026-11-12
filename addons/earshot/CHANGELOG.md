# Changelog

aamio-earshot for Node, the add-on. Its version is the version of the add-on
it is an edition of, aamio-python's aamio-earshot and aamio-php's
aisenseapi/aamio-earshot, whose changelogs say what each version changed.
Dates are the day the version was committed. Every entry says what changed for
somebody using it.

## 0.3.2 - 2026-11-12

- The first version for Node. The same add-on as aamio-earshot 0.3.2 for
  Python and aisenseapi/aamio-earshot 0.3.2 for PHP, with the same manifest:
  `aamio addon earshot card`, `broadcast`, `listen` and `decode`, and the MCP
  tools aamio_addon_earshot_broadcast, aamio_addon_earshot_listen and
  aamio_addon_earshot_decode. A card is the write address of a scope, exactly
  20 characters, and never a key; it says until when it is good, and a
  listener turns down one past its time.
- Two engines, as in the other editions: aisense, the default, at
  aisenseapi.com, and local, on this machine. The local engine makes the same
  sound as aisense and as the other two editions byte for byte, and reads what
  they make. When aisenseapi.com cannot be reached or cannot do the work, it
  is done here and the answer says so, and whether the card or the recording
  had gone there.
- A program of the system plays and records, as in the PHP edition:
  PowerShell's Media.SoundPlayer, afplay, paplay, pw-play, aplay or ffplay for
  the speaker, and sox, arecord or ffmpeg for the microphone. Each is started
  by its full path, never through a shell.
- The package has no dependencies and runs no script when it is installed. It
  is installed in the home's folder for add-ons, `addon-packages/npm`, after
  `aamio init`, and enabled with `aamio addon enable earshot`.
- No proxy is taken from the environment, and a redirect is not followed:
  where aisenseapi.com is not reached directly, the local engine does the
  work and the answer says so.
