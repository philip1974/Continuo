// @vitest-environment jsdom
// BDD: files-auto-save 第 6 条 —— 关闭脏 tab 时按生效自动保存模式直接保存、不弹「是否保存」(VSCode editorGroupView.doHandleCloseConfirmation):
// onFocusChange 总是;onWindowChange 只在 Windows / Linux,macOS 照常弹框;Markdown 语言级覆盖(afterDelay)照常弹框。
// 保存失败 / 磁盘冲突 / 写保护 / 已删除 → 不关 tab,改弹确认框(VSCode skipAutoSave)。批量关闭:自动保存的 tab 不进合并框。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { setLocale, t } from '../../i18n';
import { registerEditorWriteBack } from '../../panels/Editor/editor-writeback-registry';
import { saveAllEditors } from '../../panels/Editor/editor-commands';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  error: vi.fn(),
  disk: new Map<string, string>(),
  readonly: new Set<string>(),
  denied: new Set<string>(),
  /** 保存写盘期间编辑器里又打的字(尚未上抛 store,同 Milkdown 延迟回写):写盘时置上,回写时并进 store。 */
  typedDuringSave: new Map<string, string>(),
  pending: new Map<string, string>(),
  settings: new Map<string, unknown>(),
}));

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(id: string, fallback: T) => (mocks.settings.has(id) ? (mocks.settings.get(id) as T) : fallback),
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: { readFile: mocks.readFile, writeFile: mocks.writeFile, onDirChanged: vi.fn(() => vi.fn()) },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: mocks.error, info: vi.fn(), success: vi.fn() },
}));

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const MD = '/w/n.md';

function tab(path: string, dirty: boolean, extra: Partial<EditorTab> = {}): EditorTab {
  return { id: path, filePath: path, content: dirty ? 'mine' : 'orig', originalContent: 'orig', dirty, ...extra };
}

function setup(tabs: EditorTab[]): void {
  for (const x of tabs) mocks.disk.set(x.filePath, 'orig');
  useEditorStore.setState({ tabs, activeTabId: tabs[0]!.id, mode: 'source' });
}

beforeEach(() => {
  setLocale('en');
  vi.clearAllMocks();
  mocks.disk.clear();
  mocks.readonly.clear();
  mocks.denied.clear();
  mocks.typedDuringSave.clear();
  mocks.pending.clear();
  mocks.settings.clear();
  mocks.settings.set('files.autoSave', 'onFocusChange');
  mocks.readFile.mockImplementation(async (p: string) =>
    mocks.disk.has(p) ? { ok: true, data: mocks.disk.get(p) } : { ok: false, code: 'FS_NOT_FOUND', message: 'missing' },
  );
  mocks.writeFile.mockImplementation(async (p: string, c: string, o?: { overwriteReadonly?: boolean }) => {
    if (mocks.readonly.has(p) && !o?.overwriteReadonly) return { ok: false, code: 'FS_READONLY', message: 'ro' };
    if (mocks.denied.has(p)) return { ok: false, code: 'FS_DENIED', message: 'denied' };
    mocks.disk.set(p, c);
    const typed = mocks.typedDuringSave.get(p);
    if (typed !== undefined) {
      mocks.typedDuringSave.delete(p);
      mocks.pending.set(p, typed);
    }
    return { ok: true, data: undefined };
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
const offWriteBacks: (() => void)[] = [];
/** 模拟编辑器的同步回写句柄:把尚未上抛的输入并进 store。 */
function withEditorWriteBack(path: string): void {
  offWriteBacks.push(
    registerEditorWriteBack(path, () => {
      const typed = mocks.pending.get(path);
      if (typed === undefined) return;
      mocks.pending.delete(path);
      useEditorStore.getState().updateContent(path, typed);
    }),
  );
}
afterEach(() => {
  for (const off of offWriteBacks.splice(0)) off();
  cleanup();
  vi.restoreAllMocks();
});

const openIds = () => useEditorStore.getState().tabs.map((x) => x.id);
const saveTitle = (name: string) => t('panels.editor.save_changes_title', { name });
const multiTitle = (count: number) => t('dialog.unsaved_close.message', { count });
const listedNames = () => Array.from(document.querySelectorAll('[role=dialog] li')).map((li) => li.textContent);

async function settle() {
  await act(() => new Promise((r) => setTimeout(r, 0)));
  await act(() => new Promise((r) => setTimeout(r, 0)));
}
async function openPanel() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
}
async function closeTab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: name }) }));
  });
  await settle();
}
async function closeAll() {
  const first = document.querySelector<HTMLElement>('[role=tab]')!;
  fireEvent.contextMenu(first);
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close All' }));
  });
  await settle();
}

describe('onFocusChange:关闭脏 tab 直接保存,不弹框', () => {
  it('保存成功 → 写盘并关闭,不出现确认框', async () => {
    setup([tab(A, true)]);
    await openPanel();
    await closeTab('a.ts');
    expect(screen.queryByText(saveTitle('a.ts'))).toBeNull();
    expect(mocks.disk.get(A)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('保存失败(无权限)→ 提示失败、tab 不关,改弹确认框;选「不保存」才关闭', async () => {
    setup([tab(A, true)]);
    mocks.denied.add(A);
    await openPanel();
    await closeTab('a.ts');
    expect(mocks.error).toHaveBeenCalled();
    expect(openIds()).toEqual([A]);
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('dialog.unsaved_close.dont_save') }));
    });
    await settle();
    expect(openIds()).toEqual([]);
    expect(mocks.disk.get(A)).toBe('orig');
  });

  it('磁盘已被外部修改 → 不覆盖、不关 tab,改弹确认框;不另弹保存失败提示(第五十一轮审计 A5:此前 toast 主进程英文原文与完整路径)', async () => {
    setup([tab(A, true)]);
    mocks.disk.set(A, 'theirs');
    await openPanel();
    await closeTab('a.ts');
    expect(mocks.disk.get(A)).toBe('theirs');
    expect(openIds()).toEqual([A]);
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
    // 确认框选「保存」→ 覆盖确认(与显式保存遇冲突同一出路)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    });
    await settle();
    expect(screen.getByText(t('panels.editor.disk_changed_title'))).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  // 第五十一轮审计 A1:保存写盘期间接着打字(编辑器延迟回写还没进 store)→ 保存完先回写再判定,仍脏 → 不关,改弹确认框(VSCode
  // doHandleCloseConfirmation 保存后再查 isDirty)。此前按 store 的旧脏态判定直接关闭,新打的字丢失。
  it('保存写盘期间又打了字 → 保存后仍脏,tab 不关、弹确认框,新打的字留在 tab 里', async () => {
    setup([tab(A, true)]);
    withEditorWriteBack(A);
    mocks.typedDuringSave.set(A, 'mine more');
    await openPanel();
    await closeTab('a.ts');
    expect(mocks.disk.get(A)).toBe('mine');
    expect(openIds()).toEqual([A]);
    expect(useEditorStore.getState().tabs[0]!.content).toBe('mine more');
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
    // 再选「保存」→ 这次写盘后不再脏 → 关闭
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    });
    await settle();
    expect(mocks.disk.get(A)).toBe('mine more');
    expect(openIds()).toEqual([]);
  });

  it('确认框选「保存」写盘期间又打了字 → 同样不关、重新确认', async () => {
    setup([tab(MD, true)]); // Markdown 默认 afterDelay:关闭时弹框
    withEditorWriteBack(MD);
    await openPanel();
    await closeTab('n.md');
    mocks.typedDuringSave.set(MD, 'mine more');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    });
    await settle();
    expect(mocks.disk.get(MD)).toBe('mine');
    expect(openIds()).toEqual([MD]);
    expect(screen.getByText(saveTitle('n.md'))).toBeTruthy();
  });

  it('写保护 → 不去写保护、不关 tab,改弹确认框', async () => {
    setup([tab(A, true)]);
    mocks.readonly.add(A);
    await openPanel();
    await closeTab('a.ts');
    expect(mocks.disk.get(A)).toBe('orig');
    expect(openIds()).toEqual([A]);
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
  });

  it('已删除(orphaned)→ 不重建文件,弹确认框', async () => {
    setup([tab(A, true, { orphaned: true })]);
    mocks.disk.delete(A);
    await openPanel();
    await closeTab('a.ts');
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(openIds()).toEqual([A]);
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
  });

  it('Markdown 语言级覆盖开(afterDelay)→ Markdown 照常弹框;覆盖关 → 跟随 onFocusChange 直接保存', async () => {
    setup([tab(MD, true)]);
    await openPanel();
    await closeTab('n.md');
    expect(screen.getByText(saveTitle('n.md'))).toBeTruthy();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    cleanup();

    mocks.settings.set('autoSave.markdown.enabled', false);
    setup([tab(MD, true)]);
    await openPanel();
    await closeTab('n.md');
    expect(screen.queryByText(saveTitle('n.md'))).toBeNull();
    expect(mocks.disk.get(MD)).toBe('mine');
    expect(openIds()).toEqual([]);
  });
});

describe('onWindowChange:只在 Windows / Linux 直接保存', () => {
  beforeEach(() => mocks.settings.set('files.autoSave', 'onWindowChange'));

  it('Windows / Linux → 直接保存并关闭', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    setup([tab(A, true)]);
    await openPanel();
    await closeTab('a.ts');
    expect(mocks.disk.get(A)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('macOS → 照常弹「是否保存」', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    setup([tab(A, true)]);
    await openPanel();
    await closeTab('a.ts');
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(openIds()).toEqual([A]);
  });
});

describe('批量关闭', () => {
  it('全部是 onFocusChange 的脏 tab → 不弹合并框,逐个保存后全部关闭', async () => {
    setup([tab(A, true), tab(B, false), tab(C, true)]);
    await openPanel();
    await closeAll();
    expect(screen.queryByText(multiTitle(2))).toBeNull();
    expect(mocks.disk.get(A)).toBe('mine');
    expect(mocks.disk.get(C)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('只剩 1 个要确认的(Markdown 覆盖)→ 自动保存其余,只为它弹单文件框', async () => {
    setup([tab(A, true), tab(MD, true), tab(C, true)]);
    await openPanel();
    await closeAll();
    expect(screen.queryByText(multiTitle(3))).toBeNull();
    expect(screen.getByText(saveTitle('n.md'))).toBeTruthy();
    expect(mocks.disk.get(A)).toBe('mine');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('dialog.unsaved_close.dont_save') }));
    });
    await settle();
    expect(mocks.disk.get(C)).toBe('mine');
    expect(mocks.disk.get(MD)).toBe('orig');
    expect(openIds()).toEqual([]);
  });

  it('合并框只列需要确认的文件;选「不保存」→ 它们丢弃,自动保存的照常保存', async () => {
    const MD2 = '/w/m.md';
    setup([tab(A, true), tab(MD, true), tab(MD2, true)]);
    await openPanel();
    await closeAll();
    expect(screen.getByText(multiTitle(2))).toBeTruthy();
    expect(listedNames()).toEqual(['n.md', 'm.md']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('dialog.unsaved_close.dont_save') }));
    });
    await settle();
    expect(mocks.disk.get(A)).toBe('mine');
    expect(mocks.disk.get(MD)).toBe('orig');
    expect(mocks.disk.get(MD2)).toBe('orig');
    expect(openIds()).toEqual([]);
  });

  it('批量:前一个保存写盘期间又打了字 → 为它重新确认,选「取消」整批不关', async () => {
    setup([tab(A, true), tab(C, true)]);
    withEditorWriteBack(A);
    mocks.typedDuringSave.set(A, 'mine more');
    await openPanel();
    await closeAll();
    expect(screen.getByText(saveTitle('a.ts'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.confirm.cancel') }));
    });
    await settle();
    expect(openIds()).toEqual([A, C]);
    expect(useEditorStore.getState().tabs[0]!.content).toBe('mine more');
  });

  it('其中一个自动保存失败 → 为它弹确认框,选「取消」整批不关', async () => {
    setup([tab(A, true), tab(C, true)]);
    mocks.denied.add(C);
    await openPanel();
    await closeAll();
    expect(screen.getByText(saveTitle('c.ts'))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.confirm.cancel') }));
    });
    await settle();
    expect(mocks.disk.get(A)).toBe('mine');
    expect(openIds()).toEqual([A, C]);
  });
});

// 第五十一轮审计 A5 的兄弟入口:全部保存(⌥⌘S)已弹过一个确认框后,其余 tab 遇磁盘冲突只提示 —— 提示按语言本地化、填保存键,
// 不显示主进程的英文原文与完整路径。
describe('全部保存:其余 tab 遇磁盘冲突的提示本地化', () => {
  it('第二个冲突的 tab → 本地化提示(含保存键),不含完整路径', async () => {
    mocks.settings.set('files.autoSave', 'off');
    setLocale('zh');
    setup([tab(A, true), tab(B, true)]);
    mocks.disk.set(A, 'theirs');
    mocks.disk.set(B, 'theirs');
    await openPanel();
    await act(async () => {
      await saveAllEditors();
    });
    await settle();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const text = String(mocks.error.mock.calls[0]![0]);
    expect(text).toContain(t('errors.EDITOR_DISK_CHANGED', { hotkey: '' }).slice(0, 6));
    expect(text).not.toContain(B);
    expect(text).not.toMatch(/[A-Za-z]{4,} [A-Za-z]{4,}/); // 没有英文句子
  });
});
