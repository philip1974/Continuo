import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  addPanel: vi.fn(),
}));

vi.mock('../../shell/dock/dock-api-ref', () => ({
  getDockApi: () => ({
    activeGroup: {
      activePanel: { params: { sessionId: 'term-active' } },
    },
    addPanel: mocks.addPanel,
  }),
}));

vi.mock('../../lib/co-api', () => ({
  coApi: { terminal: { create: mocks.create } },
}));

vi.mock('../../stores/terminal.store', () => ({
  useTerminalStore: {
    getState: () => ({
      activeId: 'term-active',
      sessions: [
        { id: 'term-other', cwd: '/wrong' },
        { id: 'term-active', cwd: '/repo/packages/web' },
      ],
    }),
  },
}));

vi.mock('../../lib/popout-mode', () => ({ isPopoutWindow: () => false }));

describe('tab split panes - cwd inherit', () => {
  beforeEach(() => {
    mocks.addPanel.mockReset();
    mocks.create.mockReset().mockResolvedValue({
      ok: true,
      data: { id: 'term-new', title: 'Terminal 4' },
    });
  });

  it('inherits cwd from the active terminal session when splitting', async () => {
    const { splitTerminal } = await import('../../lib/split-terminal');

    await splitTerminal('right');

    expect(mocks.create).toHaveBeenCalledWith({
      cwd: '/repo/packages/web',
      scoped: true,
    });
  });
});
