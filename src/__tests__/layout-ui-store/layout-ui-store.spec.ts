import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';

beforeEach(() => {
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
});

describe('layout-ui.store', () => {
  it('setSidebarOpen 写入相同值时不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = useLayoutUiStore.subscribe(listener);

    try {
      useLayoutUiStore.getState().setSidebarOpen(true);

      expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('setSidebarWidth 写入相同值时不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = useLayoutUiStore.subscribe(listener);

    try {
      useLayoutUiStore.getState().setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);

      expect(useLayoutUiStore.getState().sidebarWidth).toBe(
        SIDEBAR_DEFAULT_WIDTH,
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
