import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useSettingsValuesStore,
  getSettingValue,
  useSettingValue,
} from '../../plugins/settings/values-store';
import {
  SI_TEXT_VALUE_MAX,
  type SettingItemSpec,
} from '../../plugins/registries/SettingItemRegistry';
import { coApp } from '../../plugins/co-app';

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

  it('setValue 写入相同值且内存已同步时不通知订阅者且不重复写 localStorage', () => {
    const values = { 'general.theme': 'light' };
    globalThis.localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify(values),
    );
    useSettingsValuesStore.setState({ values });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const objectKeysSpy = vi.spyOn(Object, 'keys');
    const listener = vi.fn();
    const unsubscribe = useSettingsValuesStore.subscribe(listener);

    try {
      useSettingsValuesStore.getState().setValue('general.theme', 'light');
      const objectKeysCalls = objectKeysSpy.mock.calls.length;

      expect(useSettingsValuesStore.getState().values).toBe(values);
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(objectKeysCalls).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      objectKeysSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('storage 同步读到相同 values 内容时不通知订阅者', () => {
    const values = { 'general.theme': 'light' };
    globalThis.localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify(values),
    );
    useSettingsValuesStore.setState({ values });
    const listener = vi.fn();
    const unsubscribe = useSettingsValuesStore.subscribe(listener);

    try {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'continuo.settings.values' }),
      );

      expect(useSettingsValuesStore.getState().values).toBe(values);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  // 边界(E260,写读 cap 对称):整份 overrides 序列化超 localStorage 读端 raw cap(1MiB)时,setValue
  // 拒写且**不提交内存态** —— 否则本会话内存 vs 磁盘发散,下次启动 readRecord 整表返 {} = 所有设置静默丢失。
  it('E260 整份超 1MiB → setValue 拒写且不提交内存态(保留上次有效状态)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const CAP = 1024 * 1024;
    // 预置一份单条恰好略低于 cap 的有效 overrides(模拟多个大 text 累积);再加一条即超 cap。
    const big = 'x'.repeat(CAP - 40);
    globalThis.localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify({ 'editor.scratch': big }),
    );
    useSettingsValuesStore.setState({ values: { 'editor.scratch': big } });

    useSettingsValuesStore.getState().setValue('general.theme', 'light');

    // 不提交内存态:general.theme 未写入,values 仍为上次有效状态
    expect(
      useSettingsValuesStore.getState().values['general.theme'],
    ).toBeUndefined();
    expect(getSettingValue(themeSpec)).toBe('dark'); // 回退 default(未写入)
    // localStorage 未被超大记录覆盖(仍可被 readRecord 读回 editor.scratch)
    expect(globalThis.localStorage.getItem('continuo.settings.values')).toBe(
      JSON.stringify({ 'editor.scratch': big }),
    );
    expect(warn).toHaveBeenCalled();
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

  it('setValue 持久化到 localStorage', () => {
    useSettingsValuesStore.getState().setValue('editor.fontSize', 18);
    const raw = globalThis.localStorage.getItem('continuo.settings.values');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'editor.fontSize': 18 });
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

  it('resetAll 清所有 override', () => {
    const s = useSettingsValuesStore.getState();
    s.setValue('general.theme', 'light');
    s.setValue('editor.fontSize', 18);
    useSettingsValuesStore.getState().resetAll();
    expect(useSettingsValuesStore.getState().values).toEqual({});
    expect(globalThis.localStorage.getItem('continuo.settings.values')).toBe(
      '{}',
    );
  });

  it('resetAll 空表且内存已同步时不通知订阅者且不重复写 localStorage', () => {
    globalThis.localStorage.setItem('continuo.settings.values', '{}');
    const values = {};
    useSettingsValuesStore.setState({ values });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const listener = vi.fn();
    const unsubscribe = useSettingsValuesStore.subscribe(listener);

    try {
      useSettingsValuesStore.getState().resetAll();

      expect(useSettingsValuesStore.getState().values).toBe(values);
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      setItemSpy.mockRestore();
    }
  });

  // race(R6):多窗口 lost update —— 窗口 B 基于陈旧内存快照改自己的 key,不得整表覆盖掉
  // 窗口 A 刚写进 localStorage 的另一个 key。setValue 须基于 live localStorage merge。
  it('R6 setValue 基于 live localStorage merge:不丢别窗已写的 key', () => {
    // 窗口 A 已写 general.theme=light(直接落 localStorage);窗口 B 内存快照陈旧(只有 fontSize=14)。
    globalThis.localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify({ 'editor.fontSize': 14, 'general.theme': 'light' }),
    );
    useSettingsValuesStore.setState({ values: { 'editor.fontSize': 14 } });

    // 窗口 B 改自己的 fontSize → 须 merge live(含 A 的 theme),而非整表写回陈旧快照。
    useSettingsValuesStore.getState().setValue('editor.fontSize', 18);

    const persisted = JSON.parse(
      globalThis.localStorage.getItem('continuo.settings.values')!,
    );
    expect(persisted).toEqual({ 'editor.fontSize': 18, 'general.theme': 'light' });
    // 本窗内存也收敛到含别窗 key。
    expect(useSettingsValuesStore.getState().values['general.theme']).toBe('light');
  });

  it('R6 reset 基于 live localStorage:删自己 key 不丢别窗 key', () => {
    globalThis.localStorage.setItem(
      'continuo.settings.values',
      JSON.stringify({ 'editor.fontSize': 18, 'general.theme': 'light' }),
    );
    useSettingsValuesStore.setState({ values: { 'editor.fontSize': 18 } });

    useSettingsValuesStore.getState().reset('editor.fontSize');

    const persisted = JSON.parse(
      globalThis.localStorage.getItem('continuo.settings.values')!,
    );
    expect(persisted).toEqual({ 'general.theme': 'light' });
  });

  it('writeStored 抛(quota)→ 静默,in-memory 仍写入', () => {
    const original = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() =>
        useSettingsValuesStore.getState().setValue('general.theme', 'light'),
      ).not.toThrow();
      expect(useSettingsValuesStore.getState().values['general.theme']).toBe(
        'light',
      );
    } finally {
      globalThis.localStorage.setItem = original;
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

// 边界(E139,E6/E122 同族读路径净化):select setting 的 stored 值须属于 spec.enum,否则回退
// default —— 篡改/旧 localStorage 的任意字符串不应喂给消费者(如 terminal.cursorStyle → xterm)。
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
