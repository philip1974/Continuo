// 安全:插件经 scoped app 注册贡献点时,不能覆盖宿主 / 内置插件 / 其它插件已注册的 key;
// events.clear 只清本插件自己的订阅。行为见同目录 README「贡献点 key 的所有权」。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: {} }));

import { createScopedApp, createScopedAppController } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp, CoPluginApp } from '../../plugins/types';

const DENIED = expect.objectContaining({ code: 'PERMISSION_DENIED' });
const Noop = (): null => null;

/** 内置插件:不带 plugin-fs token 的 scoped app(同 bootCorePlugins)。 */
function core(coApp: CoApp, id: string): CoPluginApp {
  return createScopedApp(coApp, id, null);
}
/** 第三方插件:PluginManager 总是带 plugin-fs token。 */
function thirdParty(coApp: CoApp, id: string): CoPluginApp {
  return createScopedApp(coApp, id, null, `token-${id}`);
}

describe('贡献点 key 的所有权:插件不能覆盖非本插件注册的 key', () => {
  it('settingTabs:覆盖内置插件的 core.plugins 页 → PERMISSION_DENIED,原条目不变', () => {
    const coApp = createTestCoApp('1.0.0');
    core(coApp, 'core.plugins').settingTabs.register({ id: 'core.plugins', title: 'Plugins', render: Noop });
    const original = coApp.settingTabs.get('core.plugins');
    const evil = thirdParty(coApp, 'evil');
    expect(() => evil.settingTabs.register({ id: 'core.plugins', title: 'Fake', render: Noop })).toThrow(DENIED);
    expect(coApp.settingTabs.get('core.plugins')).toBe(original);
  });

  it('panels(以 type 为 key):接管 settings / terminal 面板 → 拒', () => {
    const coApp = createTestCoApp('1.0.0');
    core(coApp, 'core.settings-panel').panels.register({ type: 'settings', title: 'Settings', factory: Noop });
    const original = coApp.panels.get('settings');
    const evil = thirdParty(coApp, 'evil');
    expect(() => evil.panels.register({ type: 'settings', title: 'Fake', factory: Noop })).toThrow(DENIED);
    expect(coApp.panels.get('settings')).toBe(original);
  });

  it('commands:劫持内置命令与快捷键 → 拒;被拒的注册不留下条目,插件停用后原命令仍在', () => {
    const coApp = createTestCoApp('1.0.0');
    const fn = vi.fn();
    core(coApp, 'core.terminal').commands.register({ id: 'terminal.new', title: 'New Terminal', hotkey: 'mod+t', fn });
    const ctl = createScopedAppController(coApp, 'evil', null, 'token-evil');
    expect(() =>
      ctl.app.commands.register({ id: 'terminal.new', title: 'Fake', hotkey: 'mod+t', fn: () => {} }),
    ).toThrow(DENIED);
    ctl.revoke();
    expect(coApp.commands.get('terminal.new')?.fn).toBe(fn);
  });

  it('key 字段是 getter(先返回诱饵、之后返回宿主 key)→ 检查与入表用同一份快照,不能覆盖宿主面板', () => {
    const coApp = createTestCoApp('1.0.0');
    core(coApp, 'core.terminal').panels.register({ type: 'terminal', title: 'Terminal', factory: Noop });
    const original = coApp.panels.get('terminal');
    let reads = 0;
    const spec = {
      get type(): string {
        return reads++ === 0 ? 'decoy' : 'terminal';
      },
      title: 'Fake',
      factory: Noop,
    };
    const evil = thirdParty(coApp, 'evil');
    // 快照只读一次 type:要么按 'decoy' 入表(无害),要么被拒;绝不能顶掉 terminal。
    try {
      evil.panels.register(spec);
    } catch {
      /* 被拒也可 */
    }
    expect(coApp.panels.get('terminal')).toBe(original);
    expect(reads).toBe(1);
    const registered = coApp.panels.get('decoy');
    expect(registered).toBeDefined();
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registered!.type).toBe('decoy');
  });

  it('commands 的 id getter 同样只读一次', () => {
    const coApp = createTestCoApp('1.0.0');
    const fn = vi.fn();
    core(coApp, 'core.terminal').commands.register({ id: 'terminal.new', title: 'New Terminal', fn });
    let reads = 0;
    const spec = {
      get id(): string {
        return reads++ === 0 ? 'decoy.cmd' : 'terminal.new';
      },
      title: 'Fake',
      fn: () => {},
    };
    try {
      thirdParty(coApp, 'evil').commands.register(spec);
    } catch {
      /* 被拒也可 */
    }
    expect(coApp.commands.get('terminal.new')?.fn).toBe(fn);
  });

  it('settingItems 的 enum 是深冻结拷贝:注册通过校验后再改插件手里的数组 / 选项,入表的 spec 不变', () => {
    const coApp = createTestCoApp('1.0.0');
    const options: Array<Record<string, unknown>> = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', labelKey: 'evil.b' },
    ];
    thirdParty(coApp, 'evil').settingItems.register({
      id: 'evil.choice',
      category: 'evil',
      title: 'Choice',
      type: 'select',
      default: 'a',
      enum: options as never,
    });
    // 注册期校验已过;事后把 label / value 换成对象 / 超长串,或往数组里塞超出上限的选项。
    options[0]!.label = { toString: () => 'x'.repeat(1_000_000) };
    options[0]!.value = 'z'.repeat(1_000_000);
    options[1]!.labelKey = {};
    for (let i = 0; i < 10_000; i += 1) options.push({ value: `v${i}`, label: `L${i}` });

    const registered = coApp.settingItems.get('evil.choice')!;
    expect(registered.enum).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', labelKey: 'evil.b' },
    ]);
    expect(registered.enum).not.toBe(options);
    expect(Object.isFrozen(registered.enum)).toBe(true);
    expect(registered.enum!.every((o) => Object.isFrozen(o))).toBe(true);
  });

  it('enum 选项字段是 getter(校验时合法、之后返回别的)→ 只在快照时读一次', () => {
    const coApp = createTestCoApp('1.0.0');
    let reads = 0;
    const option = {
      value: 'a',
      get label(): string {
        return reads++ === 0 ? 'A' : 'x'.repeat(1_000_000);
      },
    };
    thirdParty(coApp, 'evil').settingItems.register({
      id: 'evil.choice',
      category: 'evil',
      title: 'Choice',
      type: 'select',
      default: 'a',
      enum: [option],
    });
    expect(reads).toBe(1);
    expect(coApp.settingItems.get('evil.choice')!.enum![0]!.label).toBe('A');
    expect(reads).toBe(1);
  });

  it('畸形 enum(非数组 / 选项不是对象)照旧由注册表校验报错,不入表;调用方传入的数组与选项本身不被冻结', () => {
    const coApp = createTestCoApp('1.0.0');
    const evil = thirdParty(coApp, 'evil');
    const base = { id: 'evil.choice', category: 'evil', title: 'Choice', type: 'select', default: 'a' } as const;
    for (const bad of ['ab', { length: 1, 0: { value: 'a', label: 'A' } }, [null], ['a'], [[]]]) {
      expect(() => evil.settingItems.register({ ...base, enum: bad as never })).toThrow();
      expect(coApp.settingItems.get('evil.choice')).toBeUndefined();
    }
    const mine = [{ value: 'a', label: 'A' }];
    evil.settingItems.register({ ...base, enum: mine });
    expect(Object.isFrozen(mine)).toBe(false);
    expect(Object.isFrozen(mine[0])).toBe(false);
  });

  it('宿主直接在注册表上注册的条目(无所有者)同样不可覆盖', () => {
    const coApp = createTestCoApp('1.0.0');
    coApp.commands.register({ id: 'host.cmd', title: 'Host', fn: () => {} });
    expect(() =>
      thirdParty(coApp, 'evil').commands.register({ id: 'host.cmd', title: 'Fake', fn: () => {} }),
    ).toThrow(DENIED);
  });

  it('其余 keyed 贡献点(ribbon / statusBar / settingItems / editorActions / explorerContextMenu)同一规则', () => {
    const coApp = createTestCoApp('1.0.0');
    const a = thirdParty(coApp, 'p.a');
    const b = thirdParty(coApp, 'p.b');
    const cases: ((app: CoPluginApp) => unknown)[] = [
      (app) => app.ribbon.register({ id: 'k', icon: null, title: 'T', onClick: () => {} }),
      (app) => app.statusBar.register({ id: 'k', side: 'left', render: Noop }),
      (app) => app.settingItems.register({ id: 'k', category: 'general', title: 'T', type: 'boolean', default: false }),
      (app) => app.editorActions.register({ id: 'k', label: 'T', fn: () => {} }),
      (app) => app.explorerContextMenu.register({ id: 'k', label: 'T', fn: () => {} }),
    ];
    for (const register of cases) {
      register(a);
      expect(() => register(b)).toThrow(DENIED);
    }
  });

  it('第三方插件冒用内置插件的 id 也不能覆盖内置条目', () => {
    const coApp = createTestCoApp('1.0.0');
    core(coApp, 'core.plugins').settingTabs.register({ id: 'core.plugins', title: 'Plugins', render: Noop });
    expect(() =>
      thirdParty(coApp, 'core.plugins').settingTabs.register({ id: 'core.plugins', title: 'Fake', render: Noop }),
    ).toThrow(DENIED);
  });

  it('同一插件重复注册自己的 key 仍是后注册赢(含重载后的新实例)', () => {
    const coApp = createTestCoApp('1.0.0');
    const first = thirdParty(coApp, 'p.a');
    first.commands.register({ id: 'a.cmd', title: 'v1', fn: () => {} });
    first.commands.register({ id: 'a.cmd', title: 'v2', fn: () => {} });
    expect(coApp.commands.get('a.cmd')?.title).toBe('v2');
    thirdParty(coApp, 'p.a').commands.register({ id: 'a.cmd', title: 'v3', fn: () => {} });
    expect(coApp.commands.get('a.cmd')?.title).toBe('v3');
  });

  it('所有者注销后 key 可被其它插件注册;宿主覆盖插件条目后,原插件不能再夺回', () => {
    const coApp = createTestCoApp('1.0.0');
    const a = thirdParty(coApp, 'p.a');
    const b = thirdParty(coApp, 'p.b');
    a.commands.register({ id: 'k', title: 'A', fn: () => {} }).dispose();
    b.commands.register({ id: 'k', title: 'B', fn: () => {} });
    expect(coApp.commands.get('k')?.title).toBe('B');

    a.commands.register({ id: 'k2', title: 'A', fn: () => {} });
    coApp.commands.register({ id: 'k2', title: 'Host', fn: () => {} }); // 宿主自身代码:后注册赢不变
    expect(() => a.commands.register({ id: 'k2', title: 'A again', fn: () => {} })).toThrow(DENIED);
    expect(coApp.commands.get('k2')?.title).toBe('Host');
  });
});

describe('events.clear 只清本插件的订阅', () => {
  it('无参 clear:其它插件与宿主的订阅保留', () => {
    const coApp = createTestCoApp('1.0.0');
    const a = thirdParty(coApp, 'p.a');
    const b = thirdParty(coApp, 'p.b');
    const mine = vi.fn();
    const others = vi.fn();
    const host = vi.fn();
    a.events.on('x', mine);
    a.events.on('y', mine);
    b.events.on('x', others);
    coApp.events.on('x', host);
    a.events.clear();
    coApp.events.emit('x', 1);
    coApp.events.emit('y', 1);
    expect(mine).not.toHaveBeenCalled();
    expect(others).toHaveBeenCalledTimes(1);
    expect(host).toHaveBeenCalledTimes(1);
  });

  it('clear(name):只清本插件在该事件上的订阅', () => {
    const coApp = createTestCoApp('1.0.0');
    const a = thirdParty(coApp, 'p.a');
    const b = thirdParty(coApp, 'p.b');
    const mineX = vi.fn();
    const mineY = vi.fn();
    const others = vi.fn();
    a.events.on('x', mineX);
    a.events.on('y', mineY);
    b.events.on('x', others);
    a.events.clear('x');
    coApp.events.emit('x', 1);
    coApp.events.emit('y', 1);
    expect(mineX).not.toHaveBeenCalled();
    expect(mineY).toHaveBeenCalledTimes(1);
    expect(others).toHaveBeenCalledTimes(1);
  });
});
