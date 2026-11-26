// topic-19 P0-2: useDockLocaleSync — locale 变化时遍历 dockApi.panels
// 调 setTitle(tWithFallback(panel.params.titleKey, panel.api.title)).

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import { useDockLocaleSync } from '@/shell/dock/useDockLocaleSync';
import { setLocale } from '@/i18n/translate';
import { notifyLocaleChange } from '@/i18n/react';
import { useEditorStore } from '@/stores/editor.store';

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

/** 编辑器组面板:setTitle 真改 title(同 dockview)。 */
function editorPanel(id: string, where: 'grid' | 'floating' | 'popout' = 'grid', groupId = 'g-main'): FakePanel {
  const api: FakePanel['api'] = {
    id,
    title: 'Editor',
    setTitle: vi.fn((t: string) => {
      api.title = t;
    }),
    location: { type: where },
    group: { id: groupId },
  };
  return { api, params: { titleKey: 'panels.editor.title' } };
}

function setGroupOrder(ids: string[]) {
  useEditorStore.setState({ groups: ids.map((id) => ({ id, tabIds: [], activeTabId: null })) });
}

const titles = (panels: FakePanel[]) => panels.map((p) => p.api.title);

afterEach(() => {
  setLocale('zh');
  setGroupOrder(['editor']);
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

  // 编辑器组面板标题「编辑器 N」的 N = 该组在编辑器组顺序里的位置(同 ⌘1/⌘2/⌘3 的计数口径),第一位不带号;不是组 id
  // 里的号码(id 复用最小空号,关掉中间组再拆分后 id 与位置不一致)。对齐 VSCode EditorGroupView「Group N」按位置编号、
  // 增删组后重新编号(notifyIndexChanged)。BDD: src/__tests__/editor-groups/ 适配点「dock 面板标题」
  it('标题号码按组顺序的位置,不按组 id:[editor, editor:3, editor:2] → 编辑器 / 编辑器 2 / 编辑器 3;随 locale 切换', () => {
    setLocale('zh');
    setGroupOrder(['editor', 'editor:3', 'editor:2']);
    const panels = [editorPanel('editor'), editorPanel('editor:2'), editorPanel('editor:3')];
    renderHook(() => useDockLocaleSync(makeApi(panels)));
    expect(titles(panels)).toEqual(['编辑器', '编辑器 3', '编辑器 2']);
    act(() => {
      setLocale('en');
      notifyLocaleChange();
    });
    expect(titles(panels)).toEqual(['Editor', 'Editor 3', 'Editor 2']);
    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });
    expect(titles(panels)).toEqual(['편집기', '편집기 3', '편집기 2']);
  });

  it('组增删 / 换序(store 组顺序变化)→ 重新编号;第一个组不一定是 editor', () => {
    setLocale('zh');
    setGroupOrder(['editor', 'editor:2', 'editor:3']);
    const panels = [editorPanel('editor'), editorPanel('editor:2'), editorPanel('editor:3')];
    renderHook(() => useDockLocaleSync(makeApi(panels)));
    expect(titles(panels)).toEqual(['编辑器', '编辑器 2', '编辑器 3']);
    act(() => setGroupOrder(['editor:2', 'editor:3', 'editor']));
    expect(titles(panels)).toEqual(['编辑器 3', '编辑器', '编辑器 2']);
  });

  it('popout 子窗里的组按该子窗自己的组编号(⌘1/2/3 只数主窗);移入 / 移出 popout(布局变化)后重算', () => {
    setLocale('zh');
    setGroupOrder(['editor', 'editor:2', 'editor:3', 'editor:4']);
    const panels = [
      editorPanel('editor'),
      editorPanel('editor:2', 'popout', 'g-pop'),
      editorPanel('editor:3', 'floating', 'g-float'),
      editorPanel('editor:4', 'popout', 'g-pop'),
    ];
    renderHook(() => useDockLocaleSync(makeApi(panels)));
    expect(titles(panels)).toEqual(['编辑器', '编辑器', '编辑器 2', '编辑器 2']);
    // editor:2 收回主窗
    panels[1]!.api.location = { type: 'grid' };
    panels[1]!.api.group = { id: 'g-main' };
    act(() => {
      for (const l of [...layoutListeners]) l();
    });
    expect(titles(panels)).toEqual(['编辑器', '编辑器 2', '编辑器 3', '编辑器']);
  });

  it('api=null → no-op', () => {
    expect(() => renderHook(() => useDockLocaleSync(null))).not.toThrow();
  });
});
