// @vitest-environment jsdom
// BDD:被替换掉的预览文件的后退 / 前进条目保留,后退时按常驻重新打开。见同目录 README 第 8 条。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `content of ${p}` })),
}));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));

import { groupPreviewTabIdOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { openFileByPath } from '../../panels/Editor/editor-file-actions';
import { editorFileDeps } from '../../panels/Editor/editor-file-deps';
import {
  installNavigationHistory,
  navigateBack,
  navigateForward,
  resetNavigationHistory,
} from '../../panels/Editor/navigation-history';
import { reopenClosedEditor } from '../../panels/Editor/reopen-closed-editor';
import { clearRecentlyClosedEditors } from '../../panels/Editor/recently-closed-editors';

const A = '/w/a.ts';
const B = '/w/b.ts';
const st = () => useEditorStore.getState();
const ids = () => groupTabsOf(st(), 'editor').map((t) => t.id);

let uninstall: () => void = () => {};
beforeAll(() => {
  uninstall = installNavigationHistory();
});
afterAll(() => uninstall());

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    tabMru: new Map(),
    previewTabs: new Map(),
    viewRefs: new Map(),
  });
  resetNavigationHistory();
  clearRecentlyClosedEditors();
});

describe('导航历史与预览替换', () => {
  it('预览 a 被 b 替换 → 后退重新打开 a(常驻),前进回到 b', async () => {
    await openFileByPath(A, editorFileDeps, { preview: true });
    await openFileByPath(B, editorFileDeps, { preview: true });
    expect(ids()).toEqual([B]);
    await navigateBack();
    expect(st().activeTabId).toBe(A);
    expect(ids()).toEqual([B, A]);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBe(B);
    await navigateForward();
    expect(st().activeTabId).toBe(B);
    expect(ids()).toEqual([B, A]);
  });

  it('关闭预览 tab 后 ⇧⌘T 重新打开 → 常驻', async () => {
    await openFileByPath(A, editorFileDeps, { preview: true });
    st().closeTab(A);
    await reopenClosedEditor();
    expect(ids()).toEqual([A]);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBeUndefined();
  });
});
