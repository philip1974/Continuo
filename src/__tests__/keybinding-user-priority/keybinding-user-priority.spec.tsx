// @vitest-environment jsdom
// 快捷键冲突:用户设置的绑定优先于默认绑定(对齐 VSCode),列表标「冲突」,录键弹窗冲突项可按键过滤列表。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import {
  buildCompiledBindings,
  selectShadowedBindings,
  useCommandHotkeys,
} from '../../plugins/command-palette/useCommandHotkeys';
import { hotkeyFilterQuery } from '../../plugins/command-palette/format-hotkey';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { KeybindingCaptureModal } from '../../plugins/keybindings/KeybindingCaptureModal';
import { KeybindingsTabContent } from '../../plugins/settings/KeybindingsTabContent';
import { coApp } from '../../plugins/co-app';

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
});
afterEach(() => cleanup());

// jsdom detectPlatform()='other' → mod = Ctrl
function pressCtrl(key: string, target: Document = document): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

describe('分发:用户 override 优先于默认绑定', () => {
  it('后注册命令被用户设成与先注册命令默认键相同 → 按键执行用户设的那条', () => {
    const first = vi.fn();
    const second = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'first', title: 'First', hotkey: 'mod+k', fn: first });
    reg.register({ id: 'second', title: 'Second', fn: second });
    useKeybindingsStore.setState({ overrides: { second: 'mod+k' } });
    renderHook(() => useCommandHotkeys(reg));

    pressCtrl('k');

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('都无 override → 仍按注册顺序(先注册者响应)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'first', title: 'First', hotkey: 'mod+k', fn: first });
    reg.register({ id: 'second', title: 'Second', hotkey: 'mod+k', fn: second });
    renderHook(() => useCommandHotkeys(reg));

    pressCtrl('k');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('分发表:有 override 的命令排前,同层保持注册顺序', () => {
    const cmds = [
      { id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() },
      { id: 'b', title: 'B', fn: vi.fn() },
      { id: 'c', title: 'C', hotkey: 'mod+c', fn: vi.fn() },
      { id: 'd', title: 'D', fn: vi.fn() },
    ];
    const ids = buildCompiledBindings(cmds, 'other', { d: 'mod+d', b: 'mod+b' }).map((x) => x.cmd.id);
    expect(ids).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('selectShadowedBindings:冲突落败者 → 胜出者', () => {
  it('默认 vs 默认:后注册者落败', () => {
    const cmds = [
      { id: 'a', title: 'A', hotkey: 'mod+k', fn: vi.fn() },
      { id: 'b', title: 'B', hotkey: 'mod+k', fn: vi.fn() },
    ];
    const shadowed = selectShadowedBindings(cmds, 'other', {});
    expect([...shadowed.keys()]).toEqual(['b']);
    expect(shadowed.get('b')?.id).toBe('a');
  });

  it('用户 override 压过默认:默认那条落败', () => {
    const cmds = [
      { id: 'a', title: 'A', hotkey: 'mod+k', fn: vi.fn() },
      { id: 'b', title: 'B', fn: vi.fn() },
    ];
    const shadowed = selectShadowedBindings(cmds, 'other', { b: 'mod+k' });
    expect([...shadowed.keys()]).toEqual(['a']);
    expect(shadowed.get('a')?.id).toBe('b');
  });

  it('按运行时语义归一:主键别名 / 修饰键段序不同也算同一键', () => {
    const cmds = [
      { id: 'a', title: 'A', hotkey: 'mod+up', fn: vi.fn() },
      { id: 'b', title: 'B', hotkey: 'mod+arrowup', fn: vi.fn() },
      { id: 'c', title: 'C', hotkey: 'shift+mod+enter', fn: vi.fn() },
      { id: 'd', title: 'D', hotkey: 'mod+shift+enter', fn: vi.fn() },
    ];
    expect([...selectShadowedBindings(cmds, 'other', {}).keys()]).toEqual(['b', 'd']);
  });

  it('解绑 / 保留键 / 不同键 不算冲突', () => {
    const cmds = [
      { id: 'a', title: 'A', hotkey: 'mod+k', fn: vi.fn() },
      { id: 'b', title: 'B', hotkey: 'mod+k', fn: vi.fn() },
      { id: 'c', title: 'C', hotkey: 'mod+p', fn: vi.fn() },
      { id: 'd', title: 'D', hotkey: 'mod+p', fn: vi.fn() },
      { id: 'e', title: 'E', hotkey: 'mod+e', fn: vi.fn() },
    ];
    expect(selectShadowedBindings(cmds, 'other', { b: '' }).size).toBe(0);
  });
});

describe('hotkeyFilterQuery:按键过滤的搜索串', () => {
  it('用与列表 haystack 相同的修饰键顺序名(非 mac ctrl+…;mac cmd+…)', () => {
    expect(hotkeyFilterQuery('shift+mod+t', 'other')).toBe('ctrl+shift+t');
    expect(hotkeyFilterQuery('shift+mod+t', 'mac')).toBe('cmd+shift+t');
  });
});

describe('设置 › 快捷键列表:冲突落败行标「冲突」', () => {
  it('默认冲突:后注册那行标冲突,先注册那行不标', () => {
    coApp.commands.register({ id: 'win', title: 'Winner Cmd', hotkey: 'mod+k', fn: vi.fn() });
    coApp.commands.register({ id: 'lose', title: 'Loser Cmd', hotkey: 'mod+k', fn: vi.fn() });
    const { container } = render(<KeybindingsTabContent />);
    const rows = Array.from(container.querySelectorAll('li'));
    const loser = rows.find((r) => r.textContent?.includes('Loser Cmd'))!;
    const winner = rows.find((r) => r.textContent?.includes('Winner Cmd'))!;
    expect(loser.querySelector('[data-testid="keybinding-conflict"]')?.textContent).toBe('冲突');
    expect(loser.querySelector('[data-testid="keybinding-conflict"]')?.getAttribute('title')).toContain(
      'Winner Cmd',
    );
    expect(winner.querySelector('[data-testid="keybinding-conflict"]')).toBeNull();
  });

  it('用户把后注册命令设成同键 → 冲突标记转到原默认命令那行', () => {
    coApp.commands.register({ id: 'old', title: 'Old Default', hotkey: 'mod+k', fn: vi.fn() });
    coApp.commands.register({ id: 'mine', title: 'Mine', fn: vi.fn() });
    useKeybindingsStore.setState({ overrides: { mine: 'mod+k' } });
    const { container } = render(<KeybindingsTabContent />);
    const rows = Array.from(container.querySelectorAll('li'));
    expect(
      rows.find((r) => r.textContent?.includes('Old Default'))!.querySelector('[data-testid="keybinding-conflict"]'),
    ).not.toBeNull();
    expect(
      rows.find((r) => r.textContent?.includes('Mine'))!.querySelector('[data-testid="keybinding-conflict"]'),
    ).toBeNull();
  });
});

function renderModal(over: Partial<Parameters<typeof KeybindingCaptureModal>[0]> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const onShowSameKeybindings = vi.fn();
  const allCommands = [
    { id: 'target', title: 'Target', fn: vi.fn() },
    { id: 'other', title: 'Other Cmd', hotkey: 'mod+k', fn: vi.fn() },
  ];
  render(
    <KeybindingCaptureModal
      visible
      commandId="target"
      commandTitle="Target"
      currentHotkey={undefined}
      defaultHotkey={undefined}
      allCommands={allCommands}
      overrides={{}}
      onSave={onSave}
      onClose={onClose}
      onResetToDefault={vi.fn()}
      onShowSameKeybindings={onShowSameKeybindings}
      {...over}
    />,
  );
  return { onSave, onClose, onShowSameKeybindings };
}

describe('录键弹窗:冲突', () => {
  it('冲突项是按钮:点击按该快捷键过滤列表并关闭弹窗', () => {
    const { onShowSameKeybindings, onClose, onSave } = renderModal();
    act(() => pressCtrl('k'));
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).find(
      (b) => b.textContent?.includes('Other Cmd'),
    );
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    expect(onShowSameKeybindings).toHaveBeenCalledWith('mod+k');
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('有冲突:提示行改为「点击保存」,不再写 Enter 保存;Enter 不保存', () => {
    const { onSave } = renderModal();
    act(() => pressCtrl('k'));
    const hints = document.querySelector('[data-testid="keybinding-capture-hints"]')!;
    expect(hints.textContent).toContain('有冲突');
    expect(hints.textContent).not.toContain('Enter');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('无冲突:提示行仍是「按下新组合后,Enter 保存」', () => {
    renderModal();
    act(() => pressCtrl('j'));
    const hints = document.querySelector('[data-testid="keybinding-capture-hints"]')!;
    expect(hints.textContent).toContain('Enter');
    expect(hints.textContent).not.toContain('有冲突');
  });

  it('冲突说明:本命令保存后会胜出(冲突方是默认绑定)→「保存后由本命令响应」', () => {
    renderModal();
    act(() => pressCtrl('k'));
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('保存后由本命令响应此快捷键');
  });

  it('冲突说明:冲突方也是用户设置且先注册 → 「保存后仍由「Other Cmd」响应」', () => {
    renderModal({
      allCommands: [
        { id: 'other', title: 'Other Cmd', fn: vi.fn() },
        { id: 'target', title: 'Target', fn: vi.fn() },
      ],
      overrides: { other: 'mod+k' },
    });
    act(() => pressCtrl('k'));
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain('保存后仍由「Other Cmd」响应');
  });
});

describe('设置 › 快捷键:弹窗冲突项 → 列表按键过滤', () => {
  it('点冲突项 → 搜索框填该快捷键,只列出用这个键的命令', () => {
    coApp.commands.register({ id: 'target', title: 'Target Cmd', fn: vi.fn() });
    coApp.commands.register({ id: 'k1', title: 'Uses K', hotkey: 'mod+k', fn: vi.fn() });
    coApp.commands.register({ id: 'j1', title: 'Uses J', hotkey: 'mod+j', fn: vi.fn() });
    const { container } = render(<KeybindingsTabContent />);
    const row = Array.from(container.querySelectorAll('li')).find((r) => r.textContent?.includes('Target Cmd'))!;
    fireEvent.click(row.querySelector<HTMLButtonElement>('button[aria-label*="编辑"]')!);
    act(() => pressCtrl('k'));
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).find(
      (b) => b.textContent?.includes('Uses K'),
    )!;
    fireEvent.click(btn);
    expect(document.querySelector('.wm-modal-content')).toBeNull();
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('ctrl+k');
    expect(container.textContent).toContain('Uses K');
    expect(container.textContent).not.toContain('Uses J');
  });
});
