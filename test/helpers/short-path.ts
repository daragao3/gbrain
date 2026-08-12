/**
 * Windows 8.3 short-name lookup for the path-canonicalization tests.
 *
 * There is no Node API for this, and the obvious shell form
 * (`cmd /c for %I in ("<dir>") do @echo %~sI`) is not usable from
 * `execFileSync`: Node escapes the embedded quotes, cmd sees them literally,
 * and the command echoes the long path back with the quotes still attached —
 * which reads as "8.3 is disabled" rather than as a broken probe. PowerShell's
 * FileSystemObject is unambiguous, at the cost of one process spawn.
 *
 * Returns null when the platform isn't Windows, when the probe fails, or when
 * the directory has no distinct short alias — 8.3 generation is disable-able
 * per volume (`fsutil 8dot3name`), and a name that already conforms to 8.3
 * gets no alias at all. Callers must treat null as "skip", never as "equal".
 */

import { execFileSync } from 'node:child_process';

export function shortPathOrNull(dir: string): string | null {
  if (process.platform !== 'win32') return null;
  if (dir.includes("'")) return null; // would break the PS single-quoted literal
  let out: string;
  try {
    out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir}').ShortPath`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  } catch {
    return null;
  }
  if (!out) return null;
  // No distinct alias — the caller has nothing to exercise.
  if (out.toLowerCase() === dir.toLowerCase()) return null;
  return out;
}
