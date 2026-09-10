/**
 * The agent push gate.
 *
 * gbrain performs a real `git push` from three command shapes, each via
 * `execFileSync` INSIDE this package, so the machine-wide guard at
 * ~/.claude/hooks/block-destructive-git.py cannot see a git verb in the ARGV an
 * agent runs. These tests pin the gate that closes it.
 *
 * The most important group is NEGATIVE: this gate must not touch the read-only
 * and local-only paths, and it must not fire on a plain `sources add`.
 */
import { describe, expect, test } from 'bun:test';
import {
  AGENT_PUSH_OVERRIDE_ENV,
  EXIT_REFUSED_AGENT_ACTION,
  agentPushRefusal,
  agentSessionEvidence,
  gatedPushAction,
  pushRefusalLines,
} from '../src/core/agent-session.ts';

/** An environment that looks like an agent session. */
const AGENT = { CLAUDECODE: '1' };
/** One that does not. Deliberately holds a CLAUDE-ish name that must NOT match. */
const HUMAN = { PATH: '/usr/bin', CLAUDE_UNRELATED: '1', SHELL: '/bin/bash' };

describe('agentSessionEvidence', () => {
  test('an empty environment yields NO evidence', () => {
    expect(agentSessionEvidence({})).toEqual([]);
  });

  test('presence, not value — an EMPTY marker still counts', () => {
    // CLAUDE_CODE_DISABLE_CRON is exported EMPTY on this box. A truthiness test
    // on the value would miss a real agent session; that is the whole reason
    // this is a key-presence check.
    expect(agentSessionEvidence({ CLAUDE_CODE_DISABLE_CRON: '' })).toHaveLength(1);
  });

  test('both exact markers and the prefix are recognised', () => {
    expect(agentSessionEvidence({ CLAUDECODE: '1' })).toHaveLength(1);
    expect(agentSessionEvidence({ CLAUDE_AGENT_SDK_VERSION: '0.1' })).toHaveLength(1);
    expect(agentSessionEvidence({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toHaveLength(1);
  });

  test('a CLAUDE-ish name that is not a marker does NOT count', () => {
    expect(agentSessionEvidence(HUMAN)).toEqual([]);
  });
});

describe('gatedPushAction — the three shapes that actually push', () => {
  test('skillpack endorse --push', () => {
    expect(gatedPushAction(['skillpack', 'endorse', 'my-pack', '--push'], {})).toBeTruthy();
  });

  test('sources harden', () => {
    expect(gatedPushAction(['sources', 'harden', 'brain', '--pat-file', 'p'], {})).toBeTruthy();
  });

  test('sources add WITH a --pat-file auto-hardens, which pushes', () => {
    expect(gatedPushAction(['sources', 'add', 'x', '--pat-file', 'p'], {})).toBeTruthy();
  });

  test('sources add with the PAT in the ENVIRONMENT also auto-hardens', () => {
    expect(gatedPushAction(['sources', 'add', 'x'], { GBRAIN_GITHUB_PAT: 'ghp_x' })).toBeTruthy();
  });
});

describe('gatedPushAction — what must NOT be gated', () => {
  test('skillpack endorse WITHOUT --push only writes and commits locally', () => {
    expect(gatedPushAction(['skillpack', 'endorse', 'my-pack'], {})).toBeNull();
  });

  test('a plain sources add performs NO push — acceptPat returns null and hardening is skipped', () => {
    expect(gatedPushAction(['sources', 'add', 'x', '--url', 'https://e/r'], {})).toBeNull();
  });

  test('--no-harden opts out even with a PAT', () => {
    expect(gatedPushAction(['sources', 'add', 'x', '--pat-file', 'p', '--no-harden'], {})).toBeNull();
  });

  test('an empty GBRAIN_GITHUB_PAT is not a PAT', () => {
    expect(gatedPushAction(['sources', 'add', 'x'], { GBRAIN_GITHUB_PAT: '   ' })).toBeNull();
  });

  test('reads and every other command are untouched', () => {
    for (const argv of [
      ['skillpack', 'search', 'x'],
      ['skillpack', 'check'],
      ['sources', 'list'],
      ['sources', 'pull', '--path', '/x'],
      ['query', 'something'],
      ['serve', '--http'],
      ['doctor'],
      [],
    ]) {
      expect(gatedPushAction(argv, {})).toBeNull();
    }
  });

  test('the subcommand is read from POSITIONALS, so a flag value cannot fake it', () => {
    // `--tier endorse` must not read as the `endorse` subcommand.
    expect(gatedPushAction(['skillpack', 'search', '--tier', 'endorse', '--push'], {})).toBeNull();
  });
});

describe('agentPushRefusal — the two conditions must BOTH hold', () => {
  test('a pushing command from an agent session refuses with the family exit code', () => {
    const r = agentPushRefusal(['skillpack', 'endorse', 'p', '--push'], AGENT);
    expect(r).not.toBeNull();
    expect(r!.code).toBe(EXIT_REFUSED_AGENT_ACTION);
    expect(r!.code).toBe(30);
  });

  test('the SAME command from a human session proceeds', () => {
    expect(agentPushRefusal(['skillpack', 'endorse', 'p', '--push'], HUMAN)).toBeNull();
  });

  test('a NON-pushing command from an agent session proceeds', () => {
    expect(agentPushRefusal(['skillpack', 'endorse', 'p'], AGENT)).toBeNull();
    expect(agentPushRefusal(['sources', 'list'], AGENT)).toBeNull();
  });

  test('the override lifts it, and it is DISTINCT from the rest of the family', () => {
    const env = { ...AGENT, [AGENT_PUSH_OVERRIDE_ENV]: '1' };
    expect(agentPushRefusal(['sources', 'harden', 'b'], env)).toBeNull();
    // authorizing a sibling tool's self-update must NOT authorize a gbrain push
    const wrong = { ...AGENT, HERMES_ALLOW_AGENT_UPDATE: '1' };
    expect(agentPushRefusal(['sources', 'harden', 'b'], wrong)).not.toBeNull();
    expect(AGENT_PUSH_OVERRIDE_ENV).toBe('GBRAIN_ALLOW_AGENT_PUSH');
  });

  test('an EMPTY override is not an override', () => {
    const env = { ...AGENT, [AGENT_PUSH_OVERRIDE_ENV]: '  ' };
    expect(agentPushRefusal(['sources', 'harden', 'b'], env)).not.toBeNull();
  });
});

describe('the refusal text', () => {
  test('names the action, the evidence, the override and the escape', () => {
    const r = agentPushRefusal(['sources', 'harden', 'b'], AGENT)!;
    const text = r.lines.join('\n');
    expect(text).toContain('REFUSED');
    expect(text).toContain('sources harden');
    expect(text).toContain('CLAUDECODE');
    expect(text).toContain(AGENT_PUSH_OVERRIDE_ENV);
    // it must NOT overclaim: this stops an accident, not an intent
    expect(text).toContain('NOT an authorization boundary');
  });

  test('pushRefusalLines is pure so the text can be asserted without an env', () => {
    expect(pushRefusalLines('an action', ['some evidence']).join('\n')).toContain('an action');
  });
});
