# Changelog

aamio-earshot for Node, the add-on. Its version is the version of the add-on
it is an edition of, aamio-python's aamio-earshot and aamio-php's
aisenseapi/aamio-earshot, whose changelogs say what each version changed.
Dates are the day the version was committed. Every entry says what changed for
somebody using it.

## 0.5.0 - 2026-11-19

- A card can name the media the one who plays it prefers answers over, with
  `--via` (`via` over MCP), in order and at most three: internet, or the
  medium of a transport, as lan or bt. A card that names a medium other than
  internet carries their public key, from `--key` on the command line and the
  runtime's own over MCP, so a listener can bind that transport to it. Only
  earshot 0.5.0 and newer reads such a card; without `--via` and `--key` the
  card is the one earlier versions made, byte for byte.
- A medium on a card can carry where the one who plays it is reached on it,
  as their transport says it: `lan:192.168.2.22:47474`. Over MCP the card
  takes it from the runtime's own transports, and the model names the media
  alone; on the command line `aamio transport here` shows it. Nothing here
  knows a medium, so a transport made later is carried the same way. Needs
  aamio 0.8.1 for Node.
- A card heard with media and a key says how to bind a transport to it, with
  `aamio partner add` and `aamio transport bind`, with `--address` when the
  card says where, and binds nothing itself. A key with the shape of a scope's
  key or a read key is refused, as an address of that shape always was.
- Over MCP the listener names the transport to bind: the first medium on the
  card that one of this machine's transports carries, under that transport's
  name, so nobody has to know which transport carries which medium. When none
  does, it says so. On the command line TRANSPORT stands for it, as before.
- Over MCP a medium whose transport on this machine gives no address, as
  sound, goes on the card alone, and the note says why rather than what to
  put right.

## 0.4.0 - 2026-11-17

- The number follows aamio-earshot in Python, which now carries earshot-link,
  a transport over sound. Nothing changed in this runtime.

## 0.3.4 - 2026-11-14

- Every program is looked for only in the folders `PATH` names by a full path,
  never in the working directory, however `PATH` names it, and starts by the
  full path found: PowerShell from the folder Windows keeps it in, a recorder
  or a player, and on Windows only an `.exe`. A `PATH` that began with `.` gave
  back `sox.exe`, a name relative to wherever the agent ran, so a `sox.exe`
  there ran in place of the installed one.

## 0.3.3 - 2026-11-12

- The first version for Node. The same add-on as aamio-earshot 0.3.3 for
  Python and aisenseapi/aamio-earshot 0.3.3 for PHP, with the same manifest:
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
