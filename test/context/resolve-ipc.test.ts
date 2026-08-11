/*
 * Retrieval Reflex resolve IPC round-trip tests (#1981, T3/T5).
 */
import { describe, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_UNAVAILABLE,
  resolveIpcEndpoint,
  resolveViaIpc,
  startResolveIpcServer,
  type ResolveIpcEndpoint,
  type ResolveIpcServer,
} from '../../src/core/context/resolve-ipc.ts';
import type { PointerBlock } from '../../src/core/context/retrieval-reflex.ts';

type OwnServer = (server: ResolveIpcServer) => ResolveIpcServer;

async function withTempDir(
  body: (dir: string, own: OwnServer) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rr-ipc-'));
  const servers: ResolveIpcServer[] = [];
  const own: OwnServer = (server) => {
    servers.push(server);
    return server;
  };

  let bodyError: unknown;
  try {
    await body(dir, own);
  } catch (error) {
    bodyError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const server of servers.reverse()) {
    try {
      await server.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (bodyError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [bodyError, ...cleanupErrors],
        'resolve IPC test body and cleanup failed',
        { cause: bodyError },
      );
    }
    throw bodyError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'resolve IPC cleanup failed');
  }
}

function endpointForHost(dir: string): ResolveIpcEndpoint {
  return resolveIpcEndpoint(dir);
}

function closeRawServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function encryptedRequest(
  endpoint: ResolveIpcEndpoint,
  request: unknown,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(endpoint.authKey, 'hex'),
    nonce,
  );
  cipher.setAAD(Buffer.from('gbrain-resolve:v1:request', 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(request), 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }) + '\n';
}

describe('resolve IPC endpoints', () => {
  test('uses a resolved Unix socket beneath the data directory', async () => {
    await withTempDir((dir) => {
      expect(resolveIpcEndpoint(dir, 'linux')).toMatchObject({
        kind: 'unix-socket',
        address: join(dir, '.gbrain-resolve.sock'),
      });
    });
  });

  test('uses a stable secret-derived path-redacting Windows named pipe', async () => {
    await withTempDir((dir) => {
      const endpoint = resolveIpcEndpoint(dir, 'win32');
      expect(endpoint.kind).toBe('windows-pipe');
      expect(endpoint.address).toMatch(/^\\\\\.\\pipe\\gbrain-resolve-[a-f0-9]{24}$/);
      expect(endpoint.address).not.toContain(dir);
      expect(endpoint.authKey).toMatch(/^[a-f0-9]{64}$/);
      expect(endpoint.address).not.toContain(endpoint.authKey);
      expect(resolveIpcEndpoint(dir, 'win32')).toEqual(endpoint);
    });
  });

  test('different data-directory secrets produce different Windows pipe names', async () => {
    await withTempDir(async (dirA) => {
      await withTempDir((dirB) => {
        expect(resolveIpcEndpoint(dirA, 'win32').address).not.toBe(
          resolveIpcEndpoint(dirB, 'win32').address,
        );
      });
    });
  });
});

describe('resolve IPC lifecycle', () => {
  test('round-trip: client gets the pointer block the server returns', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      const block: PointerBlock = {
        pointers: [{ display: 'Alice', slug: 'people/alice', source_id: 'default', synopsis: 'x', arm: 'alias', confidence: 0.9 }],
        text: 'BLOCK',
      };
      const server = await startResolveIpcServer(endpoint, async (req) => {
        expect(req.candidates[0].query).toBe('Alice');
        return block;
      });
      expect(server).not.toBeNull();
      own(server!);

      const got = await resolveViaIpc(endpoint, { candidates: [{ display: 'Alice', query: 'Alice' }] });
      expect(got).not.toBe(IPC_UNAVAILABLE);
      expect((got as PointerBlock).text).toBe('BLOCK');
    });
  });

  test('absent endpoint returns IPC_UNAVAILABLE', async () => {
    await withTempDir(async (dir) => {
      const got = await resolveViaIpc(endpointForHost(dir), {
        candidates: [{ display: 'A', query: 'A' }],
      });
      expect(got).toBe(IPC_UNAVAILABLE);
    });
  });

  test.if(process.platform === 'win32')('missing named pipe returns IPC_UNAVAILABLE without a filesystem artifact', async () => {
    await withTempDir(async (dir) => {
      const endpoint = resolveIpcEndpoint(dir, 'win32');
      expect(existsSync(endpoint.address)).toBe(false);
      const got = await resolveViaIpc(endpoint, {
        candidates: [{ display: 'A', query: 'A' }],
      });
      expect(got).toBe(IPC_UNAVAILABLE);
    });
  });

  test.if(process.platform === 'win32')('round-trips over a Windows named pipe', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = resolveIpcEndpoint(dir, 'win32');
      const server = await startResolveIpcServer(endpoint, async () => ({ pointers: [], text: 'PIPE' }));
      expect(server).not.toBeNull();
      own(server!);
      const got = await resolveViaIpc(endpoint, { candidates: [{ display: 'A', query: 'A' }] });
      expect(got).not.toBe(IPC_UNAVAILABLE);
      expect((got as PointerBlock).text).toBe('PIPE');
    });
  });

  test('server rejects requests whose endpoint authentication is wrong', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      const server = await startResolveIpcServer(endpoint, async () => ({ pointers: [], text: 'SECRET' }));
      expect(server).not.toBeNull();
      own(server!);

      const forged = { ...endpoint, authKey: '0'.repeat(64) };
      const got = await resolveViaIpc(forged, { candidates: [{ display: 'A', query: 'A' }] });
      expect(got).toBe(IPC_UNAVAILABLE);
    });
  });

  test('a squatting endpoint receives neither the authentication key nor request plaintext', async () => {
    await withTempDir(async (dir) => {
      const endpoint = endpointForHost(dir);
      let captured = '';
      const rawServer = net.createServer((conn) => {
        conn.once('data', (chunk) => {
          captured += chunk.toString('utf8');
          conn.end(JSON.stringify({ ok: true, block: { pointers: [], text: 'FORGED' } }) + '\n');
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          rawServer.once('error', reject);
          rawServer.listen(endpoint.address, resolve);
        });
        const got = await resolveViaIpc(endpoint, {
          candidates: [{ display: 'A', query: 'PRIVATE-CANDIDATE' }],
          priorContextText: 'PRIVATE-CONTEXT',
        });
        expect(got).toBe(IPC_UNAVAILABLE);
        expect(captured).not.toContain(endpoint.authKey);
        expect(captured).not.toContain('PRIVATE-CANDIDATE');
        expect(captured).not.toContain('PRIVATE-CONTEXT');
      } finally {
        await closeRawServer(rawServer);
      }
    });
  });

  test('client absolute deadline closes a peer that trickles data', async () => {
    await withTempDir(async (dir) => {
      const endpoint = endpointForHost(dir);
      const acceptedSockets: net.Socket[] = [];
      const rawServer = net.createServer((conn) => {
        acceptedSockets.push(conn);
        const interval = setInterval(() => {
          if (conn.destroyed) clearInterval(interval);
          else conn.write('x');
        }, 40);
        conn.once('close', () => clearInterval(interval));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          rawServer.once('error', reject);
          rawServer.listen(endpoint.address, resolve);
        });
        const startedAt = Date.now();
        const got = await resolveViaIpc(endpoint, {
          candidates: [{ display: 'A', query: 'A' }],
        });
        expect(got).toBe(IPC_UNAVAILABLE);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        for (
          let attempt = 0;
          attempt < 100 && !acceptedSockets[0]?.destroyed;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(acceptedSockets[0]?.destroyed).toBe(true);
      } finally {
        acceptedSockets[0]?.destroy();
        await closeRawServer(rawServer);
      }
    });
  });

  test('client rejects a forged response without the endpoint authentication key', async () => {
    await withTempDir(async (dir) => {
      const endpoint = endpointForHost(dir);
      const rawServer = net.createServer((conn) => {
        conn.once('data', () => {
          conn.end(JSON.stringify({ ok: true, block: { pointers: [], text: 'FORGED' } }) + '\n');
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          rawServer.once('error', reject);
          rawServer.listen(endpoint.address, resolve);
        });
        const got = await resolveViaIpc(endpoint, { candidates: [{ display: 'A', query: 'A' }] });
        expect(got).toBe(IPC_UNAVAILABLE);
      } finally {
        await closeRawServer(rawServer);
      }
    });
  });

  test('server returning null relays as null (resolved, nothing found)', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      const server = await startResolveIpcServer(endpoint, async () => null);
      expect(server).not.toBeNull();
      own(server!);
      const got = await resolveViaIpc(endpoint, { candidates: [{ display: 'A', query: 'A' }] });
      expect(got).toBeNull();
    });
  });

  test('client rejects a response encrypted under the request domain', async () => {
    await withTempDir(async (dir) => {
      const endpoint = endpointForHost(dir);
      const rawServer = net.createServer((conn) => {
        conn.once('data', () => {
          conn.end(encryptedRequest(endpoint, {
            ok: true,
            block: { pointers: [], text: 'REFLECTED' },
          }));
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          rawServer.once('error', reject);
          rawServer.listen(endpoint.address, resolve);
        });

        const got = await resolveViaIpc(endpoint, {
          candidates: [{ display: 'A', query: 'A' }],
        });
        expect(got).toBe(IPC_UNAVAILABLE);
      } finally {
        await closeRawServer(rawServer);
      }
    });
  });

  test('server rejects tampered request ciphertext', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      let handled = 0;
      const server = await startResolveIpcServer(endpoint, async () => {
        handled += 1;
        return null;
      });
      expect(server).not.toBeNull();
      own(server!);

      const envelope = JSON.parse(encryptedRequest(endpoint, { candidates: [] }));
      envelope.ciphertext = envelope.ciphertext.replace(/^./, envelope.ciphertext[0] === 'A' ? 'B' : 'A');
      const client = net.createConnection(endpoint.address);
      client.write(JSON.stringify(envelope) + '\n');
      await new Promise<void>((resolve) => {
        client.once('close', resolve);
        client.once('error', resolve);
      });
      expect(handled).toBe(0);
    });
  });

  test('server rejects replayed encrypted requests', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      let handled = 0;
      const server = await startResolveIpcServer(endpoint, async () => {
        handled += 1;
        return null;
      });
      expect(server).not.toBeNull();
      own(server!);
      const wire = encryptedRequest(endpoint, { candidates: [] });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const client = net.createConnection(endpoint.address);
        client.write(wire);
        await new Promise<void>((resolve) => {
          client.once('close', resolve);
          client.once('error', resolve);
        });
      }
      expect(handled).toBe(1);
    });
  });

  test.if(process.platform !== 'win32')('stale Unix socket artifact is cleaned up so a fresh server can bind', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = resolveIpcEndpoint(dir, 'linux');
      writeFileSync(endpoint.address, 'stale');
      const server = await startResolveIpcServer(endpoint, async () => null);
      expect(server).not.toBeNull();
      own(server!);
      expect(existsSync(endpoint.address)).toBe(true);
      expect(statSync(endpoint.address).isSocket()).toBe(true);
    });
  });

  test.if(process.platform !== 'win32')('Unix socket is mode 0600', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = resolveIpcEndpoint(dir, 'linux');
      const server = await startResolveIpcServer(endpoint, async () => null);
      expect(server).not.toBeNull();
      own(server!);
      expect(statSync(endpoint.address).mode & 0o777).toBe(0o600);
    });
  });

  test('managed close owns accepted sockets and is idempotent', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      const server = await startResolveIpcServer(endpoint, async () => null);
      expect(server).not.toBeNull();
      const managed = own(server!);

      const accepted = new Promise<void>((resolve) => {
        managed.server.once('connection', () => resolve());
      });
      const client = net.createConnection(endpoint.address);
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('error', reject);
        });
        await accepted;
        expect(managed.sockets.size).toBe(1);

        await managed.close();
        expect(managed.sockets.size).toBe(0);
        await managed.close();
        expect(managed.server.listening).toBe(false);
      } finally {
        client.destroy();
      }
    });
  });

  test('managed close waits for active request handlers before resolving', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      let releaseHandler!: () => void;
      const handlerPending = new Promise<void>((resolve) => { releaseHandler = resolve; });
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
      const managed = await startResolveIpcServer(endpoint, async () => {
        handlerStarted();
        await handlerPending;
        return null;
      });
      expect(managed).not.toBeNull();
      own(managed!);

      const client = net.createConnection(endpoint.address);
      let closing: Promise<void> | undefined;
      let bodyError: unknown;
      try {
        client.write(encryptedRequest(endpoint, { candidates: [] }));
        await started;

        let closed = false;
        closing = managed!.close().then(() => { closed = true; });
        await Promise.resolve();
        expect(closed).toBe(false);

        releaseHandler();
        await closing;
        expect(closed).toBe(true);
      } catch (error) {
        bodyError = error;
      } finally {
        releaseHandler();
        client.destroy();
      }

      let closeError: unknown;
      if (closing !== undefined) {
        try {
          await closing;
        } catch (error) {
          closeError = error;
        }
      }
      if (bodyError !== undefined) {
        if (closeError !== undefined) {
          throw new AggregateError(
            [bodyError, closeError],
            'active-handler assertion and managed close failed',
            { cause: bodyError },
          );
        }
        throw bodyError;
      }
      if (closeError !== undefined) throw closeError;
    });
  });

  test('managed close bounds a handler that never settles', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
      const never = new Promise<never>(() => {});
      const managed = await startResolveIpcServer(endpoint, async () => {
        handlerStarted();
        return never;
      });
      expect(managed).not.toBeNull();
      own(managed!);

      const client = net.createConnection(endpoint.address);
      client.write(encryptedRequest(endpoint, { candidates: [] }));
      try {
        await started;
        const startedAt = Date.now();
        await managed!.close();
        const elapsed = Date.now() - startedAt;
        expect(elapsed).toBeGreaterThanOrEqual(750);
        expect(elapsed).toBeLessThan(3_000);
        expect(managed!.server.listening).toBe(false);
      } finally {
        client.destroy();
      }
    });
  }, 10_000);

  test('delivery callback does not fire when the client disconnects before resolution', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = endpointForHost(dir);
      let releaseHandler!: () => void;
      const handlerPending = new Promise<void>((resolve) => { releaseHandler = resolve; });
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
      let delivered = 0;
      const managed = await startResolveIpcServer(
        endpoint,
        async () => {
          handlerStarted();
          await handlerPending;
          return { pointers: [], text: 'late' };
        },
        () => { delivered += 1; },
      );
      expect(managed).not.toBeNull();
      own(managed!);

      const client = net.createConnection(endpoint.address);
      client.write(encryptedRequest(endpoint, { candidates: [] }));
      await started;
      await new Promise<void>((resolve) => {
        client.once('close', resolve);
        client.destroy();
      });
      releaseHandler();
      await managed!.close();

      expect(delivered).toBe(0);
    });
  });

  test.if(process.platform !== 'win32')('await close removes the Unix artifact before temp-directory cleanup', async () => {
    await withTempDir(async (dir, own) => {
      const endpoint = resolveIpcEndpoint(dir, 'linux');
      const server = await startResolveIpcServer(endpoint, async () => null);
      expect(server).not.toBeNull();
      const managed = own(server!);

      await managed.close();
      expect(existsSync(endpoint.address)).toBe(false);
    });
  });
});
