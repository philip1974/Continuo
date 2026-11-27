// @vitest-environment jsdom
// BDD: 已删除(orphaned)的未保存 tab —— tab 显示「(已删除)」+ 删除线;自动保存不再把文件写回;手动保存照常重建。
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { saveActiveEditor } from '../../panels/Editor/editor-commands';
import { t } from '../../i18n';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
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
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const PATH = '/work/note.md';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.readFile.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'ENOENT' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'orig', originalContent: 'orig', dirty: false }],
    activeTabId: PATH,
    mode: 'source',
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function renderAndEditThenDelete() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
  act(() => useEditorStore.getState().updateContent(PATH, 'mine'));
  act(() => useEditorStore.getState().removePaths([PATH]));
}

describe('已删除的未保存 tab', () => {
  it('tab 标题显示「(已删除)」并加删除线', async () => {
    await renderAndEditThenDelete();
    const tabEl = screen.getByRole('tab');
    expect(tabEl.textContent).toContain(t('panels.editor.tab_deleted'));
    expect(tabEl.querySelector('.line-through')?.textContent).toBe('note.md');
  });

  it('Markdown 自动保存跳过:超过自动保存延迟后文件不被写回', async () => {
    await renderAndEditThenDelete();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: true, orphaned: true });
  });

  // 外部删除后 orphaned 要经 FSEvents 防抖 + stat + 延迟复查才置位(约 0.8–1.5s);自动保存若先到点,读盘不存在
  // 不得当作「可重建」写回(此前文件被悄悄写回,之后外部同步见文件存在即清标记,用户无感知)。
  it('外部删除尚未被标记前自动保存到点:不写回,tab 标记已删除,不弹自动保存失败提示(只提示一次自动保存已暂停)', async () => {
    const { notify } = await import('../../notifications/notify');
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    act(() => useEditorStore.getState().updateContent(PATH, 'mine'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: true, orphaned: true });
    expect(screen.getByRole('tab').textContent).toContain(t('panels.editor.tab_deleted'));
    // 不弹「自动保存失败」;改为一次「自动保存已暂停」提示(见 autosave-paused-notice.spec.tsx)。
    const warned = vi.mocked(notify.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes(t('editor.autosave_failed')))).toBe(false);
    expect(warned.filter((m) => m.includes('note.md'))).toHaveLength(1);
  });

  it('外部删除尚未被标记前切走 / 卸载 flush 自动保存:同样不写回', async () => {
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    act(() => useEditorStore.getState().updateContent(PATH, 'mine'));
    await act(async () => {
      cleanup();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: true, orphaned: true });
  });

  it('手动保存(⌘S)按路径重建文件并清除已删除标记', async () => {
    await renderAndEditThenDelete();
    await act(async () => {
      await saveActiveEditor();
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'mine');
    expect(useEditorStore.getState().tabs[0]?.orphaned).toBeFalsy();
    expect(screen.getByRole('tab').textContent).not.toContain(t('panels.editor.tab_deleted'));
  });
});
