// @vitest-environment jsdom
// 第二十二轮 P2-BA:keybindings-store 跨窗口 storage 同步。
//
// 根因:overrides 用 localStorage 持久化,但 zustand 内存快照只在本窗启动时读一次。
// 多窗口下窗口 A 改/解绑快捷键 → 写 localStorage,窗口 B 内存仍是旧值 → B 的
// useCommandHotkeys 仍按旧绑定派发键盘,设置 tab / CommandPalette 显示陈旧 hotkey,
// 直到 B 重载才收敛。修复镜像 settings values-store 的同款 storage 监听。
// 见 README "第二十二轮"。被测:src/plugins/keybindings/keybindings-store.ts。

import { describe, it, expect, beforeEach } from 'vitest';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';

const STORAGE_KEY = 'continuo.keybindings.overrides';

beforeEach(() => {
  localStorage.clear();
  useKeybindingsStore.setState({ overrides: {} });
});

describe('topic49 P2-BA · keybindings 跨窗口 storage 同步', () => {
  it('别窗改了 localStorage(storage 事件)→ 本窗 overrides 重读到新绑定', () => {
    const next = { 'editor.save': 'mod+shift+s' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: JSON.stringify(next),
      }),
    );
    expect(useKeybindingsStore.getState().overrides['editor.save']).toBe(
      'mod+shift+s',
    );
  });

  it('别窗解绑(空字符串)→ 本窗收敛到 unbind 语义', () => {
    useKeybindingsStore.setState({ overrides: { 'editor.save': 'mod+s' } });
    const next = { 'editor.save': '' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: JSON.stringify(next),
      }),
    );
    expect(useKeybindingsStore.getState().overrides['editor.save']).toBe('');
  });

  it('storage 事件 key 不是本 store 的 key → 忽略', () => {
    useKeybindingsStore.setState({ overrides: { 'editor.save': 'mod+s' } });
    localStorage.setItem('some.other.key', 'x');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'some.other.key', newValue: 'x' }),
    );
    expect(useKeybindingsStore.getState().overrides['editor.save']).toBe('mod+s');
  });

  it('别窗 resetAll(清空)→ 本窗 overrides 收敛为空', () => {
    useKeybindingsStore.setState({ overrides: { 'editor.save': 'mod+s' } });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({}));
    window.dispatchEvent(
      new StorageEvent('storage', { key: STORAGE_KEY, newValue: '{}' }),
    );
    expect(useKeybindingsStore.getState().overrides['editor.save']).toBeUndefined();
  });
});
