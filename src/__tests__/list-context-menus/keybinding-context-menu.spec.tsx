// @vitest-environment jsdom
// BDD:快捷键页行右键菜单(VSCode keybindingsEditor onContextMenu)。见同目录 README。
// jsdom 的 navigator.platform 为空 → 非 mac 平台(mod = ctrl)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));
vi.mock('@/plugins/sandbox-sweep', () => ({ getCachedClipboard: () => ({ writeText: h.writeText }) }));

import { setLocale } from '@/i18n';
import { coApp } from '@/plugins/co-app';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { KeybindingsTabContent } from '@/plugins/settings/KeybindingsTabContent';

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const labelOf = (el: HTMLElement): string => el.querySelector('.wm-menu-item__content')?.textContent ?? '';
const labels = (): string[] => items().map(labelOf);
const item = (label: string) => items().find((el) => labelOf(el) === label)!;
const enabled = (): string[] => items().filter((el) => el.getAttribute('aria-disabled') !== 'true').map(labelOf);
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-keybinding-row="${id}"]`)!;
const visibleRows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-keybinding-row]')).map((li) => li.dataset['keybindingRow']);

beforeEach(() => {
  setLocale('en');
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
  useKeybindingsStore.setState({ overrides: {} });
  coApp.commands.register({ id: 'file.save', title: 'Save', category: 'File', hotkey: 'mod+s', fn: vi.fn() });
  coApp.commands.register({ id: 'file.saveAll', title: 'Save All', category: 'File', hotkey: 'mod+alt+s', fn: vi.fn() });
  coApp.commands.register({ id: 'plain', title: 'Plain Cmd', category: 'File', fn: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useKeybindingsStore.setState({ overrides: {} });
});

describe('菜单项(VSCode 同组同序)', () => {
  it('已绑定:复制 / 复制命令 ID / 复制命令标题 ─ 更改快捷键… ─ 删除 / 重置快捷键 ─ 显示相同的快捷键;未覆盖时「重置」置灰', () => {
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('file.save'));
    expect(labels()).toEqual([
      'Copy',
      'Copy Command ID',
      'Copy Command Title',
      'Change Hotkey…',
      'Remove Hotkey',
      'Reset Hotkey',
      'Show Same Hotkeys',
    ]);
    expect(document.querySelectorAll('[role=menu] [role=separator]')).toHaveLength(3);
    expect(enabled()).not.toContain('Reset Hotkey');
  });

  it('未绑定:「添加快捷键…」;删除 / 显示相同置灰', () => {
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('plain'));
    expect(labels()).toContain('Add Hotkey…');
    expect(enabled()).toEqual(['Copy', 'Copy Command ID', 'Copy Command Title', 'Add Hotkey…']);
  });

  it('保留键命令(转到文件…):更改 / 删除 / 重置置灰', () => {
    coApp.commands.register({ id: 'workbench.action.quickOpen', title: 'Go to File…', category: 'File', fn: vi.fn() });
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('workbench.action.quickOpen'));
    expect(enabled()).toEqual(['Copy', 'Copy Command ID', 'Copy Command Title', 'Show Same Hotkeys']);
  });

  it('三语文案', () => {
    setLocale('zh');
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('file.save'));
    expect(labels()).toEqual(['复制', '复制命令 ID', '复制命令标题', '更改快捷键…', '删除快捷键', '重置快捷键', '显示相同的快捷键']);
    cleanup();
    setLocale('ko');
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('plain'));
    expect(labels()).toEqual(['복사', '명령 ID 복사', '명령 제목 복사', '단축키 추가…', '단축키 제거', '단축키 초기화', '같은 단축키 표시']);
  });
});

describe('执行', () => {
  it('复制 = `{ "key", "command" }` JSON(VSCode copyKeybinding);复制命令 ID / 标题', async () => {
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('file.save'));
    fireEvent.click(item('Copy'));
    fireEvent.contextMenu(rowOf('plain'));
    fireEvent.click(item('Copy'));
    fireEvent.contextMenu(rowOf('file.save'));
    fireEvent.click(item('Copy Command ID'));
    fireEvent.contextMenu(rowOf('file.save'));
    fireEvent.click(item('Copy Command Title'));
    await settle();
    expect(h.writeText.mock.calls.map((c) => c[0])).toEqual([
      '{\n  "key": "ctrl+s",\n  "command": "file.save"\n}',
      '{\n  "key": "",\n  "command": "plain"\n}',
      'file.save',
      'Save',
    ]);
  });

  it('删除快捷键 → 显式解绑;重置快捷键 → 回到默认', async () => {
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('file.save'));
    fireEvent.click(item('Remove Hotkey'));
    await settle();
    expect(useKeybindingsStore.getState().overrides).toEqual({ 'file.save': '' });
    expect(rowOf('file.save').textContent).toContain('Unbound');
    fireEvent.contextMenu(rowOf('file.save'));
    expect(enabled()).toContain('Reset Hotkey');
    fireEvent.click(item('Reset Hotkey'));
    await settle();
    expect(useKeybindingsStore.getState().overrides).toEqual({});
    expect(rowOf('file.save').querySelector('[data-testid=keybinding-keys]')).not.toBeNull();
  });

  it('更改快捷键… → 打开录键弹窗', async () => {
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('file.save'));
    fireEvent.click(item('Change Hotkey…'));
    await settle();
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain('Save');
  });

  it('显示相同的快捷键 → 按该行快捷键精确过滤列表(VSCode 引号精确搜索,修饰键集合相同)', () => {
    coApp.commands.register({ id: 'other.save', title: 'Other Save', category: 'Other', hotkey: 'ctrl+s', fn: vi.fn() });
    render(<KeybindingsTabContent />);
    fireEvent.contextMenu(rowOf('file.save'));
    fireEvent.click(item('Show Same Hotkeys'));
    expect((screen.getByRole('textbox', { hidden: true }) as HTMLInputElement).value).toBe('"ctrl+s"');
    expect(visibleRows()).toEqual(['file.save', 'other.save']);
  });
});

describe('键盘与焦点', () => {
  it('行内按钮聚焦时 Shift+F10 打开该行菜单;Esc 关闭后焦点回到该按钮', async () => {
    render(<KeybindingsTabContent />);
    const edit = rowOf('file.save').querySelector<HTMLButtonElement>('[data-keybinding-edit]')!;
    edit.focus();
    fireEvent.keyDown(edit, { key: 'F10', shiftKey: true });
    expect(labels()[3]).toBe('Change Hotkey…');
    fireEvent.keyDown(items()[0]!, { key: 'Escape' });
    await settle();
    expect(document.querySelector('[role=menu]')).toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  it('行可聚焦(不进 Tab 序):右键聚焦的行在 Esc 后重新获得焦点', async () => {
    render(<KeybindingsTabContent />);
    const row = rowOf('plain');
    expect(row.tabIndex).toBe(-1);
    row.focus();
    fireEvent.contextMenu(row);
    fireEvent.keyDown(items()[0]!, { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(row);
  });
});

// 键盘回焦(菜单 / 对话框 Esc)时行上看得见焦点:与搜索结果树 / 资源管理器行同一组 focus-visible 内嵌 focus-ring 轮廓(鼠标点击不画)
const FOCUS_RING = ['outline-none', 'focus-visible:outline-solid', 'focus-visible:outline-1', 'focus-visible:-outline-offset-1', 'focus-visible:outline-focus-ring'];

/** WCAG 相对亮度对比度。 */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('行的键盘焦点环', () => {
  it('快捷键行:focus-visible 内嵌 focus-ring 轮廓', () => {
    render(<KeybindingsTabContent />);
    const cls = rowOf('file.save').className.split(' ');
    for (const c of FOCUS_RING) expect(cls).toContain(c);
  });

  it('focus-ring 色对设置页可能的各级底色(surface ~ surface-container-highest)亮 / 暗主题均 ≥ 3:1', () => {
    const css = readFileSync(path.resolve(__dirname, '../../styles/design-tokens.css'), 'utf8');
    const dark = css.indexOf('.dark');
    for (const block of [css.slice(0, dark), css.slice(dark)]) {
      const token = (name: string) => block.match(new RegExp(`--md-${name}:\\s*(#[0-9a-fA-F]{6})`))![1]!;
      const ring = token('focus-ring');
      for (const bg of ['surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest']) {
        expect(contrast(ring, token(bg)), bg).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
