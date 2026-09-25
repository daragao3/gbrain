/**
 * Write a (possibly large) payload to stdout and resolve once the stream has
 * accepted all of it.
 *
 * Why not console.log: once `process.stdout` has been materialised as a Node
 * stream -- process-cleanup.ts attaches an 'error' listener to it on every CLI
 * run -- Bun's console.log into a pipe stops at the first full pipe buffer
 * (64 KiB on Linux) when the reader is not draining fast enough, and the
 * remaining bytes are never delivered, even if the process stays alive for
 * flushThenExit's grace. Measured on Bun 1.3.13 / Linux with a reader that
 * attaches 1s late: console.log delivered 65,536 of 560,012 bytes (a 5s grace
 * delivered the same 65,536); an awaited process.stdout.write delivered all
 * 560,012. That is how `gbrain check-update --json` (~560 KB when the
 * changelog diff spans many releases) reached CI as truncated JSON.
 *
 * Use this for any output a machine will parse and that can exceed a pipe
 * buffer. Small human-facing lines can keep using console.log.
 */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}
