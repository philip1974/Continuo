// @vitest-environment jsdom
// BDD:编辑器 tab 批量关闭遇多个脏文件 → 一个合并确认框(VSCode showSaveConfirm「全部保存 / 不保存 / 取消」,列出文件名);
//「全部保存」中途遇「磁盘已被外部修改 / 写保护」确认:覆盖 / 放弃并重新加载成功后接着保存下一个,全部处理完才一起关闭;
// 任一处取消 / 失败 → 整批都不关。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { setLocale, t } from '../../i18n';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  error: vi.fn(),
  disk: new Map<string, string>(),
  readonly: new Set<string>(),
}));

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
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

const P = ['/w/file-00.ts', '/w/file-01.ts', '/w/file-02.ts', '/w/file-03.ts'];

function tab(path: string, dirty: boolean): EditorTab {
  return { id: path, filePath: path, content: dirty ? 'mine' : 'orig', originalContent: 'orig', dirty };
}

beforeEach(() => {
  setLocale('en');
  vi.clearAllMocks();
  mocks.disk.clear();
  mocks.readonly.clear();
  for (const p of P) mocks.disk.set(p, 'orig');
  mocks.readFile.mockImplementation(async (p: string) => ({ ok: true, data: mocks.disk.get(p) }));
  mocks.writeFile.mockImplementation(async (p: string, c: string, o?: { overwriteReadonly?: boolean }) => {
    if (mocks.readonly.has(p) && !o?.overwriteReadonly) {
      return { ok: false, code: 'FS_READONLY', message: `file is write-protected: ${p}` };
    }
    mocks.disk.set(p, c);
    return { ok: true, data: undefined };
  });
  // 01、03 脏
  useEditorStore.setState({
    tabs: [tab(P[0]!, false), tab(P[1]!, true), tab(P[2]!, false), tab(P[3]!, true)],
    activeTabId: P[0]!,
    mode: 'source',
  });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const openIds = () => useEditorStore.getState().tabs.map((x) => x.id);
const saveTitle = (name: string) => t('panels.editor.save_changes_title', { name });

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}
const button = (name: string) => screen.getByRole('button', { name });

const multiTitle = (count: number) => t('dialog.unsaved_close.message', { count });
const dialogText = () => document.querySelector('[role=dialog], [role=alertdialog]')?.textContent ?? '';
/** 合并框里逐行列出的文件名。 */
const listedNames = () =>
  Array.from(document.querySelectorAll('[role=dialog] li')).map((li) => li.textContent);

async function openPanel() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
}
/** 右键 file-00 tab →「全部关闭」。 */
async function closeAll() {
  const first = Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) =>
    el.textContent?.startsWith('file-00'),
  )!;
  fireEvent.contextMenu(first);
  await click(screen.getByRole('menuitem', { name: 'Close All' }));
  // 关闭类项在菜单关闭、焦点还原后才执行(Radix 在 setTimeout 里还原,见 TabContextMenu opensDialog)
  await act(() => new Promise((r) => setTimeout(r, 0)));
}
/** 「全部关闭」→ 合并框(file-01、file-03)→「全部保存」。 */
async function closeAllAndSaveAll() {
  await openPanel();
  await closeAll();
  expect(screen.getByText(multiTitle(2))).toBeTruthy();
  await click(button(t('dialog.unsaved_close.save_all')));
}

describe('多个脏文件 → 一个合并确认框', () => {
  it('列出全部脏文件名(不含干净的),不逐个弹单文件确认框', async () => {
    await openPanel();
    await closeAll();
    expect(screen.getByText(multiTitle(2))).toBeTruthy();
    expect(listedNames()).toEqual(['file-01.ts', 'file-03.ts']);
    expect(dialogText()).not.toContain('file-00.ts');
    expect(dialogText()).toContain(t('dialog.unsaved_close.detail'));
    expect(screen.queryByText(saveTitle('file-01.ts'))).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('「全部保存」→ 依次保存全部脏文件后一起关闭,不再弹框', async () => {
    await closeAllAndSaveAll();
    expect(mocks.disk.get(P[1]!)).toBe('mine');
    expect(mocks.disk.get(P[3]!)).toBe('mine');
    expect(openIds()).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('「不保存」→ 不写盘,全部关闭', async () => {
    await openPanel();
    await closeAll();
    await click(button(t('dialog.unsaved_close.dont_save')));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(openIds()).toEqual([]);
  });

  it('「取消」→ 整批不动,不写盘', async () => {
    await openPanel();
    await closeAll();
    await click(button(t('panels.explorer.confirm.cancel')));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(openIds()).toEqual(P);
  });

  it('超过 10 个脏文件 → 只列前 10 个,其余一行概括', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `/w/m-${String(i).padStart(2, '0')}.ts`);
    useEditorStore.setState({ tabs: many.map((p) => tab(p, true)), activeTabId: many[0]!, mode: 'source' });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    const first = document.querySelector<HTMLElement>('[role=tab]')!;
    fireEvent.contextMenu(first);
    await click(screen.getByRole('menuitem', { name: 'Close All' }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByText(multiTitle(12))).toBeTruthy();
    expect(listedNames()).toEqual([
      ...many.slice(0, 10).map((p) => p.slice('/w/'.length)),
      t('dialog.unsaved_close.more_other', { count: 2 }),
    ]);
  });

  it('只有 1 个脏文件 → 仍是单文件「保存 / 不保存 / 取消」确认框', async () => {
    useEditorStore.setState({ tabs: [tab(P[0]!, false), tab(P[1]!, true)], activeTabId: P[0]!, mode: 'source' });
    await openPanel();
    await closeAll();
    expect(screen.getByText(saveTitle('file-01.ts'))).toBeTruthy();
    expect(screen.queryByText(multiTitle(1))).toBeNull();
  });
});

describe('「全部保存」中途遇写保护 / 磁盘冲突 / 保存失败', () => {
  it('写保护 →「覆盖」成功 → 接着保存 file-03 → 全部关闭', async () => {
    mocks.readonly.add(P[1]!);
    await closeAllAndSaveAll();
    await screen.findByText(t('panels.editor.readonly_title'));
    expect(openIds()).toEqual(P); // 尚未处理完 → 一个都不关
    expect(mocks.disk.get(P[3]!)).toBe('orig'); // 按顺序:file-01 未解决前不保存后面的
    await click(button(t('panels.editor.readonly_confirm')));
    expect(mocks.disk.get(P[1]!)).toBe('mine');
    expect(mocks.disk.get(P[3]!)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('磁盘已修改 →「仍然覆盖」成功 → 接着保存 file-03', async () => {
    mocks.disk.set(P[1]!, 'theirs');
    await closeAllAndSaveAll();
    await click(button(t('panels.editor.disk_changed_confirm')));
    expect(mocks.disk.get(P[1]!)).toBe('mine');
    expect(mocks.disk.get(P[3]!)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('磁盘已修改 →「放弃并重新加载」成功 → 接着保存 file-03', async () => {
    mocks.disk.set(P[1]!, 'theirs');
    await closeAllAndSaveAll();
    await click(button(t('panels.editor.disk_changed_revert')));
    expect(mocks.disk.get(P[1]!)).toBe('theirs');
    expect(mocks.disk.get(P[3]!)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('磁盘已修改 → 再遇写保护 →「覆盖」成功 → 仍接着保存 file-03', async () => {
    mocks.disk.set(P[1]!, 'theirs');
    mocks.readonly.add(P[1]!);
    await closeAllAndSaveAll();
    await click(button(t('panels.editor.disk_changed_confirm')));
    await screen.findByText(t('panels.editor.readonly_title'));
    await click(button(t('panels.editor.readonly_confirm')));
    expect(mocks.disk.get(P[3]!)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('写保护确认「取消」→ 整批结束:一个都不关,不再保存 file-03', async () => {
    mocks.readonly.add(P[1]!);
    await closeAllAndSaveAll();
    await screen.findByText(t('panels.editor.readonly_title'));
    await click(button(t('panels.explorer.confirm.cancel')));
    expect(openIds()).toEqual(P);
    expect(mocks.disk.get(P[3]!)).toBe('orig');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('其它保存失败 → 失败提示,整批结束:一个都不关,改动留在 tab 里,不再保存后面的', async () => {
    mocks.writeFile.mockImplementationOnce(async () => ({ ok: false, code: 'FS_PERMISSION_DENIED', message: 'EACCES' }));
    await closeAllAndSaveAll();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(openIds()).toEqual(P);
    expect(useEditorStore.getState().tabs.find((x) => x.id === P[1])!.dirty).toBe(true);
    expect(mocks.disk.get(P[3]!)).toBe('orig');
  });
});
