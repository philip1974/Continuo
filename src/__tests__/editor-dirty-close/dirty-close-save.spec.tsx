// @vitest-environment jsdom
// 关闭脏 tab 的确认框(VSCode 式「保存 / 不保存 / 取消」)。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { t } from '../../i18n';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  error: vi.fn(),
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
    fs: {
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: mocks.error, info: vi.fn(), success: vi.fn() },
}));

const PATH = '/work/a.ts';
const TITLE = () => t('panels.editor.save_changes_title', { name: 'a.ts' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'mine', originalContent: 'orig', dirty: true }],
    activeTabId: PATH,
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

async function openCloseDialog() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
  fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.ts' }) }));
  expect(screen.getByText(TITLE())).toBeTruthy();
}

const saveButton = () => screen.getByRole('button', { name: t('common.save') });
const dontSaveButton = () =>
  screen.getByRole('button', { name: t('dialog.unsaved_close.dont_save') });

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('关闭脏 tab:保存 / 不保存 / 取消', () => {
  it('三个按钮,顺序 [不保存, 取消, 保存],初始焦点在「保存」', async () => {
    await openCloseDialog();
    const dialog = screen.getByRole('dialog');
    const labels = Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual([
      t('dialog.unsaved_close.dont_save'),
      t('panels.explorer.confirm.cancel'),
      t('common.save'),
    ]);
    expect(document.activeElement).toBe(saveButton());
  });

  it('保存 → 写盘当前内容并关闭 tab', async () => {
    await openCloseDialog();
    await click(saveButton());
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'mine');
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(screen.queryByText(TITLE())).toBeNull();
  });

  it('保存遇磁盘已被外部修改 → 弹覆盖确认、tab 保持打开;确认覆盖后写盘并关闭', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs' });
    await openCloseDialog();
    await click(saveButton());
    expect(screen.getByText(t('panels.editor.disk_changed_title'))).toBeTruthy();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs).toHaveLength(1);

    await click(screen.getByRole('button', { name: t('panels.editor.disk_changed_confirm') }));
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'mine');
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it('覆盖确认点取消 → tab 保持打开且仍脏', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs' });
    await openCloseDialog();
    await click(saveButton());
    await click(screen.getByRole('button', { name: t('panels.explorer.confirm.cancel') }));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
  });

  it('保存失败 → 不关闭 tab,弹错误提示', async () => {
    mocks.writeFile.mockResolvedValue({ ok: false, code: 'FS_PERMISSION_DENIED', message: 'EACCES' });
    await openCloseDialog();
    await click(saveButton());
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
    expect(mocks.error).toHaveBeenCalledTimes(1);
  });

  it('不保存 → 不写盘,关闭 tab', async () => {
    await openCloseDialog();
    await click(dontSaveButton());
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });
});
