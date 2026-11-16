// @vitest-environment jsdom
// 停用即吊销 —— 只读查询返回的回调(终审 P1):commands.get / getAll 等返回的 spec 含原始 fn,插件缓存
// `app.commands.get('terminal.new')!.fn` 后停用再调用,会绕过 execute 的吊销检查。scoped app 对外的查询结果
// 是浅拷贝,其中所有函数字段包一层吊销检查(未吊销透明调用,吊销后抛 PERMISSION_DENIED);共享注册表原对象不变。
// 见同目录 README.md。
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

const ID = 'com.x.p';
const DENIED = expect.objectContaining({ code: 'PERMISSION_DENIED' });

describe('scoped app:查询结果中的回调随吊销拒绝', () => {
  it('吊销前透明调用原函数;吊销后缓存的 get / getAll 回调抛 PERMISSION_DENIED,原函数不执行', () => {
    const coApp = createTestCoApp();
    const newTerminal = vi.fn();
    coApp.commands.register({ id: 'terminal.new', title: 'New Terminal', fn: newTerminal });
    const ctl = createScopedAppController(coApp, ID, null);

    const cachedFn = ctl.app.commands.get('terminal.new')!.fn;
    const cachedFromAll = ctl.app.commands.getAll()[0]!.fn;
    expect(() => cachedFn()).not.toThrow();
    expect(newTerminal).toHaveBeenCalledTimes(1);

    ctl.revoke();
    expect(() => cachedFn()).toThrow(DENIED);
    expect(() => cachedFromAll()).toThrow(DENIED);
    expect(newTerminal).toHaveBeenCalledTimes(1);
  });

  it('其它注册表的查询结果(panels / statusBar / ribbon / settingTabs / editorActions / explorerContextMenu / explorerDecorators)同样包装', () => {
    const coApp = createTestCoApp();
    const cb = vi.fn(() => null);
    // 动作类回调(返回 void)与渲染类回调共用同一个计数 mock
    const act = cb as unknown as () => void;
    coApp.panels.register({ type: 'p', title: 'P', factory: cb });
    coApp.statusBar.register({ id: 's', side: 'left', render: cb });
    coApp.ribbon.register({ id: 'r', title: 'R', icon: null, onClick: act });
    coApp.settingTabs.register({ id: 't', title: 'T', render: cb });
    coApp.editorActions.register({ id: 'e', label: 'E', fn: act, when: () => true });
    coApp.explorerContextMenu.register({ id: 'm', label: 'M', fn: act });
    coApp.explorerDecorators.register(cb);
    const ctl = createScopedAppController(coApp, ID, null);
    const app = ctl.app;
    const cached: Array<() => unknown> = [
      () => app.panels.get('p')!.factory({}),
      () => app.panels.list()[0]!.factory({}),
      () => app.statusBar.getBySide('left')[0]!.render(),
      () => app.ribbon.get('r')!.onClick(),
      () => app.settingTabs.getAll()[0]!.render(),
      () => app.editorActions.get('e')!.fn(),
      () => app.explorerContextMenu.get('m')!.fn({} as never),
      () => app.explorerDecorators.getAll()[0]!({} as never),
    ];
    // 先取出回调(模拟缓存),吊销后再调用
    const fns = cached.map((get) => {
      const before = cb.mock.calls.length;
      get();
      expect(cb.mock.calls.length).toBe(before + 1);
      return get;
    });
    const editorWhen = app.editorActions.get('e')!.when!;
    ctl.revoke();
    for (const call of fns) expect(call).toThrow(DENIED);
    expect(() => editorWhen({} as never)).toThrow(DENIED);
  });

  it('不修改共享注册表的原对象;查询结果引用稳定(同一快照返回同一包装)', () => {
    const coApp = createTestCoApp();
    const run = vi.fn();
    coApp.commands.register({ id: 'c', title: 'C', fn: run });
    const ctl = createScopedAppController(coApp, ID, null);
    const wrapped = ctl.app.commands.get('c')!;
    expect(wrapped).not.toBe(coApp.commands.get('c'));
    expect(coApp.commands.get('c')!.fn).toBe(run);
    expect(ctl.app.commands.get('c')).toBe(wrapped);
    expect(ctl.app.commands.getAll()).toBe(ctl.app.commands.getAll());
    ctl.revoke();
    void coApp.commands.get('c')!.fn();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('PluginManager:停用后调用缓存的命令 fn 被拒', () => {
  it('插件缓存 terminal.new 的 fn,停用后调用 → PERMISSION_DENIED,终端未创建', async () => {
    let cached!: () => unknown;
    class Cacher extends Plugin {
      onload() {
        cached = this.app.commands.get('terminal.new')!.fn;
      }
    }
    const coApp = createTestCoApp('1.0.0');
    const createTerminal = vi.fn();
    coApp.commands.register({ id: 'terminal.new', title: 'New Terminal', fn: createTerminal });
    const host: ManagerHost = {
      listPluginDirs: () => [
        { id: ID, manifestText: JSON.stringify({ id: ID, name: 'p', version: '0.1.0' }), moduleUrl: 'mod://p' },
      ],
      readEnabledIds: () => new Set([ID]),
      mutateEnabledId: () => {},
      importModule: async () => ({ default: Cacher }),
      killPluginShellProcesses: async () => {},
    };
    const mgr = new PluginManager(coApp, host);
    await mgr.init();
    await mgr.disable(ID);
    expect(() => cached()).toThrow(DENIED);
    expect(createTerminal).not.toHaveBeenCalled();
  });
});
