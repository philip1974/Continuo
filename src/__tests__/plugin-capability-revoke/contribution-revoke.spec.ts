// @vitest-environment jsdom
// 停用即吊销 —— 贡献点注册表与事件订阅(终审 P1):scoped app 原样暴露的注册表(commands / panels / ...)
// 不经 Plugin.register 收集。吊销后 register / on / subscribe 一律抛 PERMISSION_DENIED;吊销前经 scoped app 直接注册的
// 贡献与订阅由控制面记录,revoke() 时统一注销。见同目录 README.md。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok', generation: 1 }),
      _unregisterPlugin: async () => undefined,
    },
    shell: { killPluginProcesses: async () => ({ ok: true, data: undefined }) },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { createScopedAppController } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp, CoPluginApp } from '../../plugins/types';

const ID = 'com.x.p';
const fn = () => {};
// 与 notifications / dock 的吊销一致:无对应权限项的 UI 贡献 → PERMISSION_DENIED。
const DENIED = expect.objectContaining({ code: 'PERMISSION_DENIED' });
const render = () => null;

const decorator = () => null;

/** 每个注册类成员一条贡献:[成员名, 注册动作, 「该贡献是否仍在共享注册表中」探针]。 */
function contributions(app: CoPluginApp, coApp: CoApp): Array<[string, () => void, () => boolean]> {
  return [
    ['commands', () => app.commands.register({ id: 'c', title: 'C', fn }), () => coApp.commands.get('c') !== undefined],
    ['panels', () => app.panels.register({ type: 'p', title: 'P', factory: render }), () => coApp.panels.get('p') !== undefined],
    ['statusBar', () => app.statusBar.register({ id: 's', side: 'left', render }), () => coApp.statusBar.get('s') !== undefined],
    ['ribbon', () => app.ribbon.register({ id: 'r', title: 'R', icon: null, onClick: fn }), () => coApp.ribbon.get('r') !== undefined],
    ['settingTabs', () => app.settingTabs.register({ id: 't', title: 'T', render }), () => coApp.settingTabs.get('t') !== undefined],
    [
      'settingItems',
      () => app.settingItems.register({ id: 'i', category: 'general', title: 'I', type: 'boolean', default: false }),
      () => coApp.settingItems.get('i') !== undefined,
    ],
    ['explorerDecorators', () => app.explorerDecorators.register(decorator), () => coApp.explorerDecorators.getAll().includes(decorator)],
    ['editorActions', () => app.editorActions.register({ id: 'e', label: 'E', fn }), () => coApp.editorActions.get('e') !== undefined],
    ['explorerContextMenu', () => app.explorerContextMenu.register({ id: 'm', label: 'M', fn }), () => coApp.explorerContextMenu.get('m') !== undefined],
  ];
}

describe('scoped app:注册表 / 事件订阅随吊销回收', () => {
  it('吊销前直接经 scoped app 注册的贡献,revoke() 时全部注销', () => {
    const coApp = createTestCoApp();
    const ctl = createScopedAppController(coApp, ID, null);
    const all = contributions(ctl.app, coApp);
    for (const [, register] of all) register();
    for (const [name, , alive] of all) expect(alive(), name).toBe(true);
    ctl.revoke();
    for (const [name, , alive] of all) expect(alive(), name).toBe(false);
  });

  it('吊销前的 events.on 订阅与注册表 subscribe,revoke() 后不再收到通知', () => {
    const coApp = createTestCoApp();
    const ctl = createScopedAppController(coApp, ID, null);
    const onEvent = vi.fn();
    const onChange = vi.fn();
    ctl.app.events.on('x', onEvent);
    ctl.app.commands.subscribe(onChange);
    ctl.revoke();
    coApp.events.emit('x', 1);
    coApp.commands.register({ id: 'other', title: 'O', fn });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('吊销后 register / on / subscribe 一律抛 PERMISSION_DENIED,不进入共享注册表', () => {
    const coApp = createTestCoApp();
    const ctl = createScopedAppController(coApp, ID, null);
    ctl.revoke();
    for (const [name, register, alive] of contributions(ctl.app, coApp)) {
      expect(register, name).toThrow(DENIED);
      expect(alive(), name).toBe(false);
    }
    expect(() => ctl.app.events.on('x', fn)).toThrow(DENIED);
    expect(() => ctl.app.commands.subscribe(fn)).toThrow(DENIED);
  });

  it('只读查询成员与 events.off 不受影响:吊销后 getAll / get / off 照常', () => {
    const coApp = createTestCoApp();
    coApp.commands.register({ id: 'core', title: 'Core', fn });
    const ctl = createScopedAppController(coApp, ID, null);
    const listener = vi.fn();
    ctl.app.events.on('x', listener);
    ctl.revoke();
    expect(ctl.app.commands.get('core')).toBeDefined();
    expect(ctl.app.commands.getAll()).toHaveLength(1);
    expect(() => ctl.app.events.off('x', listener)).not.toThrow();
  });

  it('吊销后 commands.execute reject、events.emit / clear 抛 PERMISSION_DENIED,共享注册表 / 总线无副作用', async () => {
    const coApp = createTestCoApp();
    const run = vi.fn();
    coApp.commands.register({ id: 'window.new', title: 'New Window', fn: run });
    const other = vi.fn();
    coApp.events.on('x', other);
    const ctl = createScopedAppController(coApp, ID, null);
    ctl.revoke();
    await expect(ctl.app.commands.execute('window.new')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(run).not.toHaveBeenCalled();
    expect(() => ctl.app.events.emit('x', 1)).toThrow(DENIED);
    expect(other).not.toHaveBeenCalled();
    expect(() => ctl.app.events.clear('x')).toThrow(DENIED);
    expect(() => ctl.app.events.clear()).toThrow(DENIED);
    // 他人的订阅未被清掉
    coApp.events.emit('x', 2);
    expect(other).toHaveBeenCalledWith(2);
  });

  it('吊销前 commands.execute / events.emit 照常', async () => {
    const coApp = createTestCoApp();
    const run = vi.fn();
    coApp.commands.register({ id: 'core', title: 'Core', fn: run });
    const ctl = createScopedAppController(coApp, ID, null);
    await ctl.app.commands.execute('core');
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => ctl.app.events.emit('x', 1)).not.toThrow();
  });

  it('吊销后旧 Disposable 再 dispose 幂等,不误删他人同 id 的后注册贡献', () => {
    const coApp = createTestCoApp();
    const ctl = createScopedAppController(coApp, ID, null);
    const d = ctl.app.commands.register({ id: 'c', title: 'C', fn });
    ctl.revoke();
    coApp.commands.register({ id: 'c', title: 'Core', fn });
    d.dispose();
    expect(coApp.commands.get('c')?.title).toBe('Core');
  });

  // perf P2:经 events.off 退订的监听,控制面不再留着它的退订句柄(及其捕获的插件回调)直到吊销。
  // 可观测性:残留的句柄会在 revoke() 时再调一次底层 off;不残留则 off 调用次数 = 插件自己 off 的次数。
  it('反复 events.on / off N 次:控制面不残留已退订的句柄,revoke 不再逐个重放 off', () => {
    const coApp = createTestCoApp();
    const off = vi.spyOn(coApp.events, 'off');
    const ctl = createScopedAppController(coApp, ID, null);
    for (let i = 0; i < 20; i++) {
      const l = () => {};
      ctl.app.events.on('x', l);
      ctl.app.events.off('x', l);
    }
    expect(off).toHaveBeenCalledTimes(20);
    ctl.revoke();
    expect(off).toHaveBeenCalledTimes(20);
  });

  it('同一 listener 多次 on 后一次 off(总线按 Set 一次移除):全部对应句柄都不再残留', () => {
    const coApp = createTestCoApp();
    const off = vi.spyOn(coApp.events, 'off');
    const ctl = createScopedAppController(coApp, ID, null);
    const l = vi.fn();
    ctl.app.events.on('x', l);
    ctl.app.events.on('x', l);
    ctl.app.events.off('x', l);
    coApp.events.emit('x', 1);
    expect(l).not.toHaveBeenCalled();
    ctl.revoke();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('off 只摘对应 (name, listener):其余订阅与 off 后重新 on 的订阅仍随 revoke 注销', () => {
    const coApp = createTestCoApp();
    const ctl = createScopedAppController(coApp, ID, null);
    const a = vi.fn();
    const b = vi.fn();
    ctl.app.events.on('x', a);
    ctl.app.events.on('y', a);
    ctl.app.events.on('x', b);
    ctl.app.events.off('x', a);
    ctl.app.events.off('z', b); // 未命中:不影响 x/b
    ctl.app.events.on('x', a);
    ctl.revoke();
    coApp.events.emit('x', 1);
    coApp.events.emit('y', 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('off 后插件仍持有的旧 Disposable 再 dispose:照旧转发到总线(语义不变)', () => {
    const coApp = createTestCoApp();
    const off = vi.spyOn(coApp.events, 'off');
    const ctl = createScopedAppController(coApp, ID, null);
    const l = vi.fn();
    const d = ctl.app.events.on('x', l);
    ctl.app.events.off('x', l);
    d.dispose();
    expect(off).toHaveBeenCalledTimes(2);
  });
});

function makeManager(PluginClass: typeof Plugin): { mgr: PluginManager; coApp: CoApp } {
  const coApp = createTestCoApp('1.0.0');
  const host: ManagerHost = {
    listPluginDirs: () => [
      {
        id: ID,
        manifestText: JSON.stringify({ id: ID, name: 'p', version: '0.1.0' }),
        moduleUrl: 'mod://p',
      },
    ],
    readEnabledIds: () => new Set([ID]),
    mutateEnabledId: () => {},
    importModule: async () => ({ default: PluginClass }),
    killPluginShellProcesses: async () => {},
  };
  return { mgr: new PluginManager(coApp, host), coApp };
}

describe('PluginManager:停用后经原始注册表的注册被拒 / 被清理', () => {
  it('停用后延迟回调 app.commands.register → 被拒,命令不在注册表', async () => {
    let later!: () => unknown;
    class Deferred extends Plugin {
      onload() {
        later = () => this.app.commands.register({ id: 'late', title: 'Late', fn });
      }
    }
    const { mgr, coApp } = makeManager(Deferred);
    await mgr.init();
    await mgr.disable(ID);
    expect(() => later()).toThrow(DENIED);
    expect(coApp.commands.get('late')).toBeUndefined();
  });

  it('停用后延迟回调 app.commands.execute(如 window.new)→ reject,命令不执行', async () => {
    let later!: () => Promise<void>;
    const openWindow = vi.fn();
    class Deferred extends Plugin {
      onload() {
        later = () => this.app.commands.execute('window.new');
      }
    }
    const { mgr, coApp } = makeManager(Deferred);
    coApp.commands.register({ id: 'window.new', title: 'New Window', fn: openWindow });
    await mgr.init();
    await mgr.disable(ID);
    await expect(later()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('停用前绕过 Plugin.register 直接经 app.commands.register 注册的命令,停用后被移除', async () => {
    class Direct extends Plugin {
      onload() {
        this.app.commands.register({ id: 'direct', title: 'Direct', fn, hotkey: 'Mod+Shift+K' });
      }
    }
    const { mgr, coApp } = makeManager(Direct);
    await mgr.init();
    expect(coApp.commands.get('direct')).toBeDefined();
    await mgr.disable(ID);
    expect(coApp.commands.get('direct')).toBeUndefined();
  });
});
