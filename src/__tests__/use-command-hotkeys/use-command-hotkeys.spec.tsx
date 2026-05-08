// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

function keyEvent(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): { event: KeyboardEvent; preventDefault: ReturnType<typeof vi.fn> } {
  const event = new KeyboardEvent('keydown', {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  // 不能直接 spyOn(event, 'preventDefault')(原型方法,vitest 类型不兼容);
  // 用一个 fn 代理记录调用,再保留默认行为。
  const preventDefault = vi.fn();
  const orig = event.preventDefault.bind(event);
  Object.defineProperty(event, 'preventDefault', {
    value: () => {
      preventDefault();
      orig();
    },
  });
  return { event, preventDefault };
}

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

describe('useCommandHotkeys — 命中', () => {
  it('matches hotkey → 调 fn + preventDefault + stopPropagation', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    renderHook(() => useCommandHotkeys(reg));

    const { event, preventDefault } = keyEvent({ key: 's', metaKey: true });
    document.dispatchEvent(event);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('未匹配任何 → 不调 fn,不阻止默认', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    renderHook(() => useCommandHotkeys(reg));

    const { event, preventDefault } = keyEvent({ key: 'q' });
    document.dispatchEvent(event);
    expect(fn).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('多 cmd 同 hotkey → 第一条命中即 return', () => {
    const f1 = vi.fn();
    const f2 = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: f1 });
    reg.register({ id: 'b', title: 'B', hotkey: 'mod+s', fn: f2 });
    renderHook(() => useCommandHotkeys(reg));

    document.dispatchEvent(
      keyEvent({ key: 's', metaKey: true }).event,
    );
    // getAll 用插入序,第一条赢
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).not.toHaveBeenCalled();
  });
});

describe('useCommandHotkeys — overrides', () => {
  it('store 改 override → effect 重排,新 hotkey 生效,老的不再响应', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    renderHook(() => useCommandHotkeys(reg));

    act(() => {
      useKeybindingsStore.getState().setHotkey('a', 'mod+shift+x');
    });

    // 老 hotkey 不再响应
    document.dispatchEvent(keyEvent({ key: 's', metaKey: true }).event);
    expect(fn).not.toHaveBeenCalled();

    // 新的响应
    document.dispatchEvent(
      keyEvent({ key: 'x', metaKey: true, shiftKey: true }).event,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('override 设为空字符串 → unbind,不再响应任何', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    renderHook(() => useCommandHotkeys(reg));

    act(() => {
      useKeybindingsStore.getState().setHotkey('a', '');
    });

    document.dispatchEvent(keyEvent({ key: 's', metaKey: true }).event);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('useCommandHotkeys — registry 变化', () => {
  it('注册新命令 → 新 hotkey 立即生效', () => {
    const reg = new CommandRegistry();
    renderHook(() => useCommandHotkeys(reg));

    const fn = vi.fn();
    act(() => {
      reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    });

    document.dispatchEvent(keyEvent({ key: 'k', metaKey: true }).event);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dispose 命令 → hotkey 不再响应', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    const d = reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));

    act(() => d.dispose());
    document.dispatchEvent(keyEvent({ key: 'k', metaKey: true }).event);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('useCommandHotkeys — 卸载', () => {
  it('hook unmount → keydown 监听移除', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    const { unmount } = renderHook(() => useCommandHotkeys(reg));
    unmount();

    document.dispatchEvent(keyEvent({ key: 's', metaKey: true }).event);
    expect(fn).not.toHaveBeenCalled();
  });
});
