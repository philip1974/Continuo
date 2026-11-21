// 6 个 spec 共用的 TerminalSession 工厂。
// dock-reconciler-windowid-filter 的 5 spec + agent-create-as-new-panel 1 spec。
//
// 调用模式:
//   makeSession('A')                              // ownerWindowId=1 默认
//   makeSession('A', { ownerWindowId: 2 })
//   makeSession('A', { originHint: 'agent', createdAt: 5 })

import type { TerminalSession } from '../../stores/terminal.store';

export function makeSession(
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
    ...overrides,
  };
}
