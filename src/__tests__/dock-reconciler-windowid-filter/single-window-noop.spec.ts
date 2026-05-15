import { describe, expect, it } from 'vitest';
import {
  filterByOwnerWindow,
  type TerminalSession,
} from '../../stores/terminal.store';

function session(id: string): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
  };
}

describe('dock-reconciler-windowid-filter: single-window noop', () => {
  it('T19 全 ownerWindowId === currentWindowId -> filterByOwnerWindow(s, w) 深 equal s(identity 等价)', () => {
    const a = session('A');
    const b = session('B');
    const sessions = [a, b] as const;
    const filtered = filterByOwnerWindow(sessions, 1);
    expect(filtered).toEqual(sessions);
    expect(filtered[0]).toBe(a);
    expect(filtered[1]).toBe(b);
  });
});
