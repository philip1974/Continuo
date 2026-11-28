// @vitest-environment jsdom
// topic 49 第十一轮 · P2-CC:settings values-store 跨窗口同步。
//
// 根因:zustand 内存快照只在本窗启动时读一次,之后不随别窗的写更新。多窗口下窗口 A 改 general.language →
// 经 settings 广播更新 useSettingsStore.locale,但窗口 B 的 values-store 内存仍是旧值 →
// LanguageFromSettings 的 values→store 协调 effect 拿 B 的陈旧 value 把刚广播来的
// locale 又改回去(跨窗 locale 互斗,两窗反复翻转)。
//
// 修复:各窗 values 收敛一致。设置值迁到主进程文件后由 main 广播(此前是 localStorage 的 storage 事件),
// 见 src/__tests__/user-settings-main-store/。

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createFakeUserSettingsMain,
  uninstallUserSettingsHost,
  type FakeUserSettingsMain,
} from '../_helpers/fake-user-settings-main';

async function openWindow(main: FakeUserSettingsMain) {
  vi.resetModules();
  main.install();
  return import('../../plugins/settings/values-store');
}

afterEach(() => uninstallUserSettingsHost());

describe('topic49 P2-CC · settings 跨窗口同步', () => {
  it('别窗改了设置(main 广播)→ 本窗 values 更新到新值', async () => {
    const main = createFakeUserSettingsMain();
    const b = await openWindow(main);
    main.externalUpdate('settings', { 'general.language': 'zh' });
    expect(b.useSettingsValuesStore.getState().values['general.language']).toBe('zh');
  });

  it('只收本类记录的广播:快捷键的变化不动 values', async () => {
    const main = createFakeUserSettingsMain({ settings: { record: { 'general.language': 'en' } } });
    const b = await openWindow(main);
    main.externalUpdate('keybindings', { 'general.language': 'mod+x' });
    expect(b.useSettingsValuesStore.getState().values).toEqual({ 'general.language': 'en' });
  });

  it('别窗恢复默认(删 key)→ 本窗 values 收敛为空(回到默认)', async () => {
    const main = createFakeUserSettingsMain({ settings: { record: { 'general.language': 'zh' } } });
    const b = await openWindow(main);
    main.externalUpdate('settings', {}, ['general.language']);
    expect(b.useSettingsValuesStore.getState().values['general.language']).toBeUndefined();
  });
});
