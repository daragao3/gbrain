/**
 * Transcript capture for live-mode agent runs (D8 + D14, D17 backpressure).
 *
 * The existing minions/audit infrastructure is for INTERNAL gbrain subagents
 * only. External openclaw/hermes subprocesses don't write to those tables —
 * v1 builds its own capture channel here.
 *
 * Output: JSONL at `<run-tempdir>/transcript.jsonl`, one event per line.
 *   { schema_version: "1", ts, channel, byte_offset, bytes_b64 }
 *
 *  child stdout/stderr  ─piped─▶  TranscriptSink.write()
 *                                       │
 *                                       ▼
 *                       fs.createWriteStream (flags: 'a')
 *                          ▲
 *                          │ honors 'drain' events to avoid blocking
 *                          │ the child when bursts exceed the pipe buffer
 *                          ▼
 *                     transcript.jsonl  (line-tolerant readers
 *                                        skip malformed; render() resolves
 *                                        byte_offset → readable lines)
 *
 * Friction CLI's `transcript_offset` field references the byte offset INTO
 * `transcript.jsonl` (not into the captured payload). Render --transcripts
 * reads the file and finds the line that contains that offset.
 */

import { createWriteStream, type WriteStream } from 'fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { terminateOwnedProcessTree } from '../minions/handlers/shell-platform.ts';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { TranscriptEvent, TranscriptSink } from './agent-runner.ts';

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

export function createTranscriptSink(path: string): TranscriptSink {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });

  let bytesWritten = 0;
  let drainPromise: Promise<void> | null = null;

  function awaitDrain(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = new Promise<void>(resolve => {
      stream.once('drain', () => {
        drainPromise = null;
        resolve();
      });
    });
    return drainPromise;
  }

  return {
    write(event: TranscriptEvent) {
      const line = JSON.stringify({
        schema_version: '1',
        ts: event.ts,
        channel: event.channel,
        byte_offset: bytesWritten,
        bytes_b64: event.bytes.toString('base64'),
      }) + '\n';
      bytesWritten += Buffer.byteLength(line, 'utf-8');
      const ok = stream.write(line, 'utf-8');
      // If the kernel buffer is full, write() returns false. We don't await
      // here (callers don't expect that), but next callers wait on drain
      // before writing further. Bun's WritableStream is small; the drain
      // window is typically a few µs.
      if (!ok) void awaitDrain();
    },

    nextOffset(): number {
      return bytesWritten;
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => err ? reject(err) : resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// spawnWithCapture
// ---------------------------------------------------------------------------

export interface SpawnOpts {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  transcriptSink: TranscriptSink;
  /** Optional fixed input to write on stdin then close. */
  stdinPayload?: string;
}

export interface SpawnResult {
  exitCode: number;
  durationMs: number;
  /** True if SIGTERM/SIGKILL was issued due to timeout. */
  timedOut: boolean;
}

const SIGTERM_GRACE_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface SpawnWithCaptureDeps {
  platform?: NodeJS.Platform;
  spawn?: SpawnProcess;
  terminate?: (
    child: ChildProcess,
    platform?: NodeJS.Platform,
    signal?: NodeJS.Signals,
  ) => Promise<void>;
  graceMs?: number;
  cleanupTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnWithCapture(
  bin: string,
  args: string[],
  opts: SpawnOpts,
  deps: SpawnWithCaptureDeps = {},
): Promise<SpawnResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const platform = deps.platform ?? process.platform;
    const spawnProcess = deps.spawn ?? spawn;
    const terminate = deps.terminate ?? terminateOwnedProcessTree;
    const graceMs = deps.graceMs ?? SIGTERM_GRACE_MS;
    const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
    const setTimer = deps.setTimer ?? setTimeout;
    const clearTimer = deps.clearTimer ?? clearTimeout;
    let child: ChildProcess;
    try {
      child = spawnProcess(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        // POSIX cleanup signals the owned process group by negative PID. Create
        // that group explicitly; Windows keeps taskkill /T tree ownership.
        detached: platform !== 'win32',
      });
    } catch (e) {
      reject(e);
      return;
    }

    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let closeObservedResolve: (() => void) | undefined;
    const closeObserved = new Promise<void>((resolveClose) => {
      closeObservedResolve = resolveClose;
    });

    const clearKillTimer = () => {
      if (killTimer === null) return;
      clearTimer(killTimer);
      killTimer = null;
    };
    const beginSettle = () => {
      if (settled) return false;
      settled = true;
      clearTimer(wallClockTimer);
      clearKillTimer();
      return true;
    };
    const settle = (fn: () => void) => {
      if (!beginSettle()) return;
      fn();
    };
    const startOwnedTermination = () => {
      if (platform !== 'win32') {
        killTimer = setTimer(() => {
          killTimer = null;
          // `exit` only proves the detached group leader exited. Descendants
          // can still retain inherited pipes, so escalate the owned group until
          // `close` establishes the cleanup boundary.
          void terminate(child, platform, 'SIGKILL').catch(() => {
            // Cleanup must never replace the first process/transcript failure.
          });
        }, graceMs);
      }
      return terminate(child, platform, 'SIGTERM').catch(() => {
        // Cleanup must never replace the first process/transcript failure.
      });
    };
    const waitForCleanupBoundary = async (cleanup: Promise<void>) => {
      await Promise.race([
        Promise.all([cleanup, closeObserved]),
        new Promise<void>((resolveBoundary) => {
          const boundaryTimer = setTimer(resolveBoundary, cleanupTimeoutMs);
          closeObserved.then(() => {
            clearTimer(boundaryTimer);
            resolveBoundary();
          });
        }),
      ]);
    };
    const failFirst = (error: unknown) => {
      if (!beginSettle()) return;
      const primaryError = normalizeError(error);
      void (async () => {
        const cleanup = startOwnedTermination();
        await waitForCleanupBoundary(cleanup);
        clearKillTimer();
        reject(primaryError);
      })();
    };
    const capture = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled) return;
      try {
        opts.transcriptSink.write({ ts: Date.now(), channel, bytes: chunk });
      } catch (error) {
        failFirst(error);
      }
    };
    const wallClockTimer = setTimer(() => {
      timedOut = true;
      if (!beginSettle()) return;
      void (async () => {
        const cleanup = startOwnedTermination();
        await waitForCleanupBoundary(cleanup);
        clearKillTimer();
        resolve({
          exitCode: 124,
          durationMs: Date.now() - start,
          timedOut: true,
        });
      })();
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.stdin?.on('error', failFirst);
    child.on('exit', () => {
      // A POSIX descendant may still hold inherited pipes after its detached
      // group leader exits. Keep group escalation armed until `close`.
      if (platform === 'win32') clearKillTimer();
    });
    child.on('error', failFirst);
    child.on('close', (code) => {
      clearKillTimer();
      closeObservedResolve?.();
      settle(() => resolve({
        exitCode: typeof code === 'number' ? code : (timedOut ? 124 : 1),
        durationMs: Date.now() - start,
        timedOut,
      }));
    });

    if (opts.stdinPayload !== undefined && child.stdin) {
      try {
        opts.transcriptSink.write({
          ts: Date.now(),
          channel: 'stdin',
          bytes: Buffer.from(opts.stdinPayload, 'utf-8'),
        });
        child.stdin.end(opts.stdinPayload, 'utf-8');
      } catch (error) {
        failFirst(error);
      }
    }
  });
}
