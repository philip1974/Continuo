// @vitest-environment jsdom
// 通知按钮 + EditorPanel 保存失败附「另存为… / 重试」+ 无标题文件保存走另存为(行为见同目录 README)。
// 被测:notifications/(notify actions、Toast、NotificationsProvider)、panels/Editor/EditorPanel.tsx。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import type { NotifyAction } from '@/notifications/notify';

describe('通知按钮', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function renderToasts() {
    const { notify } = await vi.importActual<typeof import('@/notifications/notify')>('@/notifications/notify');
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    return notify;
  }

  it('按钮显示在通知里;点击先关闭通知再执行', async () => {
    const notify = await renderToasts();
    const order: string[] = [];
    act(() => {
      notify.error('Failed to save a.ts: Disk is full', {
        actions: [
          { label: 'Save As…', run: () => order.push(`run:${document.querySelectorAll('.toast').length}`) },
          { label: 'Retry', run: vi.fn() },
        ],
      });
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    });
    expect(order).toEqual(['run:1']); // 执行时同步关闭的 DOM 尚未提交,但随后消失
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('带按钮的通知不自动消失;不带的照常 15s 后消失', async () => {
    vi.useFakeTimers();
    const notify = await renderToasts();
    act(() => {
      notify.error('with actions', { actions: [{ label: 'Retry', run: () => {} }] });
      notify.error('plain');
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText('plain')).toBeNull();
    expect(screen.getByText('with actions')).toBeTruthy();
  });

  it('按钮至多 3 个;同内容再次通知时按钮换成最新一次的', async () => {
    const notify = await renderToasts();
    const mk = (p: string): NotifyAction[] => [1, 2, 3, 4].map((i) => ({ label: `${p}${i}`, run: () => {} }));
    act(() => notify.error('same', { actions: mk('a') }));
    expect(screen.queryByRole('button', { name: 'a4' })).toBeNull();
    expect(screen.getByRole('button', { name: 'a3' })).toBeTruthy();
    act(() => notify.error('same', { actions: mk('b') }));
    expect(screen.queryByRole('button', { name: 'a1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'b1' })).toBeTruthy();
  });
});

// ── EditorPanel ──────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  showSaveDialog: vi.fn(),
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
      showSaveDialog: mocks.showSaveDialog,
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', async (orig) => ({
  ...(await orig<object>()),
  notify: { warn: vi.fn(), error: mocks.error, info: vi.fn(), success: vi.fn() },
}));

import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { t } from '../../i18n';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { editorTabTitle, newUntitledFile } from '../../panels/Editor/untitled';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };
const PATH = '/work/sub/a.ts';
const NEW = '/elsewhere/a.ts';

/** 最近一次错误通知的按钮。 */
const lastActions = (): readonly NotifyAction[] =>
  (mocks.error.mock.calls.at(-1)?.[1] as { actions?: NotifyAction[] } | undefined)?.actions ?? [];

describe('EditorPanel 保存失败的按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: NEW });
    useWorkspaceStore.setState({ root: '/work' });
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

  async function pressSave(extra: KeyboardEventInit = {}) {
    render(<EditorPanel />);
    const editor = await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(editor, { key: extra.shiftKey ? 'S' : 's', ...MOD, ...extra });
    });
  }

  it.each(['FS_NOT_FOUND', 'FS_NOT_FILE', 'FS_DENIED', 'FS_NO_SPACE'])(
    '⌘S 遇 %s → 「保存失败 a.ts:…」附「另存为…」「重试」',
    async (code) => {
      mocks.writeFile.mockResolvedValue({ ok: false, code, message: 'x' });
      await pressSave();
      expect(mocks.error).toHaveBeenCalledTimes(1);
      expect(mocks.error.mock.calls[0]![0]).toContain(`${t('editor.save_failed')} a.ts`);
      expect(lastActions().map((a) => a.label)).toEqual([t('editor.save_as_action'), t('editor.retry_save')]);
    },
  );

  it('其它错误(如畸形请求)不附按钮', async () => {
    mocks.writeFile.mockResolvedValue({ ok: false, code: 'BAD_INPUT', message: 'x' });
    await pressSave();
    expect(lastActions()).toEqual([]);
  });

  it('「重试」= 同一 tab 再保存一次;成功后变干净', async () => {
    mocks.writeFile.mockResolvedValueOnce({ ok: false, code: 'FS_NO_SPACE', message: 'x' });
    mocks.writeFile.mockResolvedValueOnce({ ok: true, data: undefined });
    await pressSave();
    await act(async () => lastActions()[1]!.run());
    await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(2));
    expect(mocks.writeFile).toHaveBeenLastCalledWith(PATH, 'mine');
    await vi.waitFor(() => expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false));
  });

  it('「另存为…」= 以原路径为默认位置弹保存对话框,写到选定路径,tab 换到新路径', async () => {
    mocks.writeFile.mockImplementation(async (p: string) =>
      p === PATH ? { ok: false, code: 'FS_NOT_FOUND', message: 'x' } : { ok: true, data: undefined },
    );
    await pressSave();
    await act(async () => lastActions()[0]!.run());
    await vi.waitFor(() => expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([NEW]));
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(PATH);
    expect(mocks.writeFile).toHaveBeenLastCalledWith(NEW, 'mine');
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false);
  });

  it('另存为写盘失败 → 「保存失败」附「另存为…」(重新选位置)', async () => {
    mocks.writeFile.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'x' });
    await pressSave({ shiftKey: true });
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect(lastActions().map((a) => a.label)).toEqual([t('editor.save_as_action')]);
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([PATH]);
  });

  it('⇧⌘S 在面板内就地处理:弹保存对话框(取消 → 什么都不变)', async () => {
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: null });
    await pressSave({ shiftKey: true });
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(PATH);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('无标题文件 ⌘S → 另存为(默认 = 工作区根 + 首行名字),保存后 tab 换到新路径', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const id = newUntitledFile();
    useEditorStore.getState().updateContent(id, 'Shopping list\nmilk');
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: '/work/Shopping list.txt' });
    mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
    await pressSave();
    await vi.waitFor(() =>
      expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual(['/work/Shopping list.txt']),
    );
    expect(mocks.showSaveDialog).toHaveBeenCalledWith('/work/Shopping list.txt');
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('关闭有内容的无标题 tab:确认框写「Untitled-1」(按界面语言);「保存」= 另存为,保存成功才关闭', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const id = newUntitledFile();
    useEditorStore.getState().updateContent(id, 'draft');
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: '/work/draft.txt' });
    mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: editorTabTitle(id) }) }));
    });
    await screen.findByText(t('panels.editor.save_changes_title', { name: editorTabTitle(id) }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    });
    await vi.waitFor(() => expect(useEditorStore.getState().tabs).toHaveLength(0));
    expect(mocks.writeFile).toHaveBeenCalledWith('/work/draft.txt', 'draft');
  });

  it('关闭无标题 tab 选「保存」后在对话框取消 → 不关闭', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    const id = newUntitledFile();
    useEditorStore.getState().updateContent(id, 'draft');
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: null });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: editorTabTitle(id) }) }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('common.save') }));
    });
    await vi.waitFor(() => expect(mocks.showSaveDialog).toHaveBeenCalled());
    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([id]);
  });
});
