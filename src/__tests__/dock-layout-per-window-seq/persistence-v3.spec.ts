import { describe, it } from 'vitest';

describe('explorer.json v3 persistence schema and merge semantics', () => {
  it.todo('T1: v3 schema stores per-window entries keyed by windowSeq');
  it.todo('T2: legacy explorer roots migrate into the current window entry');
  it.todo('T3: legacy layout payload migrates into the v3 layout section');
  it.todo('T4: v3 migration is idempotent');
  it.todo('T5: corrupt optional layout data falls back without losing explorer roots');
  it.todo('T6: unknown fields survive read/write roundtrips');
  it.todo('T7: LRU metadata is bounded and deterministic');
  it.todo('T11: migration covers empty, v2-only, layout-only, and mixed explorer files');
  it.todo('T15: ensureWindowEntry creates missing entries without replacing existing data');
  it.todo('T22: writable merge rejects stale or foreign windowSeq writes');
  it.todo('T23: renderer writes preserve main-owned fields');
  it.todo('T24: writable merge preserves unknown future fields');
  it.todo('T26: mergeWritableIntoFull updates only the current-window writable segment');

  it('T1-T7/T11/T15/T22-T24/T26: roundtrips v3 data without cross-window leakage', () => {
    throw new Error('not implemented (BDD red)');
  });
});
