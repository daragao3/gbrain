/**
 * E2E tests for src/mcp/http-transport.ts against real Postgres.
 *
 * Catches schema drift (column-name typos that would slip past the unit suite's
 * stubbed engine.sql) and proves the F1+F2+F3 dispatch pipeline works against a
 * real handler doing real DB work. Also exercises the SQL-level last_used_at
 * debounce against real Postgres semantics.
 *
 * Run: DATABASE_URL=... bun test test/e2e/http-transport.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import postgres from 'postgres';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const DISPOSABLE_DATABASE_NAME = /^task6_test_[0-9a-f]{8}$/;
const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E http-transport tests (DATABASE_URL not set)');
}

function assertDisposableDatabaseName(databaseName: string): void {
  if (databaseName === 'gbrain_db' || !DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    throw new Error('E2E guard: selected database name is not an approved disposable Task 6 database; refusing to run.');
  }
}

async function assertDisposableDatabaseSelected(): Promise<void> {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  const guardConnection = postgres(DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const rows = await guardConnection<{ database_name: string }[]>`
      SELECT current_database() AS database_name
    `;
    const databaseName = rows[0]?.database_name;
    if (!databaseName) {
      throw new Error('E2E guard: current_database() returned no database name; refusing to run.');
    }
    assertDisposableDatabaseName(databaseName);
  } finally {
    await guardConnection.end({ timeout: 5 });
  }
}

describe('HTTP transport PostgreSQL database identity guard', () => {
  test('accepts only the suite disposable database naming shape', () => {
    expect(() => assertDisposableDatabaseName('task6_test_a491e265')).not.toThrow();
    for (const name of ['gbrain_db', 'gbrain_test', 'task6_test', 'task6_test_not-hex', 'other_test_a491e265']) {
      expect(() => assertDisposableDatabaseName(name)).toThrow(/refusing to run/);
    }
  });
});

interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

function generateToken(): string {
  return 'gbrain_test_' + randomBytes(16).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function startServer(): Promise<ServerHandle> {
  const engine = getEngine();
  const server = await startHttpTransport({ port: 0, engine: engine as any });
  return {
    port: (server as any).port,
    stop: async () => { (server as any).stop(true); },
  };
}

function rpc(method: string, params?: unknown, id: number = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

describeE2E('http-transport E2E (real Postgres)', () => {
  let srv: ServerHandle;
  let validToken: string;
  let revokedToken: string;
  let validTokenName: string;

  beforeAll(async () => {
    await assertDisposableDatabaseSelected();
    await setupDB();
    const conn = getConn();

    // Seed a valid + revoked token directly via SQL (mirrors auth.ts's create path).
    validToken = generateToken();
    validTokenName = 'e2e-valid-' + randomBytes(4).toString('hex');
    await conn.unsafe(
      'INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)',
      [validTokenName, hashToken(validToken)],
    );
    revokedToken = generateToken();
    await conn.unsafe(
      'INSERT INTO access_tokens (name, token_hash, revoked_at) VALUES ($1, $2, now())',
      ['e2e-revoked-' + randomBytes(4).toString('hex'), hashToken(revokedToken)],
    );

    srv = await startServer();
    console.log(`HTTP E2E server bound to ephemeral port ${srv.port}`);
  }, 30_000);

  afterAll(async () => {
    if (srv) await srv.stop();
    await teardownDB();
  });

  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const response = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: rpc('tools/call', { name, arguments: args }),
    });
    const body = await response.json();
    return {
      response,
      body,
      result: JSON.parse(body.result.content[0].text),
    };
  }

  test('1. /health → 200 with expected JSON shape', async () => {
    const r = await fetch(`http://localhost:${srv.port}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.transport).toBe('http');
    expect(body.version).toBeString();
  });

  test('2. /mcp tools/list with valid Bearer → 200 + ops list', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.tools).toBeArray();
    expect(body.result.tools.length).toBeGreaterThan(5);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toContain('put_page_conditional');
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  test('3. /mcp tools/call (real op: list_pages) round-trips successfully — F1+F2+F3 guard', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'list_pages', arguments: { limit: 5 } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.content).toBeArray();
    // Should NOT be an error — handler ran successfully against the real engine.
    expect(body.result.isError).toBeUndefined();
    // Result text should parse as JSON (list_pages returns an object/array)
    const resultText = body.result.content[0].text;
    const parsed = JSON.parse(resultText);
    expect(parsed).toBeDefined();
  });

  test('4. revoked token → 401', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${revokedToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(401);
  });

  test('5. last_used_at debounce: two consecutive valid calls → only one UPDATE within 60s', async () => {
    const conn = getConn();

    // Reset last_used_at to NULL so the first call definitely updates
    await conn.unsafe('UPDATE access_tokens SET last_used_at = NULL WHERE name = $1', [validTokenName]);

    // First request — should update last_used_at
    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    // Give the fire-and-forget UPDATE a moment to land
    await new Promise(r => setTimeout(r, 50));

    const [row1] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];
    expect(row1.last_used_at).not.toBeNull();
    const firstUpdate = row1.last_used_at;

    // Second request immediately — should NOT trigger another UPDATE (debounced by SQL WHERE)
    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    await new Promise(r => setTimeout(r, 50));

    const [row2] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];
    // Same timestamp = same UPDATE = debounce held
    expect(row2.last_used_at?.getTime()).toBe(firstUpdate?.getTime());
  });

  test('6. last_used_at debounce: simulating 65s gap → second request DOES update', async () => {
    const conn = getConn();

    // Set last_used_at to 65 seconds ago — simulates the time gap without waiting in real time
    await conn.unsafe(
      `UPDATE access_tokens SET last_used_at = now() - interval '65 seconds' WHERE name = $1`,
      [validTokenName],
    );
    const [before] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];

    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    await new Promise(r => setTimeout(r, 50));

    const [after] = await conn.unsafe(
      'SELECT last_used_at FROM access_tokens WHERE name = $1',
      [validTokenName],
    ) as { last_used_at: Date | null }[];
    expect(after.last_used_at?.getTime()).toBeGreaterThan(before.last_used_at!.getTime());
  });

  test('7. mcp_request_log gets a row per request', async () => {
    const conn = getConn();
    const beforeRows = await conn.unsafe('SELECT count(*)::int AS n FROM mcp_request_log') as { n: number }[];
    const beforeN = beforeRows[0].n;

    await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    // Fire-and-forget audit insert — give it a tick
    await new Promise(r => setTimeout(r, 100));

    const afterRows = await conn.unsafe('SELECT count(*)::int AS n FROM mcp_request_log') as { n: number }[];
    expect(afterRows[0].n).toBeGreaterThan(beforeN);

    const [row] = await conn.unsafe(
      `SELECT token_name, operation, status, latency_ms FROM mcp_request_log
       WHERE token_name = $1 ORDER BY created_at DESC LIMIT 1`,
      [validTokenName],
    ) as { token_name: string; operation: string; status: string; latency_ms: number }[];
    expect(row.token_name).toBe(validTokenName);
    expect(row.operation).toBe('tools/list');
    expect(row.status).toBe('success');
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('8. tools/call with malformed params → isError result with invalid_params', async () => {
    const r = await fetch(`http://localhost:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${validToken}`, 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'get_page', arguments: { slug: 42 } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('invalid_params');
  });

  test('9. conditional writes over /mcp return typed create and CAS conflicts as normal results', async () => {
    const v1 = '---\ntype: note\ntitle: HTTP Conditional V1\n---\n\nFirst HTTP version.';
    const v2 = '---\ntype: note\ntitle: HTTP Conditional V2\n---\n\nSecond HTTP version.';
    const v3 = '---\ntype: note\ntitle: HTTP Conditional V3\n---\n\nStale HTTP version.';

    const created = await callTool(validToken, 'put_page_conditional', {
      slug: 'test/http-conditional', content: v1, mode: 'create_only',
    });
    expect(created.response.status).toBe(200);
    expect(created.body.result.isError).toBeUndefined();
    expect(created.result).toMatchObject({ status: 'created', revision: 1 });

    const conflict = await callTool(validToken, 'put_page_conditional', {
      slug: 'test/http-conditional', content: v2, mode: 'create_only',
    });
    expect(conflict.response.status).toBe(200);
    expect(conflict.body.result.isError).toBeUndefined();
    expect(conflict.result).toMatchObject({
      status: 'conflict', reason: 'already_exists', current_revision: 1,
    });

    const updated = await callTool(validToken, 'put_page_conditional', {
      slug: 'test/http-conditional', content: v2,
      mode: 'compare_and_swap', expected_revision: created.result.revision,
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body.result.isError).toBeUndefined();
    expect(updated.result).toMatchObject({ status: 'updated', revision: 2 });

    const stale = await callTool(validToken, 'put_page_conditional', {
      slug: 'test/http-conditional', content: v3,
      mode: 'compare_and_swap', expected_revision: created.result.revision,
    });
    expect(stale.response.status).toBe(200);
    expect(stale.body.result.isError).toBeUndefined();
    expect(stale.result).toMatchObject({
      status: 'conflict', reason: 'revision_mismatch', expected_revision: 1, current_revision: 2,
    });
  }, 30_000);

  test('10. authenticated scalar source binding defeats hostile payload source fields and stamps remote provenance', async () => {
    const conn = getConn();
    await conn.unsafe(
      `INSERT INTO sources (id, name, config)
       VALUES ('source-http-a', 'source-http-a', '{}'::jsonb),
              ('source-http-b', 'source-http-b', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    const sourceToken = generateToken();
    await conn.unsafe(
      `INSERT INTO access_tokens (name, token_hash, permissions)
       VALUES ($1, $2, '{"source_id":"source-http-a"}'::jsonb)`,
      ['e2e-source-bound-' + randomBytes(4).toString('hex'), hashToken(sourceToken)],
    );

    const written = await callTool(sourceToken, 'put_page_conditional', {
      slug: 'test/http-source-bound',
      content: '---\ntype: note\ntitle: HTTP Source Bound\n---\n\nAuthenticated source wins.',
      mode: 'create_only',
      source_id: 'source-http-b',
      sourceId: 'source-http-b',
      source_kind: 'capture-cli',
      source_uri: 'spoofed://payload',
      ingested_via: 'file-watcher',
    });
    expect(written.response.status).toBe(200);
    expect(written.body.result.isError).toBeUndefined();
    expect(written.result).toMatchObject({ status: 'created', revision: 1 });

    const rows = await conn.unsafe(
      `SELECT source_id, source_kind, source_uri, ingested_via
         FROM pages WHERE slug = $1 ORDER BY source_id`,
      ['test/http-source-bound'],
    ) as Array<{ source_id: string; source_kind: string | null; source_uri: string | null; ingested_via: string | null }>;
    expect(rows).toEqual([{
      source_id: 'source-http-a',
      source_kind: 'mcp:put_page_conditional',
      source_uri: null,
      ingested_via: 'mcp:put_page_conditional',
    }]);
  });

  test('11. legacy put_page remains compatible and get_page exposes numeric revision', async () => {
    const slug = 'test/http-legacy-put';
    const legacy = await callTool(validToken, 'put_page', {
      slug,
      content: '---\ntype: note\ntitle: HTTP Legacy Put\n---\n\nLegacy compatibility body.',
    });
    expect(legacy.response.status).toBe(200);
    expect(legacy.body.result.isError).toBeUndefined();
    expect(legacy.result.status).toBe('created_or_updated');

    const read = await callTool(validToken, 'get_page', { slug });
    expect(read.response.status).toBe(200);
    expect(read.body.result.isError).toBeUndefined();
    expect(read.result.revision).toBeNumber();
    expect(read.result.revision).toBe(1);
  });

  test.each([
    [{ mode: 'overwrite' }, 'Unknown conditional write mode'],
    [{ mode: 'create_only', expected_revision: 1 }, 'create_only rejects expected_revision'],
    [{ mode: 'compare_and_swap' }, 'positive safe integer'],
    [{ mode: 'compare_and_swap', expected_revision: 0 }, 'positive safe integer'],
  ])('12. malformed conditional mode/revision stays an MCP tool error: %s', async (extra, message) => {
    const malformed = await callTool(validToken, 'put_page_conditional', {
      slug: 'test/http-invalid-conditional',
      content: '---\ntype: note\ntitle: Invalid Conditional\n---\n\nMust not be written.',
      ...extra,
    });
    expect(malformed.response.status).toBe(200);
    expect(malformed.body.jsonrpc).toBe('2.0');
    expect(malformed.body.result.isError).toBe(true);
    expect(malformed.result).toMatchObject({ error: 'invalid_params' });
    expect(malformed.result.message).toContain(message);
  });
});
