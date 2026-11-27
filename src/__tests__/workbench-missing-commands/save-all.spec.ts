// @vitest-environment jsdom
// BDD: workbench-missing-commands §2 —— 全部保存(workbench.action.files.saveAll,mac ⌥⌘S):所有编辑器组里的脏文件 tab
// 逐个交给所在组的面板保存,失败处理同 ⌘S;一次最多弹一个确认框。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeBack = vi.hoisted(() => vi.fn());
vi.mock('../../panels/Editor/editor-writeback-registry', async (orig) => ({
  ...(await orig<object>()),
  flushEditorWriteBacks: writeBack,
}));

import {
  editorCommandSpecs,
  registerEditorPanelActions,
  saveAllEditors,
  SAVE_ALL_COMMAND_ID,
  type EditorPanelActions,
} from '@/panels/Editor/editor-commands';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const st = () => useEditorStore.getState();
const dirtyTab = (p: string) => ({ ...createTab(p, 'old'), content: 'new', dirty: true });
const disposers: (() => void)[] = [];

function panel(groupId: string, prompts: readonly string[] = []): EditorPanelActions['saveTabForSaveAll'] & ReturnType<typeof vi.fn> {
  const saveTabForSaveAll = vi.fn(async (id: string, allowPrompt: boolean) => allowPrompt && prompts.includes(id));
  disposers.push(
    registerEditorPanelActions({ save: vi.fn(), saveAs: vi.fn(), closeActiveTab: () => false, closeTabs: vi.fn(), saveTabForSaveAll, confirmRevertLosingUndo: async () => true }, groupId),
  );
  return saveTabForSaveAll as never;
}

beforeEach(() => {
  writeBack.mockReset();
  useEditorStore.setState({
    tabs: [dirtyTab('/w/a.ts'), createTab('/w/clean.ts', 'x'), dirtyTab('/w/b.ts'), { ...dirtyTab('/w/pic.png') }],
    activeTabId: '/w/a.ts',
    groups: [
      { id: 'editor', tabIds: ['/w/a.ts', '/w/clean.ts', '/w/pic.png'], activeTabId: '/w/a.ts' },
      { id: 'editor:2', tabIds: ['/w/b.ts'], activeTabId: '/w/b.ts' },
    ],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

describe('命令', () => {
  it('id 同 VSCode;mac ⌥⌘S,Windows / Linux 无默认键(VSCode 是组合键 Ctrl+K S);三语标题', () => {
    const mac = editorCommandSpecs('mac').find((c) => c.id === SAVE_ALL_COMMAND_ID)!;
    expect(SAVE_ALL_COMMAND_ID).toBe('workbench.action.files.saveAll');
    expect(mac.hotkey).toBe('mod+alt+s');
    expect(editorCommandSpecs('other').find((c) => c.id === SAVE_ALL_COMMAND_ID)!.hotkey).toBeUndefined();
    expect(mac.titleKey).toBe('commands.file.save_all.title');
    for (const locale of [en, zh, ko]) expect(locale['commands.file.save_all.title']).toBeTruthy();
  });
});

describe('saveAllEditors', () => {
  it('先回写编辑器里未上抛的输入;每个脏 tab 交给所在组的面板;干净 / 图片 tab 不保存', async () => {
    const main = panel('editor');
    const second = panel('editor:2');
    await saveAllEditors();
    expect(writeBack).toHaveBeenCalledTimes(1);
    expect(writeBack.mock.invocationCallOrder[0]).toBeLessThan(main.mock.invocationCallOrder[0]!);
    expect(main.mock.calls.map((c) => c[0])).toEqual(['/w/a.ts']);
    expect(second.mock.calls.map((c) => c[0])).toEqual(['/w/b.ts']);
  });

  it('一次全部保存最多弹一个确认框:弹过之后其余 tab 的确认类失败只提示', async () => {
    const main = panel('editor', ['/w/a.ts']);
    const second = panel('editor:2', ['/w/b.ts']);
    await saveAllEditors();
    expect(main).toHaveBeenCalledWith('/w/a.ts', true);
    expect(second).toHaveBeenCalledWith('/w/b.ts', false);
  });

  it('没有脏 tab / 没有编辑器面板 → 无操作', async () => {
    useEditorStore.setState({ tabs: st().tabs.map((t) => ({ ...t, dirty: false })) });
    const main = panel('editor');
    await saveAllEditors();
    expect(main).not.toHaveBeenCalled();
    for (const d of disposers.splice(0)) d();
    useEditorStore.setState({ tabs: [dirtyTab('/w/a.ts')] });
    await expect(saveAllEditors()).resolves.toBeUndefined();
  });
});
