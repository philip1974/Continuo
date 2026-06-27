// @vitest-environment jsdom
// race(R51):全局 hotkey 绑定表 / 命令面板列表项缓存 CommandSpec 并直接调 cmd.fn()。命令被插件
// disable/reload 同步 unregister 后、到 React 重渲替换 handler/快照前的窗口内,旧闭包仍持已卸载
// 命令的 fn → 触发会执行已卸载插件代码。修:触发时按 id 从 live CommandRegistry 重查再执行,
// 死命令静默忽略。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => cleanup());

function fireModK(): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true, // jsdom detectPlatform()='other' → 'mod' = ctrlKey
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe('race(R51) · CommandRegistry.get live 查找', () => {
  it('register → get(id) 返回 spec;dispose 后 get(id) 返回 undefined', () => {
    const reg = new CommandRegistry();
    const disp = reg.register({ id: 'a', title: 'A', fn: vi.fn() });
    expect(reg.get('a')?.id).toBe('a');
    disp.dispose();
    expect(reg.get('a')).toBeUndefined();
  });
});

describe('race(R51) · hotkey 触发按 id 重查执行', () => {
  it('命令仍在 → 经 live 查找执行 fn', () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));
    fireModK();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('触发时命令已从 live registry 移除(绑定表 stale)→ 不执行 stale fn', () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));
    // 模拟「绑定表已建但命令已从 live registry 移除」—— unregister 与 React 重渲替换 handler
    // 之间的窗口。旧实现调缓存的 b.cmd.fn() → fn 被执行(bug);修复后按 id 重查得 undefined → 跳过。
    vi.spyOn(reg, 'get').mockReturnValue(undefined);
    fireModK();
    expect(fn).not.toHaveBeenCalled();
  });
});
