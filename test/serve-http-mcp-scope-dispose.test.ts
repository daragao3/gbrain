/**
 * Regression tests for disposeMcpScopeOnResponseClose() in
 * src/commands/serve-http.ts.
 *
 * Context: POST /mcp builds a throwaway `Server` + `StreamableHTTPServerTransport`
 * per request (stateless mode). Pre-fix nothing ever closed either object, so
 * every request leaked the pair. On the shared long-lived `gbrain serve --http`
 * deployment memory grew until the operator's leak guard killed the process, and
 * a process killed mid-request drops in-flight SSE responses — the SSE headers
 * are flushed BEFORE the tool handler runs, so the client reads HTTP 200 with a
 * zero-length body while the write it asked for has already committed. That is
 * the "large put_page returns an empty body but the write lands" report.
 *
 * Calls the helper directly with a fake emitter + close spies — no Express test
 * client, no module mocking, matching test/serve-http-health.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { disposeMcpScopeOnResponseClose } from '../src/commands/serve-http.ts';

/** Fake ServerResponse exposing only the `close` event the helper listens on. */
function makeRes() {
  const listeners: Array<() => void> = [];
  return {
    on(event: 'close', listener: () => void) {
      expect(event).toBe('close');
      listeners.push(listener);
      return this;
    },
    emitClose() {
      for (const l of [...listeners]) l();
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}

/** Close spy standing in for a Server / transport. */
function makeClosable(throwOnClose?: Error) {
  let calls = 0;
  return {
    close() {
      calls += 1;
      if (throwOnClose) throw throwOnClose;
    },
    get calls() {
      return calls;
    },
  };
}

describe('disposeMcpScopeOnResponseClose', () => {
  test('does not close anything before the response closes', () => {
    const res = makeRes();
    const server = makeClosable();
    const transport = makeClosable();

    disposeMcpScopeOnResponseClose(res, server, transport);

    expect(res.listenerCount).toBe(1);
    expect(server.calls).toBe(0);
    expect(transport.calls).toBe(0);
  });

  test('closes BOTH transport and server when the response closes', () => {
    const res = makeRes();
    const server = makeClosable();
    const transport = makeClosable();

    disposeMcpScopeOnResponseClose(res, server, transport);
    res.emitClose();

    expect(transport.calls).toBe(1);
    expect(server.calls).toBe(1);
  });

  test('closes transport BEFORE server (SDK stateless teardown order)', () => {
    const res = makeRes();
    const order: string[] = [];
    const server = { close: () => { order.push('server'); } };
    const transport = { close: () => { order.push('transport'); } };

    disposeMcpScopeOnResponseClose(res, server, transport);
    res.emitClose();

    expect(order).toEqual(['transport', 'server']);
  });

  test('is latched: a repeated close event does not double-close', () => {
    const res = makeRes();
    const server = makeClosable();
    const transport = makeClosable();

    disposeMcpScopeOnResponseClose(res, server, transport);
    res.emitClose();
    res.emitClose();
    res.emitClose();

    expect(transport.calls).toBe(1);
    expect(server.calls).toBe(1);
  });

  test('a throwing transport.close still lets the server be closed', () => {
    const res = makeRes();
    const server = makeClosable();
    const transport = makeClosable(new Error('transport boom'));
    const errors: unknown[] = [];

    disposeMcpScopeOnResponseClose(res, server, transport, e => errors.push(e));
    res.emitClose();

    expect(transport.calls).toBe(1);
    expect(server.calls).toBe(1); // NOT skipped by the transport throw
    expect(errors).toHaveLength(1);
  });

  test('a throwing server.close is reported, not propagated to the caller', () => {
    const res = makeRes();
    const server = makeClosable(new Error('server boom'));
    const transport = makeClosable();
    const errors: unknown[] = [];

    disposeMcpScopeOnResponseClose(res, server, transport, e => errors.push(e));

    expect(() => res.emitClose()).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  test('returned dispose runs teardown directly and stays latched vs the event', () => {
    const res = makeRes();
    const server = makeClosable();
    const transport = makeClosable();

    const dispose = disposeMcpScopeOnResponseClose(res, server, transport);
    dispose();
    res.emitClose(); // must not close a second time

    expect(transport.calls).toBe(1);
    expect(server.calls).toBe(1);
  });

  test('a rejecting async close does not surface as an unhandled rejection', async () => {
    const res = makeRes();
    const server = { close: async () => { throw new Error('async server boom'); } };
    const transport = { close: async () => { throw new Error('async transport boom'); } };

    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      disposeMcpScopeOnResponseClose(res, server, transport, () => {});
      res.emitClose();
      await new Promise(r => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toBeNull();
  });
});
