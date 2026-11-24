// @vitest-environment jsdom
// 关闭脏 .md tab 弹「保存 / 不保存 / 取消」确认框(选「不保存」即放弃) × Markdown autosave(2s 防抖)。
// - 防抖窗口内确认放弃:closeTab 先移除 tab,随后切走 flush 的保存找不到 tab —— 这不是保存失败,
//   不得弹「自动保存失败: TAB_NOT_FOUND」。
// - 确认框开着期间暂停 autosave:停留超过 delay 也不把待放弃的内容写盘;关窗计数不再豁免该 tab
//   (暂停期间关窗 flush 不会落盘,须走关窗脏文件确认)。
// - 取消确认 → 恢复 autosave,仍脏照常排队写盘。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import { willAutoSaveOnClose } from '../../panels/Editor/autosave-failures';
import { t } from '../../i18n';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  warn: vi.fn(),
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
  notify: { warn: mocks.warn, error: mocks.error },
}));

const PATH = '/work/a.md';
const DELAY = 2000; // useSettingValue 取 fallback:autoSave.delayMs = 2000

async function flushLazyEditors() {
  await act(async () => {
    await import('../../panels/Editor/CodeEditor');
    await import('../../panels/Editor/MilkdownEditor');
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openDiscardDialog() {
  render(<EditorPanel />);
  await flushLazyEditors();
  fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.md' }) }));
  expect(screen.getByText(t('panels.editor.save_changes_title', { name: 'a.md' }))).toBeTruthy();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'edited', originalContent: 'orig', dirty: true }],
    activeTabId: PATH,
    mode: 'source',
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('关闭脏 .md 确认放弃 × autosave', () => {
  it('防抖窗口内确认放弃 → 不写盘,也不弹「自动保存失败」', async () => {
    await openDiscardDialog();
    await advance(300);
    fireEvent.click(screen.getByRole('button', { name: t('dialog.unsaved_close.dont_save') }));
    await advance(DELAY * 3);

    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('确认框开着超过 delay → 不把待放弃的内容写盘;此时关窗不豁免该脏 tab', async () => {
    await openDiscardDialog();
    await advance(DELAY * 3);

    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(willAutoSaveOnClose(PATH)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t('dialog.unsaved_close.dont_save') }));
    await advance(DELAY * 3);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('取消确认 → 恢复 autosave,仍脏照常写盘', async () => {
    await openDiscardDialog();
    await advance(DELAY * 3);
    fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.confirm.cancel') }));
    expect(willAutoSaveOnClose(PATH)).toBe(true);

    await advance(DELAY - 10);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    await advance(20);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledWith(PATH, 'edited');
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

function Probe({ saveFile, enabled }: { saveFile: (id: string) => Promise<unknown>; enabled: boolean }) {
  useAutoSave(saveFile, { enabled, delayMs: DELAY });
  return null;
}

describe('useAutoSave · tab 已关闭 / 暂停', () => {
  it('防抖窗口内 tab 被关闭 → 切走 flush 不交给 saveTab(无 TAB_NOT_FOUND 失败)', async () => {
    const saveFile = vi.fn(async () => ({ ok: false, code: 'TAB_NOT_FOUND' }));
    render(<Probe saveFile={saveFile} enabled />);
    await advance(300);
    act(() => {
      useEditorStore.getState().closeTab(PATH);
    });
    await advance(DELAY * 3);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('挂载即暂停(enabled=false)的脏 .md → 关窗计数不豁免', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    render(<Probe saveFile={saveFile} enabled={false} />);
    expect(willAutoSaveOnClose(PATH)).toBe(false);
  });
});
