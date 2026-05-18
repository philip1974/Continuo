// topic-19 P0-2: useDockLocaleSync — locale 变化时遍历 dockApi.panels
// 调 setTitle(tWithFallback(panel.params.titleKey, panel.api.title)).

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import { useDockLocaleSync } from '@/shell/dock/useDockLocaleSync';
import { setLocale } from '@/i18n/translate';
import { notifyLocaleChange } from '@/i18n/react';

interface FakePanel {
  readonly api: {
    readonly id: string;
    title: string;
    setTitle: ReturnType<typeof vi.fn>;
  };
  readonly params: { titleKey?: string } | undefined;
}

function makeApi(panels: FakePanel[]): DockviewApi {
  return {
    panels,
    onDidAddPanel: vi.fn(() => ({ dispose: () => undefined })),
  } as unknown as DockviewApi;
}

afterEach(() => {
  setLocale('zh');
});

describe('useDockLocaleSync', () => {
  it('mount 时立即遍历 panels + 命中 titleKey 的 setTitle', () => {
    setLocale('zh');
    const setTitle = vi.fn();
    const panel: FakePanel = {
      api: { id: 'p1', title: 'Terminal', setTitle },
      params: { titleKey: 'panels.terminal.title' },
    };
    const api = makeApi([panel]);

    renderHook(() => useDockLocaleSync(api));

    expect(setTitle).toHaveBeenCalledWith('终端');
  });

  it('panel 无 titleKey → 不调 setTitle', () => {
    const setTitle = vi.fn();
    const panel: FakePanel = {
      api: { id: 'p1', title: 'Dynamic Title', setTitle },
      params: undefined,
    };
    const api = makeApi([panel]);

    renderHook(() => useDockLocaleSync(api));

    expect(setTitle).not.toHaveBeenCalled();
  });

  it('locale 切换后再次同步 panels title', () => {
    setLocale('zh');
    const setTitle = vi.fn();
    const panel: FakePanel = {
      api: { id: 'p1', title: '终端', setTitle },
      params: { titleKey: 'panels.terminal.title' },
    };
    const api = makeApi([panel]);

    renderHook(() => useDockLocaleSync(api));
    setTitle.mockClear();

    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });

    expect(setTitle).toHaveBeenCalledWith('터미널');
  });

  it('api=null → no-op', () => {
    expect(() => renderHook(() => useDockLocaleSync(null))).not.toThrow();
  });
});
