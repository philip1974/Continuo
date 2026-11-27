// @vitest-environment jsdom
// BDD:设置项右键 / 「更多操作」菜单(VSCode settingsTree settingActions)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));
vi.mock('@/plugins/sandbox-sweep', () => ({ getCachedClipboard: () => ({ writeText: h.writeText }) }));

import { setLocale } from '@/i18n';
import { SettingItemRow } from '@/plugins/settings/SettingItemRow';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import type { SettingItemSpec } from '@/plugins/registries/SettingItemRegistry';

function spec(over: Partial<SettingItemSpec>): SettingItemSpec {
  return { id: 'general.test', category: 'general', title: 'Test', type: 'boolean', default: false, ...over };
}

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const labelOf = (el: HTMLElement): string => el.querySelector('.wm-menu-item__content')?.textContent ?? '';
const labels = (): string[] => items().map(labelOf);
const item = (label: string) => items().find((el) => labelOf(el) === label)!;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`)!;

beforeEach(() => {
  setLocale('en');
  useSettingsValuesStore.setState({ values: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsValuesStore.setState({ values: {} });
});

describe('菜单项', () => {
  it('右键行:重置设置 ─ 复制设置 ID / 将设置复制为 JSON;未覆盖时「重置设置」置灰', () => {
    render(<SettingItemRow spec={spec({})} />);
    fireEvent.contextMenu(rowOf('general.test'));
    expect(labels()).toEqual(['Reset Setting', 'Copy Setting ID', 'Copy Setting as JSON']);
    expect(document.querySelectorAll('[role=menu] [role=separator]')).toHaveLength(1);
    expect(item('Reset Setting').getAttribute('aria-disabled')).toBe('true');
  });

  it('已覆盖:「重置设置」可用,执行后回到默认值', async () => {
    useSettingsValuesStore.setState({ values: { 'general.test': true } });
    render(<SettingItemRow spec={spec({})} />);
    fireEvent.contextMenu(rowOf('general.test'));
    expect(item('Reset Setting').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(item('Reset Setting'));
    await settle();
    expect(useSettingsValuesStore.getState().values).toEqual({});
    expect(screen.getByRole('switch', { name: 'Test' }).getAttribute('aria-checked')).toBe('false');
  });

  it('复制设置 ID;复制为 JSON = `"id": 当前生效值`(VSCode 同格式)', async () => {
    useSettingsValuesStore.setState({ values: { 'editor.fontSize': 16 } });
    render(
      <>
        <SettingItemRow spec={spec({ id: 'editor.fontSize', title: 'Font Size', type: 'number', default: 13 })} />
        <SettingItemRow spec={spec({ id: 'terminal.shell', title: 'Shell', type: 'text', default: '/bin/zsh' })} />
      </>,
    );
    fireEvent.contextMenu(rowOf('editor.fontSize'));
    fireEvent.click(item('Copy Setting ID'));
    fireEvent.contextMenu(rowOf('editor.fontSize'));
    fireEvent.click(item('Copy Setting as JSON'));
    fireEvent.contextMenu(rowOf('terminal.shell'));
    fireEvent.click(item('Copy Setting as JSON'));
    await settle();
    expect(h.writeText.mock.calls.map((c) => c[0])).toEqual([
      'editor.fontSize',
      '"editor.fontSize": 16',
      '"terminal.shell": "/bin/zsh"',
    ]);
  });

  it('三语文案', () => {
    setLocale('zh');
    render(<SettingItemRow spec={spec({})} />);
    fireEvent.contextMenu(rowOf('general.test'));
    expect(labels()).toEqual(['重置设置', '复制设置 ID', '将设置复制为 JSON']);
    cleanup();
    setLocale('ko');
    render(<SettingItemRow spec={spec({})} />);
    fireEvent.contextMenu(rowOf('general.test'));
    expect(labels()).toEqual(['설정 초기화', '설정 ID 복사', '설정을 JSON으로 복사']);
  });
});

describe('「更多操作」按钮(VSCode 齿轮)', () => {
  it('读屏名含设置标题、声明弹出菜单、悬停 / 聚焦时显示;点击打开同一菜单', () => {
    render(<SettingItemRow spec={spec({})} />);
    const more = screen.getByRole('button', { name: 'More actions for Test' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('title')).toBe('More Actions…');
    expect(more.className).toContain('opacity-0');
    expect(more.className).toContain('group-hover/setting:opacity-100');
    expect(more.className).toContain('group-focus-within/setting:opacity-100');
    fireEvent.click(more);
    expect(labels()).toEqual(['Reset Setting', 'Copy Setting ID', 'Copy Setting as JSON']);
  });

  it('三语读屏名', () => {
    setLocale('zh');
    render(<SettingItemRow spec={spec({})} />);
    expect(screen.getByRole('button', { name: 'Test 的更多操作' })).toBeTruthy();
    cleanup();
    setLocale('ko');
    render(<SettingItemRow spec={spec({})} />);
    expect(screen.getByRole('button', { name: 'Test 기타 작업' })).toBeTruthy();
  });
});

describe('键盘与焦点', () => {
  it('行内控件聚焦时 Shift+F10 打开菜单;Esc 关闭后焦点回到该控件', async () => {
    render(<SettingItemRow spec={spec({})} />);
    const sw = screen.getByRole('switch', { name: 'Test' });
    sw.focus();
    fireEvent.keyDown(sw, { key: 'F10', shiftKey: true });
    expect(labels()).toEqual(['Reset Setting', 'Copy Setting ID', 'Copy Setting as JSON']);
    fireEvent.keyDown(items()[1]!, { key: 'Escape' });
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
    expect(document.activeElement).toBe(sw);
  });

  it('行可聚焦(不进 Tab 序):右键聚焦的行在 Esc 后重新获得焦点', async () => {
    render(<SettingItemRow spec={spec({})} />);
    const row = rowOf('general.test');
    expect(row.tabIndex).toBe(-1);
    row.focus();
    fireEvent.contextMenu(row);
    fireEvent.keyDown(items()[1]!, { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(row);
  });

  it('输入框里右键 / Shift+F10 不接管(留给原生剪切 / 复制 / 粘贴菜单)', () => {
    render(<SettingItemRow spec={spec({ id: 'terminal.shell', title: 'Shell', type: 'text', default: '' })} />);
    const input = screen.getByRole('textbox');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    input.focus();
    fireEvent.keyDown(input, { key: 'F10', shiftKey: true });
    expect(document.querySelector('[role=menu]')).toBeNull();
  });
});

// popout 子窗:设置页 / 搜索面板可拖进子窗,菜单画在触发行所在文档(同 tab 右键菜单外壳)。
describe('popout 子窗', () => {
  it('子窗里右键设置项:菜单画在子窗,Esc 后焦点回到子窗里的行', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const child = frame.contentDocument!;
    const host = child.createElement('div');
    child.body.appendChild(host);
    render(<SettingItemRow spec={spec({})} />, { container: host });
    const row = child.querySelector<HTMLElement>('[data-setting-row="general.test"]')!;
    row.focus();
    fireEvent.contextMenu(row);
    expect(document.querySelector('[role=menu]')).toBeNull();
    const menuItems = Array.from(child.querySelectorAll<HTMLElement>('[role=menuitem]'));
    expect(menuItems.map(labelOf)).toEqual(['Reset Setting', 'Copy Setting ID', 'Copy Setting as JSON']);
    fireEvent.keyDown(menuItems[1]!, { key: 'Escape' });
    await settle();
    expect(child.querySelector('[role=menu]')).toBeNull();
    expect(child.activeElement).toBe(row);
    cleanup();
    frame.remove();
  });
});

// 键盘回焦(菜单 / 对话框 Esc)时行上看得见焦点:与搜索结果树 / 资源管理器行同一组 focus-visible 内嵌 focus-ring 轮廓(鼠标点击不画)
const FOCUS_RING = ['outline-none', 'focus-visible:outline-solid', 'focus-visible:outline-1', 'focus-visible:-outline-offset-1', 'focus-visible:outline-focus-ring'];

describe('行的键盘焦点环', () => {
  it('设置项行:focus-visible 内嵌 focus-ring 轮廓', () => {
    render(<SettingItemRow spec={spec({})} />);
    const cls = rowOf('general.test').className.split(' ');
    for (const c of FOCUS_RING) expect(cls).toContain(c);
  });
});
