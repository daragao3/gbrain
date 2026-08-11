#!/usr/bin/env bun
/**
 * A/B benchmark: `gbrain init --migrate-only` against a fresh file-backed
 * brain, with and without snapshot seeding.
 *
 * Arms ALTERNATE rather than running in blocks: this box's contention spread
 * is ~2.5x (two back-to-back reps of one spawn measured 11.3s and 28.9s), so
 * running all of arm A then all of arm B would confound the arm with the load
 * at the time. The concurrent `bun` count is recorded per rep for the same
 * reason — a timing without it is uninterpretable.
 *
 * The timed interval covers only `init --migrate-only`. Afterward, a separate
 * `config get version` process validates the canonical migration head through
 * `engine.getConfig('version')`; that validation time is not part of the arm.
 *
 * Run: bun run scripts/bench-pglite-bootstrap.ts [reps]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_FILE_ENV } from '../src/core/pglite-snapshot.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(REPO, 'test', 'fixtures', 'pglite-snapshot.tar');
const SNAPSHOT_VERSION = SNAPSHOT.replace(/\.tar$/, '.version');
const REPS = Number(process.argv[2] ?? 3);

export type BenchmarkRep = {
  arm: 'cold' | 'seeded';
  ms: number;
  bunProcs: number;
  exit: number;
  head: number | null;
  headExit: number;
};

async function bunProcCount(): Promise<number> {
  try {
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-Command',
        '(Get-Process bun -ErrorAction SilentlyContinue | Measure-Object).Count',
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    const [text, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) return -1;
    const count = Number(text.trim());
    return Number.isInteger(count) && count >= 0 ? count : -1;
  } catch {
    return -1;
  }
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn(
    [process.execPath, 'run', join(REPO, 'src', 'cli.ts'), ...args],
    { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit };
}

async function oneRep(arm: BenchmarkRep['arm']): Promise<BenchmarkRep> {
  const seed = arm === 'seeded';
  const home = mkdtempSync(join(tmpdir(), `gbrain-bench-${arm}-`));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_dimensions: 1536,
    }) + '\n',
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    GBRAIN_HOME: home,
  };
  // The benchmark must exercise the file-backed PGLite config above even when
  // the parent shell carries a Postgres override. Config URL precedence would
  // otherwise redirect both arms to Postgres and produce a plausible but
  // meaningless comparison.
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  if (seed) {
    env.GBRAIN_PGLITE_SNAPSHOT = SNAPSHOT;
    env[SEED_FILE_ENV] = '1';
  } else {
    delete env.GBRAIN_PGLITE_SNAPSHOT;
    delete env[SEED_FILE_ENV];
  }

  try {
    const bunProcs = await bunProcCount();
    const started = performance.now();
    const init = await runCli(['init', '--migrate-only'], env);
    const ms = Math.round(performance.now() - started);

    let head: number | null = null;
    let headExit = -1;
    if (init.exit === 0) {
      const observed = await runCli(['config', 'get', 'version'], env);
      headExit = observed.exit;
      const rawHead = observed.stdout.trim();
      const parsed = /^\d+$/.test(rawHead) ? Number(rawHead) : Number.NaN;
      if (headExit === 0 && Number.isInteger(parsed) && parsed > 0) head = parsed;
      if (headExit !== 0 || head === null) {
        console.error(
          `[bench] ${arm} head validation failed: ` +
          `exit=${headExit} stdout=${JSON.stringify(observed.stdout)} ` +
          `stderr=${JSON.stringify(observed.stderr)}`,
        );
      }
    } else {
      console.error(
        `[bench] ${arm} init failed: exit=${init.exit} ` +
        `stdout=${JSON.stringify(init.stdout)} stderr=${JSON.stringify(init.stderr)}`,
      );
    }

    return {
      arm,
      ms,
      bunProcs,
      exit: init.exit,
      head,
      headExit,
    };
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function canonicalMigrationHead(
  migrations: Array<{ version: number }>,
): number {
  return Math.max(...migrations.map((migration) => migration.version));
}

export function invalidBenchmarkReps(
  reps: BenchmarkRep[],
  expectedHead: number,
): BenchmarkRep[] {
  return reps.filter(
    (rep) => rep.exit !== 0
      || rep.headExit !== 0
      || rep.head !== expectedHead
      || rep.bunProcs < 0,
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

type Stats = { n: number; median: number; min: number; max: number; spread: number };

function stats(reps: BenchmarkRep[]): Stats {
  const values = reps.map((rep) => rep.ms);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { n: values.length, median: median(values), min, max, spread: max - min };
}

function summary(arm: BenchmarkRep['arm'], values: Stats): string {
  return `${arm.padEnd(6)} n=${values.n} median=${values.median}ms  ` +
    `min=${values.min}ms max=${values.max}ms spread=${values.spread}ms`;
}

async function main(): Promise<void> {
  if (!Number.isInteger(REPS) || REPS < 3) {
    console.error(`reps must be an integer >= 3 (got ${process.argv[2] ?? 'default'})`);
    process.exit(1);
  }
  if (!existsSync(SNAPSHOT) || !existsSync(SNAPSHOT_VERSION)) {
    console.error(`missing snapshot fixture — run: bun run build:pglite-snapshot`);
    process.exit(1);
  }
  const { computeSnapshotSchemaHash } = await import('../src/core/pglite-engine.ts');
  const { MIGRATIONS } = await import('../src/core/migrate.ts');
  const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');
  const crypto = await import('node:crypto');
  const { LEGACY_EMBEDDING_CONFIG } = await import('../test/helpers/legacy-embedding-config.ts');
  // Must hash at the SAME width build-pglite-snapshot.ts baked the fixture at,
  // or a perfectly fresh fixture reports as stale.
  const expectedSnapshotVersion = computeSnapshotSchemaHash(
    MIGRATIONS,
    PGLITE_SCHEMA_SQL,
    crypto,
    LEGACY_EMBEDDING_CONFIG.embedding_dimensions,
  );
  const actualSnapshotVersion = readFileSync(SNAPSHOT_VERSION, 'utf8').trim();
  if (actualSnapshotVersion !== expectedSnapshotVersion) {
    console.error(`stale snapshot fixture — run: bun run build:pglite-snapshot`);
    process.exit(1);
  }

  const results: BenchmarkRep[] = [];
  for (let index = 0; index < REPS; index++) {
    for (const arm of ['cold', 'seeded'] as const) {
      const result = await oneRep(arm);
      results.push(result);
      console.log(
        `rep ${index + 1} ${result.arm.padEnd(6)}: ${result.ms}ms  ` +
        `bun_procs=${result.bunProcs} exit=${result.exit} ` +
        `head=${result.head ?? 'INVALID'} head_exit=${result.headExit}`,
      );
    }
  }

  const expectedHead = canonicalMigrationHead(MIGRATIONS);
  const invalid = invalidBenchmarkReps(results, expectedHead);
  if (invalid.length > 0) {
    console.error(
      `benchmark invalid: invalid_reps=${invalid.length} expected_head=${expectedHead} ` +
      `migration_heads=${JSON.stringify(results.map((rep) => rep.head))}`,
    );
    process.exit(1);
  }

  const cold = stats(results.filter((rep) => rep.arm === 'cold'));
  const seeded = stats(results.filter((rep) => rep.arm === 'seeded'));
  console.log('');
  console.log(summary('cold', cold));
  console.log(summary('seeded', seeded));
  console.log(`speedup (median): ${(cold.median / seeded.median).toFixed(2)}x`);
}

if (import.meta.main) await main();
