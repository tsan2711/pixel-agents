/**
 * Drive the user's own terminal app from standalone mode, where Pixel Agents owns no
 * terminals. Today: macOS Terminal.app via AppleScript, addressed by TTY. Other hosts
 * and terminal apps report a reason instead of acting.
 *
 * All user-controlled values travel as `osascript` argv (never spliced into script
 * source), so a TTY path or message text cannot inject AppleScript.
 */
import { execFile } from 'child_process';

export interface TerminalActionResult {
  ok: boolean;
  message?: string;
}

const OSASCRIPT_TIMEOUT_MS = 15_000;
const TTY_RE = /^\/dev\/ttys?\d+$/;

/** Shared tab lookup; `ACTION` is replaced per command before running. */
const FIND_TAB = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          ACTION
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const FOCUS_SCRIPT = FIND_TAB.replace(
  'ACTION',
  `set selected of t to true
          set index of w to 1
          activate`,
);

// `do script ... in t` types the text into the tab's foreground process and presses Return.
const SEND_SCRIPT = FIND_TAB.replace('ACTION', 'do script (item 2 of argv) in t');

function runOsascript(script: string, args: string[]): Promise<TerminalActionResult> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', script, ...args],
      { timeout: OSASCRIPT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          resolve({
            ok: false,
            message: timedOut
              ? 'Timed out — macOS may be asking for permission to control Terminal.'
              : (stderr || err.message).trim(),
          });
          return;
        }
        const out = stdout.trim();
        resolve(
          out === 'ok'
            ? { ok: true }
            : {
                ok: false,
                message:
                  'No Terminal.app tab runs this session (VS Code, iTerm, or the desktop app?).',
              },
        );
      },
    );
  });
}

function unsupported(tty: string | undefined): TerminalActionResult | null {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'Terminal control is only available on macOS (Terminal.app).' };
  }
  if (!tty || !TTY_RE.test(tty)) {
    return { ok: false, message: 'This session has no terminal to reach.' };
  }
  return null;
}

/** Bring the Terminal.app tab attached to `tty` to the front. */
export function focusTerminal(tty: string | undefined): Promise<TerminalActionResult> {
  return Promise.resolve(unsupported(tty) ?? runOsascript(FOCUS_SCRIPT, [tty!]));
}

/** Type `text` into the Terminal.app tab attached to `tty` and press Return. Newlines are
 *  flattened to spaces: an embedded Return would submit a partial message. */
export function sendToTerminal(
  tty: string | undefined,
  text: string,
): Promise<TerminalActionResult> {
  const line = text.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!line) return Promise.resolve({ ok: false, message: 'Empty message.' });
  return Promise.resolve(unsupported(tty) ?? runOsascript(SEND_SCRIPT, [tty!, line]));
}
