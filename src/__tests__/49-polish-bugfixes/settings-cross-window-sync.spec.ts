// @vitest-environment jsdom
// topic 49 第十一轮 · P2-CC:settings values-store 跨窗口 storage 同步。
//
// 根因:values-store 用 localStorage 持久化,但 zustand 内存快照只在本窗启动时读一次,
// 之后不随别窗的写更新。多窗口下窗口 A 改 general.language → 写 localStorage + 经
// settings 广播更新 useSettingsStore.locale,但窗口 B 的 values-store 内存仍是旧值 →
// LanguageFromSettings 的 values→store 协调 effect 拿 B 的陈旧 value 把刚广播来的
// locale 又改回去(跨窗 locale 互斗,两窗反复翻转)。
//
// 修复:values-store 监听 storage 事件(只在别 document 改 localStorage 时 fire),
// 同 key 就重读 → 各窗 values 收敛一致,不再用陈旧 value 反推 store。

import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

const STORAGE_KEY = 'continuo.settings.values';

beforeEach(() => {
  localStorage.clear();
  useSettingsValuesStore.setState({ values: {} });
});

describe('topic49 P2-CC · settings 跨窗口 storage 同步', () => {
  it('别窗改了 localStorage(storage 事件)→ 本窗 values 重读到新值', () => {
    // 模拟别的窗口写了 general.language=zh 到共享 localStorage
    const next = { 'general.language': 'zh' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

    // storage 事件只在"别的 document"改 localStorage 时 fire;手动派发模拟
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: JSON.stringify(next),
      }),
    );

    expect(useSettingsValuesStore.getState().values['general.language']).toBe('zh');
  });

  it('storage 事件 key 不是本 store 的 key → 忽略,不动 values', () => {
    useSettingsValuesStore.setState({ values: { 'general.language': 'en' } });
    localStorage.setItem('some.other.key', 'x');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'some.other.key', newValue: 'x' }),
    );
    // 未变(没读自己的 key)
    expect(useSettingsValuesStore.getState().values['general.language']).toBe('en');
  });

  it('storage 事件携带的清空 → 本窗 values 收敛为空(回到默认)', () => {
    useSettingsValuesStore.setState({ values: { 'general.language': 'zh' } });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({}));
    window.dispatchEvent(
      new StorageEvent('storage', { key: STORAGE_KEY, newValue: '{}' }),
    );
    expect(useSettingsValuesStore.getState().values['general.language']).toBeUndefined();
  });
});
