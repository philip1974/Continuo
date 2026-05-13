import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addPanel: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../lib/popout-mode', () => ({ isPopoutWindow: () => true }));
vi.mock('../../shell/dock/dock-api-ref', () => ({
  getDockApi: () => ({ activeGroup: {}, addPanel: mocks.addPanel }),
}));
vi.mock('../../lib/co-api', () => ({ coApi: { terminal: { create: mocks.create } } }));
vi.mock('../../stores/terminal.store', () => ({
  useTerminalStore: { getState: () => ({ activeId: null, sessions: [] }) },
}));

describe('tab split panes - popout disabled', () => {
  beforeEach(() => {
    mocks.addPanel.mockReset();
    mocks.create.mockReset();
  });

  it('does not split or create terminals inside popout windows', async () => {
    const { splitTerminal } = await import('../../lib/split-terminal');

    await splitTerminal('right');

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.addPanel).not.toHaveBeenCalled();
  });
});
