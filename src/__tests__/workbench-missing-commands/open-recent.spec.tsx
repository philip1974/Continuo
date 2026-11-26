// @vitest-environment jsdom
// BDD: workbench-missing-commands §3 —— 打开最近的文件夹(workbench.action.openRecent,mac ⌃R):Quick Pick 列出最近打开的文件夹,
// 键盘可用;打开走与「最近打开」菜单同一路径(openRecentRootOrNotify:去重聚焦、目录不存在询问删除、焦点交给新文件树)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const openRecent = vi.hoisted(() => vi.fn());
vi.mock('../../panels/Explorer/open-recent-root', async (orig) => ({
  ...(await orig<object>()),
  openRecentRootOrNotify: openRecent,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { OpenRecentModal } from '@/plugins/open-recent/OpenRecentModal';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { explorerCommandSpecs, OPEN_RECENT_COMMAND_ID } from '@/panels/Explorer/explorer-commands';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { isTerminalKeptHotkey } from '@/panels/Terminal/terminal-hotkeys';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { setLocale } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const spec = (platform: 'mac' | 'other') => explorerCommandSpecs(platform).find((c) => c.id === OPEN_RECENT_COMMAND_ID)!;
const input = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

beforeEach(() => {
  setLocale('en');
  openRecent.mockReset();
  useOpenRecentStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  useWorkspaceStore.setState({ root: '/p/current', recentRoots: ['/p/current', '/p/alpha', '/q/beta'] });
});
afterEach(() => cleanup());

describe('命令', () => {
  it('id 同 VSCode;mac ⌃R,Windows / Linux 无默认键(⌃R 被应用菜单「重新加载窗口」占用);三语标题', () => {
    expect(OPEN_RECENT_COMMAND_ID).toBe('workbench.action.openRecent');
    expect(spec('mac').hotkey).toBe('ctrl+r');
    expect(spec('other').hotkey).toBeUndefined();
    for (const locale of [en, zh, ko]) expect(locale['commands.file.open_recent.title']).toBeTruthy();
  });

  it('执行:打开 Quick Pick,并关掉命令面板 / Quick Open(picker 互斥)', () => {
    useQuickOpenStore.setState({ isOpen: true });
    useCommandPaletteStore.setState({ isOpen: true });
    void spec('mac').fn();
    expect(useOpenRecentStore.getState().isOpen).toBe(true);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('终端获焦时 ⌃R 留给 shell(反向搜索),不交给全局分发', () => {
    const commands = { getAll: () => [{ ...spec('mac') }] as CommandSpec[] };
    const e = new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', ctrlKey: true });
    expect(isTerminalKeptHotkey(e, 'mac', {}, commands)).toBe(true);
  });
});

describe('Quick Pick', () => {
  it('列出最近打开的文件夹(当前文件夹除外);输入过滤;↓ + Enter 打开选中项并关闭', () => {
    act(() => useOpenRecentStore.getState().open());
    render(<OpenRecentModal />);
    expect(options()).toEqual(['alpha/p', 'beta/q']);
    fireEvent.change(input(), { target: { value: 'bet' } });
    expect(options()).toEqual(['beta/q']);
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(openRecent).toHaveBeenCalledWith('/q/beta', useWorkspaceStore.getState().setRoot, expect.any(Function));
    expect(useOpenRecentStore.getState().isOpen).toBe(false);
  });

  it('选项可访问名称为「名称，父路径」;点击同样打开', () => {
    act(() => useOpenRecentStore.getState().open());
    render(<OpenRecentModal />);
    const alpha = screen.getByRole('option', { name: /alpha/ });
    expect(alpha.getAttribute('aria-label')).toContain('/p');
    fireEvent.click(alpha);
    expect(openRecent.mock.calls[0]![0]).toBe('/p/alpha');
  });

  it('目录已不存在 → picker 关闭后仍显示「是否从最近列表删除」询问', () => {
    openRecent.mockImplementation((p: string, _set: unknown, onMissing: (p: string) => void) => onMissing(p));
    act(() => useOpenRecentStore.getState().open());
    render(<OpenRecentModal />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useOpenRecentStore.getState().isOpen).toBe(false);
    expect(screen.getByRole('dialog').textContent).toContain('/p/alpha');
  });

  it('没有最近打开的文件夹 → 空态提示', () => {
    useWorkspaceStore.setState({ recentRoots: ['/p/current'] });
    act(() => useOpenRecentStore.getState().open());
    render(<OpenRecentModal />);
    expect(screen.getByRole('status').textContent).toBe(en['open_recent.empty']);
  });
});
