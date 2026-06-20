import { describe, expect, it } from 'vitest';
import {
  createTab,
  getStateAfterClosingTabsOutsideRoot,
  type EditorTab,
} from '../../stores/editor.store';

function tab(overrides: Partial<EditorTab> & { id: string }): EditorTab {
  return {
    filePath: overrides.id,
    content: '',
    originalContent: '',
    dirty: false,
    ...overrides,
  };
}

// P2 数据丢失回归:切换 workspace root 时,旧实现只按 filePath 位置判定,落在新 root
// 外的**脏(未保存)**真实文件 tab 被直接关闭、编辑静默丢失。修复:dirty tab 与 untitled
// 草稿一样始终保留。
describe('49 · 切 root 保留 root 外的脏 tab', () => {
  it('root 外的脏文件 tab 保留,clean 文件 tab 关闭', () => {
    const tabs = [
      tab({ id: '/old/dirty.md', dirty: true, content: 'unsaved edits' }),
      tab({ id: '/old/clean.md', dirty: false }),
      tab({ id: '/new/x.md', dirty: false }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/dirty.md', '/new');
    // 脏 tab 与新 root 内 tab 保留;clean 的 /old/clean.md 关闭
    expect(r.tabs.map((t) => t.id).sort()).toEqual(['/new/x.md', '/old/dirty.md']);
  });

  it('root=null(关文件夹)也保留脏 tab', () => {
    const draft = createTab(null, 'draft');
    const tabs = [
      tab({ id: '/old/dirty.md', dirty: true }),
      tab({ id: '/old/clean.md', dirty: false }),
      draft,
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/clean.md', null);
    expect(r.tabs.map((t) => t.id).sort()).toEqual(
      ['/old/dirty.md', draft.id].sort(),
    );
  });

  it('active 是被关的 clean tab → 切到保留的脏 tab', () => {
    const tabs = [
      tab({ id: '/old/clean.md', dirty: false }),
      tab({ id: '/old/dirty.md', dirty: true }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/clean.md', '/new');
    expect(r.tabs.map((t) => t.id)).toEqual(['/old/dirty.md']);
    expect(r.activeTabId).toBe('/old/dirty.md');
  });

  it('全 clean 且都在 root 外 → 仍全关(不回归既有行为)', () => {
    const tabs = [
      tab({ id: '/old/a.md', dirty: false }),
      tab({ id: '/old/b.md', dirty: false }),
    ];
    const r = getStateAfterClosingTabsOutsideRoot(tabs, '/old/a.md', '/new');
    expect(r.tabs).toEqual([]);
    expect(r.activeTabId).toBeNull();
  });
});
