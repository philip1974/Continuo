// @vitest-environment jsdom
// BDD:编辑器 tab 批量关闭中途遇「磁盘已被外部修改 / 写保护」确认(对齐 VSCode 组内批量关闭):覆盖 / 放弃并重新加载
// 成功后接着确认下一个脏 tab,全部确认完才一起关闭;任一处取消 / 失败 → 整批都不关。见同目录 README。
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

/** 右键 file-00 tab →「全部关闭」→ 第一个确认针对 file-01,选「保存」。 */
async function closeAllAndSaveFirst() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
  const first = Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) =>
    el.textContent?.startsWith('file-00'),
  )!;
  fireEvent.contextMenu(first);
  await click(screen.getByRole('menuitem', { name: 'Close All' }));
  expect(screen.getByText(saveTitle('file-01.ts'))).toBeTruthy();
  await click(button(t('common.save')));
}

describe('批量关闭中途遇写保护 / 磁盘冲突确认', () => {
  it('写保护 →「覆盖」成功 → 接着确认 file-03;「不保存」→ 全部关闭', async () => {
    mocks.readonly.add(P[1]!);
    await closeAllAndSaveFirst();
    await screen.findByText(t('panels.editor.readonly_title'));
    await click(button(t('panels.editor.readonly_confirm')));
    expect(mocks.disk.get(P[1]!)).toBe('mine');
    expect(openIds()).toEqual(P); // 尚未全部确认完 → 一个都不关
    expect(screen.getByText(saveTitle('file-03.ts'))).toBeTruthy();
    await click(button(t('dialog.unsaved_close.dont_save')));
    expect(openIds()).toEqual([]);
  });

  it('磁盘已修改 →「仍然覆盖」成功 → 接着确认 file-03', async () => {
    mocks.disk.set(P[1]!, 'theirs');
    await closeAllAndSaveFirst();
    await click(button(t('panels.editor.disk_changed_confirm')));
    expect(mocks.disk.get(P[1]!)).toBe('mine');
    expect(screen.getByText(saveTitle('file-03.ts'))).toBeTruthy();
    await click(button(t('common.save')));
    expect(mocks.disk.get(P[3]!)).toBe('mine');
    expect(openIds()).toEqual([]);
  });

  it('磁盘已修改 →「放弃并重新加载」成功 → 接着确认 file-03', async () => {
    mocks.disk.set(P[1]!, 'theirs');
    await closeAllAndSaveFirst();
    await click(button(t('panels.editor.disk_changed_revert')));
    expect(screen.getByText(saveTitle('file-03.ts'))).toBeTruthy();
    await click(button(t('dialog.unsaved_close.dont_save')));
    expect(openIds()).toEqual([]);
  });

  it('磁盘已修改 → 再遇写保护 →「覆盖」成功 → 仍接着确认 file-03', async () => {
    mocks.disk.set(P[1]!, 'theirs');
    mocks.readonly.add(P[1]!);
    await closeAllAndSaveFirst();
    await click(button(t('panels.editor.disk_changed_confirm')));
    await screen.findByText(t('panels.editor.readonly_title'));
    await click(button(t('panels.editor.readonly_confirm')));
    expect(screen.getByText(saveTitle('file-03.ts'))).toBeTruthy();
  });

  it('写保护确认「取消」→ 整批结束:一个都不关,不再问 file-03', async () => {
    mocks.readonly.add(P[1]!);
    await closeAllAndSaveFirst();
    await screen.findByText(t('panels.editor.readonly_title'));
    await click(button(t('panels.explorer.confirm.cancel')));
    expect(openIds()).toEqual(P);
    expect(screen.queryByText(saveTitle('file-03.ts'))).toBeNull();
  });

  it('前面选「不保存」、后面「取消」→ 整批不动(已确认不保存的也不关)', async () => {
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    const first = Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) =>
      el.textContent?.startsWith('file-00'),
    )!;
    fireEvent.contextMenu(first);
    await click(screen.getByRole('menuitem', { name: 'Close All' }));
    await click(button(t('dialog.unsaved_close.dont_save')));
    expect(screen.getByText(saveTitle('file-03.ts'))).toBeTruthy();
    await click(button(t('panels.explorer.confirm.cancel')));
    expect(openIds()).toEqual(P);
  });
});
