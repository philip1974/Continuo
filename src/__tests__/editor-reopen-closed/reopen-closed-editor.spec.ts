// @vitest-environment jsdom
// BDD:重新打开已关闭的编辑器(VSCode workbench.action.reopenClosedEditor,⇧⌘T)。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTab,
  editorGroupIdsOf,
  groupActiveTabIdOf,
  groupTabsOf,
  useEditorStore,
  type EditorTab,
} from '../../stores/editor.store';
import { reopenClosedEditor } from '../../panels/Editor/reopen-closed-editor';
import {
  clearRecentlyClosedEditors,
  RECENTLY_CLOSED_EDITORS_MAX,
  recentlyClosedEditorPaths,
} from '../../panels/Editor/recently-closed-editors';
import type { EditorFileDeps } from '../../panels/Editor/editor-file-actions';
import {
  clearEditorViewStates,
  markdownScrollTopOf,
  persistedEditorViewStateOf,
  saveMarkdownScrollTop,
  seedPersistedEditorViewState,
} from '../../panels/Editor/editor-view-state-cache';
import { registerEditorFocus } from '../../panels/Editor/editor-focus-registry';
import { editorCommandSpecs, REOPEN_CLOSED_EDITOR_COMMAND } from '../../panels/Editor/editor-commands';
import {
  terminalYieldedCommandId,
  WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND,
} from '../../panels/Terminal/terminal-hotkeys';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const M = '/w/m.md';

function reset(): void {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
    viewRefs: new Map(),
  });
  clearRecentlyClosedEditors();
  clearEditorViewStates();
}

beforeEach(reset);

const st = () => useEditorStore.getState();
const open = (path: string, content = `disk ${path}`): void => st().openTab(createTab(path, content));
const ids = (groupId = 'editor'): string[] => groupTabsOf(st(), groupId).map((t) => t.id);

/** 磁盘:files 里的路径可读(内容 = `disk <path>`),其余 ENOENT。 */
function diskOf(files: readonly string[]): EditorFileDeps & { readFile: ReturnType<typeof vi.fn> } {
  const readFile = vi.fn(async (p: string) =>
    files.includes(p)
      ? { ok: true as const, data: `disk ${p}` }
      : { ok: false as const, code: 'FS_ENOENT', message: 'not found' },
  );
  return { readFile, fs: { readFile, writeFile: vi.fn() } } as never;
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

describe('关闭后重新打开(单组)', () => {
  it('关闭中间的 tab → 重新打开回到原位置并激活,焦点进入它的编辑器', async () => {
    open(A);
    open(B);
    open(C);
    st().closeTab(B);
    expect(ids()).toEqual([A, C]);

    const focus = vi.fn();
    const unregister = registerEditorFocus(B, focus, 'editor');
    expect(await reopenClosedEditor(diskOf([A, B, C]))).toBe(true);
    expect(ids()).toEqual([A, B, C]);
    expect(st().activeTabId).toBe(B);
    await nextFrame();
    await nextFrame();
    expect(focus).toHaveBeenCalled();
    unregister();
  });

  it('按关闭的倒序逐个重新打开(栈);批量关闭后连按恢复原顺序', async () => {
    open(A);
    open(B);
    open(C);
    // 右键「全部关闭」= 逐个 closeTab
    for (const id of [A, B, C]) st().closeTab(id);
    expect(ids()).toEqual([]);
    const disk = diskOf([A, B, C]);
    await reopenClosedEditor(disk);
    expect(ids()).toEqual([C]);
    await reopenClosedEditor(disk);
    await reopenClosedEditor(disk);
    expect(ids()).toEqual([A, B, C]);
    expect(st().activeTabId).toBe(A);
  });

  it('栈空 → 什么都不做', async () => {
    const disk = diskOf([A]);
    expect(await reopenClosedEditor(disk)).toBe(false);
    expect(disk.readFile).not.toHaveBeenCalled();
    expect(st().tabs).toEqual([]);
  });

  it('最多记 20 条,超出丢最早的;同一路径再次关闭只留栈顶一条', () => {
    for (let i = 0; i < RECENTLY_CLOSED_EDITORS_MAX + 3; i++) {
      const p = `/w/f${i}.ts`;
      open(p);
      st().closeTab(p);
    }
    expect(RECENTLY_CLOSED_EDITORS_MAX).toBe(20);
    const paths = recentlyClosedEditorPaths();
    expect(paths).toHaveLength(20);
    expect(paths[0]).toBe('/w/f3.ts');
    open('/w/f5.ts');
    st().closeTab('/w/f5.ts');
    const again = recentlyClosedEditorPaths();
    expect(again).toHaveLength(20);
    expect(again.filter((p) => p === '/w/f5.ts')).toHaveLength(1);
    expect(again.at(-1)).toBe('/w/f5.ts');
  });

  it('文件已不存在 → 跳过这条,重新打开下一条', async () => {
    open(A);
    open(B);
    st().closeTab(A);
    st().closeTab(B);
    expect(await reopenClosedEditor(diskOf([A]))).toBe(true);
    expect(ids()).toEqual([A]);
    expect(recentlyClosedEditorPaths()).toEqual([]);
  });

  it('已经打开的 → 跳过这条,重新打开下一条', async () => {
    open(A);
    open(B);
    st().closeTab(A);
    st().closeTab(B);
    open(B); // 用户自己又打开了 B
    expect(await reopenClosedEditor(diskOf([A, B]))).toBe(true);
    expect(ids()).toEqual([A, B]);
    expect(st().activeTabId).toBe(A);
  });

  it('弃改关闭的脏文件按磁盘内容重开(不恢复未保存修改)', async () => {
    open(A);
    st().updateContent(A, 'unsaved edits');
    expect(st().tabs[0]!.dirty).toBe(true);
    st().closeTab(A); // 确认框选「不保存」后的关闭
    await reopenClosedEditor(diskOf([A]));
    const tab = st().tabs.find((t) => t.id === A)!;
    expect(tab.content).toBe(`disk ${A}`);
    expect(tab.dirty).toBe(false);
  });

  it('视图状态回到关闭前:CodeMirror 选区 / 顶部可见行、Markdown 滚动', async () => {
    open(A);
    open(M);
    seedPersistedEditorViewState(A, { selection: { anchor: 3, head: 5 }, topLine: 7 });
    saveMarkdownScrollTop(M, 120);
    st().closeTab(A);
    st().closeTab(M);
    // 关闭后视图状态缓存随 tab 丢弃
    expect(persistedEditorViewStateOf(A, undefined)).toBeUndefined();
    expect(markdownScrollTopOf(M)).toBeUndefined();

    const disk = diskOf([A, M]);
    await reopenClosedEditor(disk);
    await reopenClosedEditor(disk);
    expect(markdownScrollTopOf(M)).toBe(120);
    expect(persistedEditorViewStateOf(A, undefined)).toEqual({ selection: { anchor: 3, head: 5 }, topLine: 7 });
  });

  it('插件经 SDK 打开的 tab 关闭不记录', () => {
    const plugin: EditorTab = { ...createTab(A, 'x'), pluginOpenedPath: A };
    st().openTab(plugin);
    st().closeTab(A);
    expect(recentlyClosedEditorPaths()).toEqual([]);
  });

  it('读盘期间用户又切到别的文件 → 只在后台插回,不抢激活', async () => {
    open(A);
    open(B);
    st().closeTab(A);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const readFile = vi.fn(async (p: string) => {
      await gate;
      return { ok: true as const, data: `disk ${p}` };
    });
    const pending = reopenClosedEditor({ fs: { readFile, writeFile: vi.fn() } } as never);
    open(C); // 用户在读盘期间打开了 C
    st().switchTab(C);
    release();
    expect(await pending).toBe(true);
    expect(ids()).toEqual([A, B, C]);
    expect(st().activeTabId).toBe(C);
  });
});

describe('openTab 的 index 选项(单元)', () => {
  it('新加入时插到 index(越界收进范围);已在组里的不移动', () => {
    open(A);
    open(B);
    st().openTab(createTab(C, 'c'), { index: 1 });
    expect(ids()).toEqual([A, C, B]);
    st().openTab(createTab('/w/z.ts', 'z'), { index: 99 });
    expect(ids()).toEqual([A, C, B, '/w/z.ts']);
    st().openTab(createTab('/w/y.ts', 'y'), { index: -5 });
    expect(ids()[0]).toBe('/w/y.ts');
    st().openTab(st().tabs.find((t) => t.id === B)!, { index: 0 });
    expect(ids()).toEqual(['/w/y.ts', A, C, B, '/w/z.ts']);
    expect(st().activeTabId).toBe(B);
    // 多组
    expect(st().splitGroup('editor', 'editor:2', A)).toBe(true);
    st().openTab(st().tabs.find((t) => t.id === C)!, { groupId: 'editor:2', index: 0 });
    expect(ids('editor:2')).toEqual([C, A]);
  });
});

describe('失效', () => {
  it('删除文件 / 目录 → 其下的条目移除', () => {
    open('/w/d/x.ts');
    open(A);
    st().closeTab('/w/d/x.ts');
    st().closeTab(A);
    st().removePaths(['/w/d']);
    expect(recentlyClosedEditorPaths()).toEqual([A]);
  });

  it('切换工作区根 → 不在新根下的条目移除;删除 / 切根关闭的 tab 不入栈', () => {
    open('/other/o.ts');
    open(A);
    st().closeTab('/other/o.ts');
    open(B);
    st().closeTabsOutsideRoot('/w2');
    expect(recentlyClosedEditorPaths()).toEqual([]);
    open('/w2/k.ts');
    st().removePaths(['/w2/k.ts']);
    expect(recentlyClosedEditorPaths()).toEqual([]);
  });
});

describe('编辑器组', () => {
  function twoGroups(): void {
    open(A);
    open(B);
    expect(st().splitGroup('editor', 'editor:2', B)).toBe(true);
    st().openTab(createTab(C, 'disk c'), { groupId: 'editor:2' });
    // editor = [A, B],editor:2 = [B, C],活动组 editor:2
  }

  it('原组还在 → 回原组原位置;活动组随之切到原组', async () => {
    twoGroups();
    st().closeTab(A, 'editor');
    st().setActiveGroup('editor:2');
    await reopenClosedEditor(diskOf([A, B, C]));
    expect(ids('editor')).toEqual([A, B]);
    expect(st().activeGroupId).toBe('editor');
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(A);
  });

  it('文件仍在别的组打开 → 在原组再打开它(同一文档,不重新读盘)', async () => {
    twoGroups();
    st().closeTab(B, 'editor:2');
    expect(ids('editor:2')).toEqual([C]);
    const disk = diskOf([A, B, C]);
    await reopenClosedEditor(disk);
    expect(ids('editor:2')).toEqual([B, C]);
    expect(groupActiveTabIdOf(st(), 'editor:2')).toBe(B);
    expect(disk.readFile).not.toHaveBeenCalled();
    expect(st().tabs.filter((t) => t.id === B)).toHaveLength(1);
  });

  it('关闭编辑器组 → 组里关掉的 tab 入栈(移走的脏 tab 不记);组已不在 → 落到当前活动组', async () => {
    twoGroups();
    st().updateContent(C, 'dirty');
    st().removeGroup('editor:2', 'dirty'); // dock 面板 ×:干净的关闭、脏的移到相邻组
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([A, B, C]);
    expect(recentlyClosedEditorPaths()).toEqual([B]);
    st().closeTab(A);
    st().closeTab(B);
    await reopenClosedEditor(diskOf([A, B, C]));
    await reopenClosedEditor(diskOf([A, B, C]));
    // 再关 B:来自已关闭的 editor:2 的旧条目被取代(同一路径只留栈顶一条)。栈顶 B(位置 0)→ A(位置 0)
    expect(ids('editor')).toEqual([A, B, C]);
    expect(await reopenClosedEditor(diskOf([A, B, C]))).toBe(false);
  });
});

describe('命令与快捷键', () => {
  it('workbench.action.reopenClosedEditor:默认 mod+shift+t(两平台),View 分类,三语标题', () => {
    expect(REOPEN_CLOSED_EDITOR_COMMAND).toEqual({ id: 'workbench.action.reopenClosedEditor', hotkey: 'mod+shift+t' });
    for (const platform of ['mac', 'other'] as const) {
      const spec = editorCommandSpecs(platform).find((s) => s.id === REOPEN_CLOSED_EDITOR_COMMAND.id);
      expect(spec?.hotkey).toBe('mod+shift+t');
      expect(spec?.categoryKey).toBe('commands.view.category');
      const k = spec!.titleKey as keyof typeof en;
      expect(en[k]).toBe('Reopen Closed Editor');
      expect(zh[k]).toBe('重新打开已关闭的编辑器');
      expect(ko[k]).toBeTruthy();
    }
  });

  it('默认键不与其它命令冲突', () => {
    for (const platform of ['mac', 'other'] as const) {
      const same = editorCommandSpecs(platform).filter((s) => s.hotkey === 'mod+shift+t');
      expect(same.map((s) => s.id)).toEqual([REOPEN_CLOSED_EDITOR_COMMAND.id]);
    }
  });

  it('终端里:mac ⇧⌘T 让出给命令;Windows / Linux Ctrl+Shift+T 照常进 shell', () => {
    expect(WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND).toEqual(REOPEN_CLOSED_EDITOR_COMMAND);
    const none = { getAll: () => [] };
    const key = (init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', shiftKey: true, ...init });
    expect(terminalYieldedCommandId(key({ metaKey: true }), 'mac', {}, none)).toBe(REOPEN_CLOSED_EDITOR_COMMAND.id);
    expect(terminalYieldedCommandId(key({ ctrlKey: true }), 'other', {}, none)).toBeNull();
  });
});
