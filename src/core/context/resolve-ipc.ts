/**
 * Retrieval Reflex — resolve IPC (issue #1981, D9=C).
 *
 * PGLite is single-connection: `gbrain serve` holds the one connection for its
 * lifetime, so the context engine cannot open its own. Instead, `serve`
 * optionally listens on a local IPC endpoint and answers a NARROW request —
 * candidates in, pointers out — using the connection it already owns. Raw SQL
 * never crosses the wire.
 *
 * POSIX uses a mode-0600 Unix-domain socket under the PGLite data directory.
 * Windows uses a per-data-directory-secret-derived, path-redacting named pipe.
 * Requests and responses use domain-separated AES-256-GCM envelopes, so a
 * squatting endpoint learns neither the persistent key nor retrieval context.
 * Protocol: one newline-delimited JSON request and response, each bounded to
 * 256 KiB before base64 decoding.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { EntityCandidate } from './entity-salience.ts';
import type { PointerBlock } from './retrieval-reflex.ts';

const SOCK_NAME = '.gbrain-resolve.sock';
const AUTH_NAME = '.gbrain-resolve.key';
const CLIENT_TIMEOUT_MS = 250;
const SERVER_CLOSE_DRAIN_MS = 1_000;
const MAX_MSG_BYTES = 256 * 1024;
const AUTH_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PROTOCOL_VERSION = 1;
const REQUEST_AAD = Buffer.from('gbrain-resolve:v1:request', 'utf8');

interface EncryptedEnvelope {
  v: number;
  nonce: string;
  ciphertext: string;
  tag: string;
  requestNonce?: string;
}

function decodeBase64Field(
  value: unknown,
  exactBytes?: number,
): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MSG_BYTES) {
    return null;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (exactBytes !== undefined && decoded.length !== exactBytes) return null;
  if (decoded.length > MAX_MSG_BYTES) return null;
  return decoded;
}

function ipcKey(authKey: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(authKey)) throw new Error('invalid resolve IPC key');
  return Buffer.from(authKey, 'hex');
}

function responseAad(requestNonce: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from('gbrain-resolve:v1:response:', 'utf8'),
    requestNonce,
  ]);
}

function encryptEnvelope(
  authKey: string,
  payload: unknown,
  aad: Buffer,
  requestNonce?: Buffer,
): EncryptedEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', ipcKey(authKey), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const envelope: EncryptedEnvelope = {
    v: PROTOCOL_VERSION,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  if (requestNonce) envelope.requestNonce = requestNonce.toString('base64');
  return envelope;
}

function decryptEnvelope(
  authKey: string,
  envelope: unknown,
  aad: Buffer,
  expectedRequestNonce?: Buffer,
): { payload: unknown; nonce: Buffer } {
  if (!envelope || typeof envelope !== 'object') throw new Error('invalid envelope');
  const wire = envelope as Partial<EncryptedEnvelope>;
  if (wire.v !== PROTOCOL_VERSION) throw new Error('unsupported protocol');
  const nonce = decodeBase64Field(wire.nonce, NONCE_BYTES);
  const ciphertext = decodeBase64Field(wire.ciphertext);
  const tag = decodeBase64Field(wire.tag, TAG_BYTES);
  if (!nonce || !ciphertext || !tag) throw new Error('invalid envelope fields');
  if (expectedRequestNonce) {
    const boundNonce = decodeBase64Field(wire.requestNonce, NONCE_BYTES);
    if (!boundNonce || !boundNonce.equals(expectedRequestNonce)) {
      throw new Error('response request binding mismatch');
    }
  } else if (wire.requestNonce !== undefined) {
    throw new Error('request envelope has response binding');
  }
  const decipher = createDecipheriv('aes-256-gcm', ipcKey(authKey), nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  if (plaintext.length > MAX_MSG_BYTES) throw new Error('decrypted payload too large');
  return { payload: JSON.parse(plaintext.toString('utf8')), nonce };
}

function resolveIpcAuthKey(dataDir: string): string {
  const authPath = join(dataDir, AUTH_NAME);
  try {
    const existing = readFileSync(authPath, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch { /* initialize below */ }

  const generated = randomBytes(AUTH_BYTES).toString('hex');
  try {
    writeFileSync(authPath, generated + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { chmodSync(authPath, 0o600); } catch { /* best effort on Windows */ }
    return generated;
  } catch {
    try {
      const raced = readFileSync(authPath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(raced)) return raced;
    } catch { /* fail closed below */ }
  }
  throw new Error(`cannot initialize resolve IPC authentication at ${authPath}`);
}

/** Marker the client returns when no server is reachable (vs. a real null result). */
export const IPC_UNAVAILABLE = Symbol('ipc-unavailable');

export interface ResolveRequest {
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  sourceId?: string;
  /** v0.43 (#2095, codex D7): suppression mode — 'slug-only' under windowing. */
  suppression?: 'slug-and-title' | 'slug-only';
}

export type ResolveHandler = (req: ResolveRequest) => Promise<PointerBlock | null>;

export interface ResolveIpcEndpoint {
  kind: 'unix-socket' | 'windows-pipe';
  address: string;
  /** Per-data-directory secret used for endpoint derivation and protocol auth. */
  authKey: string;
}

export interface ResolveIpcServer {
  endpoint: ResolveIpcEndpoint;
  server: net.Server;
  sockets: Set<net.Socket>;
  close(): Promise<void>;
}

/** Canonical local endpoint for a PGLite data directory. */
export function resolveIpcEndpoint(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): ResolveIpcEndpoint {
  const canonical = resolvePath(dataDir);
  const authKey = resolveIpcAuthKey(canonical);
  if (platform === 'win32') {
    // The secret-derived name prevents cross-account first-instance squatting
    // from redirecting a client to a predictable global pipe name. The request
    // and response authentication below still fail closed if the name leaks.
    const name = createHmac('sha256', authKey)
      .update(canonical.toLowerCase())
      .digest('hex')
      .slice(0, 24);
    return {
      kind: 'windows-pipe',
      address: `\\\\.\\pipe\\gbrain-resolve-${name}`,
      authKey,
    };
  }
  return {
    kind: 'unix-socket',
    address: join(canonical, SOCK_NAME),
    authKey,
  };
}

/**
 * Client: ship candidates to a running serve, get pointers back. Returns
 * IPC_UNAVAILABLE when no server is listening (caller falls through the ladder);
 * a real PointerBlock | null otherwise. Never throws — fail-soft to UNAVAILABLE.
 */
export async function resolveViaIpc(
  endpoint: ResolveIpcEndpoint,
  req: ResolveRequest,
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE> {
  if (endpoint.kind === 'unix-socket' && !existsSync(endpoint.address)) {
    return IPC_UNAVAILABLE;
  }
  return new Promise((resolve) => {
    let requestNonce: Buffer;
    let requestWire: string;
    try {
      const requestEnvelope = encryptEnvelope(endpoint.authKey, req, REQUEST_AAD);
      requestNonce = Buffer.from(requestEnvelope.nonce, 'base64');
      requestWire = JSON.stringify(requestEnvelope) + '\n';
      if (Buffer.byteLength(requestWire, 'utf8') > MAX_MSG_BYTES) {
        resolve(IPC_UNAVAILABLE);
        return;
      }
    } catch {
      resolve(IPC_UNAVAILABLE);
      return;
    }

    let settled = false;
    let buf = '';
    let bytes = 0;
    const decoder = new StringDecoder('utf8');
    let sock: net.Socket;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: PointerBlock | null | typeof IPC_UNAVAILABLE) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      try { sock.destroy(); } catch { /* noop */ }
      resolve(value);
    };
    try {
      sock = net.createConnection(endpoint.address);
    } catch {
      resolve(IPC_UNAVAILABLE);
      return;
    }
    // Absolute per-turn deadline: socket inactivity timeouts reset on every byte,
    // so a trickling peer could otherwise retain an abandoned request forever.
    deadline = setTimeout(() => finish(IPC_UNAVAILABLE), CLIENT_TIMEOUT_MS);
    sock.on('connect', () => {
      sock.write(requestWire);
    });
    sock.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MSG_BYTES) {
        finish(IPC_UNAVAILABLE);
        return;
      }
      buf += decoder.write(chunk);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const envelope = JSON.parse(buf.slice(0, nl));
        const { payload } = decryptEnvelope(
          endpoint.authKey,
          envelope,
          responseAad(requestNonce),
          requestNonce,
        );
        if (!payload || typeof payload !== 'object') throw new Error('invalid response');
        const response = payload as { ok?: unknown; block?: PointerBlock | null };
        finish(response.ok === true ? response.block ?? null : IPC_UNAVAILABLE);
      } catch {
        finish(IPC_UNAVAILABLE);
      }
    });
    // Any error (ENOENT, ECONNREFUSED, stale socket) or close before a
    // response means the optional resolve rung is unavailable.
    sock.on('error', () => finish(IPC_UNAVAILABLE));
    sock.on('close', () => finish(IPC_UNAVAILABLE));
  });
}

function closeNetServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!error || code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });
}

/**
 * Start a best-effort local resolve listener. A bind failure returns null and
 * never blocks `serve`. The managed handle owns accepted sockets and exposes an
 * idempotent awaited close boundary for deterministic shutdown.
 */
export async function startResolveIpcServer(
  endpoint: ResolveIpcEndpoint,
  handler: ResolveHandler,
  /** Fired only after the response write was accepted. */
  onDelivered?: (block: PointerBlock, req: ResolveRequest) => void,
): Promise<ResolveIpcServer | null> {
  cleanupStaleIpcEndpoint(endpoint);

  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const activeRequests = new Set<Promise<void>>();
    const seenRequestNonces = new Set<string>();
    const seenRequestNonceOrder: string[] = [];
    const rememberRequestNonce = (nonce: Buffer): boolean => {
      const encoded = nonce.toString('base64');
      if (seenRequestNonces.has(encoded)) return false;
      seenRequestNonces.add(encoded);
      seenRequestNonceOrder.push(encoded);
      if (seenRequestNonceOrder.length > 4096) {
        const oldest = seenRequestNonceOrder.shift();
        if (oldest !== undefined) seenRequestNonces.delete(oldest);
      }
      return true;
    };
    const server = net.createServer((conn) => {
      sockets.add(conn);
      conn.once('close', () => sockets.delete(conn));
      let buf = '';
      let handled = false;
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        if (handled) return;
        buf += chunk;
        if (Buffer.byteLength(buf, 'utf8') > MAX_MSG_BYTES) {
          conn.destroy();
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        handled = true;
        const line = buf.slice(0, nl);
        const request = (async () => {
          let resp: string;
          let delivered: { block: PointerBlock; req: ResolveRequest } | null = null;
          let requestNonce: Buffer | null = null;
          try {
            const encryptedRequest = JSON.parse(line);
            const decrypted = decryptEnvelope(
              endpoint.authKey,
              encryptedRequest,
              REQUEST_AAD,
            );
            requestNonce = decrypted.nonce;
            if (!rememberRequestNonce(requestNonce)) {
              conn.destroy();
              return;
            }
            if (!decrypted.payload || typeof decrypted.payload !== 'object') {
              throw new Error('invalid request');
            }
            const req = decrypted.payload as ResolveRequest;
            if (!Array.isArray(req.candidates)) throw new Error('invalid request');
            const block = await handler(req);
            const payload = { ok: true, block };
            resp = JSON.stringify(encryptEnvelope(
              endpoint.authKey,
              payload,
              responseAad(requestNonce),
              requestNonce,
            ));
            if (block) delivered = { block, req };
          } catch {
            // Malformed or unauthenticated input gets no oracle response. Handler
            // errors are encrypted below only after request authentication.
            try {
              if (requestNonce === null) {
                conn.destroy();
                return;
              }
              resp = JSON.stringify(encryptEnvelope(
                endpoint.authKey,
                { ok: false, block: null },
                responseAad(requestNonce),
                requestNonce,
              ));
            } catch {
              conn.destroy();
              return;
            }
          }

          if (Buffer.byteLength(resp, 'utf8') + 1 > MAX_MSG_BYTES) {
            conn.destroy();
            return;
          }

          if (conn.destroyed || !conn.writable) return;
          await new Promise<void>((resolveWrite) => {
            conn.write(resp + '\n', (error?: Error | null) => {
              if (!error && delivered && onDelivered && !conn.destroyed) {
                try { onDelivered(delivered.block, delivered.req); } catch { /* telemetry only */ }
              }
              resolveWrite();
            });
          });
          if (!conn.destroyed) conn.end();
        })();
        activeRequests.add(request);
        void request.finally(() => activeRequests.delete(request));
      });
      conn.on('error', () => { try { conn.destroy(); } catch { /* noop */ } });
    });

    let closed: Promise<void> | null = null;
    const managed: ResolveIpcServer = {
      endpoint,
      server,
      sockets,
      close() {
        if (closed) return closed;
        closed = (async () => {
          for (const socket of [...sockets]) socket.destroy();
          await closeNetServer(server);
          const draining = Promise.allSettled([...activeRequests]).then(() => undefined);
          let drainTimer: ReturnType<typeof setTimeout> | null = null;
          const drainDeadline = new Promise<void>((resolveDrain) => {
            drainTimer = setTimeout(resolveDrain, SERVER_CLOSE_DRAIN_MS);
          });
          await Promise.race([draining, drainDeadline]);
          if (drainTimer !== null) clearTimeout(drainTimer);
          sockets.clear();
          cleanupStaleIpcEndpoint(endpoint);
        })();
        return closed;
      },
    };

    const onStartupError = () => resolve(null);
    server.once('error', onStartupError);
    server.listen(endpoint.address, () => {
      server.removeListener('error', onStartupError);
      // Runtime errors must remain handled after startup; accepted-connection
      // errors have their own handlers above.
      server.on('error', () => {});
      if (endpoint.kind === 'unix-socket') {
        try { chmodSync(endpoint.address, 0o600); } catch { /* best effort */ }
      }
      resolve(managed);
    });
  });
}

/** Remove a stale Unix endpoint artifact. Named pipes have no file artifact. */
export function cleanupStaleIpcEndpoint(endpoint: ResolveIpcEndpoint): void {
  if (endpoint.kind !== 'unix-socket') return;
  try {
    if (existsSync(endpoint.address)) {
      const stat = statSync(endpoint.address);
      if (stat.isSocket() || stat.isFIFO() || stat.isFile()) unlinkSync(endpoint.address);
    }
  } catch {
    /* best effort */
  }
}
