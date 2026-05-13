import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addPanel: vi.fn(),
  create: vi.fn(),
  activeGroup: {
    id: 'group-nested',
    activePanel: { params: { sessionId: 'term-nested' } },
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
      activeId: 'term-nested',
      sessions: [{ id: 'term-nested', cwd: '/repo/nested' }],
    }),
  },
}));

vi.mock('../../lib/popout-mode', () => ({ isPopoutWindow: () => false }));

describe('tab split panes - nested split', () => {
  beforeEach(() => {
    mocks.addPanel.mockReset();
    mocks.create.mockReset().mockResolvedValue({
      ok: true,
      data: { id: 'term-child', title: 'Terminal child' },
    });
  });

  it('uses the currently active nested group as the split reference group', async () => {
    const { splitTerminal } = await import('../../lib/split-terminal');

    await splitTerminal('right');

    expect(mocks.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        position: expect.objectContaining({ referenceGroup: mocks.activeGroup }),
      }),
    );
  });
});
