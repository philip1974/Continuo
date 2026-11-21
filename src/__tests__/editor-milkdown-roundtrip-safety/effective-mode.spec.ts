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

    // 外部重载 / 另存为不撤销用户对这个文件的选择
    useEditorStore.getState().markSaved('/work/flow.md');
    useEditorStore.getState().reloadFromDisk('/work/flow.md', `${unsafe}external\n`);
    expect(getEffectiveMode(activeTab())).toBe('edit');
    useEditorStore.getState().setFilePath('/work/flow.md', '/work/renamed.md');
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
