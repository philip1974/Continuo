// 无标题文本文件(行为见同目录 README)。被测:panels/Editor/untitled.ts、editor-file-actions saveFile、useAutoSave、
// lib/persist/explorer-persist、stores/editor.store(最近关闭)、shell/dock/dirty-close、electron/main/dirty-close-confirm。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';
import { editorTabTitle, newUntitledFile, nextUntitledNumber } from '../../panels/Editor/untitled';
import { EDITOR_UNTITLED, saveFile } from '../../panels/Editor/editor-file-actions';
import { isAutoSaveEnabled } from '../../panels/Editor/useAutoSave';
import { collectEditorSnapshot } from '../../lib/persist/explorer-persist';
import { popRecentlyClosedEditor } from '../../panels/Editor/recently-closed-editors';
import { saveDirtyTabsForClose, saveForCloseFailureMessage } from '../../shell/dock/dirty-close';
import { buildDirtyCloseDialog } from '../../../electron/main/dirty-close-confirm';
import { setLocale, t } from '../../i18n';
import type { MainT } from '../../../electron/main/i18n';
import { LOCALE_DICTS, interpolateTemplate } from '../../../electron/shared/i18n-interpolate';
import { isUntitledPath, untitledNumberOf, untitledPath } from '../../../electron/shared/untitled';

const st = () => useEditorStore.getState();
/** main 端 t(同 getMainT 的查找链,locale 显式给出)。 */
const createMainT =
  (locale: keyof typeof LOCALE_DICTS): MainT =>
  (key, params) => {
    const dict = LOCALE_DICTS[locale] as Record<string, string>;
    const tpl = dict[key] ?? (LOCALE_DICTS.en as Record<string, string>)[key] ?? key;
    return params ? interpolateTemplate(tpl, params) : tpl;
  };

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: PRIMARY_EDITOR_GROUP_ID, tabIds: [], activeTabId: null }],
    activeGroupId: PRIMARY_EDITOR_GROUP_ID,
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
});
afterEach(() => setLocale('en'));

describe('标识', () => {
  it('untitled:Untitled-N;只认正整数编号', () => {
    expect(untitledPath(3)).toBe('untitled:Untitled-3');
    expect(untitledNumberOf('untitled:Untitled-12')).toBe(12);
    for (const p of ['untitled:Untitled-0', 'untitled:Untitled-01', 'untitled:Untitled-x', '/work/Untitled-1', 'Untitled-1']) {
      expect(isUntitledPath(p)).toBe(false);
    }
  });
});

describe('新建无标题文本文件', () => {
  it('打开空的 Untitled-1 并激活,常驻(不是预览)、不脏、纯文本(无扩展名)', () => {
    const id = newUntitledFile();
    expect(id).toBe('untitled:Untitled-1');
    expect(st().activeTabId).toBe(id);
    expect(st().tabs[0]).toMatchObject({ id, content: '', dirty: false, milkdownUnsafe: false });
    expect(st().previewTabs.size).toBe(0);
  });

  it('编号取未被占用的最小正整数', () => {
    newUntitledFile();
    newUntitledFile();
    expect(st().tabs.map((x) => x.id)).toEqual(['untitled:Untitled-1', 'untitled:Untitled-2']);
    st().closeTab('untitled:Untitled-1');
    expect(newUntitledFile()).toBe('untitled:Untitled-1');
    expect(nextUntitledNumber(st().tabs)).toBe(3);
  });

  it.each([
    ['en', 'Untitled-2'],
    ['zh', '无标题-2'],
    ['ko', '제목 없음-2'],
  ] as const)('%s:tab 名 = %s;磁盘文件照常显示文件名', (locale, title) => {
    setLocale(locale);
    expect(editorTabTitle('untitled:Untitled-2')).toBe(title);
    expect(editorTabTitle('/work/a.ts')).toBe('a.ts');
  });

  it('落在指定的编辑器组(命令传触发窗口的组,popout 子窗里 ⌘N 落在子窗)', () => {
    st().openTab(createTab('/work/a.ts', 'a'));
    st().splitGroup(PRIMARY_EDITOR_GROUP_ID, 'editor:2', null);
    const id = newUntitledFile('editor:2');
    const groups = st().groups;
    expect(groups.find((g) => g.id === 'editor:2')).toMatchObject({ tabIds: [id], activeTabId: id });
    expect(groups.find((g) => g.id === PRIMARY_EDITOR_GROUP_ID)?.tabIds).toEqual(['/work/a.ts']);
  });

  it('输入后变脏', () => {
    const id = newUntitledFile();
    st().updateContent(id, 'hello');
    expect(st().tabs[0]?.dirty).toBe(true);
  });
});

describe('保存与自动保存', () => {
  it('按路径保存无标题文件 → EDITOR_UNTITLED(调用方改走另存为),不读不写', async () => {
    const id = newUntitledFile();
    st().updateContent(id, 'x');
    const fs = { readFile: vi.fn(), writeFile: vi.fn() };
    expect(await saveFile(id, { fs })).toMatchObject({ ok: false, code: EDITOR_UNTITLED });
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('自动保存跳过无标题文件', () => {
    expect(isAutoSaveEnabled('untitled:Untitled-1')).toBe(false);
    expect(isAutoSaveEnabled('/work/a.md')).toBe(true);
  });
});

describe('不持久化、不进最近关闭', () => {
  it('会话快照跳过无标题 tab(活动的也不记)', () => {
    st().openTab(createTab('/work/a.ts', 'a'));
    const id = newUntitledFile();
    expect(collectEditorSnapshot(st().tabs, id)).toEqual({ openFilePaths: ['/work/a.ts'], activePath: null });
  });

  it('关闭无标题 tab 不进最近关闭(⇧⌘T 不会去读不存在的路径)', () => {
    while (popRecentlyClosedEditor()) {
      /* drain */
    }
    st().openTab(createTab('/work/a.ts', 'a'));
    const id = newUntitledFile();
    st().closeTab(id);
    st().closeTab('/work/a.ts');
    expect(popRecentlyClosedEditor()?.path).toBe('/work/a.ts');
    expect(popRecentlyClosedEditor()).toBeUndefined();
  });
});

describe('关窗 / 退出', () => {
  it('确认框里显示按界面语言的「Untitled-N」', () => {
    for (const locale of ['en', 'zh', 'ko'] as const) {
      const mt = createMainT(locale);
      const d = buildDirtyCloseDialog({ dirty: 1, ids: ['untitled:Untitled-4#7'] }, mt);
      expect(d.message).toBe(mt('panels.editor.save_changes_title', { name: mt('editor.untitled_name', { n: 4 }) }));
      const multi = buildDirtyCloseDialog({ dirty: 2, ids: ['/w/a.ts#1', 'untitled:Untitled-1#2'] }, mt);
      expect(multi.detail.split('\n').slice(0, 2)).toEqual(['a.ts', mt('editor.untitled_name', { n: 1 })]);
    }
  });

  it('确认框选「保存」:无标题文件计入失败并追加命名保存的出路', async () => {
    const tabs = [
      { id: 'untitled:Untitled-1', filePath: 'untitled:Untitled-1', dirty: true },
      { id: '/w/a.ts', filePath: '/w/a.ts', dirty: true },
    ];
    const saveTab = vi.fn(async (id: string) =>
      id.startsWith('untitled:') ? { ok: false, code: EDITOR_UNTITLED } : { ok: true },
    );
    const r = await saveDirtyTabsForClose(tabs, saveTab, () => [tabs[0]!]);
    expect(r).toMatchObject({ failed: 1, untitled: 1, failedPaths: ['untitled:Untitled-1'] });
    const msg = saveForCloseFailureMessage(r, '⌘S');
    expect(msg).toContain(t('dialog.unsaved_close.untitled_note', { count: 1, hotkey: '⌘S' }));
    expect(msg).toContain('Untitled-1');
    expect(msg).not.toContain('untitled:');
  });
});
