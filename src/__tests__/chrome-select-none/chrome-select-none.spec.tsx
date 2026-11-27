// @vitest-environment jsdom
// BDD:界面外框的标题栏 / tab 栏不可选中文字(右键 / 拖选不留下选区高亮;VSCode 工作台外框 user-select:none)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { ExplorerHeader } from '@/panels/Explorer/ExplorerHeader';
import { OutlineSection } from '@/panels/Outline/OutlineView';
import { __resetOutlineStoreForTest, useOutlineStore } from '@/panels/Outline/outline-store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { setLocale } from '@/i18n';

/** 元素自身或某个祖先带 select-none(Tailwind user-select:none,子孙继承)。 */
function isUnselectable(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.classList.contains('select-none')) return true;
  }
  return false;
}

beforeEach(() => {
  setLocale('en');
  useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
  __resetOutlineStoreForTest();
});
afterEach(() => cleanup());

describe('侧栏标题栏不可选中文字', () => {
  it('资源管理器标题(工作区名)', () => {
    render(<ExplorerHeader root="/Users/foo/myapp" />);
    expect(isUnselectable(screen.getByText('myapp'))).toBe(true);
  });

  it('大纲标题(折叠 / 展开两种状态)', () => {
    useOutlineStore.setState({ expanded: false });
    const r = render(<OutlineSection />);
    expect(isUnselectable(screen.getByText('Outline'))).toBe(true);
    r.unmount();
    useOutlineStore.setState({ expanded: true });
    render(<OutlineSection />);
    expect(isUnselectable(screen.getByText('Outline'))).toBe(true);
  });
});

describe('tab 栏不可选中文字', () => {
  it('design TabNav(编辑器 tab 栏等)根样式 user-select: none', () => {
    const css = readFileSync(join(process.cwd(), 'src/design/TabNav.css'), 'utf8');
    const rule = /\.wm-tab-nav\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/user-select:\s*none/);
  });
});
