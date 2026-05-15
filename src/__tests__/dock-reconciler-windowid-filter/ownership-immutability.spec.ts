import { describe, expect, it } from 'vitest';
import {
  filterByOwnerWindow,
  nextActiveAfterClose,
  type TerminalSession,
} from '../../stores/terminal.store';

function session(id: string, ownerWindowId: number): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId,
  };
}

describe('dock-reconciler-windowid-filter: INV-2 renderer defense', () => {
  it('T15 prev=[A:o1] next=[A:o2] -> filter 后 prev=[A] next=[] -> A 标 removed', () => {
    const prev = filterByOwnerWindow([session('A', 1)], 1);
    const next = filterByOwnerWindow([session('A', 2)], 1);
    const removed = prev.filter((s) => !next.some((n) => n.id === s.id));
    const closeResult = nextActiveAfterClose(prev, 'A', removed[0]!.id);
    expect(prev.map((s) => s.id)).toEqual(['A']);
    expect(next).toEqual([]);
    expect(removed.map((s) => s.id)).toEqual(['A']);
    expect(closeResult).toEqual({ sessions: [], activeId: null });
  });
});
