// @vitest-environment jsdom
// 显式保存遇写保护文件(FS_READONLY)→ 确认框「文件是只读的 —— 覆盖 / 取消」;覆盖 = 带 overwriteReadonly 重试,
// 取消 = 不写、tab 仍脏。行为见同目录 README。被测:EditorPanel.tsx + editor-file-actions.ts saveFile。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { setLocale, t } from '../../i18n';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

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
const READONLY = { ok: false, code: 'FS_READONLY', message: 'file is write-protected: /work/a.ts' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
  mocks.writeFile.mockImplementation(async (_p: string, _c: string, o?: { overwriteReadonly?: boolean }) =>
    o?.overwriteReadonly ? { ok: true, data: undefined } : READONLY,
  );
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

const dirty = () => useEditorStore.getState().tabs.find((x) => x.id === PATH)?.dirty;

async function saveAndWaitForReadonlyDialog() {
  render(<EditorPanel />);
  const editor = await screen.findByTestId('code-editor');
  await act(async () => {
    fireEvent.keyDown(editor, { key: 's', ...MOD });
  });
  await screen.findByText(t('panels.editor.readonly_title'));
}

describe('显式保存写保护文件', () => {
  it('⌘S 遇 FS_READONLY → 弹确认框(含文件名),不弹错误 toast', async () => {
    await saveAndWaitForReadonlyDialog();
    expect(screen.getByText('a.ts', { selector: 'code' })).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  // 文件名作为 {name} 占位放进三语文案,由各语言决定位置与助词(韩语此前在 <code> 后固定加空格再接「은(는)」)。
  it.each(['en', 'zh', 'ko'] as const)('%s:确认框说明 = 带文件名的整句文案,文件名以 <code> 呈现', async (locale) => {
    setLocale(locale);
    try {
      await saveAndWaitForReadonlyDialog();
      const dialog = screen.getByRole('alertdialog');
      const code = screen.getByText('a.ts', { selector: 'code' });
      const description = code.parentElement!;
      expect(dialog.contains(description)).toBe(true);
      expect(description.textContent).toBe(t('panels.editor.readonly_body', { name: 'a.ts' }));
      expect(description.textContent).not.toMatch(/a\.ts\s+은\(는\)/);
    } finally {
      setLocale('en');
    }
  });

  it('取消 → 不重试写盘,tab 仍脏', async () => {
    await saveAndWaitForReadonlyDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.confirm.cancel') }));
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(dirty()).toBe(true);
  });

  it('覆盖 → 带 overwriteReadonly 重试,成功后 tab 变干净', async () => {
    await saveAndWaitForReadonlyDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.readonly_confirm') }));
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).toHaveBeenLastCalledWith(PATH, 'mine', { overwriteReadonly: true });
    expect(dirty()).toBe(false);
  });

  it('关闭脏 tab 选「保存」遇 FS_READONLY → 同一确认框;覆盖成功后关闭该 tab', async () => {
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.ts' }) }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('common.save') }));
    });
    await screen.findByText(t('panels.editor.readonly_title'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.readonly_confirm') }));
    });
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });
});
