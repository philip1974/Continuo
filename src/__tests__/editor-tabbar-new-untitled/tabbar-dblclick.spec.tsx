// @vitest-environment jsdom
// BDD: editor-tabbar-new-untitled —— 双击 tab 栏空白处在本组新建无标题文件。见同目录 README。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { EditorHeader, isTabBarBlankTarget, type TabChrome } from '../../panels/Editor/EditorHeader';
import { groupPreviewTabIdOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { isUntitledPath } from '../../panels/Editor/untitled';
import { setLocale } from '../../i18n';

function tab(id: string) {
  return { id, filePath: id, content: 'x', originalContent: 'x', dirty: false };
}

beforeEach(() => {
  setLocale('en');
  useEditorStore.setState({ tabs: [tab('/a.ts'), tab('/b.ts')], activeTabId: '/a.ts', mode: 'source' });
});
afterEach(() => cleanup());

const noop = (_tab: TabChrome) => {};

function header() {
  const { container } = render(<EditorHeader onCloseRequest={noop} />);
  const tablist = container.querySelector<HTMLElement>('[role="tablist"]')!;
  return { container, tablist, wrapper: tablist.parentElement! };
}

const tabIds = () => groupTabsOf(useEditorStore.getState(), useEditorStore.getState().activeGroupId).map((t) => t.id);

describe('双击 tab 栏空白处', () => {
  it('双击 tablist 空白处 → 本组末尾新建常驻的无标题文件并激活', () => {
    const { tablist } = header();
    act(() => fireEvent.doubleClick(tablist));
    const ids = tabIds();
    expect(ids).toHaveLength(3);
    expect(ids.slice(0, 2)).toEqual(['/a.ts', '/b.ts']);
    expect(isUntitledPath(ids[2]!)).toBe(true);
    const s = useEditorStore.getState();
    expect(groupPreviewTabIdOf(s, s.activeGroupId)).not.toBe(ids[2]);
    expect(useEditorStore.getState().activeTabId).toBe(ids[2]);
  });

  it('双击 tab 栏外层容器(tablist 两侧空白)同样新建', () => {
    const { wrapper } = header();
    act(() => fireEvent.doubleClick(wrapper));
    expect(tabIds()).toHaveLength(3);
  });

  it('双击 tab 本身 / tab 里的文字 / 关闭按钮 → 不新建', () => {
    const { container } = header();
    const tabEl = container.querySelector<HTMLElement>('[role="tab"]')!;
    act(() => fireEvent.doubleClick(tabEl));
    act(() => fireEvent.doubleClick(tabEl.firstElementChild ?? tabEl));
    for (const btn of container.querySelectorAll('button')) act(() => fireEvent.doubleClick(btn));
    expect(tabIds()).toEqual(['/a.ts', '/b.ts']);
  });

  it('判定:只有容器本身或其直接子 tablist 算空白', () => {
    const container = document.createElement('div');
    const list = document.createElement('nav');
    list.setAttribute('role', 'tablist');
    const t = document.createElement('div');
    t.setAttribute('role', 'tab');
    list.appendChild(t);
    container.appendChild(list);
    expect(isTabBarBlankTarget(container, container)).toBe(true);
    expect(isTabBarBlankTarget(list, container)).toBe(true);
    expect(isTabBarBlankTarget(t, container)).toBe(false);
    expect(isTabBarBlankTarget(null, container)).toBe(false);
  });
});
