// topic-19 P0-2: useDockLocaleSync — locale 变化时遍历 dockApi.panels
// 调 setTitle(tWithFallback(panel.params.titleKey, panel.api.title)).

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
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

afterEach(cleanup);

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

  // 编辑器组面板(editor / editor:N)可能叠在同一 dock 组里(popout / 浮动组里拆分、拖进同组):第二个起标题带编号可区分
  // (BDD: src/__tests__/editor-groups/ 适配点「dock 面板标题」)
  it('编辑器组面板 editor:N → 「编辑器 N」;第一个组 editor 仍是「编辑器」;随 locale 切换', () => {
    setLocale('zh');
    const first = vi.fn();
    const second = vi.fn();
    const api = makeApi([
      { api: { id: 'editor', title: 'Editor', setTitle: first }, params: { titleKey: 'panels.editor.title' } },
      { api: { id: 'editor:2', title: 'Editor', setTitle: second }, params: { titleKey: 'panels.editor.title' } },
    ]);
    renderHook(() => useDockLocaleSync(api));
    expect(first).toHaveBeenLastCalledWith('编辑器');
    expect(second).toHaveBeenLastCalledWith('编辑器 2');
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    expect(second).toHaveBeenLastCalledWith('Editor 2');
    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });
    expect(second).toHaveBeenLastCalledWith('편집기 2');
  });

  it('api=null → no-op', () => {
    expect(() => renderHook(() => useDockLocaleSync(null))).not.toThrow();
  });
});
