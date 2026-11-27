// @vitest-environment jsdom
// ⌘N / 另存为后的焦点 + 无标题文件的显示名(行为见同目录 README「焦点」「无标题文件的显示名」)。
// 被测:panels/Editor/untitled.ts、panels/Editor/EditorPanel.tsx(saveAsTab)、panels/Editor/codemirror-phrases.ts、
// plugins/editor-encoding/encoding-actions.ts。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyAction } from '@/notifications/notify';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  showSaveDialog: vi.fn(),
  error: vi.fn(),
  focus: vi.fn(),
}));

vi.mock('../../panels/Editor/editor-focus-registry', async (orig) => ({
  ...(await orig<object>()),
  requestEditorFocus: mocks.focus,
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
import { setLocale, t } from '../../i18n';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { editorTabTitle, newUntitledFile } from '../../panels/Editor/untitled';
import { editorContentLabel, previewContentLabel } from '../../panels/Editor/codemirror-phrases';
import { acceptEncodingPick, openChangeEncoding } from '../../plugins/editor-encoding/encoding-actions';
import { useEncodingPickerStore } from '../../plugins/editor-encoding/store';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };
const PATH = '/work/sub/a.ts';
const NEW = '/elsewhere/a.ts';
const st = () => useEditorStore.getState();
const lastActions = (): readonly NotifyAction[] =>
  (mocks.error.mock.calls.at(-1)?.[1] as { actions?: NotifyAction[] } | undefined)?.actions ?? [];
const focusedIds = () => mocks.focus.mock.calls.map((c) => c[0] as string);

function resetStore() {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: PRIMARY_EDITOR_GROUP_ID, tabIds: [], activeTabId: null }],
    activeGroupId: PRIMARY_EDITOR_GROUP_ID,
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  useWorkspaceStore.setState({ root: '/work' });
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.showSaveDialog.mockResolvedValue({ ok: true, data: NEW });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('en');
});

describe('⌘N 后新编辑器获焦', () => {
  it('新建的无标题文件在其编辑器组里请求聚焦(缺省活动组)', () => {
    const id = newUntitledFile();
    expect(mocks.focus).toHaveBeenCalledWith(id, PRIMARY_EDITOR_GROUP_ID);
  });

  it('指定编辑器组(子窗 / 触发窗口的组)→ 聚焦该组里的新编辑器', () => {
    const id = newUntitledFile(PRIMARY_EDITOR_GROUP_ID);
    expect(mocks.focus).toHaveBeenLastCalledWith(id, PRIMARY_EDITOR_GROUP_ID);
  });
});

describe('另存为后的焦点', () => {
  function seedFile() {
    useEditorStore.setState({
      tabs: [{ id: PATH, filePath: PATH, content: 'mine', originalContent: 'orig', dirty: true }],
      activeTabId: PATH,
      groups: [{ id: PRIMARY_EDITOR_GROUP_ID, tabIds: [PATH], activeTabId: PATH }],
    });
  }
  async function press(extra: KeyboardEventInit = {}) {
    render(<EditorPanel />);
    const editor = await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(editor, { key: extra.shiftKey ? 'S' : 's', ...MOD, ...extra });
    });
  }

  it('⇧⌘S 成功 → 换到新路径的编辑器获焦', async () => {
    seedFile();
    await press({ shiftKey: true });
    await vi.waitFor(() => expect(st().tabs.map((x) => x.id)).toEqual([NEW]));
    expect(mocks.focus).toHaveBeenLastCalledWith(NEW, PRIMARY_EDITOR_GROUP_ID);
  });

  it('⇧⌘S 取消 → 焦点回原编辑器', async () => {
    seedFile();
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: null });
    await press({ shiftKey: true });
    await vi.waitFor(() => expect(mocks.focus).toHaveBeenCalledWith(PATH, PRIMARY_EDITOR_GROUP_ID));
  });

  it('对话框期间焦点被移到面板外 → 不抢', async () => {
    seedFile();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    mocks.showSaveDialog.mockImplementation(async () => {
      outside.focus();
      return { ok: true, data: NEW };
    });
    await press({ shiftKey: true });
    await vi.waitFor(() => expect(st().tabs.map((x) => x.id)).toEqual([NEW]));
    expect(mocks.focus).not.toHaveBeenCalled();
    outside.remove();
  });

  it('保存失败通知里的「另存为…」成功 → 新路径的编辑器获焦', async () => {
    seedFile();
    mocks.writeFile.mockImplementation(async (p: string) =>
      p === PATH ? { ok: false, code: 'FS_NOT_FOUND', message: 'x' } : { ok: true, data: undefined },
    );
    await press();
    await act(async () => lastActions()[0]!.run());
    await vi.waitFor(() => expect(st().tabs.map((x) => x.id)).toEqual([NEW]));
    expect(mocks.focus).toHaveBeenLastCalledWith(NEW, PRIMARY_EDITOR_GROUP_ID);
  });

  it('无标题文件 ⌘S(走另存为)成功 → 新路径的编辑器获焦', async () => {
    const id = newUntitledFile();
    st().updateContent(id, 'notes');
    mocks.focus.mockClear();
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: '/work/notes.txt' });
    await press();
    await vi.waitFor(() => expect(st().tabs.map((x) => x.id)).toEqual(['/work/notes.txt']));
    expect(mocks.focus).toHaveBeenLastCalledWith('/work/notes.txt', PRIMARY_EDITOR_GROUP_ID);
  });

  it('关闭无标题 tab 选「保存」→ 另存为成功后 tab 关闭,不为它请求聚焦', async () => {
    const id = newUntitledFile();
    st().updateContent(id, 'draft');
    mocks.focus.mockClear();
    mocks.showSaveDialog.mockResolvedValue({ ok: true, data: '/work/draft.txt' });
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: editorTabTitle(id) }) }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('common.save') }));
    });
    await vi.waitFor(() => expect(st().tabs).toHaveLength(0));
    expect(focusedIds()).not.toContain('/work/draft.txt');
  });
});

describe('无标题文件的显示名', () => {
  it('编辑区可访问名称念「无标题-N」,不念内部标识', () => {
    setLocale('zh');
    const id = 'untitled:Untitled-4';
    expect(editorContentLabel(id)).toBe(t('editor.aria.content', { name: '无标题-4' }));
    expect(editorContentLabel(id, 2)).toBe(t('editor.aria.content_group', { name: '无标题-4', n: '2' }));
    expect(previewContentLabel(id)).not.toContain('untitled:');
    // 普通文件不变
    expect(editorContentLabel('/work/a.ts')).toBe(t('editor.aria.content', { name: 'a.ts' }));
  });

  it('更改文件编码:无标题文件跳过「通过编码重新打开」,直接选保存编码;选定只改 tab 编码,不写盘、不报错', async () => {
    const id = newUntitledFile();
    openChangeEncoding(id);
    expect(useEncodingPickerStore.getState().request).toEqual({ kind: 'save', tabId: id });
    acceptEncodingPick({ kind: 'save', tabId: id }, 'gbk');
    await Promise.resolve();
    expect(st().tabs[0]?.encoding).toBe('gbk');
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
