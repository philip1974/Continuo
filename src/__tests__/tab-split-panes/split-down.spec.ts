import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addPanel: vi.fn(),
  create: vi.fn(),
  activeGroup: {
    activePanel: { params: { sessionId: 'term-active' } },
  },
}));

vi.mock('../../shell/dock/dock-api-ref', () => ({
  getDockApi: () => ({
    activeGroup: mocks.activeGroup,
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
      sessions: [{ id: 'term-active', cwd: '/repo' }],
    }),
  },
}));

vi.mock('../../lib/popout-mode', () => ({ isPopoutWindow: () => false }));

describe('tab split panes - split down', () => {
  beforeEach(() => {
    mocks.addPanel.mockReset();
    mocks.create.mockReset().mockResolvedValue({
      ok: true,
      data: { id: 'term-down', title: 'Terminal 3' },
    });
  });

  it('creates a scoped terminal and adds it below the active group', async () => {
    const { splitTerminal } = await import('../../lib/split-terminal');

    await splitTerminal('below');

    expect(mocks.create).toHaveBeenCalledWith({ cwd: '/repo', scoped: true });
    expect(mocks.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'terminal-term-down',
        position: expect.objectContaining({
          referenceGroup: mocks.activeGroup,
          direction: 'below',
        }),
      }),
    );
  });
});
