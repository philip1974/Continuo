import { describe, it, expect, beforeEach } from 'vitest';
import {
  useKeybindingsStore,
  getEffectiveHotkey,
} from '../../plugins/keybindings/keybindings-store';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';

const open: CommandSpec = {
  id: 'settings.open',
  title: '打开设置',
  hotkey: 'mod+,',
  fn: () => {},
};

const noHotkey: CommandSpec = {
  id: 'foo.bar',
  title: 'Foo Bar',
  fn: () => {},
};

beforeEach(() => {
  globalThis.localStorage.clear();
  useKeybindingsStore.setState({ overrides: {} });
});

describe('keybindings-store', () => {
  it('初态空,getEffectiveHotkey 返 spec.hotkey', () => {
    expect(useKeybindingsStore.getState().overrides).toEqual({});
    expect(getEffectiveHotkey(open)).toBe('mod+,');
    expect(getEffectiveHotkey(noHotkey)).toBeUndefined();
  });

  it('setHotkey 新组合 → effective 用 override', () => {
    useKeybindingsStore.getState().setHotkey('settings.open', 'mod+shift+,');
    expect(getEffectiveHotkey(open)).toBe('mod+shift+,');
  });

  it('setHotkey 空字符串 → effective 返 undefined(unbind)', () => {
    useKeybindingsStore.getState().setHotkey('settings.open', '');
    expect(getEffectiveHotkey(open)).toBeUndefined();
  });

  it('setHotkey 持久化 localStorage', () => {
    useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+x');
    const raw = globalThis.localStorage.getItem(
      'continuo.keybindings.overrides',
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'foo.bar': 'mod+x' });
  });

  it('reset 删 override → 回 spec.hotkey', () => {
    useKeybindingsStore.getState().setHotkey('settings.open', 'mod+1');
    useKeybindingsStore.getState().reset('settings.open');
    expect(getEffectiveHotkey(open)).toBe('mod+,');
  });

  it('reset 不存在的 id → state 引用不变', () => {
    const before = useKeybindingsStore.getState().overrides;
    useKeybindingsStore.getState().reset('zombie');
    expect(useKeybindingsStore.getState().overrides).toBe(before);
  });

  it('resetAll 清所有 override + 持久化空', () => {
    const s = useKeybindingsStore.getState();
    s.setHotkey('a', 'x');
    s.setHotkey('b', '');
    useKeybindingsStore.getState().resetAll();
    expect(useKeybindingsStore.getState().overrides).toEqual({});
    expect(
      globalThis.localStorage.getItem('continuo.keybindings.overrides'),
    ).toBe('{}');
  });

  it('对没有 spec.hotkey 的命令也能设 override', () => {
    useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+f');
    expect(getEffectiveHotkey(noHotkey)).toBe('mod+f');
  });
});

describe('keybindings-store · localStorage 错误兜底', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    useKeybindingsStore.setState({ overrides: {} });
  });

  it('writeStored 抛(quota)→ 静默,in-memory 仍写入', () => {
    const original = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() =>
        useKeybindingsStore.getState().setHotkey('a', 'mod+a'),
      ).not.toThrow();
      expect(useKeybindingsStore.getState().overrides.a).toBe('mod+a');
    } finally {
      globalThis.localStorage.setItem = original;
    }
  });
});

describe('keybindings-store · readStored 防御', () => {
  it('JSON.parse 失败 / 非对象 → reload 时 module 自身的 readStored 容错(此处仅断言运行时 store 在乱数据下不抛)', async () => {
    // 预埋损坏数据
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      'not-json-{{{',
    );
    // 通过动态 import 强制重读 module(vi.resetModules + 再 import)
    const { vi } = await import('vitest');
    vi.resetModules();
    const mod = await import('../../plugins/keybindings/keybindings-store');
    expect(mod.useKeybindingsStore.getState().overrides).toEqual({});
  });

  it('localStorage 中是数组 → fallback 空对象', async () => {
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify(['not', 'an', 'object']),
    );
    const { vi } = await import('vitest');
    vi.resetModules();
    const mod = await import('../../plugins/keybindings/keybindings-store');
    expect(mod.useKeybindingsStore.getState().overrides).toEqual({});
  });

  it('localStorage 有效对象 → hydrate 进 store', async () => {
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify({ 'cmd.x': 'mod+x' }),
    );
    const { vi } = await import('vitest');
    vi.resetModules();
    const mod = await import('../../plugins/keybindings/keybindings-store');
    expect(mod.useKeybindingsStore.getState().overrides).toEqual({
      'cmd.x': 'mod+x',
    });
  });
});
