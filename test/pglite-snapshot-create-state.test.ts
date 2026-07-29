import { describe, expect, test } from 'bun:test';
import {
  acquirePgliteConnectLock,
  createPgliteWithSnapshotFallback,
} from '../src/core/pglite-engine.ts';

type CreateOptions = { dataDir?: string; loadDataDir?: Blob };
type FakeDb = { attempt: number };

function stateRecorder(initial = true): {
  set: (loaded: boolean) => void;
  get: () => boolean;
  transitions: boolean[];
} {
  let loaded = initial;
  const transitions: boolean[] = [];
  return {
    set(next) {
      loaded = next;
      transitions.push(next);
    },
    get: () => loaded,
    transitions,
  };
}

describe('acquirePgliteConnectLock snapshot state', () => {
  test('clears loaded before lock acquisition even when acquisition fails', async () => {
    const state = stateRecorder();
    const failure = new Error('lock unavailable');
    let stateDuringAcquire: boolean | undefined;

    await expect(
      acquirePgliteConnectLock(
        async () => {
          stateDuringAcquire = state.get();
          throw failure;
        },
        '/brain',
        state.set,
      ),
    ).rejects.toBe(failure);

    expect(stateDuringAcquire).toBe(false);
    expect(state.get()).toBe(false);
    expect(state.transitions).toEqual([false]);
  });
});

describe('createPgliteWithSnapshotFallback snapshot state', () => {
  test('marks loaded only after snapshot-backed create succeeds', async () => {
    const state = stateRecorder();
    const snapshot = new Blob(['snapshot']);
    let stateDuringCreate: boolean | undefined;

    const db = await createPgliteWithSnapshotFallback<CreateOptions, FakeDb>(
      async (options) => {
        expect(options.loadDataDir).toBe(snapshot);
        stateDuringCreate = state.get();
        return { attempt: 1 };
      },
      { dataDir: '/fresh', loadDataDir: snapshot },
      state.set,
    );

    expect(db).toEqual({ attempt: 1 });
    expect(stateDuringCreate).toBe(false);
    expect(state.get()).toBe(true);
    expect(state.transitions).toEqual([false, true]);
  });

  test('leaves loaded false after a non-race first-create failure', async () => {
    const state = stateRecorder();
    const failure = new Error('unrelated create failure');
    let attempts = 0;

    await expect(
      createPgliteWithSnapshotFallback<CreateOptions, FakeDb>(
        async () => {
          attempts += 1;
          throw failure;
        },
        { dataDir: '/fresh', loadDataDir: new Blob(['snapshot']) },
        state.set,
      ),
    ).rejects.toBe(failure);

    expect(attempts).toBe(1);
    expect(state.get()).toBe(false);
    expect(state.transitions).toEqual([false, false]);
  });

  test('retries only the exact populated-dataDir failure and stays false', async () => {
    const state = stateRecorder();
    const snapshot = new Blob(['snapshot']);
    const seen: CreateOptions[] = [];

    const db = await createPgliteWithSnapshotFallback<CreateOptions, FakeDb>(
      async (options) => {
        seen.push(options);
        if (seen.length === 1) {
          throw new Error('Database already exists, cannot load from tarball');
        }
        return { attempt: 2 };
      },
      { dataDir: '/raced', loadDataDir: snapshot },
      state.set,
    );

    expect(db).toEqual({ attempt: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.loadDataDir).toBe(snapshot);
    expect(seen[1]?.loadDataDir).toBeUndefined();
    expect(state.get()).toBe(false);
    expect(state.transitions).toEqual([false, false]);
  });

  test('leaves loaded false when the populated-dataDir retry fails', async () => {
    const state = stateRecorder();
    const retryFailure = new Error('retry create failed');
    let attempts = 0;

    await expect(
      createPgliteWithSnapshotFallback<CreateOptions, FakeDb>(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('Database already exists, cannot load from tarball');
          }
          throw retryFailure;
        },
        { dataDir: '/raced', loadDataDir: new Blob(['snapshot']) },
        state.set,
      ),
    ).rejects.toBe(retryFailure);

    expect(attempts).toBe(2);
    expect(state.get()).toBe(false);
    expect(state.transitions).toEqual([false, false, false]);
  });
});
