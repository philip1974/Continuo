// @vitest-environment jsdom
// BDD:编辑器组的编号 / ⌘N 按空间顺序(对齐 VSCode GroupsOrder.GRID_APPEARANCE:网格从左到右、从上到下),拖动换位后
// dock 标题「编辑器 N」、⌘1/⌘2/⌘3、重置布局都跟着位置走;重启恢复的 popout 子窗关掉后重新编号。见同目录 README。
// 真实 dockview(jsdom)+ 假 popout 子窗。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi, DockviewComponent } from 'dockview-react';
import { useEditorStore } from '../../stores/editor.store';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { focusEditorGroup } from '../../panels/Editor/editor-groups-actions';
import { resetDockLayout } from '../../shell/dock/layout.default';
import { useDockLocaleSync } from '../../shell/dock/useDockLocaleSync';
import { mainEditorGroupOrder } from '../../shell/dock/editor-group-order';
import { publishEditorGroupNumbers, useEditorGroupNumber } from '../../panels/Editor/editor-group-number';
import { setLocale } from '../../i18n/translate';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

const EDITOR = { component: 'editor', title: 'Editor', params: { titleKey: 'panels.editor.title' } } as const;

beforeEach(() => {
  setLocale('zh');
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: ['editor', 'editor:2', 'editor:3'].map((id) => ({ id, tabIds: [], activeTabId: null })),
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});
afterEach(() => {
  cleanup();
  publishEditorGroupNumbers(new Map());
  setDockApi(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  useEditorStore.setState({ groups: [{ id: 'editor', tabIds: [], activeTabId: null }], activeGroupId: 'editor' });
});

/** 三个编辑器组左右分栏:editor | editor:2 | editor:3(⌘\ 两次)。 */
function threeColumns(dock: DockviewComponent = createDock()) {
  const api = dock.api as DockviewApi;
  api.addPanel({ id: 'editor', ...EDITOR });
  api.addPanel({ id: 'editor:2', ...EDITOR, position: { referencePanel: 'editor', direction: 'right' } });
  api.addPanel({ id: 'editor:3', ...EDITOR, position: { referencePanel: 'editor:2', direction: 'right' } });
  return { dock, api };
}

/** 把 editor:3 的 dock tab 拖到最左(拖到 editor 组的左边缘)。 */
function dragThirdToLeft(api: DockviewApi) {
  api.getPanel('editor:3')!.api.moveTo({ group: api.getPanel('editor')!.group, position: 'left' });
}

const title = (api: DockviewApi, id: string) => api.getPanel(id)!.api.title;
/** 主窗各编辑器组的标题,按视觉位置(DOM 顺序)从左到右。 */
const titlesLeftToRight = (api: DockviewApi) =>
  api.panels
    .filter((p) => p.api.id.startsWith('editor'))
    .sort((a, b) => (a.group.element.compareDocumentPosition(b.group.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((p) => p.api.title);

describe('空间顺序(GRID_APPEARANCE)', () => {
  it('拖动换位:编辑器 3 拖到最左 → 顺序 [editor:3, editor, editor:2]', () => {
    const { api } = threeColumns();
    expect(mainEditorGroupOrder(api)).toEqual(['editor', 'editor:2', 'editor:3']);
    dragThirdToLeft(api);
    expect(mainEditorGroupOrder(api)).toEqual(['editor:3', 'editor', 'editor:2']);
  });

  it('网格从左到右、从上到下;同一 dock 组里叠放的按 tab 顺序;浮动组在网格之后;popout 子窗里的不计入', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.addPanel({ id: 'editor', ...EDITOR });
    // 右栏上下拆分:editor:4 在上、editor:2 在下
    api.addPanel({ id: 'editor:2', ...EDITOR, position: { referencePanel: 'editor', direction: 'right' } });
    api.addPanel({ id: 'editor:4', ...EDITOR, position: { referencePanel: 'editor:2', direction: 'above' } });
    // editor:3 叠在左栏 editor 组里(tab 在 editor 之后)
    api.addPanel({ id: 'editor:3', ...EDITOR, position: { referencePanel: 'editor', direction: 'within' } });
    api.addPanel({ id: 'editor:5', ...EDITOR, floating: true });
    api.addPanel({ id: 'editor:6', ...EDITOR, position: { referencePanel: 'editor:2', direction: 'right' } });
    await openFakePopout(dock, 'editor:6');
    expect(mainEditorGroupOrder(api)).toEqual(['editor', 'editor:3', 'editor:4', 'editor:2', 'editor:5']);
  });

  it('dock 标题「编辑器 N」跟空间位置:拖动换位后从左到右仍是「编辑器 | 编辑器 2 | 编辑器 3」', async () => {
    const { api } = threeColumns();
    renderHook(() => useDockLocaleSync(api));
    expect(titlesLeftToRight(api)).toEqual(['编辑器', '编辑器 2', '编辑器 3']);
    await act(async () => dragThirdToLeft(api));
    expect(titlesLeftToRight(api)).toEqual(['编辑器', '编辑器 2', '编辑器 3']);
    expect(title(api, 'editor:3')).toBe('编辑器');
  });

  it('同一来源发布读屏组号:随换位更新;只剩一个组 → 不带组号', async () => {
    const { api } = threeColumns();
    renderHook(() => useDockLocaleSync(api));
    const { result } = renderHook(() => useEditorGroupNumber('editor:3'));
    expect(result.current).toBe(3);
    await act(async () => dragThirdToLeft(api));
    expect(result.current).toBe(1);
    await act(async () => {
      api.getPanel('editor')!.api.close();
      api.getPanel('editor:2')!.api.close();
    });
    expect(result.current).toBeUndefined();
  });

  it('⌘1 / ⌘2 按空间位置:拖动换位后 ⌘1 聚焦最左的组', () => {
    const { api } = threeColumns();
    setDockApi(api);
    dragThirdToLeft(api);
    focusEditorGroup(1);
    expect(useEditorStore.getState().activeGroupId).toBe('editor:3');
    expect(api.activePanel?.id).toBe('editor:3');
    focusEditorGroup(3);
    expect(useEditorStore.getState().activeGroupId).toBe('editor:2');
  });

  it('⌘N 新建组(N = 组数 + 1)以空间上最后一组为参照', () => {
    const { api } = threeColumns();
    setDockApi(api);
    // 拖动后空间顺序 [editor:3, editor, editor:2]:最后一组是 editor:2(创建顺序里的最后一组是 editor:3)
    dragThirdToLeft(api);
    focusEditorGroup(4);
    const created = useEditorStore.getState().activeGroupId;
    expect(mainEditorGroupOrder(api)).toEqual(['editor:3', 'editor', 'editor:2', created]);
  });

  it('重置布局按空间顺序分栏(不按创建顺序重排)', () => {
    const { api } = threeColumns();
    dragThirdToLeft(api);
    resetDockLayout(api);
    expect(mainEditorGroupOrder(api)).toEqual(['editor:3', 'editor', 'editor:2']);
    const groups = (['editor:3', 'editor', 'editor:2'] as const).map((id) => api.getPanel(id)!.group);
    expect(new Set(groups).size).toBe(3);
  });
});

describe('重启恢复的 popout 子窗挂上 / 关掉后重新编号', () => {
  /** 把布局按 fromJSON 恢复到新 dock(同重启),popout 子窗用假子窗;返回关掉该子窗的函数。 */
  async function restoreWithPopout(): Promise<{ api: DockviewApi; closePopout: () => void }> {
    const source = threeColumns();
    await openFakePopout(source.dock, 'editor:2');
    const layout = source.api.toJSON();
    source.dock.dispose();

    const dock = createDock();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const child = iframe.contentWindow!;
    vi.spyOn(window, 'open').mockImplementation(() => {
      queueMicrotask(() => child.dispatchEvent(new Event('load')));
      return child;
    });
    // 同 DockShell:标题同步在恢复布局之前就已挂上
    renderHook(() => useDockLocaleSync(dock.api));
    dock.fromJSON(layout);
    const popped = () => dock.api.getPanel('editor:2')?.api.location.type === 'popout';
    for (let i = 0; i < 50 && !popped(); i++) await act(async () => {});
    expect(popped()).toBe(true);
    return { api: dock.api, closePopout: () => child.dispatchEvent(new Event('beforeunload')) };
  }

  it('子窗关闭、组回到主窗 → 三个组标题互不重名,按空间位置编号', async () => {
    const { api, closePopout } = await restoreWithPopout();
    // 子窗挂上(dockview 此时不发布局事件):子窗里只有它一个,各自编号;主窗剩两组
    await act(async () => {});
    expect(title(api, 'editor:2')).toBe('编辑器');
    expect([title(api, 'editor'), title(api, 'editor:3')]).toEqual(['编辑器', '编辑器 2']);
    await act(async () => {
      closePopout();
      await Promise.resolve();
    });
    expect(api.getPanel('editor:2')!.api.location.type).toBe('grid');
    const order = mainEditorGroupOrder(api);
    expect(order).toHaveLength(3);
    expect(order.map((id) => title(api, id))).toEqual(['编辑器', '编辑器 2', '编辑器 3']);
    expect(titlesLeftToRight(api)).toEqual(['编辑器', '编辑器 2', '编辑器 3']);
  });
});
