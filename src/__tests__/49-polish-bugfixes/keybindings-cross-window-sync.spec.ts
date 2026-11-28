// @vitest-environment jsdom
// 第二十二轮 P2-BA:keybindings-store 跨窗口同步。
//
// 根因:zustand 内存快照只在本窗启动时读一次。多窗口下窗口 A 改/解绑快捷键,窗口 B 内存仍是旧值 → B 的
// useCommandHotkeys 仍按旧绑定派发键盘,设置 tab / CommandPalette 显示陈旧 hotkey,直到 B 重载才收敛。
// 快捷键覆盖迁到主进程文件后由 main 广播(此前是 localStorage 的 storage 事件),见 src/__tests__/user-settings-main-store/。
// 见 README "第二十二轮"。被测:src/plugins/keybindings/keybindings-store.ts。

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createFakeUserSettingsMain,
  uninstallUserSettingsHost,
  type FakeUserSettingsMain,
} from '../_helpers/fake-user-settings-main';

async function openWindow(main: FakeUserSettingsMain) {
  vi.resetModules();
  main.install();
  return import('../../plugins/keybindings/keybindings-store');
}

afterEach(() => uninstallUserSettingsHost());

describe('topic49 P2-BA · keybindings 跨窗口同步', () => {
  it('别窗改了快捷键(main 广播)→ 本窗 overrides 更新到新绑定', async () => {
    const main = createFakeUserSettingsMain();
    const b = await openWindow(main);
    main.externalUpdate('keybindings', { 'editor.save': 'mod+shift+s' });
    expect(b.useKeybindingsStore.getState().overrides['editor.save']).toBe('mod+shift+s');
  });

  it('别窗解绑(空字符串)→ 本窗收敛到 unbind 语义', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'editor.save': 'mod+s' } } });
    const b = await openWindow(main);
    main.externalUpdate('keybindings', { 'editor.save': '' });
    expect(b.useKeybindingsStore.getState().overrides['editor.save']).toBe('');
  });

  it('只收本类记录的广播:设置值的变化不动 overrides', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'editor.save': 'mod+s' } } });
    const b = await openWindow(main);
    main.externalUpdate('settings', { 'editor.save': 'x' });
    expect(b.useKeybindingsStore.getState().overrides).toEqual({ 'editor.save': 'mod+s' });
  });

  it('别窗恢复默认 → 本窗 overrides 收敛为空', async () => {
    const main = createFakeUserSettingsMain({ keybindings: { record: { 'editor.save': 'mod+s' } } });
    const b = await openWindow(main);
    main.externalUpdate('keybindings', {}, ['editor.save']);
    expect(b.useKeybindingsStore.getState().overrides['editor.save']).toBeUndefined();
  });
});
