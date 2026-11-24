// @vitest-environment jsdom
// 插件启动期事件门控(R16 + 放开时机前移):main 推送的文件变化(reload)、跨窗口启停 / 卸载广播在**扫描完成**
//(全部条目已登记)后即交给 PluginManager 处理,不再等全部插件激活完。某插件授权弹窗 / onload 挂起时 init 可能永不
// 结束,其它插件的事件不能因此失效;同 id 的事件与 init 激活经生命周期锁排序。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok' }),
      _unregisterPlugin: async () => undefined,
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { wirePluginEvents } from '../../plugins/plugin-events';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';
import { deferred, flushMacrotasks, type Deferred } from '../_helpers/async';

const A = 'com.x.a'; // 声明权限 → init 激活时等授权弹窗
const B = 'com.x.b';
const C = 'com.x.c'; // 启动快照为禁用

const loaded: string[] = []; // 每次构造实例记录 moduleUrl
const unloaded: string[] = [];
class P extends Plugin {
  constructor(...args: ConstructorParameters<typeof Plugin>) {
    super(...args);
    loaded.push(`${this.manifest.id}@${this.manifest.version}`);
  }
  onload() {}
  onunload() {
    unloaded.push(this.manifest.id);
  }
}

interface Window {
  mgr: PluginManager;
  /** 下一次 / 当前挂起的授权弹窗(resolve 授予的权限)。 */
  prompt: () => Deferred<readonly string[]>;
  version: Record<string, string>;
  /** 已从磁盘删除的插件目录(main 删目录后才广播卸载)。 */
  gone: Set<string>;
  scan: Deferred<void> | null;
  emitChanged: (id: string) => void;
  emitEnabled: (id: string, enabled: boolean) => void;
  emitUninstalled: (id: string) => void;
  onError: ReturnType<typeof vi.fn>;
}

/** 按 main-app 的接线方式:先发起 init,再接 main 推送的三类事件。holdScan → 首次扫描挂起直到 scan.resolve()。 */
function makeWindow(opts: { holdScan?: boolean; dirs?: string[] } = {}): Window {
  const version: Record<string, string> = { [A]: '0.1.0', [B]: '0.1.0', [C]: '0.1.0' };
  const ids = opts.dirs ?? [A, B, C];
  const gone = new Set<string>();
  let scan: Deferred<void> | null = opts.holdScan ? deferred() : null;
  let pending: Deferred<readonly string[]> | null = null;
  const listing = () =>
    ids.filter((id) => !gone.has(id)).map((id) => ({
      id,
      manifestText: JSON.stringify({
        id,
        name: id,
        version: version[id],
        ...(id === A ? { permissions: ['shell'] } : {}),
      }),
      moduleUrl: `mod://${id}@${version[id]}`,
    }));
  const host: ManagerHost = {
    listPluginDirs: async () => {
      const snapshot = listing(); // 先取快照再挂起:模拟扫描读到的是变化前的文件
      if (scan) {
        const s = scan;
        scan = null;
        await s.promise;
      }
      return snapshot;
    },
    readEnabledIds: () => new Set([A, B]),
    mutateEnabledId: () => {},
    importModule: async () => ({ default: P }),
    removePluginDir: async () => {},
    permissionStore: new InMemoryPermissionStore(), // A 的授权未决定 → 走 promptFn
    promptFn: () => {
      pending = deferred<readonly string[]>();
      return pending.promise as never;
    },
  };
  const mgr = new PluginManager(createTestCoApp('1.0.0'), host);
  const heldScan = scan;
  const onError = vi.fn();
  let onChanged!: (id: string) => void;
  let onEnabled!: (id: string, enabled: boolean) => void;
  let onUninstalled!: (id: string) => void;
  void mgr.init().catch(() => {});
  wirePluginEvents(
    mgr,
    {
      onChanged: (cb) => (onChanged = cb),
      onEnabledChanged: (cb) => (onEnabled = cb),
      onUninstalled: (cb) => (onUninstalled = cb),
    },
    onError,
  );
  return {
    mgr,
    prompt: () => pending!,
    version,
    gone,
    scan: heldScan,
    emitChanged: (id) => onChanged(id),
    emitEnabled: (id, on) => onEnabled(id, on),
    emitUninstalled: (id) => onUninstalled(id),
    onError,
  };
}

const status = (w: Window, id: string) => w.mgr.listAll().find((p) => p.id === id)?.status;

beforeEach(() => {
  loaded.length = 0;
  unloaded.length = 0;
});

describe('扫描完成前到达的事件(R16)', () => {
  it('文件变化在条目登记之后执行 reload,不被「Plugin not found」丢弃', async () => {
    const w = makeWindow({ holdScan: true, dirs: [B] });
    w.version[B] = '0.2.0'; // 扫描快照之后文件已改:init 按旧快照激活,须由排队的 reload 换成新代码
    w.emitChanged(B);
    await flushMacrotasks(2);
    expect(w.mgr.listAll()).toEqual([]); // 尚未扫描

    w.scan!.resolve();
    await flushMacrotasks(5);
    expect(w.onError).not.toHaveBeenCalled();
    expect(status(w, B)).toBe('enabled');
    expect(loaded).toEqual([`${B}@0.1.0`, `${B}@0.2.0`]); // 先按快照激活,再由 reload 换新代码
    expect(unloaded).toEqual([B]);
    expect(w.mgr.listAll().find((p) => p.id === B)?.manifest.version).toBe('0.2.0');
  });

  it('卸载广播丢弃该插件待处理的 reload(不报错);卸载照常执行,其它插件照常 reload', async () => {
    const w = makeWindow({ holdScan: true, dirs: [B, C] });
    w.emitChanged(B);
    w.emitChanged(C);
    w.gone.add(B); // main 先删目录再广播
    w.emitUninstalled(B);
    w.scan!.resolve();
    await flushMacrotasks(5);
    expect(w.onError).not.toHaveBeenCalled();
    expect(w.mgr.listAll().map((p) => p.id)).toEqual([C]);
    expect(loaded).not.toContain(`${B}@0.1.0`); // B 未被 init 按旧快照激活
  });

  it('扫描失败(listPluginDirs 抛)后事件照常交给 PluginManager,不永久挂起', async () => {
    const mgr = new PluginManager(createTestCoApp('1.0.0'), {
      listPluginDirs: async () => {
        throw new Error('scan boom');
      },
      readEnabledIds: () => new Set(),
      mutateEnabledId: () => {},
      importModule: async () => ({ default: P }),
    });
    const onError = vi.fn();
    let onChanged!: (id: string) => void;
    void mgr.init().catch(() => {});
    wirePluginEvents(
      mgr,
      { onChanged: (cb) => (onChanged = cb), onEnabledChanged: () => {}, onUninstalled: () => {} },
      onError,
    );
    onChanged('x');
    await flushMacrotasks(3);
    expect(onError).toHaveBeenCalledWith('reload', expect.objectContaining({ message: expect.stringMatching(/not found/i) }));
  });
});

describe('某插件授权弹窗挂起(init 永不结束)时,其它插件的事件照常生效', () => {
  it('B 的文件变化 → 立即热重载为新代码;C 的跨窗启用 → 立即激活', async () => {
    const w = makeWindow();
    await flushMacrotasks(3);
    expect(w.prompt()).toBeTruthy(); // init 挂在 A 的授权弹窗上
    expect(status(w, B)).toBe('enabled'); // B 排在 A 之后,尚未激活

    w.version[B] = '0.2.0';
    w.emitChanged(B);
    w.emitEnabled(C, true);
    await flushMacrotasks(5);

    expect(loaded).toContain(`${B}@0.2.0`);
    expect(loaded).toContain(`${C}@0.1.0`);
    expect(status(w, C)).toBe('enabled');
    expect(w.onError).not.toHaveBeenCalled();

    // 用户随后授权:init 继续,轮到 B / C 时已激活 → 不重复激活(单实例)
    w.prompt().resolve(['shell']);
    await flushMacrotasks(5);
    expect(status(w, A)).toBe('enabled');
    expect(loaded.filter((x) => x.startsWith(B))).toEqual([`${B}@0.2.0`]);
    expect(loaded.filter((x) => x.startsWith(C))).toEqual([`${C}@0.1.0`]);
  });

  it('B 的跨窗禁用 / 卸载 → 立即落地,init 之后也不激活', async () => {
    const w = makeWindow();
    await flushMacrotasks(3);
    w.emitEnabled(B, false);
    w.emitUninstalled(C);
    await flushMacrotasks(5);
    expect(status(w, B)).toBe('disabled');
    expect(w.mgr.listAll().map((p) => p.id)).toEqual([A, B]);

    w.prompt().resolve(['shell']);
    await flushMacrotasks(5);
    expect(loaded.some((x) => x.startsWith(B))).toBe(false);
    expect(status(w, B)).toBe('disabled');
  });
});

describe('同一插件:事件与 init 激活经生命周期锁排序', () => {
  it('init 正在激活 A(授权弹窗挂起)时收到 A 的文件变化 → 排在激活之后重载,只留一个实例', async () => {
    const w = makeWindow({ dirs: [A] });
    await flushMacrotasks(3);
    w.version[A] = '0.2.0';
    w.emitChanged(A);
    await flushMacrotasks(5);
    expect(loaded).toEqual([]); // 不与挂起的激活并发

    w.prompt().resolve(['shell']);
    await flushMacrotasks(8);
    expect(loaded).toEqual([`${A}@0.1.0`, `${A}@0.2.0`]);
    expect(unloaded).toEqual([A]); // 旧实例已停用
    expect(status(w, A)).toBe('enabled');
  });

  it('init 正在激活 A(授权弹窗挂起)时收到 A 的禁用广播 → 授权返回后也不加载插件代码,落 disabled', async () => {
    const w = makeWindow({ dirs: [A] });
    await flushMacrotasks(3);
    w.emitEnabled(A, false); // 锁内停用排在挂起的激活之后;停用意图已同步记下
    await flushMacrotasks(5);
    w.prompt().resolve(['shell']); // 授权返回:激活在加载模块前查到停用意图 → 中止
    await flushMacrotasks(8);
    expect(loaded).toEqual([]);
    expect(status(w, A)).toBe('disabled');
  });
});

describe('接线', () => {
  it('reload 失败 → onError(reload),不抛', async () => {
    const w = makeWindow({ dirs: [B] });
    await flushMacrotasks(3);
    w.emitChanged('com.unknown');
    await flushMacrotasks(3);
    expect(w.onError).toHaveBeenCalledWith('reload', expect.any(Error));
  });
});
