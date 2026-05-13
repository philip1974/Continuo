// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';
import { useClosingStore } from '../../stores/closing.store';

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('../../lib/co-api', () => ({
  coApi: {
    terminal: {
      remove: mocks.remove,
      kill: mocks.kill,
    },
  },
}));

import { wrapPanelClose } from '../../shell/dock/wrap-panel-close';

describe('tab split panes - panel close via wrap-panel-close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.remove.mockReset().mockResolvedValue({ ok: true });
    mocks.kill.mockReset();
    useClosingStore.setState({ ids: new Set() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes scoped terminal sessions before running the delayed panel close', () => {
    const realClose = vi.fn();
    const panel = {
      params: { sessionId: 'term-scoped' },
      api: {
        id: 'terminal-term-scoped',
        close: realClose,
      },
    };

    wrapPanelClose(panel as never);
    panel.api.close();

    expect(mocks.remove).toHaveBeenCalledWith('term-scoped');
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(realClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(realClose).toHaveBeenCalledTimes(1);
  });
});
