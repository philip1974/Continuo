import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useKeybindingsStore,
  getEffectiveHotkey,
} from '../../plugins/keybindings/keybindings-store';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';
import {
  createFakeUserSettingsMain,
  flushUserSettings,
  uninstallUserSettingsHost,
  type FakeUserSettingsMain,
} from '../_helpers/fake-user-settings-main';

type KeybindingsStoreModule = typeof import('../../plugins/keybindings/keybindings-store');

/** 一个「窗口」:装上该窗口的 host 后重新加载 keybindings-store(store 创建时读 main 快照)。 */
async function openWindow(main: FakeUserSettingsMain): Promise<KeybindingsStoreModule> {
  vi.resetModules();
  main.install();
  return import('../../plugins/keybindings/keybindings-store');
}

afterEach(() => uninstallUserSettingsHost());

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
    s.setHotkey('settings.open', 'x'.repeat(65)); // 超长(> 注册侧 CMD_HOTKEY_MAX=64,此前 override 侧放到 256)
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBeUndefined();
  });

  it('setHotkey 含未知修饰符(hyper+x)→ no-op,不写', () => {
    useKeybindingsStore.getState().setHotkey('settings.open', 'hyper+x');
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBeUndefined();
  });

  it('E145 setHotkey 合法形态 → 写入;空串 unbind → 写入', () => {
    const s = useKeybindingsStore.getState();
    s.setHotkey('settings.open', 'mod+k');
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBe('mod+k');
    s.setHotkey('settings.open', '');
    expect(useKeybindingsStore.getState().overrides['settings.open']).toBe('');
  });

  it('setHotkey 立即生效,并以增量发给 main(main 写盘后两边一致)', async () => {
    const main = createFakeUserSettingsMain();
    const w = await openWindow(main);
    w.useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+x');
    expect(w.useKeybindingsStore.getState().overrides).toEqual({ 'foo.bar': 'mod+x' });
    expect(main.calls).toEqual([{ kind: 'update', scope: 'keybindings', set: { 'foo.bar': 'mod+x' }, remove: [] }]);
    await flushUserSettings();
    expect(main.record('keybindings')).toEqual({ 'foo.bar': 'mod+x' });
    expect(main.record('settings')).toEqual({}); // 两类记录分开存
  });

  it('setHotkey 写入相同值时不通知订阅者且不发给 main', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'foo.bar': 'mod+x' } } });
    const w = await openWindow(main);
    const overrides = w.useKeybindingsStore.getState().overrides;
    const listener = vi.fn();
    const unsubscribe = w.useKeybindingsStore.subscribe(listener);
    try {
      w.useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+x');
      await flushUserSettings();
      expect(w.useKeybindingsStore.getState().overrides).toBe(overrides);
      expect(main.calls).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('main 广播内容相同的 overrides 时不通知订阅者', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'foo.bar': 'mod+x' } } });
    const w = await openWindow(main);
    const overrides = w.useKeybindingsStore.getState().overrides;
    const listener = vi.fn();
    const unsubscribe = w.useKeybindingsStore.subscribe(listener);
    try {
      main.rebroadcast('keybindings');
      expect(w.useKeybindingsStore.getState().overrides).toBe(overrides);
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

  it('对没有 spec.hotkey 的命令也能设 override', () => {
    useKeybindingsStore.getState().setHotkey('foo.bar', 'mod+f');
    expect(getEffectiveHotkey(noHotkey)).toBe('mod+f');
  });
});

describe('keybindings-store · 写盘失败', () => {
  it('main 写盘失败 → 回滚到上次有效状态,不抛', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const main = createFakeUserSettingsMain({ keybindings: { record: { b: 'mod+b' } } });
      const w = await openWindow(main);
      main.failNextUpdate('HANDLER_ERROR');
      expect(() => w.useKeybindingsStore.getState().setHotkey('a', 'mod+a')).not.toThrow();
      await flushUserSettings();
      expect(w.useKeybindingsStore.getState().overrides).toEqual({ b: 'mod+b' });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
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

// race(R6/R113,values-store 同型):多窗口 lost update —— 只发增量、由 main 串行读-改-写,不整表覆盖别窗 key。
describe('keybindings-store · R6 多窗口 lost update', () => {
  it('两个窗口同时改不同命令 → 两个都保留,两窗收敛', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'cmd.a': 'mod+a' } } });
    const a = await openWindow(main);
    const b = await openWindow(main);
    a.useKeybindingsStore.getState().setHotkey('cmd.a', 'mod+shift+a');
    b.useKeybindingsStore.getState().setHotkey('cmd.b', 'mod+b');
    await flushUserSettings();
    const merged = { 'cmd.a': 'mod+shift+a', 'cmd.b': 'mod+b' };
    expect(main.record('keybindings')).toEqual(merged);
    expect(a.useKeybindingsStore.getState().overrides).toEqual(merged);
    expect(b.useKeybindingsStore.getState().overrides).toEqual(merged);
  });

  it('reset 删自己 override 不丢别窗 override', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'cmd.a': 'mod+a' } } });
    const a = await openWindow(main);
    const b = await openWindow(main);
    b.useKeybindingsStore.getState().setHotkey('cmd.b', 'mod+b');
    a.useKeybindingsStore.getState().reset('cmd.a');
    await flushUserSettings();
    expect(main.record('keybindings')).toEqual({ 'cmd.b': 'mod+b' });
  });

  // 边界(E240,E145 写端对偶):读端 valueGuard 复用写端 isValidHotkeyShape。main 只校验「字符串 + 长度」,
  // 篡改 / 旧版本残留的畸形 override(mod++s 空段等)被放行会让 compileCombo 当成 mod+s 参与全局快捷键匹配 →
  // 意外触发命令。快照与广播都经读端守卫:只接受 '' 或形态合法值,其余丢弃(降级默认)。
  it('E240 快照 / 广播里的畸形 override(mod++s 空段)→ 丢弃,不混入有效快捷键', async () => {
    const bad = {
      'cmd.good': 'mod+shift+x', // 合法 → 保留
      'cmd.bad': 'mod++s', // 空段畸形 → 丢弃
      'cmd.unbind': '', // 空串 unbind → 保留
      'cmd.space': 'mod+ s', // 含空白畸形 → 丢弃
    };
    const main = createFakeUserSettingsMain({ keybindings: { record: bad } });
    const w = await openWindow(main);
    const check = (ov: Record<string, string>): void => {
      expect(ov['cmd.good']).toBe('mod+shift+x');
      expect(ov['cmd.unbind']).toBe('');
      expect('cmd.bad' in ov).toBe(false);
      expect('cmd.space' in ov).toBe(false);
    };
    check(w.useKeybindingsStore.getState().overrides);
    main.externalUpdate('keybindings', { 'cmd.bad2': 'shift++' });
    check(w.useKeybindingsStore.getState().overrides);
    expect('cmd.bad2' in w.useKeybindingsStore.getState().overrides).toBe(false);
  });
});
