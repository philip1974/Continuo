import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import {
  useSettingsValuesStore,
  getStoredSettingValue,
  useSettingValue,
  migrateLegacySettingIds,
} from '../../plugins/settings/values-store';
import {
  SI_TEXT_VALUE_MAX,
  coerceSettingValue,
  type SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';
import { coApp } from '../../plugins/co-app';
import {
  createFakeUserSettingsMain,
  flushUserSettings,
  uninstallUserSettingsHost,
  type FakeUserSettingsMain,
} from '../_helpers/fake-user-settings-main';

type ValuesStoreModule = typeof import('../../plugins/settings/values-store');

/** 一个「窗口」:装上该窗口的 host 后重新加载 values-store(store 创建时读 main 快照)。 */
async function openWindow(main: FakeUserSettingsMain): Promise<ValuesStoreModule> {
  vi.resetModules();
  main.install();
  return import('../../plugins/settings/values-store');
}

/** 非 React 读取口径:override ?? default,经 coerceSettingValue 规整(与 useSettingValue 同一规整)。 */
function getSettingValue(spec: SettingItemSpec): unknown {
  return coerceSettingValue(spec, getStoredSettingValue(spec.id) ?? spec.default);
}

const textSpec: SettingItemSpec = {
  id: 'editor.scratch',
  category: 'editor',
  title: '便签',
  type: 'text',
  default: '',
};

const themeSpec: SettingItemSpec = {
  id: 'general.theme',
  category: 'general',
  title: '主题',
  type: 'select',
  default: 'dark',
};

const fontSizeSpec: SettingItemSpec = {
  id: 'editor.fontSize',
  category: 'editor',
  title: '字号',
  type: 'number',
  default: 14,
};

beforeEach(() => {
  globalThis.localStorage.clear();
  useSettingsValuesStore.setState({ values: {} });
});

afterEach(() => {
  cleanup();
  uninstallUserSettingsHost();
});

describe('settings values-store', () => {
  it('初态 values 空,getSettingValue 返 default', () => {
    expect(useSettingsValuesStore.getState().values).toEqual({});
    expect(getSettingValue(themeSpec)).toBe('dark');
    expect(getSettingValue(fontSizeSpec)).toBe(14);
  });

  it('setValue 写入 + getSettingValue 反映', () => {
    useSettingsValuesStore.getState().setValue('general.theme', 'light');
    expect(getSettingValue(themeSpec)).toBe('light');
  });

  it('setValue 写入相同值时不通知订阅者且不发给 main', async () => {
    const main = createFakeUserSettingsMain({ settings: { record: { 'general.theme': 'light' } } });
    const w = await openWindow(main);
    const values = w.useSettingsValuesStore.getState().values;
    const listener = vi.fn();
    const unsubscribe = w.useSettingsValuesStore.subscribe(listener);
    try {
      w.useSettingsValuesStore.getState().setValue('general.theme', 'light');
      await flushUserSettings();
      expect(w.useSettingsValuesStore.getState().values).toBe(values);
      expect(main.calls).toEqual([]);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('main 广播内容相同的 values 时不通知订阅者', async () => {
    const main = createFakeUserSettingsMain({ settings: { record: { 'general.theme': 'light' } } });
    const w = await openWindow(main);
    const values = w.useSettingsValuesStore.getState().values;
    const listener = vi.fn();
    const unsubscribe = w.useSettingsValuesStore.subscribe(listener);
    try {
      main.rebroadcast('settings');
      expect(w.useSettingsValuesStore.getState().values).toBe(values);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  // 边界(E260,写读 cap 对称):整份记录超 main 文件上限时 main 拒写(PAYLOAD_TOO_LARGE),本窗**不保留**乐观写入 ——
  // 否则本会话内存与磁盘发散,重启后这次修改凭空消失。
  it('E260 main 拒写(超上限)→ 回滚到上次有效状态并 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const main = createFakeUserSettingsMain({ settings: { record: { 'editor.scratch': 'big' } } });
    const w = await openWindow(main);
    main.failNextUpdate('PAYLOAD_TOO_LARGE');
    w.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    await flushUserSettings();
    expect(w.useSettingsValuesStore.getState().values).toEqual({ 'editor.scratch': 'big' });
    expect(main.record('settings')).toEqual({ 'editor.scratch': 'big' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[settings] setValue 拒写'));
    warn.mockRestore();
  });

  // 边界(E6):getSettingValue 读路径对 number override 按 spec.min/max clamp,防已持久化(损坏
  // localStorage / 旧版本)的越界值喂给 xterm fontSize 等消费者致异常。
  it('E6 getSettingValue 对越界持久化 number 按 spec clamp', () => {
    const clampedSpec: SettingItemSpec = {
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      type: 'number',
      default: 14,
      min: 8,
      max: 40,
    };
    // 直接塞越界 override(模拟损坏持久化)
    useSettingsValuesStore.setState({ values: { 'editor.fontSize': 9999 } });
    expect(getSettingValue(clampedSpec)).toBe(40); // clamp 到 max
    useSettingsValuesStore.setState({ values: { 'editor.fontSize': 0 } });
    expect(getSettingValue(clampedSpec)).toBe(8); // clamp 到 min
  });

  // 边界(E241,E142 写端对偶):getSettingValue 读路径对 text override 按 SI_TEXT_VALUE_MAX 截断 ——
  // 篡改/旧版 localStorage 可放入接近 1MiB 的超长 text(过 valueGuard + readRecord raw cap),读端经
  // coerceSettingValue 截断,防原样返回超长字符串致设置页/消费者渲染卡顿。读≡写。
  it('E241 getSettingValue 对超长持久化 text 按 SI_TEXT_VALUE_MAX 截断', () => {
    const long = 'x'.repeat(SI_TEXT_VALUE_MAX + 5000);
    useSettingsValuesStore.setState({ values: { 'editor.scratch': long } });
    const got = getSettingValue(textSpec);
    expect(typeof got).toBe('string');
    expect((got as string).length).toBe(SI_TEXT_VALUE_MAX); // 截断,不是 +5000
  });

  it('E241 useSettingValue(hook)读路径同样截断超长 text', () => {
    const d = coApp.settingItems.register({
      id: 'test.e241.text',
      category: 'editor',
      title: 't',
      type: 'text',
      default: '',
    });
    try {
      const long = 'y'.repeat(SI_TEXT_VALUE_MAX + 1234);
      useSettingsValuesStore.setState({ values: { 'test.e241.text': long } });
      const { result } = renderHook(() =>
        useSettingValue<string>('test.e241.text', ''),
      );
      expect(result.current.length).toBe(SI_TEXT_VALUE_MAX);
    } finally {
      d.dispose();
    }
  });

  it('E241 合法长度 text 不受影响', () => {
    useSettingsValuesStore.setState({ values: { 'editor.scratch': 'hello' } });
    expect(getSettingValue(textSpec)).toBe('hello');
  });

  it('setValue 立即生效,并以增量发给 main(main 写盘后两边一致)', async () => {
    const main = createFakeUserSettingsMain();
    const w = await openWindow(main);
    w.useSettingsValuesStore.getState().setValue('editor.fontSize', 18);
    expect(w.useSettingsValuesStore.getState().values).toEqual({ 'editor.fontSize': 18 }); // 乐观更新
    expect(main.calls).toEqual([{ kind: 'update', scope: 'settings', set: { 'editor.fontSize': 18 }, remove: [] }]);
    await flushUserSettings();
    expect(main.record('settings')).toEqual({ 'editor.fontSize': 18 });
    expect(w.useSettingsValuesStore.getState().values).toEqual({ 'editor.fontSize': 18 });
  });

  it('reset 删除 override → 回 default', () => {
    const s = useSettingsValuesStore.getState();
    s.setValue('general.theme', 'light');
    expect(getSettingValue(themeSpec)).toBe('light');
    useSettingsValuesStore.getState().reset('general.theme');
    expect(getSettingValue(themeSpec)).toBe('dark');
  });

  it('reset 不存在的 id → 不变(同 state 引用)', () => {
    const before = useSettingsValuesStore.getState().values;
    useSettingsValuesStore.getState().reset('nope');
    expect(useSettingsValuesStore.getState().values).toBe(before);
  });

  // race(R6/R113):多窗口 lost update —— 此前各窗口在 localStorage 上读-改-写,两窗可基于旧快照互相覆盖。
  // 现在只发增量、由 main 串行读-改-写:两个窗口同时改不同 key,两个都保留,且各窗经广播收敛。
  it('R6 两个窗口同时改不同 key → main 两个都保留,两窗都收敛到合并结果', async () => {
    const main = createFakeUserSettingsMain({ settings: { record: { 'editor.fontSize': 14 } } });
    const a = await openWindow(main);
    const b = await openWindow(main);
    a.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    b.useSettingsValuesStore.getState().setValue('editor.fontSize', 18);
    await flushUserSettings();
    const merged = { 'editor.fontSize': 18, 'general.theme': 'light' };
    expect(main.record('settings')).toEqual(merged);
    expect(a.useSettingsValuesStore.getState().values).toEqual(merged);
    expect(b.useSettingsValuesStore.getState().values).toEqual(merged);
  });

  it('R6 reset 只删自己的 key,不丢别窗的 key', async () => {
    const main = createFakeUserSettingsMain({ settings: { record: { 'editor.fontSize': 18 } } });
    const a = await openWindow(main);
    const b = await openWindow(main);
    a.useSettingsValuesStore.getState().setValue('general.theme', 'light');
    b.useSettingsValuesStore.getState().reset('editor.fontSize');
    await flushUserSettings();
    expect(main.record('settings')).toEqual({ 'general.theme': 'light' });
    expect(b.useSettingsValuesStore.getState().values).toEqual({ 'general.theme': 'light' });
  });

  it('main 写盘失败 → 回滚到上次有效状态并提示保存失败', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const main = createFakeUserSettingsMain();
      const w = await openWindow(main);
      main.failNextUpdate('HANDLER_ERROR');
      expect(() => w.useSettingsValuesStore.getState().setValue('general.theme', 'light')).not.toThrow();
      await flushUserSettings();
      expect(w.useSettingsValuesStore.getState().values).toEqual({});
      // notify 镜像到 console.error(Provider 未挂载时)
      expect(error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/settings\.persist\.save_failed|Failed to save settings/));
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

// 边界(E122,E6 同族读路径对齐):useSettingValue hook 对 number override 也须按注册 spec clamp,
// 与 getSettingValue 一致。此前 hook 直接返 override,越界/非有限值绕过 clamp 喂给 xterm/CSS/timer。
describe('useSettingValue · number clamp (E122)', () => {
  it('E122 越界 / 非有限 number override 经 hook 按 spec clamp', () => {
    const d = coApp.settingItems.register({
      id: 'test.e122.num',
      category: 'editor',
      title: 'n',
      type: 'number',
      default: 13,
      min: 8,
      max: 40,
    });
    try {
      useSettingsValuesStore.setState({ values: { 'test.e122.num': 9999 } });
      expect(
        renderHook(() => useSettingValue<number>('test.e122.num', 13)).result
          .current,
      ).toBe(40); // clamp 到 max
      useSettingsValuesStore.setState({ values: { 'test.e122.num': 0 } });
      expect(
        renderHook(() => useSettingValue<number>('test.e122.num', 13)).result
          .current,
      ).toBe(8); // clamp 到 min
      // 非有限(经 setValue 进 in-memory store)→ clampSettingNumber 回退 default
      useSettingsValuesStore.setState({
        values: { 'test.e122.num': Infinity },
      });
      expect(
        renderHook(() => useSettingValue<number>('test.e122.num', 13)).result
          .current,
      ).toBe(13);
    } finally {
      d.dispose();
      useSettingsValuesStore.setState({ values: {} });
    }
  });

  it('E122 未注册 spec → hook 原样返回(graceful,不崩)', () => {
    useSettingsValuesStore.setState({ values: { 'test.e122.unregistered': 9999 } });
    expect(
      renderHook(() => useSettingValue<number>('test.e122.unregistered', 13))
        .result.current,
    ).toBe(9999);
    useSettingsValuesStore.setState({ values: {} });
  });
});

// 默认值只有一个来源:已注册 spec 的 default(设置页 SettingItemRow 显示的也是它)。调用点传的 fallback
// 只在 spec 未注册(测试 / 早期)时兜底 —— 此前未存值时一律用调用点字面量,两处一旦漂移,设置页显示的默认
// 与实际运行值就不同。
describe('useSettingValue · 默认值来源', () => {
  it('spec 已注册且未存值 → 返回 spec.default(不用调用点 fallback)', () => {
    const d = coApp.settingItems.register({
      id: 'test.default.src',
      category: 'editor',
      title: 'n',
      type: 'number',
      default: 14,
      min: 8,
      max: 40,
    });
    try {
      useSettingsValuesStore.setState({ values: {} });
      expect(
        renderHook(() => useSettingValue<number>('test.default.src', 13)).result.current,
      ).toBe(14);
    } finally {
      d.dispose();
    }
  });

  it('spec 未注册且未存值 → 返回调用点 fallback', () => {
    useSettingsValuesStore.setState({ values: {} });
    expect(
      renderHook(() => useSettingValue<number>('test.default.unregistered', 13)).result.current,
    ).toBe(13);
  });
});

// 边界(E139,E6/E122 同族读路径净化):select setting 的 stored 值须属于 spec.enum,否则回退
// default —— 篡改/旧 localStorage 的任意字符串不应喂给消费者(如 terminal.integrated.cursorStyle → xterm)。
describe('select enum 净化 (E139)', () => {
  const cursorSpec: SettingItemSpec = {
    id: 'test.e139.cursor',
    category: 'terminal',
    title: 'cursor',
    type: 'select',
    default: 'block',
    enum: [
      { value: 'block', label: 'Block' },
      { value: 'underline', label: 'Underline' },
      { value: 'bar', label: 'Bar' },
    ],
  };

  it('E139 getSettingValue:非法 select 值 → 回退 default', () => {
    useSettingsValuesStore.setState({
      values: { 'test.e139.cursor': 'evil-injection' },
    });
    expect(getSettingValue(cursorSpec)).toBe('block');
  });

  it('E139 getSettingValue:合法 select 值 → 保留', () => {
    useSettingsValuesStore.setState({ values: { 'test.e139.cursor': 'bar' } });
    expect(getSettingValue(cursorSpec)).toBe('bar');
  });

  it('E139 无 enum 的 select spec → 原样返回(不误伤极简 spec)', () => {
    // themeSpec 无 enum 字段;stored 任意值应原样返回(无可校验集合)。
    useSettingsValuesStore.setState({ values: { 'general.theme': 'light' } });
    expect(getSettingValue(themeSpec)).toBe('light');
  });

  it('E139 useSettingValue(hook):非法 select 值经注册 spec → 回退 default', () => {
    const d = coApp.settingItems.register(cursorSpec);
    try {
      useSettingsValuesStore.setState({
        values: { 'test.e139.cursor': 'evil' },
      });
      expect(
        renderHook(() => useSettingValue<string>('test.e139.cursor', 'block'))
          .result.current,
      ).toBe('block');
      useSettingsValuesStore.setState({
        values: { 'test.e139.cursor': 'underline' },
      });
      expect(
        renderHook(() => useSettingValue<string>('test.e139.cursor', 'block'))
          .result.current,
      ).toBe('underline'); // 合法值保留
    } finally {
      d.dispose();
      useSettingsValuesStore.setState({ values: {} });
    }
  });
});

// 边界(E142,E122/E139 读路径净化的写侧对偶):setValue 写入前按 live spec 净化 + text 截断,
// 防超大 text 撑爆 settings localStorage 整份记录(1MiB raw cap 超限丢全表)+ 持久化非法值。
describe('setValue 写侧净化 (E142)', () => {
  it('E142 超长 text 值 → 截断到上限(spec 未注册也截断)', () => {
    useSettingsValuesStore.getState().setValue(
      'test.e142.text',
      'x'.repeat(70 * 1024),
    );
    const v = useSettingsValuesStore.getState().values['test.e142.text'];
    expect(typeof v).toBe('string');
    expect((v as string).length).toBe(64 * 1024);
    useSettingsValuesStore.setState({ values: {} });
  });

  it('E142 经注册 spec 净化:number clamp / select 非法回退 default / 合法保留', () => {
    const dn = coApp.settingItems.register({
      id: 'test.e142.num',
      category: 'editor',
      title: 'n',
      type: 'number',
      default: 13,
      min: 8,
      max: 40,
    });
    const ds = coApp.settingItems.register({
      id: 'test.e142.sel',
      category: 'editor',
      title: 's',
      type: 'select',
      default: 'block',
      enum: [
        { value: 'block', label: 'B' },
        { value: 'bar', label: 'Bar' },
      ],
    });
    try {
      const store = useSettingsValuesStore.getState();
      store.setValue('test.e142.num', 9999);
      expect(useSettingsValuesStore.getState().values['test.e142.num']).toBe(40);
      store.setValue('test.e142.sel', 'evil');
      expect(useSettingsValuesStore.getState().values['test.e142.sel']).toBe(
        'block',
      );
      store.setValue('test.e142.sel', 'bar');
      expect(useSettingsValuesStore.getState().values['test.e142.sel']).toBe(
        'bar',
      );
    } finally {
      dn.dispose();
      ds.dispose();
      useSettingsValuesStore.setState({ values: {} });
    }
  });
});

describe('values-store · readStored 防御', () => {
  it('JSON 损坏 → 空对象 hydrate', async () => {
    globalThis.localStorage.setItem('continuo.settings.values', 'not-json');
    vi.resetModules();
    const mod = await import('../../plugins/settings/values-store');
    expect(mod.useSettingsValuesStore.getState().values).toEqual({});
  });

  it('值是数组 → 空对象 hydrate', async () => {
    globalThis.localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify(['a', 'b']),
    );
    vi.resetModules();
    const mod = await import('../../plugins/settings/values-store');
    expect(mod.useSettingsValuesStore.getState().values).toEqual({});
  });
});

// 终端字号 / 光标样式改用 VSCode 的 id(terminal.integrated.fontSize / terminal.integrated.cursorStyle):旧 id 的已存值不丢。
describe('settings values-store — 旧设置 id 迁移', () => {
  const KEY = 'continuo.settings.values';

  it('迁移规则:旧 id 改记到新 id 并删除;新 id 已有值时以新 id 为准;无旧 id 返回原对象', () => {
    const plain = { 'editor.fontSize': 14 };
    expect(migrateLegacySettingIds(plain)).toBe(plain);
    expect(
      migrateLegacySettingIds({ 'terminal.fontSize': 18, 'terminal.cursorStyle': 'bar', 'editor.fontSize': 14 }),
    ).toEqual({
      'terminal.integrated.fontSize': 18,
      'terminal.integrated.cursorStyle': 'bar',
      'editor.fontSize': 14,
    });
    expect(
      migrateLegacySettingIds({ 'terminal.fontSize': 18, 'terminal.integrated.fontSize': 20 }),
    ).toEqual({ 'terminal.integrated.fontSize': 20 });
  });

  it('启动:已存的旧 id 读成新 id,并立即写回 main(旧 id 消失)', async () => {
    const main = createFakeUserSettingsMain({
      settings: { record: { 'terminal.fontSize': 18, 'terminal.cursorStyle': 'bar' } },
    });
    const fresh = await openWindow(main);
    const expected = { 'terminal.integrated.fontSize': 18, 'terminal.integrated.cursorStyle': 'bar' };
    expect(fresh.useSettingsValuesStore.getState().values).toEqual(expected);
    await flushUserSettings();
    expect(main.record('settings')).toEqual(expected);
  });

  it('跨窗口广播读到旧 id 时同样迁移', async () => {
    const main = createFakeUserSettingsMain();
    const w = await openWindow(main);
    main.externalUpdate('settings', { 'terminal.cursorStyle': 'underline' });
    expect(w.useSettingsValuesStore.getState().values).toEqual({ 'terminal.integrated.cursorStyle': 'underline' });
  });

  it('无 main(单测 / 无 preload):按旧 localStorage 记录只读初始化(同样迁移旧 id)', async () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ 'terminal.fontSize': 16 }));
    vi.resetModules();
    const fresh = await import('../../plugins/settings/values-store');
    expect(fresh.useSettingsValuesStore.getState().values).toEqual({ 'terminal.integrated.fontSize': 16 });
  });
});
