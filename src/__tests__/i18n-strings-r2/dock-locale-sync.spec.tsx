// topic-19 P0-2: useDockLocaleSync — locale 变化时遍历 dockApi.panels
// 调 setTitle(tWithFallback(panel.params.titleKey, panel.api.title)).

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import { useDockLocaleSync } from '@/shell/dock/useDockLocaleSync';
import { setLocale } from '@/i18n/translate';
import { notifyLocaleChange } from '@/i18n/react';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

interface FakePanel {
  readonly api: {
    readonly id: string;
    title: string;
    setTitle: ReturnType<typeof vi.fn>;
    location?: { type: 'grid' | 'floating' | 'popout' };
    group?: { id: string };
  };
  readonly params: { titleKey?: string } | undefined;
}

type Listener = () => void;
const layoutListeners = new Set<Listener>();

function makeApi(panels: FakePanel[]): DockviewApi {
  const on = vi.fn((l: Listener) => {
    layoutListeners.add(l);
    return { dispose: () => layoutListeners.delete(l) };
  });
  return {
    panels,
    onDidAddPanel: on,
    onDidLayoutChange: on,
  } as unknown as DockviewApi;
}

afterEach(() => {
  setLocale('zh');
  layoutListeners.clear();
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

  // 编辑器组面板标题「编辑器 N」的 N = 该组在所在窗口里的空间位置(网格从左到右、从上到下,同 ⌘1/⌘2/⌘3 的计数口径),
  // 第一位不带号;不是组 id 里的号码(id 复用最小空号,关掉中间组再拆分后 id 与位置不一致)。对齐 VSCode EditorGroupView
  //「Group N」按 GRID_APPEARANCE 位置编号、增删组后重新编号。真实 dockview。BDD: src/__tests__/editor-groups/
  describe('编辑器组标题编号(真实 dockview)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      document.body.innerHTML = '';
    });
    const EDITOR = { component: 'editor', title: 'Editor', params: { titleKey: 'panels.editor.title' } } as const;
    const title = (api: DockviewApi, id: string) => api.getPanel(id)!.api.title;

    it('标题号码按位置,不按组 id:editor | editor:3 | editor:2 → 编辑器 / 编辑器 2 / 编辑器 3;随 locale 切换', () => {
      setLocale('zh');
      const api = createDock().api as DockviewApi;
      api.addPanel({ id: 'editor', ...EDITOR });
      api.addPanel({ id: 'editor:3', ...EDITOR, position: { referencePanel: 'editor', direction: 'right' } });
      api.addPanel({ id: 'editor:2', ...EDITOR, position: { referencePanel: 'editor:3', direction: 'right' } });
      renderHook(() => useDockLocaleSync(api));
      const ids = ['editor', 'editor:3', 'editor:2'];
      expect(ids.map((id) => title(api, id))).toEqual(['编辑器', '编辑器 2', '编辑器 3']);
      act(() => {
        setLocale('en');
        notifyLocaleChange();
      });
      expect(ids.map((id) => title(api, id))).toEqual(['Editor', 'Editor 2', 'Editor 3']);
      act(() => {
        setLocale('ko');
        notifyLocaleChange();
      });
      expect(ids.map((id) => title(api, id))).toEqual(['편집기', '편집기 2', '편집기 3']);
    });

    it('关掉一个组 → 其余按位置重新编号;第一个组不一定是 editor', async () => {
      setLocale('zh');
      const api = createDock().api as DockviewApi;
      api.addPanel({ id: 'editor', ...EDITOR });
      api.addPanel({ id: 'editor:2', ...EDITOR, position: { referencePanel: 'editor', direction: 'right' } });
      api.addPanel({ id: 'editor:3', ...EDITOR, position: { referencePanel: 'editor:2', direction: 'right' } });
      renderHook(() => useDockLocaleSync(api));
      await act(async () => api.getPanel('editor')!.api.close());
      expect([title(api, 'editor:2'), title(api, 'editor:3')]).toEqual(['编辑器', '编辑器 2']);
    });

    it('popout 子窗里的组按该子窗自己的组编号(⌘1/2/3 只数主窗),浮动组排在主窗网格之后;收回主窗后重算', async () => {
      setLocale('zh');
      const dock = createDock();
      const api = dock.api as DockviewApi;
      api.addPanel({ id: 'editor', ...EDITOR });
      api.addPanel({ id: 'editor:2', ...EDITOR, position: { referencePanel: 'editor', direction: 'right' } });
      api.addPanel({ id: 'editor:4', ...EDITOR, position: { referencePanel: 'editor:2', direction: 'right' } });
      api.addPanel({ id: 'editor:3', ...EDITOR, floating: true });
      renderHook(() => useDockLocaleSync(api));
      await openFakePopout(dock, 'editor:2');
      // editor:4 拖进子窗(与 editor:2 叠在子窗的 dock 组里)
      await act(async () => {
        api.getPanel('editor:4')!.api.moveTo({ group: api.getPanel('editor:2')!.group, position: 'center' });
      });
      const ids = ['editor', 'editor:2', 'editor:3', 'editor:4'];
      expect(ids.map((id) => title(api, id))).toEqual(['编辑器', '编辑器', '编辑器 2', '编辑器 2']);
      // editor:4 收回主窗(拖到主编辑器组右侧)
      await act(async () => {
        api.getPanel('editor:4')!.api.moveTo({ group: api.getPanel('editor')!.group, position: 'right' });
      });
      expect(ids.map((id) => title(api, id))).toEqual(['编辑器', '编辑器', '编辑器 3', '编辑器 2']);
    });
  });

  it('api=null → no-op', () => {
    expect(() => renderHook(() => useDockLocaleSync(null))).not.toThrow();
  });
});
