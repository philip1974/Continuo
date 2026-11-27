// @vitest-environment jsdom
// BDD:切换窗口命令与选择器(renderer)。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ listWindows: vi.fn(), focusWindow: vi.fn() }));
vi.mock('@/lib/co-api', () => ({ coApi: { window: { listWindows: h.listWindows, focusWindow: h.focusWindow } } }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { SwitchWindowModal } from '@/plugins/switch-window/SwitchWindowModal';
import { useSwitchWindowStore } from '@/plugins/switch-window/store';
import { SWITCH_WINDOW_COMMAND_ID, switchWindowCommandSpec } from '@/plugins/switch-window/switch-window-command';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { POPOUT_HOTKEY_COMMAND_IDS } from '@/plugins/command-palette/useCommandHotkeys';
import { isTerminalKeptHotkey } from '@/panels/Terminal/terminal-hotkeys';
import { runInCommandDocument } from '@/shell/dock/popout-documents';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import type { WindowSwitchEntry } from '../../../electron/shared/window-channels';
import { setLocale } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const WINDOWS: WindowSwitchEntry[] = [
  { id: 1, title: 'a.ts — ws-a', parentId: null, current: true },
  { id: 4, title: 'term — ws-a', parentId: 1, current: false },
  { id: 2, title: 'README.md — ws-b', parentId: null, current: false },
];
const input = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option');
const flush = () => act(async () => {});

async function openPicker(): Promise<void> {
  await act(async () => {
    void switchWindowCommandSpec('mac').fn();
  });
  render(<SwitchWindowModal />);
  await flush();
}

beforeEach(() => {
  setLocale('en');
  vi.clearAllMocks();
  h.listWindows.mockResolvedValue({ ok: true, data: WINDOWS });
  h.focusWindow.mockResolvedValue({ ok: true, data: undefined });
  useSwitchWindowStore.getState().close();
  useSwitchWindowStore.setState({ windows: null, query: '', selectedIndex: 0, hostDocument: null });
});
afterEach(() => cleanup());

describe('命令', () => {
  it('id / 标题同 VSCode(三语);mac ⌃W,Windows / Linux 无默认键', () => {
    expect(SWITCH_WINDOW_COMMAND_ID).toBe('workbench.action.switchWindow');
    expect(switchWindowCommandSpec('mac').hotkey).toBe('ctrl+w');
    expect(switchWindowCommandSpec('other').hotkey).toBeUndefined();
    expect(en['commands.window.switch.title']).toBe('Switch Window…');
    for (const locale of [zh, ko]) expect(locale['commands.window.switch.title']).toBeTruthy();
  });

  it('终端获焦时 ⌃W 留给 shell(删前一个词;VSCode commandsToSkipShell 不含它)', () => {
    const commands = { getAll: () => [switchWindowCommandSpec('mac')] as CommandSpec[] };
    const e = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(isTerminalKeptHotkey(e, 'mac', {}, commands)).toBe(true);
  });

  it('popout 子窗里也分发(选择器画在按键所在子窗)', () => {
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(SWITCH_WINDOW_COMMAND_ID)).toBe(true);
  });

  it('执行:关掉其它选择器,打开切换窗口', async () => {
    useQuickOpenStore.setState({ isOpen: true });
    useOpenRecentStore.setState({ isOpen: true });
    await openPicker();
    expect(useSwitchWindowStore.getState().isOpen).toBe(true);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useOpenRecentStore.getState().isOpen).toBe(false);
  });
});

describe('选择器', () => {
  it('列出所有窗口(含子窗),当前窗口标「Current Window」,初始选中它的下一个;占位文字同 VSCode', async () => {
    await openPicker();
    expect(options().map((o) => o.textContent)).toEqual([
      'a.ts — ws-aCurrent Window',
      'term — ws-a',
      'README.md — ws-b',
    ]);
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('placeholder')).toBe('Select a window to switch to');
  });

  it('当前窗口是最后一个 → 初始选中第一个', async () => {
    h.listWindows.mockResolvedValue({
      ok: true,
      data: [
        { id: 1, title: 'A', parentId: null, current: false },
        { id: 2, title: 'B', parentId: null, current: true },
      ],
    });
    await openPicker();
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter → 聚焦所选窗口并关闭', async () => {
    await openPicker();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(h.focusWindow).toHaveBeenCalledWith(4);
    expect(useSwitchWindowStore.getState().isOpen).toBe(false);
  });

  it('按标题过滤;点击聚焦', async () => {
    await openPicker();
    fireEvent.change(input(), { target: { value: 'readme' } });
    expect(options().map((o) => o.textContent)).toEqual(['README.md — ws-b']);
    fireEvent.click(options()[0]!);
    expect(h.focusWindow).toHaveBeenCalledWith(2);
  });

  it('没有匹配 → 提示', async () => {
    await openPicker();
    fireEvent.change(input(), { target: { value: 'zzzz' } });
    expect(screen.getByRole('status').textContent).toBe(en['switch_window.no_match']);
  });

  it('选的是当前窗口 → 只关闭,不请求聚焦', async () => {
    await openPicker();
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(h.focusWindow).not.toHaveBeenCalled();
    expect(useSwitchWindowStore.getState().isOpen).toBe(false);
  });

  it('在 popout 子窗里触发 → 按子窗的 window.open 名请求列表(当前窗口 = 该子窗)', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const child = frame.contentWindow!;
    child.name = 'dv-popout-7';
    await act(async () => {
      runInCommandDocument(child.document, () => void switchWindowCommandSpec('mac').fn());
    });
    expect(h.listWindows).toHaveBeenCalledWith({ popoutName: 'dv-popout-7' });
    expect(useSwitchWindowStore.getState().hostDocument).toBe(child.document);
    frame.remove();
  });

  it('列表迟到时已关闭 → 丢弃', async () => {
    let resolve!: (v: unknown) => void;
    h.listWindows.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    void switchWindowCommandSpec('mac').fn();
    useSwitchWindowStore.getState().close();
    await act(async () => resolve({ ok: true, data: WINDOWS }));
    expect(useSwitchWindowStore.getState().windows).toBeNull();
    expect(useSwitchWindowStore.getState().isOpen).toBe(false);
  });
});
