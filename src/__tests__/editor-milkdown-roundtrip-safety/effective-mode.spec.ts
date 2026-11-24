import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTab,
  getEffectiveMode,
  useEditorStore,
} from '../../stores/editor.store';

const unsafe = '---\nid: demo\n---\n# Title\n';

function activeTab() {
  const s = useEditorStore.getState();
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
  useEditorStore.getState().openTab(createTab('/work/flow.md', unsafe));
});

describe('getEffectiveMode for unsafe markdown', () => {
  it('keeps preview as preview (read-only never rewrites the file)', () => {
    useEditorStore.getState().setMode('preview');
    expect(getEffectiveMode(activeTab())).toBe('preview');
  });

  it('forces edit to source until the tab is opted in', () => {
    useEditorStore.getState().setMode('edit');
    expect(getEffectiveMode(activeTab())).toBe('source');

    const before = useEditorStore.getState().chromeVersion;
    useEditorStore.getState().acceptUnsafeEdit('/work/flow.md');

    expect(getEffectiveMode(activeTab())).toBe('edit');
    // EditorHeader 的 effectiveMode 派生靠 chromeVersion 失效
    expect(useEditorStore.getState().chromeVersion).toBe(before + 1);
  });

  it('keeps the opt-in across edits and scopes it to that tab', () => {
    useEditorStore.getState().setMode('edit');
    useEditorStore.getState().acceptUnsafeEdit('/work/flow.md');
    useEditorStore.getState().updateContent('/work/flow.md', `${unsafe}more\n`);
    expect(getEffectiveMode(activeTab())).toBe('edit');

    // 外部重载 / 改名不撤销用户对这个文件的选择
    useEditorStore.getState().markSaved('/work/flow.md');
    useEditorStore.getState().reloadFromDisk('/work/flow.md', `${unsafe}external\n`);
    expect(getEffectiveMode(activeTab())).toBe('edit');
    useEditorStore.getState().renamePath('/work/flow.md', '/work/renamed.md');
    expect(getEffectiveMode(activeTab())).toBe('edit');

    useEditorStore.getState().openTab(createTab('/work/other.md', unsafe));
    expect(getEffectiveMode(activeTab())).toBe('source');
  });

  it('is a no-op for unknown or already opted-in tabs', () => {
    useEditorStore.getState().acceptUnsafeEdit('/work/flow.md');
    const state = useEditorStore.getState();
    useEditorStore.getState().acceptUnsafeEdit('/work/flow.md');
    useEditorStore.getState().acceptUnsafeEdit('/work/missing.md');
    expect(useEditorStore.getState()).toBe(state);
  });
});

// 草稿(无路径)在编辑面板里按 Markdown 处理(走 Milkdown、显示模式切换),unsafe 守卫须同一口径:此前 store
// 判草稿「不是 markdown」→ milkdownUnsafe 恒 false,草稿 Source 里写 frontmatter / wiki-link 后切 Edit 直接进
// Milkdown,序列化回写改坏内容(issue-44 要防的情形)。
describe('草稿 tab 与 unsafe 守卫同口径', () => {
  it('草稿内容 unsafe → Edit 落到 Source;编辑成 unsafe 后同样', () => {
    useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
    const draft = createTab(null, unsafe);
    useEditorStore.getState().openTab(draft);
    expect(getEffectiveMode(activeTab())).toBe('source');

    const clean = createTab(null, '# plain\n');
    useEditorStore.getState().openTab(clean);
    expect(getEffectiveMode(activeTab())).toBe('edit');
    useEditorStore.getState().updateContent(clean.id, '[[wiki]] link\n');
    expect(getEffectiveMode(activeTab())).toBe('source');
  });
});
