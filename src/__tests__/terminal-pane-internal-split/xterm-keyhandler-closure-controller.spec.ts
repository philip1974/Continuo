import { describe, expect, it, vi } from 'vitest';
import {
  handlePaneSplitKeyDown,
  type PaneKeyOptions,
} from '../../panels/Terminal/useTerminal';

describe('terminal pane internal split - xterm keyhandler closure controller', () => {
  it('focuses the owning leaf before mod+backslash splits', () => {
    const dispatch = vi.fn();
    const split = vi.fn();
    const opts: PaneKeyOptions = { panelId: 'panel-1', tabId: 'tab-1', leafId: 'leaf-2' };
    const event = {
      type: 'keydown',
      metaKey: true,
      shiftKey: false,
      key: '\\',
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    const handled = handlePaneSplitKeyDown(event, opts, {
      dispatch,
      split,
      focusPrev: vi.fn(),
      focusNext: vi.fn(),
    });

    expect(handled).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'FOCUS_LEAF', leafId: 'leaf-2' },
    });
    expect(split).toHaveBeenCalledWith('horizontal');
  });

  it('uses mod+shift+backslash for vertical split and bracket keys for focus navigation', () => {
    const dispatch = vi.fn();
    const split = vi.fn();
    const focusNext = vi.fn();
    const opts: PaneKeyOptions = { panelId: 'panel-1', tabId: 'tab-1', leafId: 'leaf-2' };

    expect(
      handlePaneSplitKeyDown(
        {
          type: 'keydown',
          metaKey: true,
          shiftKey: true,
          key: '\\',
          preventDefault: vi.fn(),
        } as unknown as KeyboardEvent,
        opts,
        { dispatch, split, focusPrev: vi.fn(), focusNext },
      ),
    ).toBe(false);
    expect(split).toHaveBeenCalledWith('vertical');

    expect(
      handlePaneSplitKeyDown(
        {
          type: 'keydown',
          metaKey: true,
          key: ']',
          preventDefault: vi.fn(),
        } as unknown as KeyboardEvent,
        opts,
        { dispatch, split, focusPrev: vi.fn(), focusNext },
      ),
    ).toBe(false);
    expect(focusNext).toHaveBeenCalled();
  });
});
