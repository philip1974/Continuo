import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  // 边界(E145,写端形态校验):畸形 hotkey(含空白/空段/超长)会让 compileCombo 产出空主键
  //(永不触发)+ UI 异常 → setHotkey 拒写(no-op)。'' = unbind 放行,合法形态写入。
  it('E145 setHotkey 畸形 hotkey(含空白 / 空段 / 超长)→ no-op,不写', () => {
    const s = useKeybindingsStore.getState();
    s.setHotkey('settings.open', 'mod+ '); // 含空白
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBeUndefined();
    s.setHotkey('settings.open', 'shift++'); // 空段(主键 '+')
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBeUndefined();
    s.setHotkey('settings.open', 'x'.repeat(257)); // 超长
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBeUndefined();
  });

  it('E145 setHotkey 合法形态 → 写入;空串 unbind → 写入', () => {
    const s = useKeybindingsStore.getState();
    s.setHotkey('settings.open', 'mod+k');
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBe('mod+k');
    s.setHotkey('settings.open', '');
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBe('');
  });

  it('setHotkey 持久化 localStorage', () => {
    useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+x');
    const raw = globalThis.localStorage.getItem(
      'continuo.keybindings.overrides',
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'foo.bar': 'mod+x' });
  });

  it('setHotkey 写入相同值且内存已同步时不通知订阅者且不重复写 localStorage', () => {
    const overrides = { 'foo.bar': 'mod+x' };
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify(overrides),
    );
    useKeybindingsStore.setState({ overrides });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const objectKeysSpy = vi.spyOn(Object, 'keys');
    const listener = vi.fn();
    const unsubscribe = useKeybindingsStore.subscribe(listener);

    try {
      useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+x');
      const objectKeysCalls = objectKeysSpy.mock.calls.length;

      expect(useKeybindingsStore.getState().overrides).toBe(overrides);
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(objectKeysCalls).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      objectKeysSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('storage 同步读到相同 overrides 内容时不通知订阅者', () => {
    const overrides = { 'foo.bar': 'mod+x' };
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify(overrides),
    );
    useKeybindingsStore.setState({ overrides });
    const listener = vi.fn();
    const unsubscribe = useKeybindingsStore.subscribe(listener);

    try {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'continuo.keybindings.overrides',
        }),
      );

      expect(useKeybindingsStore.getState().overrides).toBe(overrides);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
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

// race(R6,values-store 同型):多窗口 lost update —— 基于 live localStorage merge 单 key,不整表覆盖别窗 key。
describe('keybindings-store · R6 多窗口 lost update', () => {
  it('setHotkey 基于 live localStorage merge:不丢别窗已写的 override', () => {
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify({ 'cmd.a': 'mod+a', 'cmd.b': 'mod+b' }),
    );
    useKeybindingsStore.setState({ overrides: { 'cmd.a': 'mod+a' } }); // 陈旧快照只有 a
    useKeybindingsStore.getState().setHotkey('cmd.a', 'mod+shift+a');
    const persisted = JSON.parse(
      globalThis.localStorage.getItem('continuo.keybindings.overrides')!,
    );
    expect(persisted).toEqual({ 'cmd.a': 'mod+shift+a', 'cmd.b': 'mod+b' });
  });

  it('reset 基于 live localStorage:删自己 override 不丢别窗 override', () => {
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify({ 'cmd.a': 'mod+a', 'cmd.b': 'mod+b' }),
    );
    useKeybindingsStore.setState({ overrides: { 'cmd.a': 'mod+a' } });
    useKeybindingsStore.getState().reset('cmd.a');
    const persisted = JSON.parse(
      globalThis.localStorage.getItem('continuo.keybindings.overrides')!,
    );
    expect(persisted).toEqual({ 'cmd.b': 'mod+b' });
  });

  // 边界(E240,E145 写端对偶):读端 valueGuard 复用写端 HOTKEY_SHAPE_RE。篡改/旧版本残留的畸形
  // localStorage override(mod++s 空段等)被读端放行会让 compileCombo 当成 mod+s 参与全局快捷键匹配 →
  // 意外触发命令。读端只接受 '' 或形态合法值,其余丢弃(降级默认),与写端语义一致。
  it('E240 读回畸形 override(mod++s 空段)→ 丢弃,不混入有效快捷键', () => {
    // 直接写畸形 localStorage(模拟篡改/旧版本残留),含一个合法 + 一个畸形 + 一个空(unbind)。
    globalThis.localStorage.setItem(
      'continuo.keybindings.overrides',
      JSON.stringify({
        'cmd.good': 'mod+shift+x', // 合法 → 保留
        'cmd.bad': 'mod++s', // 空段畸形 → 丢弃
        'cmd.unbind': '', // 空串 unbind → 保留
        'cmd.space': 'mod+ s', // 含空白畸形 → 丢弃
      }),
    );
    // 经 storage 事件触发读端重读(同跨窗同步路径)。
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'continuo.keybindings.overrides',
        newValue: globalThis.localStorage.getItem(
          'continuo.keybindings.overrides',
        ),
      }),
    );
    const ov = useKeybindingsStore.getState().overrides;
    expect(ov['cmd.good']).toBe('mod+shift+x'); // 合法保留
    expect(ov['cmd.unbind']).toBe(''); // unbind 保留
    expect('cmd.bad' in ov).toBe(false); // 畸形丢弃
    expect('cmd.space' in ov).toBe(false); // 畸形丢弃
  });
});
