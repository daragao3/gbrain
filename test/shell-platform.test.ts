import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveShellInvocation,
  terminateOwnedProcessTree,
  waitForOwnedChild,
} from '../src/core/minions/handlers/shell-platform.ts';

class FakeChild extends EventEmitter {
  pid: number | undefined = 1234;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }
}

function child(value = new FakeChild()): ChildProcess {
  return value as unknown as ChildProcess;
}

class TrackingAbortSignal extends EventTarget {
  aborted = false;
  reason: unknown;
  listenerCount = 0;

  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listenerCount++;
    super.addEventListener(...args);
  }

  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listenerCount--;
    super.removeEventListener(...args);
  }

  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.dispatchEvent(new Event('abort'));
  }
}

describe('resolveShellInvocation', () => {
  test('uses /bin/sh on POSIX', () => {
    expect(resolveShellInvocation('printf ok', { platform: 'linux', env: {} })).toEqual({
      executable: '/bin/sh', args: ['-c', 'printf ok'],
    });
  });

  test('uses configured ComSpec on Windows', () => {
    const comspec = String.raw`C:\Windows\System32\cmd.exe`;
    expect(resolveShellInvocation('echo ok', { platform: 'win32', env: { ComSpec: comspec } })).toEqual({
      executable: comspec, args: ['/d', '/s', '/c', 'echo ok'],
    });
  });

  test('falls back to cmd.exe when ComSpec is absent', () => {
    expect(resolveShellInvocation('echo ok', { platform: 'win32', env: {} })).toEqual({
      executable: 'cmd.exe', args: ['/d', '/s', '/c', 'echo ok'],
    });
  });

  test.each(['', '   ', '\t\r\n'])('falls back to cmd.exe for blank ComSpec %j', (ComSpec) => {
    expect(resolveShellInvocation('echo ok', { platform: 'win32', env: { ComSpec } })).toEqual({
      executable: 'cmd.exe', args: ['/d', '/s', '/c', 'echo ok'],
    });
  });

  test('keeps the command as one final argument without interpolation', () => {
    const command = 'echo one && echo "two words" | findstr two';
    const invocation = resolveShellInvocation(command, {
      platform: 'win32', env: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
    });
    expect(invocation.args).toEqual(['/d', '/s', '/c', command]);
    expect(invocation.args.at(-1)).toBe(command);
  });
});

describe('terminateOwnedProcessTree', () => {
  test.each([undefined, 0, -1, 1.5])('does nothing for invalid pid %j', async (pid) => {
    const owned = new FakeChild();
    owned.pid = pid;
    let spawnCalls = 0;
    await terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => { spawnCalls++; throw new Error('must not spawn'); }) as never,
    });
    expect(spawnCalls).toBe(0);
    expect(owned.killCalls).toEqual([]);
  });

  test('uses exact taskkill argv and waits for helper close', async () => {
    const owned = new FakeChild();
    const helper = new FakeChild();
    const calls: unknown[][] = [];
    let settled = false;
    const promise = terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: ((...args: unknown[]) => { calls.push(args); return child(helper); }) as never,
    }).then(() => { settled = true; });
    await Promise.resolve();
    expect(calls).toEqual([['taskkill.exe', ['/PID', '1234', '/T', '/F'], { shell: false, stdio: 'ignore' }]]);
    expect(settled).toBe(false);
    helper.emit('close', 0, null);
    await promise;
    expect(settled).toBe(true);
    expect(helper.killCalls).toEqual([]);
    expect(owned.killCalls).toEqual([]);
  });

  test('hung taskkill helper times out and falls back to the same owned child', async () => {
    const owned = new FakeChild();
    const helper = new FakeChild();
    const timers: Array<() => void> = [];
    let settled = false;
    const promise = terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => child(helper)) as never,
      helperTimeoutMs: 25,
      setTimer: ((fn: () => void) => { timers.push(fn); return timers.length; }) as never,
      clearTimer: (() => {}) as never,
    }).then(() => { settled = true; });

    await Promise.resolve();
    expect(timers).toHaveLength(1);
    expect(settled).toBe(false);
    timers[0]();
    await promise;
    expect(settled).toBe(true);
    expect(helper.killCalls).toEqual(['SIGKILL']);
    expect(owned.killCalls).toEqual([undefined]);
    helper.emit('close', 0, null);
    expect(helper.killCalls).toEqual(['SIGKILL']);
    expect(owned.killCalls).toEqual([undefined]);
  });

  test('helper timeout still falls back when killing the owned helper throws', async () => {
    const owned = new FakeChild();
    const helper = new FakeChild();
    helper.kill = () => { throw new Error('helper kill failed'); };
    const timers: Array<() => void> = [];
    const promise = terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => child(helper)) as never,
      helperTimeoutMs: 25,
      setTimer: ((fn: () => void) => { timers.push(fn); return timers.length; }) as never,
      clearTimer: (() => {}) as never,
    });

    await Promise.resolve();
    timers[0]();
    await promise;
    expect(owned.killCalls).toEqual([undefined]);
  });

  test('non-zero taskkill close falls back to the same owned child', async () => {
    const owned = new FakeChild();
    const helper = new FakeChild();
    const promise = terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => child(helper)) as never,
    });

    helper.emit('close', 1, null);
    await promise;
    expect(helper.killCalls).toEqual([]);
    expect(owned.killCalls).toEqual([undefined]);
  });

  test('helper close then error settles once without fallback', async () => {
    const owned = new FakeChild();
    const helper = new FakeChild();
    let settles = 0;
    const promise = terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => child(helper)) as never,
    }).then(() => { settles++; });
    helper.emit('close', 0, null);
    helper.emit('error', new Error('late'));
    await promise;
    expect(settles).toBe(1);
    expect(helper.killCalls).toEqual([]);
    expect(owned.killCalls).toEqual([]);
  });

  test('helper error falls back once and later close still settles once', async () => {
    const owned = new FakeChild();
    const helper = new FakeChild();
    let settles = 0;
    const promise = terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => child(helper)) as never,
    }).then(() => { settles++; });
    helper.emit('error', new Error('cannot start'));
    helper.emit('close', 1, null);
    await promise;
    expect(settles).toBe(1);
    expect(helper.killCalls).toEqual([]);
    expect(owned.killCalls).toEqual([undefined]);
  });

  test('synchronous helper spawn failure falls back once', async () => {
    const owned = new FakeChild();
    await terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => { throw new Error('sync spawn failure'); }) as never,
    });
    expect(owned.killCalls).toEqual([undefined]);
  });

  test('does not target an already-exited Windows root pid', async () => {
    const owned = new FakeChild();
    owned.exitCode = 0;
    let spawnCalls = 0;
    await terminateOwnedProcessTree(child(owned), 'win32', 'SIGTERM', {
      spawn: (() => { spawnCalls++; return child(); }) as never,
    });
    expect(spawnCalls).toBe(0);
    expect(owned.killCalls).toEqual([]);
  });

  test('signals the owned POSIX process group with the requested signal after root exit', async () => {
    const owned = new FakeChild();
    owned.signalCode = 'SIGTERM';
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    await terminateOwnedProcessTree(child(owned), 'linux', 'SIGKILL', {
      killProcessGroup: (pid, signal) => { groupSignals.push([pid, signal]); },
    });
    expect(groupSignals).toEqual([[1234, 'SIGKILL']]);
    expect(owned.killCalls).toEqual([]);
  });

  test('POSIX group-signal fallback only targets a live owned root', async () => {
    const live = new FakeChild();
    await terminateOwnedProcessTree(child(live), 'linux', 'SIGTERM', {
      killProcessGroup: () => { throw new Error('not a group leader'); },
    });
    expect(live.killCalls).toEqual(['SIGTERM']);

    const exited = new FakeChild();
    exited.exitCode = 0;
    await terminateOwnedProcessTree(child(exited), 'linux', 'SIGKILL', {
      killProcessGroup: () => { throw new Error('group is gone'); },
    });
    expect(exited.killCalls).toEqual([]);
  });
});

test.skipIf(process.platform === 'win32')(
  'POSIX cancellation reaps descendants that retain inherited pipes after root exit',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shell-group-cancel-'));
    const descendantPidFile = join(dir, 'descendant.pid');
    const abort = new AbortController();
    const shutdown = new AbortController();
    const owned = spawn('/bin/sh', ['-c', `
trap 'exit 0' TERM
/bin/sh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' child "${descendantPidFile}" &
while [ ! -s "${descendantPidFile}" ]; do sleep 0.01; done
while :; do sleep 1; done
`], {
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(descendantPidFile)) {
        if (Date.now() >= deadline) throw new Error('descendant pid was not published');
        await Bun.sleep(10);
      }
      const descendantPid = Number(readFileSync(descendantPidFile, 'utf8').trim());
      expect(descendantPid).toBeGreaterThan(0);

      const resultPromise = waitForOwnedChild(owned, {
        signal: abort.signal,
        shutdownSignal: shutdown.signal,
        platform: process.platform,
        graceMs: 50,
      });
      abort.abort(new Error('cancel'));
      const result = await Promise.race([
        resultPromise,
        Bun.sleep(5_000).then(() => { throw new Error('owned process group did not close'); }),
      ]);

      expect(result.abortLabel).toBe('signal');
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      if (owned.pid) {
        try { process.kill(-owned.pid, 'SIGKILL'); } catch { /* group already reaped */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

describe('waitForOwnedChild lifecycle', () => {
  function setup(platform: NodeJS.Platform = 'linux') {
    const owned = new FakeChild();
    const signal = new TrackingAbortSignal();
    const shutdown = new TrackingAbortSignal();
    const timers: Array<() => void> = [];
    let cleared = 0;
    const terminateCalls: Array<{ proc: ChildProcess; signal: NodeJS.Signals }> = [];
    const promise = waitForOwnedChild(child(owned), {
      signal: signal as unknown as AbortSignal,
      shutdownSignal: shutdown as unknown as AbortSignal,
      platform,
      graceMs: 5000,
      terminate: async (proc, _targetPlatform, targetSignal = 'SIGTERM') => {
        terminateCalls.push({ proc, signal: targetSignal });
        proc.kill(targetSignal);
      },
      setTimer: ((fn: () => void) => { timers.push(fn); return timers.length; }) as never,
      clearTimer: (() => { cleared++; }) as never,
    });
    return { owned, signal, shutdown, timers, terminateCalls, promise, cleared: () => cleared };
  }

  test('abort between exit and close never targets exited pid but waits for close', async () => {
    const h = setup('win32');
    let settled = false;
    h.promise.then(() => { settled = true; });
    h.owned.exitCode = 0;
    h.owned.emit('exit', 0, null);
    h.signal.abort(new Error('late abort'));
    await Promise.resolve();
    expect(h.terminateCalls).toEqual([]);
    expect(settled).toBe(false);
    h.owned.emit('close', 0, null);
    expect((await h.promise).abortLabel).toBe('signal');
  });

  test('POSIX abort sends SIGTERM and grace expiry escalates to SIGKILL', async () => {
    const h = setup('linux');
    h.signal.abort(new Error('cancel'));
    await Promise.resolve();
    expect(h.owned.killCalls).toEqual(['SIGTERM']);
    expect(h.timers).toHaveLength(1);
    h.timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.owned.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    h.owned.signalCode = 'SIGKILL';
    h.owned.emit('exit', null, 'SIGKILL');
    h.owned.emit('close', null, 'SIGKILL');
    expect((await h.promise).abortLabel).toBe('signal');
  });

  test('POSIX abort after root exit still terminates descendants holding pipes', async () => {
    const h = setup('linux');
    h.owned.exitCode = 0;
    h.owned.emit('exit', 0, null);
    h.signal.abort(new Error('late cancel'));
    await Promise.resolve();
    expect(h.terminateCalls.map(call => call.signal)).toEqual(['SIGTERM']);
    expect(h.timers).toHaveLength(1);
    h.timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.terminateCalls.map(call => call.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    h.owned.emit('close', 0, null);
    expect((await h.promise).abortLabel).toBe('signal');
  });

  test('root exit keeps group SIGKILL escalation armed while close is pending', async () => {
    const h = setup('linux');
    h.signal.abort(new Error('cancel'));
    await Promise.resolve();
    h.owned.signalCode = 'SIGTERM';
    h.owned.emit('exit', null, 'SIGTERM');
    h.timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.owned.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.terminateCalls.map(call => call.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    h.owned.emit('close', null, 'SIGTERM');
    await h.promise;
    expect(h.cleared()).toBe(0);
  });

  test('cleans both abort listeners and the grace timer after close', async () => {
    const h = setup('linux');
    expect(h.signal.listenerCount).toBe(1);
    expect(h.shutdown.listenerCount).toBe(1);
    h.signal.abort(new Error('cancel'));
    await Promise.resolve();
    h.owned.emit('exit', null, 'SIGTERM');
    h.owned.emit('close', null, 'SIGTERM');
    await h.promise;
    expect(h.cleared()).toBe(1);
    expect(h.signal.listenerCount).toBe(0);
    expect(h.shutdown.listenerCount).toBe(0);
    expect(h.owned.listenerCount('exit')).toBe(0);
    expect(h.owned.listenerCount('error')).toBe(0);
    expect(h.owned.listenerCount('close')).toBe(0);
  });

  test('kill-related child error after abort remains diagnostic and aborted', async () => {
    const h = setup('linux');
    h.signal.abort(new Error('cancel'));
    const killError = new Error('kill ESRCH');
    h.owned.emit('error', killError);
    h.owned.emit('close', null, 'SIGTERM');
    const result = await h.promise;
    expect(result.abortLabel).toBe('signal');
    expect(result.killError).toBe(killError);
  });
});
