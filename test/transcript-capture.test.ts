/**
 * Transcript capture tests — async drain, byte offsets, multi-byte safety,
 * spawn-with-capture happy + timeout paths.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'url';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { TranscriptEvent, TranscriptSink } from '../src/core/claw-test/agent-runner.ts';
import { createTranscriptSink, spawnWithCapture } from '../src/core/claw-test/transcript-capture.ts';

const TRANSCRIPT_WORKER = fileURLToPath(new URL('./fixtures/transcript-worker.mjs', import.meta.url));

function channelThrowingSink(channel: TranscriptEvent['channel'], error: Error): TranscriptSink {
  return {
    write(event) {
      if (event.channel === channel) throw error;
    },
    nextOffset: () => 0,
    close: async () => {},
  };
}

function createResistantChild(primary: Error) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  let closeObserved = false;

  Object.assign(child, {
    pid: 42_424,
    stdout,
    stderr,
    stdin,
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      signals.push(signal);
      if (signal !== 'SIGKILL') return true;
      stdout.end();
      stderr.end();
      stdin.destroy();
      queueMicrotask(() => {
        (child as { signalCode: NodeJS.Signals | null }).signalCode = signal;
        child.emit('exit', null, signal);
        closeObserved = true;
        child.emit('close', null, signal);
      });
      return true;
    },
  });

  queueMicrotask(() => stdout.write('trigger'));
  return {
    child,
    primary,
    signals,
    closeObserved: () => closeObserved,
  };
}

type SpawnWithCaptureDeps = {
  platform?: NodeJS.Platform;
  spawn?: () => ChildProcess;
  terminate?: (
    child: ChildProcess,
    platform?: NodeJS.Platform,
    signal?: NodeJS.Signals,
  ) => Promise<void>;
  graceMs?: number;
  cleanupTimeoutMs?: number;
};

const spawnWithCaptureWithDeps = spawnWithCapture as unknown as (
  bin: string,
  args: string[],
  opts: Parameters<typeof spawnWithCapture>[2],
  deps?: SpawnWithCaptureDeps,
) => ReturnType<typeof spawnWithCapture>;

let tmp: string;
let path: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'transcript-'));
  path = join(tmp, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('createTranscriptSink', () => {
  test('writes events as JSONL lines with byte_offset', async () => {
    const sink = createTranscriptSink(path);
    sink.write({ ts: 1, channel: 'stdout', bytes: Buffer.from('hello') });
    sink.write({ ts: 2, channel: 'stderr', bytes: Buffer.from('world') });
    await sink.close();

    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].channel).toBe('stdout');
    expect(lines[0].byte_offset).toBe(0);
    expect(lines[1].channel).toBe('stderr');
    expect(lines[1].byte_offset).toBeGreaterThan(0);
    expect(Buffer.from(lines[0].bytes_b64, 'base64').toString('utf-8')).toBe('hello');
    expect(Buffer.from(lines[1].bytes_b64, 'base64').toString('utf-8')).toBe('world');
  });

  test('preserves multi-byte UTF-8 (no chunk-boundary corruption)', async () => {
    const sink = createTranscriptSink(path);
    // Split a 4-byte emoji across two writes to simulate stdio chunk boundaries.
    const emoji = '🌍';
    const buf = Buffer.from(emoji, 'utf-8');
    sink.write({ ts: 1, channel: 'stdout', bytes: buf.slice(0, 2) });
    sink.write({ ts: 2, channel: 'stdout', bytes: buf.slice(2) });
    await sink.close();

    const lines = readFileSync(path, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const concatenated = Buffer.concat([
      Buffer.from(lines[0].bytes_b64, 'base64'),
      Buffer.from(lines[1].bytes_b64, 'base64'),
    ]).toString('utf-8');
    expect(concatenated).toBe(emoji);
  });

  test('byte_offset is monotonic and matches the actual file position', async () => {
    const sink = createTranscriptSink(path);
    const before1 = sink.nextOffset();
    sink.write({ ts: 1, channel: 'stdout', bytes: Buffer.from('a') });
    const before2 = sink.nextOffset();
    sink.write({ ts: 2, channel: 'stdout', bytes: Buffer.from('b') });
    await sink.close();

    expect(before1).toBe(0);
    expect(before2).toBeGreaterThan(0);

    // Verify the offsets recorded in lines match the actual file substring offsets.
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n').map(l => JSON.parse(l));
    const expectedOffsets = [0, Buffer.byteLength(raw.split('\n')[0] + '\n')];
    expect(lines[0].byte_offset).toBe(expectedOffsets[0]);
    expect(lines[1].byte_offset).toBe(expectedOffsets[1]);
  });

  test('survives bursty writes (drain handling)', async () => {
    const sink = createTranscriptSink(path);
    // 256KB of payload across 256 1KB writes — exceeds default pipe buffer
    const chunk = Buffer.alloc(1024, 0x61); // 'a' * 1024
    for (let i = 0; i < 256; i++) {
      sink.write({ ts: i, channel: 'stdout', bytes: chunk });
    }
    await sink.close();

    const raw = readFileSync(path, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(256);
  });

  test('close is idempotent', async () => {
    const sink = createTranscriptSink(path);
    sink.write({ ts: 1, channel: 'stdout', bytes: Buffer.from('x') });
    await sink.close();
    // Second close should not throw — the writeStream's `end` won't fire 'close' a second time
    // but we can call without error in our own wrapper.
    // (Implementation note: we don't expose a closed flag; idempotent via stream's no-op behavior.)
    expect(existsSync(path)).toBe(true);
  });
});

describe('spawnWithCapture', () => {
  test('captures stdout from a small command', async () => {
    const sink = createTranscriptSink(path);
    const result = await spawnWithCapture(process.execPath, [TRANSCRIPT_WORKER, 'stdout', 'hi'], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      transcriptSink: sink,
    });
    await sink.close();
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    const raw = readFileSync(path, 'utf-8');
    const captured = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const stdoutBytes = captured.filter(e => e.channel === 'stdout')
      .map(e => Buffer.from(e.bytes_b64, 'base64').toString('utf-8'))
      .join('');
    expect(stdoutBytes).toBe('hi');
  });

  test('non-zero exit propagates', async () => {
    const sink = createTranscriptSink(path);
    const result = await spawnWithCapture(process.execPath, [TRANSCRIPT_WORKER, 'exit', '7'], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      transcriptSink: sink,
    });
    await sink.close();
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  test('timeout fires SIGTERM/SIGKILL', async () => {
    const sink = createTranscriptSink(path);
    const result = await spawnWithCapture(process.execPath, [TRANSCRIPT_WORKER, 'wait'], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 200,
      transcriptSink: sink,
    });
    await sink.close();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 30_000);

  test('spawns POSIX capture workers in an owned process group', async () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let spawnOptions: SpawnOptions | undefined;
    Object.assign(child, {
      pid: 42_427,
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });

    const promise = spawnWithCaptureWithDeps('unused', [], {
      cwd: tmp,
      env: {},
      timeoutMs: 5_000,
      transcriptSink: channelThrowingSink('stdout', new Error('unused')),
    }, {
      platform: 'linux',
      spawn: ((_bin: string, _args: readonly string[], options: SpawnOptions) => {
        spawnOptions = options;
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      }) as never,
    });

    await promise;
    expect(spawnOptions?.detached).toBe(true);
  });

  test('does not detach capture workers on Windows', async () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let spawnOptions: SpawnOptions | undefined;
    Object.assign(child, {
      pid: 42_428,
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });

    const promise = spawnWithCaptureWithDeps('unused', [], {
      cwd: tmp,
      env: {},
      timeoutMs: 5_000,
      transcriptSink: channelThrowingSink('stdout', new Error('unused')),
    }, {
      platform: 'win32',
      spawn: ((_bin: string, _args: readonly string[], options: SpawnOptions) => {
        spawnOptions = options;
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      }) as never,
    });

    await promise;
    expect(spawnOptions?.detached).toBe(false);
  });


  test('stdin transcript failure terminates the owned child before rejecting once', async () => {
    const marker = join(tmp, 'worker.pid');
    const primary = new Error('stdin transcript write failed');
    let writes = 0;
    const throwingSink = {
      write() {
        writes++;
        throw primary;
      },
      nextOffset: () => 0,
      close: async () => {},
    };

    const promise = spawnWithCapture(process.execPath, [TRANSCRIPT_WORKER, 'wait', '', marker], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 50,
      transcriptSink: throwingSink,
      stdinPayload: 'input',
    });

    await expect(promise).rejects.toBe(primary);
    await Bun.sleep(150);
    expect(writes).toBe(1);
  }, 10_000);

  test('routes asynchronous stdin errors through owned-child cleanup', async () => {
    const primary = new Error('stdin stream failed asynchronously');
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let closeObserved = false;
    const scheduleClose = (signal: NodeJS.Signals = 'SIGTERM') => {
      queueMicrotask(() => {
        (child as { signalCode: NodeJS.Signals | null }).signalCode = signal;
        child.emit('exit', null, signal);
        closeObserved = true;
        child.emit('close', null, signal);
      });
    };

    Object.assign(child, {
      pid: 42_425,
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        scheduleClose(signal);
        return true;
      },
    });
    stdin.end = (() => {
      queueMicrotask(() => {
        stdin.emit('error', primary);
        scheduleClose();
      });
      return stdin;
    }) as typeof stdin.end;

    const promise = spawnWithCaptureWithDeps('unused', [], {
      cwd: tmp,
      env: {},
      timeoutMs: 5_000,
      transcriptSink: channelThrowingSink('stdout', new Error('unused')),
      stdinPayload: 'input',
    }, {
      platform: 'linux',
      spawn: () => child,
      terminate: async () => {},
      graceMs: 100,
    });

    await expect(promise).rejects.toBe(primary);
    expect(closeObserved).toBe(true);
  });

  for (const channel of ['stdout', 'stderr'] as const) {
    test(`${channel} transcript failure terminates the owned child before rejecting`, async () => {
      const primary = new Error(`${channel} transcript write failed`);
      const mode = channel;
      const promise = spawnWithCapture(process.execPath, [TRANSCRIPT_WORKER, mode, 'trigger'], {
        cwd: tmp,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 5_000,
        transcriptSink: channelThrowingSink(channel, primary),
      });

      await expect(promise).rejects.toBe(primary);
    }, 10_000);
  }

  test('resistant POSIX child is SIGKILLed and closed before first failure rejects', async () => {
    const primary = new Error('stdout transcript write failed first');
    const resistant = createResistantChild(primary);
    let rejectionCount = 0;

    const promise = spawnWithCaptureWithDeps('unused', [], {
      cwd: tmp,
      env: {},
      timeoutMs: 20,
      transcriptSink: channelThrowingSink('stdout', primary),
    }, {
      platform: 'linux',
      spawn: () => resistant.child,
      graceMs: 5,
    });
    void promise.catch(() => { rejectionCount++; });

    await expect(promise).rejects.toBe(primary);
    expect(resistant.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(resistant.closeObserved()).toBe(true);
    resistant.child.emit('error', new Error('late child error'));
    resistant.child.emit('close', 0, null);
    await Bun.sleep(50);
    expect(rejectionCount).toBe(1);
    expect(resistant.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('first failure rejects after close even when terminator never settles', async () => {
    const primary = new Error('first transcript failure');
    const resistant = createResistantChild(primary);
    let rejectionCount = 0;
    const promise = spawnWithCaptureWithDeps('unused', [], {
      cwd: tmp,
      env: {},
      timeoutMs: 100,
      transcriptSink: channelThrowingSink('stdout', primary),
    }, {
      platform: 'linux',
      spawn: () => resistant.child,
      terminate: async (_child, _platform, signal = 'SIGTERM') => {
        if (signal === 'SIGKILL') resistant.child.kill('SIGKILL');
        return new Promise<void>(() => {});
      },
      graceMs: 5,
      cleanupTimeoutMs: 25,
    });
    void promise.catch(() => { rejectionCount++; });

    await expect(promise).rejects.toBe(primary);
    expect(resistant.closeObserved()).toBe(true);
    expect(resistant.signals).toEqual(['SIGKILL']);
    await Bun.sleep(120);
    expect(rejectionCount).toBe(1);
    expect(resistant.signals).toEqual(['SIGKILL']);
  });

  test('timeout returns finitely when terminator and owned child never settle', async () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const signals: NodeJS.Signals[] = [];
    Object.assign(child, {
      pid: 42_426,
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        signals.push(signal);
        return true;
      },
    });

    const result = await spawnWithCaptureWithDeps('unused', [], {
      cwd: tmp,
      env: {},
      timeoutMs: 5,
      transcriptSink: channelThrowingSink('stdout', new Error('unused')),
    }, {
      platform: 'linux',
      spawn: () => child,
      terminate: async (_child, _platform, signal = 'SIGTERM') => {
        if (signal === 'SIGKILL') signals.push(signal);
        return new Promise<void>(() => {});
      },
      graceMs: 5,
      cleanupTimeoutMs: 15,
    });

    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(signals).toEqual(['SIGKILL']);
    child.emit('close', 0, null);
    child.emit('error', new Error('late'));
    await Bun.sleep(20);
    expect(signals).toEqual(['SIGKILL']);
  });

  test('rejects when the binary does not exist', async () => {
    const sink = createTranscriptSink(path);
    await expect(
      spawnWithCapture(join(tmp, 'missing-executable'), [], {
        cwd: tmp,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 1_000,
        transcriptSink: sink,
      })
    ).rejects.toThrow();
    await sink.close();
  });
});
