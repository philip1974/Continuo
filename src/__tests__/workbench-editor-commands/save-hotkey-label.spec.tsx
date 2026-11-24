// @vitest-environment jsdom
// BDD: workbench-editor-commands / 3 提示文案里的保存键填当前生效绑定(不写死 Cmd/Ctrl+S)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import { useEditorStore } from '../../stores/editor.store';
import { saveHotkeyLabel, SAVE_COMMAND } from '../../panels/Editor/editor-commands';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { getLocale, setLocale, translate } from '../../i18n';
import { localizeErrorByCode } from '../../lib/localize-error';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: h.warn, error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const KEYS = ['errors.EDITOR_DISK_CHANGED', 'dialog.unsaved_close.disk_changed_note'] as const;
const original = getLocale();

beforeEach(() => useKeybindingsStore.setState({ overrides: {} }));
afterEach(() => {
  setLocale(original);
  cleanup();
  vi.useRealTimers();
});

describe('saveHotkeyLabel', () => {
  it('默认 mod+s → mac ⌘S / 其它 Ctrl+S;改绑跟随;解绑 → 命令标题', () => {
    expect(saveHotkeyLabel('mac')).toBe('⌘S');
    expect(saveHotkeyLabel('other')).toBe('Ctrl+S');
    useKeybindingsStore.setState({ overrides: { [SAVE_COMMAND.id]: 'mod+shift+s' } });
    expect(saveHotkeyLabel('mac')).toBe('⇧⌘S');
    expect(saveHotkeyLabel('other')).toBe('Ctrl+Shift+S');
    useKeybindingsStore.setState({ overrides: { [SAVE_COMMAND.id]: '' } });
    setLocale('zh');
    expect(saveHotkeyLabel('other')).toBe(translate('commands.file.save.title'));
  });
});

describe('文案用 {hotkey} 占位(三语),不写死 Cmd/Ctrl+S', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ko', ko],
  ] as const)('%s', (_locale, dict) => {
    for (const key of KEYS) {
      expect(dict[key]).toContain('{hotkey}');
      expect(dict[key]).not.toContain('Cmd/Ctrl');
    }
  });

  it('磁盘冲突错误按 code 本地化时填入生效绑定', () => {
    setLocale('zh');
    useKeybindingsStore.setState({ overrides: { [SAVE_COMMAND.id]: 'mod+shift+s' } });
    const text = localizeErrorByCode('EDITOR_DISK_CHANGED', 'raw', { hotkey: saveHotkeyLabel('other') });
    expect(text).toContain('Ctrl+Shift+S');
    expect(text).not.toContain('{hotkey}');
  });
});

describe('自动保存遇磁盘冲突的提示', () => {
  function Probe({ saveFile }: { saveFile: () => Promise<unknown> }) {
    useAutoSave(saveFile, { enabled: true, delayMs: 10 });
    return null;
  }

  it('toast 里写的是当前生效的保存键', async () => {
    vi.useFakeTimers();
    setLocale('zh');
    useKeybindingsStore.setState({ overrides: { [SAVE_COMMAND.id]: 'mod+shift+s' } });
    useEditorStore.setState({
      tabs: [{ id: '/a.md', filePath: '/a.md', content: 'new', originalContent: 'old', dirty: true }],
      activeTabId: '/a.md',
    });
    const saveFile = vi.fn(async () => ({ ok: false, code: 'EDITOR_DISK_CHANGED', message: 'raw english' }));
    render(<Probe saveFile={saveFile} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(saveFile).toHaveBeenCalled();
    const text = String(h.warn.mock.calls[0]?.[0]);
    expect(text).toContain('Ctrl+Shift+S');
    expect(text).not.toContain('raw english');
  });
});
