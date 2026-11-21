// @vitest-environment jsdom
// topic 49 · P2-BI:全局快捷键触发的命令失败也要弹 error toast(与命令面板一致)。
//
// 根因:命令面板 execute 路径已用 runContributedAction 包裹(同步 throw + async reject
// → notify.error),但 useCommandHotkeys 的快捷键派发路径仍是裸 `void cmd.fn()`:同步
// throw 逃逸 keydown handler、async reject 成 unhandledrejection,且无任何 toast → 用
// hotkey 触发的命令失败"按了没反应"完全静默。这是本仓最高频缺陷族「helper 建了未传播
// 到平行调用点」(第十四轮 P2-AO / P1-AX 同类)的再现。
//
// 修复:hotkey 派发也经 runContributedAction,label 用 localize 后 title 与面板对齐。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));
vi.mock('@/notifications/notify', () => ({ notify: notifyMock }));

import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

function dispatchModS(): void {
  // R15:matchesHotkey 平台感知,jsdom 环境 detectPlatform()='other' → 'mod' = ctrlKey。
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => cleanup());

describe('topic49 P2-BI · hotkey 命令失败弹 error toast', () => {
  it('命令同步 throw → notify.error(含 title + 错误信息)', () => {
    const reg = new CommandRegistry();
    reg.register({
      id: 'a',
      title: 'Boom',
      hotkey: 'mod+s',
      fn: () => {
        throw new Error('sync fail');
      },
    });
    renderHook(() => useCommandHotkeys(reg));

    dispatchModS();

    expect(notifyMock.error).toHaveBeenCalledTimes(1);
    const msg = String(notifyMock.error.mock.calls[0]![0]);
    expect(msg).toContain('Boom');
    expect(msg).toContain('sync fail');
  });

  it('命令 async reject → notify.error(含 title)', async () => {
    const reg = new CommandRegistry();
    reg.register({
      id: 'a',
      title: 'AsyncBoom',
      hotkey: 'mod+s',
      fn: () => Promise.reject(new Error('async fail')),
    });
    renderHook(() => useCommandHotkeys(reg));

    dispatchModS();
    await Promise.resolve();
    await Promise.resolve();

    expect(notifyMock.error).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.error.mock.calls[0]![0])).toContain('AsyncBoom');
  });

  it('命令成功 → 不弹 error(无副作用)', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'OK', hotkey: 'mod+s', fn: vi.fn() });
    renderHook(() => useCommandHotkeys(reg));

    dispatchModS();

    expect(notifyMock.error).not.toHaveBeenCalled();
  });
});
