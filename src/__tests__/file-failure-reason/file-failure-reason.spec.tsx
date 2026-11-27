// @vitest-environment jsdom
// 文件打开 / 保存失败提示带「动作 + 文件名 + 本地化原因」,errno 细分常见原因,错误码文案不因缺参回退原文。
// 行为见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import { notifyOpenFailed } from '../../notifications/notify-open-failed';
import { setLocale, t } from '../../i18n';
import { LOCALE_DICTS } from '../../../electron/shared/i18n-interpolate';
import { mapNodeErrnoCode } from '../../../electron/main/ipc/fs/path-utils';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
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
  notify: { warn: mocks.warn, error: mocks.error, info: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  setLocale('zh');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLocale('en');
});

describe('errno → 业务码细分', () => {
  it('ENOSPC → FS_NO_SPACE;EROFS → FS_READONLY_FS;其余未知仍 FS_IO', () => {
    expect(mapNodeErrnoCode({ code: 'ENOSPC' })).toBe('FS_NO_SPACE');
    expect(mapNodeErrnoCode({ code: 'EROFS' })).toBe('FS_READONLY_FS');
    expect(mapNodeErrnoCode({ code: 'EWHATEVER' })).toBe('FS_IO');
  });

  it('新码三语都有文案', () => {
    for (const locale of ['en', 'zh', 'ko'] as const) {
      for (const code of ['FS_READONLY', 'FS_NO_SPACE', 'FS_READONLY_FS']) {
        expect(LOCALE_DICTS[locale][`errors.${code}`], `${locale} ${code}`).toBeTruthy();
      }
    }
  });
});

describe('显式保存失败提示带文件名', () => {
  it('⌘S 写盘 FS_NO_SPACE → 「保存失败 a.ts：磁盘空间不足，磁盘上的原文件未改动」(见 save-in-place README「提示」)', async () => {
    const path = '/work/a.ts';
    mocks.readFile.mockResolvedValue({ ok: true, data: 'orig' });
    mocks.writeFile.mockResolvedValue({ ok: false, code: 'FS_NO_SPACE', message: 'atomic write tmp failed: /work/a.ts' });
    useEditorStore.setState({
      tabs: [{ id: path, filePath: path, content: 'mine', originalContent: 'orig', dirty: true }],
      activeTabId: path,
      mode: 'source',
    });
    render(<EditorPanel />);
    const editor = await screen.findByTestId('code-editor');
    await act(async () => {
      fireEvent.keyDown(editor, { key: 's', ...MOD });
    });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0]?.[0]).toBe(
      t('common.label_detail', { label: `${t('editor.save_failed')} a.ts`, detail: t('editor.save_no_space_unchanged') }),
    );
  });
});

function Probe({ saveTab }: { saveTab: (id: string, o?: unknown) => Promise<unknown> }) {
  useAutoSave(saveTab, { enabled: true, delayMs: 50 });
  return null;
}

describe('自动保存失败提示带文件名;写保护不弹框、不重试', () => {
  it('FS_READONLY → warn「自动保存失败 note.md：文件是只读的」,只调一次 saveTab 且不带 overwriteReadonly', async () => {
    vi.useFakeTimers();
    useEditorStore.setState({
      tabs: [{ id: '/w/note.md', filePath: '/w/note.md', content: 'x', originalContent: 'o', dirty: true }],
      activeTabId: '/w/note.md',
    });
    const saveTab = vi.fn(async () => ({ ok: false, code: 'FS_READONLY', message: 'file is write-protected' }));
    render(<Probe saveTab={saveTab} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(saveTab).toHaveBeenCalledTimes(1);
    expect(saveTab.mock.calls[0]).not.toContainEqual(expect.objectContaining({ overwriteReadonly: true }));
    // 出路:按保存键可选择覆盖(显式保存走覆盖确认框);保存键填当前生效绑定(jsdom = 'other' → Ctrl+S)。
    expect(mocks.warn.mock.calls[0]?.[0]).toBe(
      t('common.label_detail', {
        label: `${t('editor.autosave_failed')} note.md`,
        detail: t('editor.autosave_readonly_detail', { reason: t('errors.FS_READONLY'), hotkey: 'Ctrl+S' }),
      }),
    );
    expect(String(mocks.warn.mock.calls[0]?.[0])).toContain('Ctrl+S');
  });
});

describe('打开失败:错误码文案不因缺参回退英文原文 / 绝对路径', () => {
  it('悬空符号链接 FS_NOT_FOUND → zh「打开失败 dangling：找不到文件」', () => {
    notifyOpenFailed('dangling', { code: 'FS_NOT_FOUND', message: 'readFile failed: /private/tmp/links/dangling' });
    const text = String(mocks.error.mock.calls[0]?.[0]);
    expect(text).toBe(
      t('common.label_detail', { label: `${t('quick_open.open_failed')} dangling`, detail: t('errors.FS_NOT_FOUND') }),
    );
    expect(text).not.toContain('readFile failed');
    expect(text).not.toContain('/private/tmp');
  });

  // 守卫:经 localizeErrorByCode / notifyFailure 按 code 展示的 `errors.<CODE>` 文案(大写业务码)不得含占位符 ——
  // 调用点只有 code + message,缺参时 helper 回退原文(英文 + 绝对路径)。唯一例外 EDITOR_DISK_CHANGED:
  // 显式保存弹确认框不走 toast,自动保存提示传 { hotkey }。
  it('errors.<UPPER_CODE> 文案无占位符(EDITOR_DISK_CHANGED 除外)', () => {
    const ALLOW = new Set(['errors.EDITOR_DISK_CHANGED']);
    const hits: string[] = [];
    for (const locale of ['en', 'zh', 'ko'] as const) {
      for (const [key, text] of Object.entries(LOCALE_DICTS[locale])) {
        if (!/^errors\.[A-Z][A-Z0-9_]*$/.test(key) || ALLOW.has(key)) continue;
        if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(text)) hits.push(`${locale} ${key}: ${text}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
