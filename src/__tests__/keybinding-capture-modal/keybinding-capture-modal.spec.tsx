// @vitest-environment jsdom
// R16:eventToCombo 现在平台感知。本 spec 在 jsdom(detectPlatform()='other')下,'mod' 主修饰键
// = Ctrl,故 combo 捕获用 ctrlKey 事件 → 编成 'mod+...'(与生产 mac 上 Cmd→'mod' 对称)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { KeybindingCaptureModal } from '../../plugins/keybindings/KeybindingCaptureModal';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

function defaultProps(over: Partial<Parameters<typeof KeybindingCaptureModal>[0]> = {}) {
  return {
    visible: true,
    commandId: 'cmd.a',
    commandTitle: 'Command A',
    currentHotkey: undefined,
    defaultHotkey: undefined,
    allCommands: [] as readonly CommandSpec[],
    onSave: vi.fn(),
    onClose: vi.fn(),
    onResetToDefault: vi.fn(),
    ...over,
  };
}

function dispatchKey(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: opts.key,
        metaKey: opts.metaKey ?? false,
        ctrlKey: opts.ctrlKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        altKey: opts.altKey ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function getButtons(): Record<string, HTMLButtonElement> {
  const out: Record<string, HTMLButtonElement> = {};
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    '.wm-modal-content button',
  )) {
    out[b.textContent ?? ''] = b;
  }
  return out;
}

describe('KeybindingCaptureModal — 显示态', () => {
  it('captured=null + currentHotkey=undefined → 显示「按下新组合…」', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '按下新组合…',
    );
  });

  it('visible=false → 不渲染 Modal', () => {
    const props = defaultProps({ visible: false });
    render(<KeybindingCaptureModal {...props} />);
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });

  it('captured 非空 → KeyCap 切片渲染新组合', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    // KeyCap 内部有 mod 标识(⌘ on mac, Ctrl on others);至少 'X' 字符在
    const modal = document.querySelector('.wm-modal-content')!;
    expect(modal.textContent).toMatch(/X/i);
  });
});

describe('KeybindingCaptureModal — 按键', () => {
  it('单独修饰键不更新 captured(保存按钮仍 disabled)', () => {
    const onSave = vi.fn();
    const props = defaultProps({ onSave });
    render(<KeybindingCaptureModal {...props} />);

    dispatchKey({ key: 'Meta', ctrlKey: true });
    dispatchKey({ key: 'Shift', shiftKey: true });
    expect(getButtons()['保存']!.disabled).toBe(true);
  });

  it('Backspace → captured="",显示「未绑定」', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'Backspace' });
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '未绑定',
    );
  });
});

describe('KeybindingCaptureModal — 保存 / 重置', () => {
  it('captured=null → 保存 disabled', () => {
    const props = defaultProps();
    render(<KeybindingCaptureModal {...props} />);
    expect(getButtons()['保存']!.disabled).toBe(true);
  });

  it('captured=组合 → 保存调 onSave + onClose', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const props = defaultProps({ onSave, onClose });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'k', ctrlKey: true });

    fireEvent.click(getButtons()['保存']!);
    expect(onSave).toHaveBeenCalledWith('mod+k');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('captured="" → 保存空字符串(unbind 路径)', () => {
    const onSave = vi.fn();
    const props = defaultProps({ onSave });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'Backspace' });
    fireEvent.click(getButtons()['保存']!);
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('defaultHotkey 缺 + captured 未设 → 重置默认 disabled', () => {
    const props = defaultProps({ defaultHotkey: undefined });
    render(<KeybindingCaptureModal {...props} />);
    expect(getButtons()['重置默认']!.disabled).toBe(true);
  });

  it('defaultHotkey 存在 → 重置默认启用,点击调 onResetToDefault + onClose', () => {
    const onResetToDefault = vi.fn();
    const onClose = vi.fn();
    const props = defaultProps({
      defaultHotkey: 'mod+s',
      onResetToDefault,
      onClose,
    });
    render(<KeybindingCaptureModal {...props} />);
    fireEvent.click(getButtons()['重置默认']!);
    expect(onResetToDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('KeybindingCaptureModal — 冲突检测', () => {
  it('其它命令的 effective hotkey 与 captured 相同 → 显示警告', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.a', title: 'A', hotkey: 'mod+old', fn: () => {} },
      { id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} },
    ];
    const props = defaultProps({ allCommands: all });
    render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'x', ctrlKey: true });
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '此组合已绑定到其它命令',
    );
  });

  it('captured=null → 不显示警告', () => {
    const all: CommandSpec[] = [
      { id: 'cmd.b', title: 'B', hotkey: 'mod+x', fn: () => {} },
    ];
    const props = defaultProps({ allCommands: all });
    render(<KeybindingCaptureModal {...props} />);
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).not.toContain('此组合已绑定');
  });
});

describe('KeybindingCaptureModal — visible 切换 → captured 复位', () => {
  it('false → true 时新一轮捕获从 null 开始', () => {
    const props = defaultProps({ visible: true });
    const { rerender } = render(<KeybindingCaptureModal {...props} />);
    dispatchKey({ key: 'k', ctrlKey: true });
    rerender(<KeybindingCaptureModal {...props} visible={false} />);
    rerender(<KeybindingCaptureModal {...props} visible={true} />);

    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      '按下新组合…',
    );
  });
});

describe('KeybindingCaptureModal — 取消', () => {
  it('点取消 → onClose', () => {
    const onClose = vi.fn();
    const props = defaultProps({ onClose });
    render(<KeybindingCaptureModal {...props} />);
    fireEvent.click(getButtons()['取消']!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
