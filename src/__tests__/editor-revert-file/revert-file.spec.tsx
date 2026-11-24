// @vitest-environment jsdom
// BDD: 还原文件(workbench.action.files.revert)与磁盘冲突时「放弃更改并重新加载」。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import {
  REVERT_COMMAND_ID,
  editorCommandSpecs,
  revertActiveEditor,
  saveActiveEditor,
} from '../../panels/Editor/editor-commands';
import { t } from '../../i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

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

beforeEach(() => {
  vi.clearAllMocks();
  // 磁盘上已是别人的版本
  mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs' });
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

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const tab = () => useEditorStore.getState().tabs[0];
const revertButton = () => screen.getByRole('button', { name: t('panels.editor.disk_changed_revert') });

async function saveIntoConflict() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
  // ⌘S(workbench.action.files.save)经面板注册的保存实现
  await act(async () => {
    await saveActiveEditor();
  });
  expect(screen.getByText(t('panels.editor.disk_changed_title'))).toBeTruthy();
}

describe('磁盘冲突:覆盖 / 放弃更改并重新加载 / 取消', () => {
  it('覆盖确认框提供「放弃更改并重新加载」', async () => {
    await saveIntoConflict();
    const labels = Array.from(screen.getByRole('dialog').querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual([
      t('panels.editor.disk_changed_revert'),
      t('panels.explorer.confirm.cancel'),
      t('panels.editor.disk_changed_confirm'),
    ]);
  });

  it('放弃更改并重新加载 → 不写盘,tab 内容换成磁盘版本且不再脏,确认框关闭', async () => {
    await saveIntoConflict();
    const epoch = tab()?.reloadEpoch ?? 0;
    await click(revertButton());
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(tab()).toMatchObject({ content: 'theirs', originalContent: 'theirs', dirty: false });
    // Milkdown 视图靠 reloadEpoch 重挂拿新内容(与外部同步同一路径)
    expect(tab()?.reloadEpoch).toBe(epoch + 1);
    expect(screen.queryByText(t('panels.editor.disk_changed_title'))).toBeNull();
    expect(screen.getByTestId('code-editor').textContent).toBe('theirs');
  });

  it('来自关闭脏 tab 的「保存」遇冲突 → 放弃更改并重新加载后关闭该 tab', async () => {
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.ts' }) }));
    await click(screen.getByRole('button', { name: t('common.save') }));
    await click(revertButton());
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });
});

describe('还原文件命令 workbench.action.files.revert', () => {
  it('注册为「文件」分类命令,无默认快捷键,三语标题', () => {
    const spec = editorCommandSpecs('mac').find((s) => s.id === REVERT_COMMAND_ID);
    expect(REVERT_COMMAND_ID).toBe('workbench.action.files.revert');
    expect(spec?.hotkey).toBeUndefined();
    expect(spec?.categoryKey).toBe('commands.file.category');
    const k = spec!.titleKey as keyof typeof en;
    expect(en[k]).toBe('Revert File');
    expect(zh[k]).toBe('还原文件');
    expect(ko[k]).toBeTruthy();
  });

  it('把活动 tab 重置为磁盘内容(dirty → clean)', async () => {
    await act(async () => {
      await revertActiveEditor();
    });
    expect(mocks.readFile).toHaveBeenCalledWith(PATH);
    expect(tab()).toMatchObject({ content: 'theirs', originalContent: 'theirs', dirty: false });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('磁盘内容与上次加载相同时也丢弃未保存的修改', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
    await act(async () => {
      await revertActiveEditor();
    });
    expect(tab()).toMatchObject({ content: 'orig', dirty: false });
  });

  it('读盘失败(如文件已不存在)→ 提示错误,tab 内容与脏态不变', async () => {
    mocks.readFile.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'ENOENT' });
    await act(async () => {
      await revertActiveEditor();
    });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(tab()).toMatchObject({ content: 'mine', dirty: true });
  });

  it('没有活动文件 tab → 什么也不做', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await act(async () => {
      await revertActiveEditor();
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
