import { describe, expect, it } from 'vitest';
import { filterByOwnerWindow } from '../../stores/terminal.store';
import { makeSession } from './fixtures';

describe('dock-reconciler-windowid-filter: INV-2 renderer defense', () => {
  it('T15 prev=[A:o1] next=[A:o2] -> filter 后 prev=[A] next=[] -> A 标 removed', () => {
    const prev = filterByOwnerWindow([makeSession('A')], 1);
    const next = filterByOwnerWindow([makeSession('A', { ownerWindowId: 2 })], 1);
    const removed = prev.filter((s) => !next.some((n) => n.id === s.id));
    expect(prev.map((s) => s.id)).toEqual(['A']);
    expect(next).toEqual([]);
    expect(removed.map((s) => s.id)).toEqual(['A']);
  });
});
