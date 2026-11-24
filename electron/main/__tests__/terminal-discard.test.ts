import { describe, expect, it, vi } from 'vitest';
import { discardTerminalSession } from '../services/terminal-discard';

function deps(has = true) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      sessionStore: { remove: vi.fn((id: string) => calls.push(`remove:${id}`)) },
      service: {
        has: vi.fn(() => has),
        kill: vi.fn((id: string) => calls.push(`kill:${id}`)),
        forceKill: vi.fn((id: string) => calls.push(`forceKill:${id}`)),
      },
    },
  };
}

describe('discardTerminalSession', () => {
  it('先删会话元数据再杀 PTY;force=false → kill(grace)', () => {
    const { d, calls } = deps();
    discardTerminalSession(d, 't1', { force: false });
    expect(calls).toEqual(['remove:t1', 'kill:t1']);
  });

  it('force=true → forceKill(立即 SIGKILL)', () => {
    const { d, calls } = deps();
    discardTerminalSession(d, 't2', { force: true });
    expect(calls).toEqual(['remove:t2', 'forceKill:t2']);
  });

  it('PTY 已不存在 → 只删元数据,不调 kill', () => {
    const { d, calls } = deps(false);
    discardTerminalSession(d, 't3', { force: true });
    expect(calls).toEqual(['remove:t3']);
  });
});
