// @vitest-environment jsdom
// BDD: workspace-search / 8 文件删除 / 改名 / 移动后,结果从列表移除(VSCode SearchView.onFilesChanged),不再指向旧路径
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchFileResult } from '../../../electron/shared/workspace-search';

const h = vi.hoisted(() => ({
  listener: null as ((e: unknown) => void) | null,
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    search: {
      start: vi.fn(async () => ({ ok: true })),
      cancel: vi.fn(async () => ({ ok: true })),
      onEvent: (cb: (e: unknown) => void) => {
        h.listener = cb;
        return () => {
          h.listener = null;
        };
      },
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() } } }));

import { useWorkspaceStore } from '@/stores/workspace.store';
import { useEditorStore } from '@/stores/editor.store';
import { __resetSearchForTest, matchRowKey, useSearchStore } from '@/panels/Search/search-store';

const m = (line: number) => ({ line, column: 1, length: 3, preview: 'foo', previewStart: 0, previewLength: 3 });
const result = (rel: string, n: number): SearchFileResult => ({
  path: `/w/${rel}`,
  relPath: rel,
  matches: Array.from({ length: n }, (_, i) => m(i + 1)),
});

function searchWith(files: SearchFileResult[]): void {
  useSearchStore.getState().setPattern('foo');
  useSearchStore.getState().searchNow();
  const id = 'search-1'; // 每个用例 __resetSearchForTest 后的首个查询
  h.listener!({ searchId: id, kind: 'files', files });
  h.listener!({ searchId: id, kind: 'done', limitHit: false, filesLimitHit: false });
}
const paths = () => useSearchStore.getState().files.map((f) => f.path);

beforeEach(() => {
  useWorkspaceStore.setState({ root: '/w' });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  __resetSearchForTest();
  useWorkspaceStore.setState({ root: null });
});

describe('文件改名 / 移动 / 删除后的搜索结果', () => {
  it('改名 / 移动文件 → 该文件结果移除,计数随之更新,其它文件保留', () => {
    searchWith([result('src/file-3.ts', 2), result('src/other.ts', 1)]);
    expect(useSearchStore.getState().resultCount).toBe(3);
    useEditorStore.getState().renamePath('/w/src/file-3.ts', '/w/lib/file-3.ts');
    expect(paths()).toEqual(['/w/src/other.ts']);
    expect(useSearchStore.getState().resultCount).toBe(1);
  });

  it('移动目录 → 其下全部文件的结果移除;同前缀的兄弟目录(src/ab)不受影响', () => {
    searchWith([result('src/a/x.ts', 1), result('src/a/deep/y.ts', 1), result('src/ab/z.ts', 1)]);
    useEditorStore.getState().renamePath('/w/src/a', '/w/moved');
    expect(paths()).toEqual(['/w/src/ab/z.ts']);
  });

  it('删除(资源管理器删除 / 外部删除确认)→ 文件或目录下的结果移除', () => {
    searchWith([result('a.ts', 1), result('d/b.ts', 1), result('c.ts', 1)]);
    useEditorStore.getState().removePaths(['/w/a.ts', '/w/d']);
    expect(paths()).toEqual(['/w/c.ts']);
  });

  it('活动行 / 折叠状态指向被移除的文件 → 一并清除', () => {
    searchWith([result('a.ts', 2), result('b.ts', 1)]);
    useSearchStore.getState().toggleCollapsed('/w/a.ts', true);
    useSearchStore.getState().setActiveKey(matchRowKey('/w/a.ts', 1));
    useEditorStore.getState().renamePath('/w/a.ts', '/w/a2.ts');
    expect(useSearchStore.getState().activeKey).toBeNull();
    expect(useSearchStore.getState().collapsed.has('/w/a.ts')).toBe(false);
  });

  it('不相关的路径变更不改结果(store 不变)', () => {
    searchWith([result('a.ts', 1)]);
    const before = useSearchStore.getState().files;
    useEditorStore.getState().renamePath('/w/zzz.ts', '/w/yyy.ts');
    expect(useSearchStore.getState().files).toBe(before);
  });
});
