import { Unreachable } from "./errors.js";
import * as programs from "./programs.js";

/*
 * Opening a picture on this machine's screen, in whatever shows pictures here.
 *
 * Windows opens it with the program set for PNG files, through start; macOS
 * with open; Linux with xdg-open when there is a display to open it on,
 * DISPLAY or WAYLAND_DISPLAY, which the manifest asks for by name, started in
 * the background so the viewer outlives the call. The picture stays where it
 * was written, for the viewer to show. Nothing is sent. The same as
 * aamio-php's Screen and aamio-python's aamio_qrcast.screen.
 */

// How long a viewer is waited for, to hear that it failed.
const WAIT = 15;
const OTHER_WAY = "Write the code to a file with --out (out over MCP) and show it another way.";

/** Open the picture on the screen, and say what opened it. Unreachable when nothing here can. */
export async function show(path, { platform = programs.platform(), environ = process.env, which = programs.which, run = programs.run } = {}) {
  if (platform === "win32") {
    // What cmd would change inside quotes: a quote, which no path on Windows has, and a name between two percent signs.
    if (/"|%[^%]+%/.test(path)) {
      throw new Unreachable("viewer_failed", `Windows could not open the picture: its path, ${path}, has a quote or a %name% in it, which the command line would change. ${OTHER_WAY}`);
    }
    // The title start takes first is left empty, so the path is never read as one, and the path is inside quotes
    // of this line's own, whatever is in it: an ampersand in a folder's name is part of the name and not the end
    // of the command. /s takes the outer pair of quotes away and leaves the rest as it is written.
    const [code, , err] = await run([environ.COMSPEC || environ.ComSpec || "cmd.exe", "/d", "/s", "/c", `"start "" "${path}""`], WAIT, { verbatim: true });
    if (code !== 0) throw new Unreachable("viewer_failed", `Windows could not open the picture: ${programs.lastLine(err)}. ${OTHER_WAY}`);
    return "windows";
  }
  if (platform === "darwin") {
    const [code, , err] = await run(["open", path], WAIT);
    if (code !== 0) throw new Unreachable("viewer_failed", `open could not open the picture: ${programs.lastLine(err)}. ${OTHER_WAY}`);
    return "open";
  }
  if (!environ.DISPLAY && !environ.WAYLAND_DISPLAY) {
    throw new Unreachable("no_screen", "This machine has no screen the add-on can reach: neither DISPLAY nor WAYLAND_DISPLAY is set. Write the code to a file with --out (out over MCP) and show it where it can be seen.");
  }
  if (which("xdg-open") === null) {
    throw new Unreachable("no_viewer", `Nothing here opens a picture: xdg-open is missing. Install xdg-utils, or write the code to a file with --out (out over MCP) and show it another way.`);
  }
  // The path is an argument to the script and never part of it.
  const [code, , err] = await run(["sh", "-c", 'xdg-open "$1" >/dev/null 2>&1 &', "sh", path], WAIT);
  if (code !== 0) throw new Unreachable("viewer_failed", `xdg-open could not be started: ${programs.lastLine(err)}. ${OTHER_WAY}`);
  return "xdg-open";
}
