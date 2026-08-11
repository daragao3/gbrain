import { spawn, type ChildProcess } from 'node:child_process';

export interface ShellInvocation {
  executable: string;
  args: string[];
}

export function resolveShellInvocation(
  command: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): ShellInvocation {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === 'win32') {
    const configured = env.ComSpec?.trim();
    return {
      executable: configured || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return { executable: '/bin/sh', args: ['-c', command] };
}

type SpawnProcess = typeof spawn;

const TASKKILL_HELPER_TIMEOUT_MS = 15_000;

interface TerminateOwnedProcessTreeDeps {
  spawn?: SpawnProcess;
  helperTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

function rootHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function terminateOwnedProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  signal: NodeJS.Signals = 'SIGTERM',
  deps: TerminateOwnedProcessTreeDeps = {},
): Promise<void> {
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return;

  if (platform !== 'win32') {
    const killProcessGroup = deps.killProcessGroup
      ?? ((groupPid: number, groupSignal: NodeJS.Signals) => process.kill(-groupPid, groupSignal));
    try {
      killProcessGroup(pid as number, signal);
    } catch {
      // A detached POSIX child owns a process group whose ID is its PID. If it
      // failed before becoming group leader, fall back to the exact live root.
      // Never target the positive PID after exit, when the OS could reuse it.
      if (!rootHasExited(child)) {
        try { child.kill(signal); } catch { /* child already exited */ }
      }
    }
    return;
  }
  if (rootHasExited(child)) return;
  const spawnProcess = deps.spawn ?? spawn;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const helperTimeoutMs = deps.helperTimeoutMs ?? TASKKILL_HELPER_TIMEOUT_MS;
  const directFallback = () => {
    if (rootHasExited(child)) return;
    try { child.kill(); } catch { /* child already exited */ }
  };

  await new Promise<void>((resolve) => {
    let helper: ChildProcess;
    try {
      helper = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
      });
    } catch {
      directFallback();
      resolve();
      return;
    }

    let settled = false;
    let helperTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fallback: boolean, killHelper = false) => {
      if (settled) return false;
      settled = true;
      if (helperTimer !== null) clearTimer(helperTimer);
      helper.removeListener('close', onClose);
      if (killHelper) {
        try { helper.kill('SIGKILL'); } catch { /* still fall back to owned root */ }
      }
      if (fallback) directFallback();
      // Keep the error listener after settlement so a malformed helper that
      // emits a late error cannot become an uncaught exception.
      resolve();
      return true;
    };
    const onClose = (code: number | null) => settle(code !== 0);
    const onError = () => settle(true);
    helper.once('close', onClose);
    helper.once('error', onError);
    helperTimer = setTimer(() => settle(true, true), helperTimeoutMs);
  });
}

export interface OwnedChildResult {
  exitCode: number;
  abortLabel: 'signal' | 'shutdown' | '';
  abortReason?: unknown;
  processError?: Error;
  killError?: Error;
}

interface OwnedChildWaitOptions {
  signal: AbortSignal;
  shutdownSignal: AbortSignal;
  platform?: NodeJS.Platform;
  graceMs: number;
  terminate?: (
    child: ChildProcess,
    platform?: NodeJS.Platform,
    signal?: NodeJS.Signals,
  ) => Promise<void>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export async function waitForOwnedChild(
  child: ChildProcess,
  opts: OwnedChildWaitOptions,
): Promise<OwnedChildResult> {
  const platform = opts.platform ?? process.platform;
  const terminate = opts.terminate ?? terminateOwnedProcessTree;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  let rootExited = rootHasExited(child);
  let abortLabel: OwnedChildResult['abortLabel'] = '';
  let abortReason: unknown;
  let processError: Error | undefined;
  let killError: Error | undefined;
  let exitCode: number | null = child.exitCode;
  let exitSignal: NodeJS.Signals | null = child.signalCode;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let terminateChain: Promise<void> = Promise.resolve();

  const clearGrace = () => {
    if (graceTimer === null) return;
    clearTimer(graceTimer);
    graceTimer = null;
  };

  const rememberKillError = (err: unknown) => {
    const normalized = err instanceof Error ? err : new Error(String(err));
    if (killError === undefined) killError = normalized;
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    rootExited = true;
    exitCode = code;
    exitSignal = signal;
    // `exit` only means the group leader is gone. A descendant may still own
    // inherited pipes, so keep POSIX SIGKILL escalation armed until `close`.
    if (platform === 'win32') clearGrace();
  };

  const startAbort = (label: 'signal' | 'shutdown', reason: unknown) => {
    if (abortLabel !== '') return;
    abortLabel = label;
    abortReason = reason;
    // On Windows the tree helper cannot safely target a reused root PID after
    // exit. A detached POSIX group, however, remains owned by its original
    // group ID while descendants keep inherited pipes open, so cancellation in
    // the exit-to-close interval must still signal and escalate the group.
    if (rootExited && platform === 'win32') return;
    terminateChain = terminate(child, platform, 'SIGTERM').catch(rememberKillError);
    if (platform !== 'win32') {
      graceTimer = setTimer(() => {
        graceTimer = null;
        // Signal the owned POSIX process group even if its leader emitted exit:
        // descendants retaining stdout/stderr are precisely why close is pending.
        terminateChain = terminateChain
          .then(() => terminate(child, platform, 'SIGKILL'))
          .catch(rememberKillError);
      }, opts.graceMs);
    }
  };

  const onSignalAbort = () => startAbort('signal', opts.signal.reason);
  const onShutdownAbort = () => startAbort('shutdown', opts.shutdownSignal.reason);
  opts.signal.addEventListener('abort', onSignalAbort);
  opts.shutdownSignal.addEventListener('abort', onShutdownAbort);
  child.on('exit', onExit);

  if (opts.signal.aborted) onSignalAbort();
  if (opts.shutdownSignal.aborted) onShutdownAbort();

  const closePromise = new Promise<void>((resolve) => {
    const onError = (err: Error) => {
      rootExited = true;
      clearGrace();
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (abortLabel !== '') killError = normalized;
      else processError = normalized;
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      rootExited = true;
      exitCode = code;
      exitSignal = signal;
      clearGrace();
      child.removeListener('error', onError);
      resolve();
    };
    child.once('error', onError);
    child.once('close', onClose);
  });

  try {
    await closePromise;
    await terminateChain;
  } finally {
    clearGrace();
    child.removeListener('exit', onExit);
    opts.signal.removeEventListener('abort', onSignalAbort);
    opts.shutdownSignal.removeEventListener('abort', onShutdownAbort);
  }

  const normalizedExit = exitCode !== null
    ? exitCode
    : exitSignal === 'SIGTERM' ? 143
    : exitSignal === 'SIGKILL' ? 137
    : -1;
  return { exitCode: normalizedExit, abortLabel, abortReason, processError, killError };
}
