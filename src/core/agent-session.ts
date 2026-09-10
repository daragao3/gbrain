/**
 * Refuse gbrain's outward-facing git pushes from what looks like an agent session.
 *
 * WHY THIS EXISTS. Two commands in this CLI perform a real `git push`:
 *
 *   - `gbrain skillpack endorse <name> --push`  -> core/skillpack/endorse.ts
 *   - `gbrain sources harden ...`               -> core/brain-repo-durability.ts
 *   - `gbrain sources add ... ` with a PAT      -> the SAME durability push, run
 *                                                  automatically on add
 *
 * Every one of those is an `execFileSync('git', [...])` INSIDE this package, so
 * the machine-wide guard at `~/.claude/hooks/block-destructive-git.py` cannot
 * see it. That hook reads the ARGV of what an agent runs, and `gbrain sources
 * add ...` carries no git verb there: no block, no pending id, no grant.
 *
 * A CONTENT SCAN of launched scripts was measured over 436 of them on
 * 2026-09-09 and rejected, and re-measured at larger scale on 2026-09-10 (a
 * verb regex over 164 candidate scripts flags 145, overwhelmingly prose --
 * `Array.push`, a "Push" UI label, `clean start-of`). A PUSH-FLAG heuristic was
 * measured the same day and is no better: 146 commands carry one and almost all
 * are prose. The hook cannot close this class; a gate at the command seam can.
 * Records: loops `gitguard-script-file-argument-gap-20260909`,
 * `gitguard-script-path-gap-close-20260910`.
 *
 * WHY THE GATE IS AT THE TYPED-COMMAND SEAM AND NOT AT THE PUSH. Placement is
 * decided by measurement, not taste. gbrain's own suite imports from
 * `src/cli.ts` in dozens of test files and calls `hardenBrainRepo` /
 * `runSkillpack` directly, and it runs inside an agent session -- a gate
 * reading ambient environment at the push, or inside `main()`, would fail those.
 * The same mistake in the sibling `hermes update` gate turned 7 failures into 41
 * before it was moved to the dispatch seam. So the seam is the
 * `import.meta.main` block in `src/cli.ts`, which a TYPED `gbrain ...` reaches
 * and an in-process import does not. Nothing has been parsed, connected or
 * mutated when this runs, so a refusal is inert by construction.
 *
 * NOT AN AUTHORIZATION BOUNDARY, and it cannot be one: anything that can run the
 * command can set the override. Like the hook it complements, it stops an
 * ACCIDENT.
 *
 * CODEX SESSIONS ARE NOT DETECTED. Their environment has never been measured on
 * this box, and a guessed marker that never fires is worse than a documented gap.
 *
 * THIS IS A DELIBERATE PORT of `hermes_cli/_agent_session.py`, not an import --
 * gbrain is a separate TypeScript project and cannot import that package. Same
 * markers, same presence-not-value rule, same exit code, so a session that has
 * met one recognises the other. The family: `hermes update`,
 * agent-src `scripts/release.py`, agent-src `devflow_delegation/cli.py`,
 * jobflow-platform `scripts/ops/refresh-ci-snapshot.ps1`, and this.
 */

/** Shared across the whole gate family. One number means one thing. */
export const EXIT_REFUSED_AGENT_ACTION = 30;

/**
 * Set to any non-empty value to push anyway.
 *
 * Deliberately DISTINCT from the other overrides in the family: authorizing a
 * self-update must never also authorize publishing to a skillpack registry or
 * to someone's brain repo.
 */
export const AGENT_PUSH_OVERRIDE_ENV = 'GBRAIN_ALLOW_AGENT_PUSH';

/**
 * PRESENCE, not value. `CLAUDE_CODE_DISABLE_CRON` is exported EMPTY, so a
 * truthiness test on the value would miss a real agent session.
 */
const AGENT_ENV_EXACT = ['CLAUDECODE', 'CLAUDE_AGENT_SDK_VERSION'];
const AGENT_ENV_PREFIX = 'CLAUDE_CODE_';

/**
 * Why this looks like an agent session, as zero or more human sentences.
 *
 * An EMPTY array means "no evidence", which is the only thing a caller may
 * treat as "not an agent session".
 */
export function agentSessionEvidence(env: Record<string, string | undefined> = process.env): string[] {
  const markers = Object.keys(env)
    .filter((name) => AGENT_ENV_EXACT.includes(name) || name.startsWith(AGENT_ENV_PREFIX))
    .sort();
  if (markers.length === 0) return [];
  let shown = markers.slice(0, 4).join(', ');
  if (markers.length > 4) shown += `, +${markers.length - 4} more`;
  return [`environment: ${markers.length} agent marker(s) set — ${shown}`];
}

/**
 * The publishing action this argv would perform, or null.
 *
 * Narrow on purpose -- it names the three reachable push paths and nothing
 * else. `sources add` is gated ONLY when a PAT is actually available, because
 * `hardenBrainRepo` is skipped without one (`acceptPat` returns null and the
 * caller logs "No PAT provided … skipping durability hardening"), so a plain
 * `sources add` performs no push and must not be refused.
 */
export function gatedPushAction(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): string | null {
  const args = argv.filter((a) => typeof a === 'string');
  const positional = args.filter((a) => !a.startsWith('-'));
  const [command, sub] = positional;
  if (command === 'skillpack' && sub === 'endorse' && args.includes('--push')) {
    return 'gbrain skillpack endorse --push (pushes HEAD to the registry remote)';
  }
  if (command === 'sources' && sub === 'harden') {
    return 'gbrain sources harden (commits and pushes durability scaffolding)';
  }
  if (command === 'sources' && sub === 'add' && !args.includes('--no-harden')) {
    const hasPat = args.includes('--pat-file') || (env.GBRAIN_GITHUB_PAT || '').trim() !== '';
    if (hasPat) {
      return 'gbrain sources add with a PAT (auto-hardens, which commits and pushes)';
    }
  }
  return null;
}

/** The refusal, as lines. Separated from printing so tests can read it. */
export function pushRefusalLines(action: string, evidence: string[]): string[] {
  return [
    '',
    '='.repeat(72),
    '  REFUSED: an outward-facing push from what looks like an agent session',
    '='.repeat(72),
    '',
    `  action: ${action}`,
    '',
    ...evidence.map((e) => `  * ${e}`),
    '',
    '  This push is a git subprocess INSIDE gbrain, so the machine-wide guard at',
    '  ~/.claude/hooks/block-destructive-git.py never sees it — no block, no',
    '  pending id, no grant. This gate is that missing stop.',
    '',
    '  It is NOT an authorization boundary: it stops an accident, not an intent.',
    '',
    '  To proceed deliberately, either run it yourself outside an agent session,',
    `  or set ${AGENT_PUSH_OVERRIDE_ENV}=1 for this one command.`,
    '',
    '  Read-only and local-only paths are unaffected: `skillpack endorse` without',
    '  --push still writes endorsements.json and commits, `sources add --no-harden`',
    '  still adds the source, and every other subcommand is untouched.',
    '',
  ];
}

/**
 * Refuse if this argv would push and we look like an agent session.
 *
 * Returns the exit code to use, or null to proceed. Returning rather than
 * exiting keeps it testable.
 */
export function agentPushRefusal(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): { code: number; lines: string[] } | null {
  if ((env[AGENT_PUSH_OVERRIDE_ENV] || '').trim() !== '') return null;
  const action = gatedPushAction(argv, env);
  if (!action) return null;
  const evidence = agentSessionEvidence(env);
  if (evidence.length === 0) return null;
  return { code: EXIT_REFUSED_AGENT_ACTION, lines: pushRefusalLines(action, evidence) };
}
