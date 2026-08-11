import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ResolveIpcServer } from '../src/core/context/resolve-ipc.ts';
import { closeMcpResources } from '../src/mcp/server.ts';

describe('MCP resolve IPC shutdown ordering', () => {
  test('awaits IPC close before disconnecting the engine', async () => {
    const order: string[] = [];
    let releaseClose!: () => void;
    const closePending = new Promise<void>((resolve) => { releaseClose = resolve; });
    const ipc = {
      close: async () => {
        order.push('ipc:start');
        await closePending;
        order.push('ipc:end');
      },
    } as unknown as ResolveIpcServer;
    const engine = {
      disconnect: async () => { order.push('engine'); },
    } as unknown as BrainEngine;

    const closing = closeMcpResources(ipc, engine);
    await Promise.resolve();
    expect(order).toEqual(['ipc:start']);
    releaseClose();
    await closing;
    expect(order).toEqual(['ipc:start', 'ipc:end', 'engine']);
  });

  test('an IPC close failure does not skip engine disconnect', async () => {
    const order: string[] = [];
    const ipc = {
      close: async () => {
        order.push('ipc');
        throw new Error('close failed');
      },
    } as unknown as ResolveIpcServer;
    const engine = {
      disconnect: async () => { order.push('engine'); },
    } as unknown as BrainEngine;

    await closeMcpResources(ipc, engine);
    expect(order).toEqual(['ipc', 'engine']);
  });
});
