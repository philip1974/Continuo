// @vitest-environment jsdom
// 显式保存遇外部修改(EDITOR_DISK_CHANGED)→ 异步弹出「仍然覆盖」确认框。用户按完 Cmd+S 往往
// 继续打字:若初始焦点落在破坏性的「仍然覆盖」按钮,紧接着的空格 / 回车会直接 force 覆盖外部
// 修改(例如终端 agent 刚改过该文件)。destructive 确认框的初始焦点须落在「取消」。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
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

const PATH = '/work/a.ts';

beforeEach(() => {
  vi.clearAllMocks();
  // 磁盘内容 ≠ originalContent:外部(如终端 agent)在用户编辑期间改过文件。
  mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'mine', originalContent: 'orig', dirty: true }],
    activeTabId: PATH,
    mode: 'source',
  });
  // Modal 在 rAF 里设置初始焦点;同步执行以便断言。
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function saveAndWaitForOverwriteDialog() {
  render(<EditorPanel />);
  const editor = await screen.findByTestId('code-editor');
  await act(async () => {
    fireEvent.keyDown(editor, { key: 's', metaKey: true });
  });
  await screen.findByText(t('panels.editor.disk_changed_title'));
}

describe('外部修改后 Cmd+S 弹出的「仍然覆盖」确认框', () => {
  it('初始焦点不在「仍然覆盖」,而在「取消」', async () => {
    await saveAndWaitForOverwriteDialog();
    const overwrite = screen.getByRole('button', { name: t('panels.editor.disk_changed_confirm') });
    const cancel = screen.getByRole('button', { name: t('panels.explorer.confirm.cancel') });
    expect(document.activeElement).not.toBe(overwrite);
    expect(document.activeElement).toBe(cancel);
  });

  it.each(['Enter', ' '])('弹出后立即按 %j(激活焦点按钮)→ 不 force 写盘,确认框关闭、tab 仍脏', async (key) => {
    await saveAndWaitForOverwriteDialog();
    const focused = document.activeElement as HTMLElement;
    // 浏览器里在聚焦的 <button> 上按回车 / 空格 = 点击它;jsdom 不合成该 click,这里显式模拟。
    await act(async () => {
      fireEvent.keyDown(focused, { key });
      focused.click();
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(screen.queryByText(t('panels.editor.disk_changed_title'))).toBeNull();
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
  });

  it('用户显式点「仍然覆盖」→ 照常 force 写盘', async () => {
    await saveAndWaitForOverwriteDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.disk_changed_confirm') }));
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'mine');
  });
});
