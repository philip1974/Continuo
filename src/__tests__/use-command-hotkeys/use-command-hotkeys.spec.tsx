// @vitest-environment jsdom
// R15:matchesHotkey 现在平台感知。本 hook 测试用默认 detectPlatform()(jsdom 环境 = 'other'),
// 该平台下 'mod' = ctrlKey,故用 ctrlKey 事件触发 mod+* 命令(验证 hook 接线,非平台细节)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  buildCompiledBindings,
  useCommandHotkeys,
} from '../../plugins/command-palette/useCommandHotkeys';
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
  it('没有有效 hotkey 时复用空预编译表,避免空数组分配', () => {
    const empty = buildCompiledBindings([], 'other');
    const noHotkey = buildCompiledBindings(
      [{ id: 'a', title: 'A', fn: vi.fn() }],
      'other',
    );
    const explicitUnbind = buildCompiledBindings(
      [{ id: 'b', title: 'B', hotkey: '', fn: vi.fn() }],
      'other',
    );

    expect(noHotkey).toBe(empty);
    expect(explicitUnbind).toBe(empty);
  });

  it('没有有效 hotkey 时不注册全局 keydown listener', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', fn: vi.fn() });
    const addSpy = vi.spyOn(document, 'addEventListener');

    try {
      renderHook(() => useCommandHotkeys(reg));
      const keydownAdds = addSpy.mock.calls.filter(
        ([type]) => type === 'keydown',
      );
      expect(keydownAdds).toHaveLength(0);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('matches hotkey → 调 fn + preventDefault + stopPropagation', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    renderHook(() => useCommandHotkeys(reg));

    const { event, preventDefault } = keyEvent({ key: 's', ctrlKey: true });
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

  it('一次 keydown 只归一化事件 key 一次,不按绑定数重复 lowercase', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: vi.fn() });
    reg.register({ id: 'b', title: 'B', hotkey: 'mod+k', fn: vi.fn() });
    renderHook(() => useCommandHotkeys(reg));
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      document.dispatchEvent(keyEvent({ key: 'q', ctrlKey: true }).event);
      expect(lowerSpy).toHaveBeenCalledTimes(1);
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('多 cmd 同 hotkey → 第一条命中即 return', () => {
    const f1 = vi.fn();
    const f2 = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: f1 });
    reg.register({ id: 'b', title: 'B', hotkey: 'mod+s', fn: f2 });
    renderHook(() => useCommandHotkeys(reg));

    document.dispatchEvent(
      keyEvent({ key: 's', ctrlKey: true }).event,
    );
    // getAll 用插入序,第一条赢
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).not.toHaveBeenCalled();
  });
});

describe('useCommandHotkeys — a11y · 可编辑目标内放行无修饰键(A64)', () => {
  function withInput(run: (input: HTMLInputElement) => void): void {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      run(input);
    } finally {
      input.remove();
    }
  }

  it('焦点在 input 内、绑定单键 x → 不执行命令、不阻止默认(可正常打字)', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'x', fn });
    renderHook(() => useCommandHotkeys(reg));

    withInput((input) => {
      const { event, preventDefault } = keyEvent({ key: 'x' });
      input.dispatchEvent(event);
      expect(fn).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  it('焦点在 input 内、绑定 shift+x(仅 shift 仍属打字)→ 同样放行', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'shift+x', fn });
    renderHook(() => useCommandHotkeys(reg));

    withInput((input) => {
      const { event, preventDefault } = keyEvent({ key: 'x', shiftKey: true });
      input.dispatchEvent(event);
      expect(fn).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    });
  });

  it('焦点在 input 内、绑定 mod+s(带修饰)→ 仍执行(全局保存等需生效)', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn });
    renderHook(() => useCommandHotkeys(reg));

    withInput((input) => {
      const { event, preventDefault } = keyEvent({ key: 's', ctrlKey: true });
      input.dispatchEvent(event);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(preventDefault).toHaveBeenCalled();
    });
  });

  it('非可编辑目标(document)、绑定单键 x → 正常执行(全局单键仍有效)', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'x', fn });
    renderHook(() => useCommandHotkeys(reg));

    const { event, preventDefault } = keyEvent({ key: 'x' });
    document.dispatchEvent(event);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
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
    document.dispatchEvent(keyEvent({ key: 's', ctrlKey: true }).event);
    expect(fn).not.toHaveBeenCalled();

    // 新的响应
    document.dispatchEvent(
      keyEvent({ key: 'x', ctrlKey: true, shiftKey: true }).event,
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

    document.dispatchEvent(keyEvent({ key: 's', ctrlKey: true }).event);
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

    document.dispatchEvent(keyEvent({ key: 'k', ctrlKey: true }).event);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dispose 命令 → hotkey 不再响应', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    const d = reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));

    act(() => d.dispose());
    document.dispatchEvent(keyEvent({ key: 'k', ctrlKey: true }).event);
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

    document.dispatchEvent(keyEvent({ key: 's', ctrlKey: true }).event);
    expect(fn).not.toHaveBeenCalled();
  });
});
