// 安全:插件拿到的贡献点命名空间是「只含 SDK 公开方法的冻结外观」,不是注册表实例(也不是它的 Proxy)。
// 注册表的内部字段(items / listeners / byName / fns)、受保护方法(registerKeyed)与原型方法都不可达。
// 行为见同目录 README「贡献点命名空间是冻结外观」。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({ coApi: {} }));

import { buildPluginListDirEntries, createScopedAppController } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp, CoPluginApp } from '../../plugins/types';

const Noop = (): null => null;
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function setup(): { coApp: CoApp; hostFn: () => void; evil: Loose; revoke: () => void; app: CoPluginApp } {
  const coApp = createTestCoApp('1.0.0');
  const hostFn = vi.fn();
  coApp.commands.register({ id: 'terminal.new', title: 'New Terminal', fn: hostFn });
  coApp.settingTabs.register({ id: 'core.plugins', title: 'Plugins', render: Noop });
  const ctl = createScopedAppController(coApp, 'evil', null, 'token-evil');
  return { coApp, hostFn, evil: ctl.app as unknown as Loose, revoke: ctl.revoke, app: ctl.app };
}

/** 各命名空间对插件公开的成员(以 src/plugins/types.ts 的 Plugin*Api 为准)。 */
const KEYED = ['get', 'getAll', 'register', 'subscribe'];
const SURFACE: Record<string, string[]> = {
  panels: [...KEYED, 'list'].sort(),
  commands: [...KEYED, 'execute'].sort(),
  statusBar: [...KEYED, 'getBySide'].sort(),
  ribbon: KEYED,
  settingTabs: KEYED,
  settingItems: [...KEYED, 'getByCategory'].sort(),
  editorActions: KEYED,
  explorerContextMenu: KEYED,
  explorerDecorators: ['getAll', 'register', 'subscribe'],
  events: ['clear', 'emit', 'off', 'on'],
  workspace: ['getRoot'],
};

describe('贡献点命名空间是冻结外观:注册表内部不可达', () => {
  it('registerKeyed 不可达:不能绕过校验 / 所有权覆盖宿主命令与权限管理页', () => {
    const { coApp, hostFn, evil } = setup();
    const tab = coApp.settingTabs.get('core.plugins');
    expect(evil.commands.registerKeyed).toBeUndefined();
    expect(evil.settingTabs.registerKeyed).toBeUndefined();
    expect(() =>
      evil.commands.registerKeyed('terminal.new', { id: 'terminal.new', title: {}, fn: () => {} }),
    ).toThrow(TypeError);
    expect(coApp.commands.get('terminal.new')?.fn).toBe(hostFn);
    expect(coApp.settingTabs.get('core.plugins')).toBe(tab);
  });

  it('内部 Map / Set / 数组(items / listeners / hotkeyCounts / byName / fns)不可达', () => {
    const { coApp, hostFn, evil } = setup();
    for (const ns of Object.keys(SURFACE)) {
      for (const field of ['items', 'listeners', 'hotkeyCounts', 'cachedAll', 'byName', 'fns']) {
        expect(evil[ns][field], `${ns}.${field}`).toBeUndefined();
      }
    }
    expect(() => evil.commands.items.delete('terminal.new')).toThrow(TypeError);
    expect(coApp.commands.get('terminal.new')?.fn).toBe(hostFn);
  });

  it('原型是 Object.prototype:拿不到注册表类的原型方法去 .call', () => {
    const { coApp, hostFn, evil } = setup();
    for (const ns of Object.keys(SURFACE)) {
      expect(Object.getPrototypeOf(evil[ns]), ns).toBe(Object.prototype);
    }
    const proto = Object.getPrototypeOf(evil.commands) as Loose;
    expect(proto.register).toBeUndefined();
    expect(proto.registerKeyed).toBeUndefined();
    // 外观方法是闭包,不读 this:拿别的对象当 this 调用,走的仍是本插件的所有权检查。
    expect(() =>
      evil.commands.register.call(coApp.commands, { id: 'terminal.new', title: 'Fake', fn: () => {} }),
    ).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(coApp.commands.get('terminal.new')?.fn).toBe(hostFn);
  });

  it('吊销后同样拿不到内部 Map:不能留下僵尸条目', () => {
    const { coApp, evil, revoke } = setup();
    revoke();
    expect(evil.commands.items).toBeUndefined();
    expect(() => evil.commands.items.set('zombie', { id: 'zombie', title: 'Z', fn: () => {} })).toThrow(TypeError);
    expect(coApp.commands.get('zombie')).toBeUndefined();
    expect(() => evil.commands.register({ id: 'zombie', title: 'Z', fn: () => {} })).toThrow(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(coApp.commands.get('zombie')).toBeUndefined();
  });

  it('events.byName / explorerDecorators.fns 不可达:不能清空他人订阅或改装饰器列表', () => {
    const { coApp, evil } = setup();
    const hostListener = vi.fn();
    coApp.events.on('x', hostListener);
    const decorator = (): null => null;
    coApp.explorerDecorators.register(decorator);
    expect(evil.events.byName).toBeUndefined();
    expect(evil.explorerDecorators.fns).toBeUndefined();
    expect(() => evil.events.byName.clear()).toThrow(TypeError);
    expect(() => evil.explorerDecorators.fns.splice(0)).toThrow(TypeError);
    coApp.events.emit('x', 1);
    expect(hostListener).toHaveBeenCalledTimes(1);
    expect(coApp.explorerDecorators.getAll()).toEqual([decorator]);
  });

  it('自有属性恰为 SDK 公开方法;外观与方法均冻结;遍历自有属性 / 描述符 / 原型拿不到任何对象', () => {
    const { evil } = setup();
    for (const [ns, members] of Object.entries(SURFACE)) {
      const facade = evil[ns] as object;
      expect(Reflect.ownKeys(facade).sort(), ns).toEqual(members);
      expect(Object.getOwnPropertyNames(facade).sort(), ns).toEqual(members);
      expect(Object.isFrozen(facade), ns).toBe(true);
      for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(facade))) {
        expect(typeof desc.value, `${ns}.${name}`).toBe('function');
        expect(Object.isFrozen(desc.value), `${ns}.${name}`).toBe(true);
        // 方法是箭头函数:没有 prototype,自有属性只有 length / name。
        expect(Reflect.ownKeys(desc.value as object).sort(), `${ns}.${name}`).toEqual(['length', 'name']);
        expect(Object.getPrototypeOf(desc.value), `${ns}.${name}`).toBe(Function.prototype);
      }
      expect('items' in facade, ns).toBe(false);
    }
  });

  it('外观不可改写:不能给自己换方法,也不影响其它插件的外观', () => {
    const { coApp, evil } = setup();
    const other = createScopedAppController(coApp, 'other', null, 'token-other').app as unknown as Loose;
    expect(() => {
      'use strict';
      evil.commands.get = () => undefined;
    }).toThrow(TypeError);
    expect(evil.commands).not.toBe(other.commands);
    // workspace 此前是宿主单例对象原样透传:一个插件改写 getRoot 会影响所有插件。
    expect(evil.workspace).not.toBe(coApp.workspace);
    expect(() => {
      'use strict';
      evil.workspace.getRoot = async () => '/evil';
    }).toThrow(TypeError);
  });

  it('查询结果不泄露内部对象:spec 是冻结拷贝,数组是冻结拷贝,嵌套 enum 也不是宿主的数组', () => {
    const { coApp, evil, hostFn } = setup();
    const hostEnum = [{ value: 'a', label: 'A' }];
    coApp.settingItems.register({
      id: 'host.choice',
      category: 'general',
      title: 'Choice',
      type: 'select',
      default: 'a',
      enum: hostEnum,
    });
    const spec = evil.commands.get('terminal.new') as Loose;
    expect(spec).not.toBe(coApp.commands.get('terminal.new'));
    expect(Object.isFrozen(spec)).toBe(true);
    const all = evil.commands.getAll() as Loose[];
    expect(all).not.toBe(coApp.commands.getAll());
    expect(Object.isFrozen(all)).toBe(true);
    // 回调包装不能当作改写宿主函数对象的通道。
    expect(() => {
      spec.fn.hacked = 1;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(spec.fn, 'hacked2', { value: 1, configurable: true })).toThrow(TypeError);
    expect((hostFn as unknown as Loose).hacked).toBeUndefined();
    expect((hostFn as unknown as Loose).hacked2).toBeUndefined();

    const item = evil.settingItems.get('host.choice') as Loose;
    expect(item.enum).not.toBe(hostEnum);
    expect(item.enum).toEqual(hostEnum);
    expect(Object.isFrozen(item.enum)).toBe(true);
    expect(item.enum[0]).not.toBe(hostEnum[0]);
    expect(Object.isFrozen(item.enum[0])).toBe(true);
    expect(evil.settingItems.getByCategory('general')[0].enum[0]).not.toBe(hostEnum[0]);
  });

  it('fs.listDir 对空目录返回的共享空数组是冻结的:一个插件不能往里塞条目污染其它插件的结果', () => {
    const empty = buildPluginListDirEntries('/a', []) as unknown[];
    expect(Object.isFrozen(empty)).toBe(true);
    expect(() => empty.push({ name: 'fake' })).toThrow(TypeError);
    expect(buildPluginListDirEntries('/b', [])).toEqual([]);
  });

  it('公开方法照常工作(register / get / getAll / subscribe / execute / on / emit / off)', async () => {
    const { coApp, app } = setup();
    const changed = vi.fn();
    const unsubscribe = app.commands.subscribe(changed);
    const fn = vi.fn();
    const d = app.commands.register({ id: 'evil.cmd', title: 'Mine', fn });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(coApp.commands.get('evil.cmd')?.title).toBe('Mine');
    expect(app.commands.get('evil.cmd')?.title).toBe('Mine');
    expect(app.commands.getAll().map((c) => c.id)).toEqual(['terminal.new', 'evil.cmd']);
    await app.commands.execute('evil.cmd');
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
    d.dispose();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(coApp.commands.get('evil.cmd')).toBeUndefined();

    const listener = vi.fn();
    app.events.on('e', listener);
    app.events.emit('e', 7);
    expect(listener).toHaveBeenCalledWith(7);
    app.events.off('e', listener);
    app.events.emit('e', 8);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
