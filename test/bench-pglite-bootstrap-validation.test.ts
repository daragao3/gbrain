import { describe, expect, test } from 'bun:test';
import {
  canonicalMigrationHead,
  invalidBenchmarkReps,
  type BenchmarkRep,
} from '../scripts/bench-pglite-bootstrap.ts';

describe('PGLite bootstrap benchmark validation', () => {
  const validRep = (head: number): BenchmarkRep => ({
    arm: 'cold',
    ms: 1,
    bunProcs: 1,
    exit: 0,
    head,
    headExit: 0,
  });

  test('derives the canonical head from the maximum migration version', () => {
    expect(canonicalMigrationHead([
      { version: 5 },
      { version: 2 },
      { version: 9 },
    ])).toBe(9);
  });

  test('rejects agreeing repetitions when their head is not canonical', () => {
    expect(invalidBenchmarkReps([validRep(8), validRep(8)], 9)).toHaveLength(2);
  });

  test('accepts repetitions only when each reaches the canonical head', () => {
    expect(invalidBenchmarkReps([validRep(9), validRep(9)], 9)).toEqual([]);
  });
});
