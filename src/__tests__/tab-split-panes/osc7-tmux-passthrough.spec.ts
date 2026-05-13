// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  oscHandler: null as null | ((data: string) => boolean),
  updateCwd: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    parser = {
      registerOscHandler: vi.fn((code: number, handler: (data: string) => boolean) => {
        if (code === 7) mocks.oscHandler = handler;
        return { dispose: vi.fn() };
      }),
    };
    loadAddon() {}
    open() {}
    onData() { return { dispose: vi.fn() }; }
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn(),
      updateCwd: mocks.updateCwd,
      onData: vi.fn(() => vi.fn()),
      write: vi.fn(),
    },
  },
}));
vi.mock('../../plugins/settings/values-store', () => ({ useSettingValue: (_: string, fallback: unknown) => fallback }));
vi.mock('../../stores/layout-ui.store', () => ({ useLayoutUiStore: () => false }));
vi.mock('../../theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';

function Harness() {
  const { containerRef } = useTerminal('term-tmux');
  return React.createElement('div', { ref: containerRef });
}

describe('tab split panes - OSC 7 tmux passthrough', () => {
  beforeEach(() => {
    mocks.oscHandler = null;
    mocks.updateCwd.mockReset();
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it('accepts OSC 7 payloads after xterm unwraps tmux passthrough', async () => {
    render(React.createElement(Harness));

    await waitFor(() => expect(mocks.oscHandler).toEqual(expect.any(Function)));
    mocks.oscHandler?.('file:///tmp/from-tmux');

    expect(mocks.updateCwd).toHaveBeenCalledWith('term-tmux', '/tmp/from-tmux');
  });
});
