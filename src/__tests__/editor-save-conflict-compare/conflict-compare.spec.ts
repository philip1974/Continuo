// @vitest-environment jsdom
// BDD:保存冲突差异 tab 的打开 / 接受我的版本 / 使用磁盘版本 / 原 tab 关闭时自动关闭 / 命令。见同目录 README 契约 2、4、5。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewComponent } from 'dockview-react';
import { useEditorStore } from '@/stores/editor.store';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import {
  ACCEPT_LOCAL_CHANGES_COMMAND_ID,
  REVERT_LOCAL_CHANGES_COMMAND_ID,
  activeConflictDiff,
  conflictCompareCommandSpecs,
  openConflictCompare,
  resolveConflict,
} from '@/panels/Editor/conflict-compare';
import { CONFLICT_DIFF_PANEL_TYPE, conflictDiffPanelId } from '@/panels/Editor/conflict-diff-constants';
import { setLocale, t } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { createDock } from '../dock-terminal-vscode-focus/dock-fixtures';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      stat: vi.fn(async () => ({ ok: false, code: 'FS_NOT_FOUND' })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
  },
}));
vi.mock('@/notifications/notify', () => ({
  notify: { warn: vi.fn(), error: mocks.error, info: vi.fn(), success: vi.fn() },
}));

const PATH = '/work/conflict.txt';
let dock: DockviewComponent;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setLocale('zh');
  mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs\n' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: { mtimeMs: 1.5, size: 5, ino: 1 } });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'mine\n', originalContent: 'orig\n', dirty: true }],
    activeTabId: PATH,
    mode: 'source',
  });
  dock = createDock();
  dock.api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  dock.api.addPanel({ id: 'search', component: 'search', title: 'Search', position: { direction: 'right' } });
  setDockApi(dock.api);
});
afterEach(() => {
  setDockApi(null);
  dock.dispose();
  vi.useRealTimers();
  setLocale('zh');
});

const diffPanel = () => dock.api.getPanel(conflictDiffPanelId(PATH));
/** panel.api.close() 经关闭动画(EXIT_DURATION_MS)后才真正移除。 */
const flushClose = () => vi.advanceTimersByTime(EXIT_DURATION_MS + 50);

describe('打开差异 tab', () => {
  it('落在原编辑器组面板所在的 dock 组里并成为活动面板;标题 / params 正确', () => {
    openConflictCompare(PATH, 'editor');
    const panel = diffPanel();
    expect(panel).toBeTruthy();
    expect(panel!.view.contentComponent).toBe(CONFLICT_DIFF_PANEL_TYPE);
    expect(panel!.group.id).toBe(dock.api.getPanel('editor')!.group.id);
    expect(dock.api.activePanel).toBe(panel);
    expect(panel!.api.title).toBe('conflict.txt（在磁盘上）↔ conflict.txt（你的版本）');
    expect(panel!.params).toMatchObject({ tabId: PATH, groupId: 'editor', titleArgs: { name: 'conflict.txt' } });
    // 不写盘、tab 仍脏
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'mine\n', dirty: true });
  });

  it('同一文档再次比较 → 激活已有的差异 tab,不重建', () => {
    openConflictCompare(PATH, 'editor');
    const first = diffPanel();
    dock.api.getPanel('editor')!.api.setActive();
    openConflictCompare(PATH, 'editor');
    expect(dock.api.panels.filter((p) => p.view.contentComponent === CONFLICT_DIFF_PANEL_TYPE)).toHaveLength(1);
    expect(dock.api.activePanel).toBe(first);
  });

  it('标题三语', () => {
    const k = 'panels.editor.conflict_diff.title';
    expect(en[k]).toBe('{name} (on Disk) ↔ {name} (Your Version)');
    expect(zh[k]).toBe('{name}（在磁盘上）↔ {name}（你的版本）');
    expect(ko[k]).toBe('{name}(디스크) ↔ {name}(내 버전)');
  });
});

describe('接受我的版本 / 使用磁盘版本', () => {
  it('接受 → 强制写盘(不先读盘比较)、tab 干净;关闭差异 tab,回到原编辑器组', async () => {
    openConflictCompare(PATH, 'editor');
    expect(await resolveConflict(PATH, 'editor', 'accept')).toBe(true);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'mine\n');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'mine\n', originalContent: 'mine\n', dirty: false });
    expect(dock.api.activePanel?.id).toBe('editor');
    flushClose();
    expect(diffPanel()).toBeUndefined();
    expect(useEditorStore.getState().activeTabId).toBe(PATH);
  });

  it('使用磁盘版本 → 不写盘,tab 换成磁盘内容且干净;关闭差异 tab,回到原编辑器组', async () => {
    openConflictCompare(PATH, 'editor');
    expect(await resolveConflict(PATH, 'editor', 'revert')).toBe(true);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'theirs\n', originalContent: 'theirs\n', dirty: false });
    expect(dock.api.activePanel?.id).toBe('editor');
    flushClose();
    expect(diffPanel()).toBeUndefined();
  });

  it('失败 → 按 code 提示,差异 tab 保留,tab 仍脏', async () => {
    mocks.writeFile.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'EACCES' });
    openConflictCompare(PATH, 'editor');
    expect(await resolveConflict(PATH, 'editor', 'accept')).toBe(false);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    flushClose();
    expect(diffPanel()).toBeTruthy();
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);

    mocks.readFile.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    expect(await resolveConflict(PATH, 'editor', 'revert')).toBe(false);
    expect(mocks.error).toHaveBeenCalledTimes(2);
    flushClose();
    expect(diffPanel()).toBeTruthy();
  });
});

describe('原 tab 关闭 → 差异 tab 自动关闭', () => {
  it('关闭原 tab 后差异 tab 随之关闭', () => {
    openConflictCompare(PATH, 'editor');
    expect(diffPanel()).toBeTruthy();
    useEditorStore.getState().closeTab(PATH);
    flushClose();
    expect(diffPanel()).toBeUndefined();
  });

  it('改名(tab id 随路径变)同样关闭', () => {
    openConflictCompare(PATH, 'editor');
    useEditorStore.getState().renamePath(PATH, '/work/renamed.txt');
    flushClose();
    expect(diffPanel()).toBeUndefined();
  });
});

describe('命令 acceptLocalChanges / revertLocalChanges', () => {
  it('VSCode 同名 id,「文件」分类,无默认键,三语标题', () => {
    const specs = conflictCompareCommandSpecs();
    expect(specs.map((s) => s.id)).toEqual([ACCEPT_LOCAL_CHANGES_COMMAND_ID, REVERT_LOCAL_CHANGES_COMMAND_ID]);
    expect(ACCEPT_LOCAL_CHANGES_COMMAND_ID).toBe('workbench.files.action.acceptLocalChanges');
    expect(REVERT_LOCAL_CHANGES_COMMAND_ID).toBe('workbench.files.action.revertLocalChanges');
    for (const s of specs) {
      expect(s.hotkey).toBeUndefined();
      expect(s.categoryKey).toBe('commands.file.category');
      const k = s.titleKey as keyof typeof en;
      expect(en[k]).toBeTruthy();
      expect(zh[k]).toBeTruthy();
      expect(ko[k]).toBeTruthy();
    }
    expect(t('commands.file.accept_local_changes.title')).toBe('接受我的版本（覆盖磁盘上的文件）');
    expect(t('commands.file.revert_local_changes.title')).toBe('使用磁盘版本（放弃我的更改）');
  });

  it('作用于活动差异 tab', async () => {
    openConflictCompare(PATH, 'editor');
    expect(activeConflictDiff()).toMatchObject({ tabId: PATH, groupId: 'editor' });
    await conflictCompareCommandSpecs()[0]!.fn();
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'mine\n');
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false);
  });

  it('活动面板不是差异 tab → 什么也不做', async () => {
    openConflictCompare(PATH, 'editor');
    dock.api.getPanel('search')!.api.setActive();
    expect(activeConflictDiff()).toBeNull();
    for (const s of conflictCompareCommandSpecs()) await s.fn();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'mine\n', dirty: true });
  });
});
