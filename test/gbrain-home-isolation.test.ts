/**
 * Hermeticity test: every site that writes under `~/.gbrain` must honor
 * `GBRAIN_HOME=<tmp>` and write under `<tmp>/.gbrain` instead of the developer's
 * real home.
 *
 * Why this exists: `src/core/config.ts::configDir()` already supports
 * `GBRAIN_HOME` as a parent-dir override (returns `<override>/.gbrain`), but
 * historically many call sites built paths from `os.homedir()` directly,
 * bypassing the override. The hermeticity migration migrated every write-side
 * caller to `gbrainPath(...)`. This test is the regression gate.
 *
 * Scope: write-isolation only. Read-side host detection in
 * `src/commands/init.ts` (reading `~/.claude`, `~/.openclaw`, etc. for module
 * fingerprinting) is the documented v1 caveat and is NOT asserted here.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, readFileSync, statSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve, sep } from 'path';

// Save original env so we don't leak between tests. #2823: GBRAIN_AUDIT_DIR
// must be captured too — the shared test bootstrap (test/helpers/audit-dir-preload.ts)
// sets a process-global scratch dir before any test file runs, so "restore"
// here means "put back the preload's value," not "delete the var and let
// it fall through to the real ~/.gbrain/audit for every test file that
// runs after this one in the same shard process."
const ORIG_GBRAIN_HOME = process.env.GBRAIN_HOME;
const ORIG_GBRAIN_AUDIT_DIR = process.env.GBRAIN_AUDIT_DIR;

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-home-isolation-'));
}

describe('GBRAIN_HOME write-side isolation', () => {
  test('configDir() returns <GBRAIN_HOME>/.gbrain when override is set', async () => {
    const tmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    try {
      const { configDir, gbrainPath } = await import('../src/core/config.ts');
      expect(configDir()).toBe(join(tmp, '.gbrain'));
      expect(gbrainPath('foo', 'bar.json')).toBe(join(tmp, '.gbrain', 'foo', 'bar.json'));
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('configDir() falls back to homedir when GBRAIN_HOME unset', async () => {
    delete process.env.GBRAIN_HOME;
    try {
      const { configDir } = await import('../src/core/config.ts');
      // Contract: when GBRAIN_HOME is unset, configDir() === os.homedir()/.gbrain.
      // Asserting against os.homedir() (rather than a "not /tmp/" sentinel) keeps
      // this test correct under safety wrappers that redirect HOME=/tmp/... — the
      // behavior we care about is that the fallback path equals homedir().
      expect(configDir()).toBe(join(homedir(), '.gbrain'));
    } finally {
      if (ORIG_GBRAIN_HOME !== undefined) process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
    }
  });

  test('rejects relative GBRAIN_HOME', async () => {
    process.env.GBRAIN_HOME = 'relative/path';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/absolute path/);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
    }
  });

  test("rejects GBRAIN_HOME containing '..' segments", async () => {
    process.env.GBRAIN_HOME = '/tmp/foo/../bar';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/'\.\.' segments/);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
    }
  });

  test('saveConfig/loadConfig honor GBRAIN_HOME', async () => {
    const tmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    try {
      const { saveConfig, loadConfig } = await import('../src/core/config.ts');
      const cfg = { engine: 'pglite' as const, database_path: join(tmp, '.gbrain', 'brain.pglite') };
      saveConfig(cfg);
      // Config file should exist under the override, NOT under real ~/.gbrain.
      expect(existsSync(join(tmp, '.gbrain', 'config.json'))).toBe(true);

      // Round-trip: loadConfig() finds it back via the override.
      const loaded = loadConfig();
      expect(loaded?.engine).toBe('pglite');
      expect(loaded?.database_path).toBe(cfg.database_path);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('integrity, sync-failures, integrations heartbeat resolve under GBRAIN_HOME', async () => {
    const tmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    try {
      const { gbrainPath } = await import('../src/core/config.ts');
      // Spot-check a representative set of paths used across the migrated sites.
      const paths = [
        gbrainPath('integrity-review.md'),                       // src/commands/integrity.ts
        gbrainPath('sync-failures.jsonl'),                       // src/core/sync.ts
        gbrainPath('integrations', 'recipe-x'),                  // src/commands/integrations.ts
        gbrainPath('migrate-manifest.json'),                     // src/commands/migrate-engine.ts
        gbrainPath('import-checkpoint.json'),                    // src/commands/import.ts
        gbrainPath('migrations', 'v0_13_1-rollback.jsonl'),      // src/commands/migrations/v0_13_1.ts
        gbrainPath('migrations', 'pending-host-work.jsonl'),     // src/commands/migrations/v0_14_0.ts
        gbrainPath('audit'),                                     // shell-audit / backpressure-audit
        gbrainPath('cycle.lock'),                                // src/core/cycle.ts
        gbrainPath('fail-improve'),                              // src/core/fail-improve.ts
        gbrainPath('validator-lint.jsonl'),                      // src/core/output/post-write.ts
        gbrainPath('brain.pglite'),                              // init pglite default
      ];
      for (const p of paths) {
        expect(p.startsWith(join(tmp, '.gbrain'))).toBe(true);
      }
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // --- fail-closed backstop -------------------------------------------------
  //
  // GBRAIN_HOME is ambient process state, so honoring it is ADVISORY: every
  // test above proves the override works when a caller remembers to set it,
  // and none of them can stop a caller that forgets. A `migrate --to pglite`
  // that completes without GBRAIN_HOME rewrites the MACHINE-GLOBAL config
  // (`migrate-engine.ts` ends with `saveConfig`), repointing the shared brain
  // at a throwaway mkdtemp target. Every later CLI read then returns
  // `page_not_found` / "No timeline entries." against an empty brain — a
  // SILENT FALSE NEGATIVE indistinguishable from a genuinely deleted page.
  //
  // These tests pin the backstop that makes the dangerous shape fail closed
  // regardless of which caller forgot. They fake `homedir()` so the assertion
  // can never reach the developer's real `~/.gbrain/config.json`, before OR
  // after the guard exists.
  describe('saveConfig fail-closed: no machine-global repoint at a temp brain', () => {
    function withFakeHome<T>(fn: (fakeHome: string) => T): T {
      const fakeHome = fresh();
      const prev = {
        gbrainHome: process.env.GBRAIN_HOME,
        userProfile: process.env.USERPROFILE,
        home: process.env.HOME,
        allow: process.env.GBRAIN_ALLOW_TEMP_BRAIN,
      };
      // No GBRAIN_HOME => this is a machine-global write...
      delete process.env.GBRAIN_HOME;
      // ...but against a FAKE machine, so a missing guard cannot damage the
      // developer's real brain config while this test is red.
      process.env.USERPROFILE = fakeHome;
      process.env.HOME = fakeHome;
      try {
        return fn(fakeHome);
      } finally {
        if (prev.gbrainHome !== undefined) process.env.GBRAIN_HOME = prev.gbrainHome; else delete process.env.GBRAIN_HOME;
        if (prev.userProfile !== undefined) process.env.USERPROFILE = prev.userProfile; else delete process.env.USERPROFILE;
        if (prev.home !== undefined) process.env.HOME = prev.home; else delete process.env.HOME;
        if (prev.allow !== undefined) process.env.GBRAIN_ALLOW_TEMP_BRAIN = prev.allow; else delete process.env.GBRAIN_ALLOW_TEMP_BRAIN;
        rmSync(fakeHome, { recursive: true, force: true });
      }
    }

    test('refuses to repoint the machine-global brain at a temp-dir target', async () => {
      const { saveConfig } = await import('../src/core/config.ts');
      const target = join(mkdtempSync(join(tmpdir(), 'gbrain-guard-target-')), 'brain.pglite');
      try {
        withFakeHome((fakeHome) => {
          expect(() => saveConfig({ engine: 'pglite', database_path: target })).toThrow(/temporary directory/i);
          // Fail CLOSED: the refusal must happen before any bytes land.
          expect(existsSync(join(fakeHome, '.gbrain', 'config.json'))).toBe(false);
        });
      } finally {
        rmSync(join(target, '..'), { recursive: true, force: true });
      }
    });

    test('a refusal appends a JSONL row naming the offending process', async () => {
      // The refusal alone tells you SOMETHING tried to repoint the brain; the
      // audit row is what tells you WHAT did. That is the whole point of the
      // forensic path — the caller behind the observed incidents was an
      // untracked script that a repo-wide search could not find, so the stack
      // recorded from inside its own process is the only thing that names it.
      const { saveConfig } = await import('../src/core/config.ts');
      const auditDir = fresh();
      const target = join(mkdtempSync(join(tmpdir(), 'gbrain-guard-target-')), 'brain.pglite');
      const prevAudit = process.env.GBRAIN_AUDIT_DIR;
      // Pin the audit dir explicitly: the shared bootstrap sets it
      // process-globally, so asserting the default location would be reading
      // another test's scratch dir.
      process.env.GBRAIN_AUDIT_DIR = auditDir;
      try {
        withFakeHome(() => {
          expect(() => saveConfig({ engine: 'pglite', database_path: target })).toThrow();
        });

        const rowsPath = join(auditDir, 'config-repoint-refused.jsonl');
        expect(existsSync(rowsPath)).toBe(true);
        const lines = readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean);
        expect(lines.length).toBe(1);

        const row = JSON.parse(lines[0]!);
        expect(row.event).toBe('refused_global_config_repoint');
        expect(row.pid).toBe(process.pid);
        expect(row.database_path).toBe(target);
        expect(row.engine).toBe('pglite');
        expect(row.cwd).toBe(process.cwd());
        expect(Array.isArray(row.argv)).toBe(true);
        // The stack is the actual answer to "which code did this?".
        expect(typeof row.stack).toBe('string');
        expect(row.reason).toMatch(/temporary directory/i);
        // Timestamp must be a real ISO instant, not a placeholder.
        expect(Number.isNaN(Date.parse(row.ts))).toBe(false);
      } finally {
        if (prevAudit !== undefined) process.env.GBRAIN_AUDIT_DIR = prevAudit;
        else delete process.env.GBRAIN_AUDIT_DIR;
        rmSync(auditDir, { recursive: true, force: true });
        rmSync(join(target, '..'), { recursive: true, force: true });
      }
    });

    test('allows the identical write when GBRAIN_HOME sandboxes it', async () => {
      const { saveConfig, loadConfigFileOnly } = await import('../src/core/config.ts');
      const sandbox = fresh();
      const target = join(mkdtempSync(join(tmpdir(), 'gbrain-guard-target-')), 'brain.pglite');
      const prev = process.env.GBRAIN_HOME;
      process.env.GBRAIN_HOME = sandbox;
      try {
        // A temp target is the NORMAL shape for a sandboxed test — the guard
        // must not break hermetic callers that did the right thing.
        expect(() => saveConfig({ engine: 'pglite', database_path: target })).not.toThrow();
        expect(loadConfigFileOnly()?.database_path).toBe(target);
      } finally {
        if (prev !== undefined) process.env.GBRAIN_HOME = prev; else delete process.env.GBRAIN_HOME;
        rmSync(sandbox, { recursive: true, force: true });
        rmSync(join(target, '..'), { recursive: true, force: true });
      }
    });

    test('allows a machine-global repoint at a PERMANENT pglite brain', async () => {
      const { saveConfig, loadConfigFileOnly } = await import('../src/core/config.ts');
      // Deliberately narrow: migrating the real brain to a PGLite file in a
      // durable location is a legitimate configuration, not the bug.
      const permanent = resolve(sep, 'gbrain-permanent-brain', 'brain.pglite');
      withFakeHome(() => {
        expect(() => saveConfig({ engine: 'pglite', database_path: permanent })).not.toThrow();
        expect(loadConfigFileOnly()?.database_path).toBe(permanent);
      });
    });

    test('GBRAIN_ALLOW_TEMP_BRAIN=1 is the documented escape hatch', async () => {
      const { saveConfig, loadConfigFileOnly } = await import('../src/core/config.ts');
      const target = join(mkdtempSync(join(tmpdir(), 'gbrain-guard-target-')), 'brain.pglite');
      try {
        withFakeHome(() => {
          process.env.GBRAIN_ALLOW_TEMP_BRAIN = '1';
          expect(() => saveConfig({ engine: 'pglite', database_path: target })).not.toThrow();
          expect(loadConfigFileOnly()?.database_path).toBe(target);
        });
      } finally {
        rmSync(join(target, '..'), { recursive: true, force: true });
      }
    });

    test('a postgres config is never affected', async () => {
      const { saveConfig, loadConfigFileOnly } = await import('../src/core/config.ts');
      withFakeHome(() => {
        expect(() => saveConfig({ engine: 'postgres', database_url: 'postgres://u:p@127.0.0.1:5432/db' })).not.toThrow();
        expect(loadConfigFileOnly()?.engine).toBe('postgres');
      });
    });

    // ---- The two ways the tmpdir() fence gets walked around ----------------
    //
    // `isPathInside` is pure `path.relative()` math and never touches the
    // filesystem. That is correct for its other callers but leaves this guard
    // with two blind spots, both of which have a real-world shape.

    test.if(process.platform === 'win32')(
      'refuses a temp target spelled with a Windows 8.3 short name',
      async () => {
        // WINDOWS-ONLY, and therefore invisible to this project's ubuntu CI —
        // 8.3 aliases do not exist on POSIX, so there is nothing to assert
        // there. Written for the machine where the real repoints happened.
        //
        // The hazard needs a short-named component ABOVE the target. A user
        // directory longer than 8 characters (`Administrator` -> `ADMINI~1`)
        // does it on a normal install; here we redirect TMP/TEMP at a
        // long-named root, which is the same shape and is exactly how a CI
        // runner or installer that exports a short-form %TEMP% hits it.
        const { saveConfig } = await import('../src/core/config.ts');
        const { isPathInside } = await import('../src/core/path-confine.ts');
        const { execFileSync } = await import('child_process');

        // No quotes around %I's argument: execFileSync already quotes the /c
        // string, and cmd would keep an inner pair literally.
        const shortPathOf = (p: string): string =>
          execFileSync('cmd', ['/d', '/c', `for %I in (${p}) do @echo %~sI`], { encoding: 'utf8' }).trim();

        const longRoot = mkdtempSync(join(tmpdir(), 'gbrain-longname-temproot-'));
        const prevTemp = process.env.TEMP;
        const prevTmp = process.env.TMP;
        try {
          const shortRoot = shortPathOf(longRoot);
          // A volume with NtfsDisable8dot3NameCreation=1 hands back the long
          // path unchanged. Nothing to prove there — don't fail, just stop.
          if (shortRoot.toLowerCase() === longRoot.toLowerCase()) return;

          withFakeHome(() => {
            // os.tmpdir() reads TMP/TEMP on Windows, so this repoints the very
            // fence under test at our long-named root.
            process.env.TEMP = longRoot;
            process.env.TMP = longRoot;
            const target = join(shortRoot, 'sub', 'brain.pglite');

            // The hazard, demonstrated: to the lexical check the short spelling
            // is an unrelated directory, so the fence reads as "outside".
            expect(isPathInside(target, tmpdir())).toBe(false);
            // The guard canonicalizes both sides first, so it still fires.
            expect(() => saveConfig({ engine: 'pglite', database_path: target }))
              .toThrow(/temporary directory/i);
          });
        } finally {
          if (prevTemp !== undefined) process.env.TEMP = prevTemp; else delete process.env.TEMP;
          if (prevTmp !== undefined) process.env.TMP = prevTmp; else delete process.env.TMP;
          rmSync(longRoot, { recursive: true, force: true });
        }
      },
    );

    test('refuses a migration scratch dir even when it sits OUTSIDE tmpdir()', async () => {
      // `tmpdir()` is read at call time, so a run whose TMPDIR was redirected
      // after it created its target — or that hardcoded a scratch dir on
      // another volume — lands outside the containment fence while being just
      // as throwaway. The mkdtemp prefix is the tell, so it is matched by name.
      const { saveConfig } = await import('../src/core/config.ts');
      const { isPathInside } = await import('../src/core/path-confine.ts');
      const target = resolve(sep, 'gbrain-not-the-temp-dir', 'gbrain-migrate-target-M72hsf', 'brain.pglite');
      withFakeHome(() => {
        // Precondition: containment alone would let this through.
        expect(isPathInside(target, tmpdir())).toBe(false);
        expect(() => saveConfig({ engine: 'pglite', database_path: target }))
          .toThrow(/migration scratch directory/i);
      });
    });

    test('the scratch-dir refusal still yields to GBRAIN_HOME and the escape hatch', async () => {
      // Same narrowness as the containment arm: a sandboxed write is never a
      // machine-global repoint, and the documented opt-out must cover both
      // throwaway shapes, not just the one that existed first.
      const { saveConfig } = await import('../src/core/config.ts');
      const target = resolve(sep, 'elsewhere', 'gbrain-migrate-target-M72hsf', 'brain.pglite');
      const sandbox = fresh();
      const prev = process.env.GBRAIN_HOME;
      process.env.GBRAIN_HOME = sandbox;
      try {
        expect(() => saveConfig({ engine: 'pglite', database_path: target })).not.toThrow();
      } finally {
        if (prev !== undefined) process.env.GBRAIN_HOME = prev; else delete process.env.GBRAIN_HOME;
        rmSync(sandbox, { recursive: true, force: true });
      }
      withFakeHome(() => {
        process.env.GBRAIN_ALLOW_TEMP_BRAIN = '1';
        expect(() => saveConfig({ engine: 'pglite', database_path: target })).not.toThrow();
      });
    });

    test('a durable path that merely MENTIONS a brain is still allowed', async () => {
      // Guard the name-match against over-reach: only the scratch prefix is
      // special, not the word "gbrain" or "migrate" anywhere in a real path.
      const { saveConfig, loadConfigFileOnly } = await import('../src/core/config.ts');
      const durable = resolve(sep, 'srv', 'gbrain-migrations', 'production', 'brain.pglite');
      withFakeHome(() => {
        expect(() => saveConfig({ engine: 'pglite', database_path: durable })).not.toThrow();
        expect(loadConfigFileOnly()?.database_path).toBe(durable);
      });
    });
  });

  test('GBRAIN_AUDIT_DIR override still wins over GBRAIN_HOME', async () => {
    const tmp = fresh();
    const auditTmp = fresh();
    process.env.GBRAIN_HOME = tmp;
    process.env.GBRAIN_AUDIT_DIR = auditTmp;
    try {
      const { resolveAuditDir } = await import('../src/core/minions/handlers/shell-audit.ts');
      // Per the docstring: GBRAIN_AUDIT_DIR is the explicit override and wins.
      expect(resolveAuditDir()).toBe(auditTmp);
    } finally {
      process.env.GBRAIN_HOME = ORIG_GBRAIN_HOME;
      if (ORIG_GBRAIN_AUDIT_DIR === undefined) {
        delete process.env.GBRAIN_AUDIT_DIR;
      } else {
        process.env.GBRAIN_AUDIT_DIR = ORIG_GBRAIN_AUDIT_DIR;
      }
      rmSync(tmp, { recursive: true, force: true });
      rmSync(auditTmp, { recursive: true, force: true });
    }
  });
});
