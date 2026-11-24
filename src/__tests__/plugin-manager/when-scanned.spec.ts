// @vitest-environment jsdom
// 扫描完成信号(whenScanned):init 先登记全部插件再逐个激活。激活可能 await 用户授权弹窗 / 插件 onload 挂起,
// init 可能长时间不完成;只需 manifest 信息的消费者(启动更新检查)挂在「扫描完成」上,不被激活拖住。
// 激活顺序、生命周期锁、停用意图(扫描后、激活前到达的禁用 / 卸载不激活)保持原语义。
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
import { createTestCoApp } from '../../plugins/test-utils';
import { flushMacrotasks } from '../_helpers/async';

const constructed: string[] = [];
let releaseHang: (() => void) | null = null;

class HangPlugin extends Plugin {
  onload(): Promise<void> {
    constructed.push(this.manifest.id);
    return new Promise<void>((r) => {
      releaseHang = r;
    });
  }
}
class OkPlugin extends Plugin {
  onload(): void {
    constructed.push(this.manifest.id);
  }
}

function makeManager(
  over: Partial<ManagerHost> = {},
): { mgr: PluginManager; mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn();
  const dir = (id: string) => ({
    id,
    manifestText: JSON.stringify({ id, name: id, version: '0.1.0' }),
    moduleUrl: `mod://${id}`,
  });
  const host: ManagerHost = {
    listPluginDirs: () => [dir('a'), dir('b')],
    readEnabledIds: () => new Set(['a', 'b']),
    mutateEnabledId: mutate,
    importModule: async (url) => ({ default: url === 'mod://a' ? HangPlugin : OkPlugin }),
    removePluginDir: vi.fn().mockResolvedValue(undefined),
    killPluginShellProcesses: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), mutate };
}

beforeEach(() => {
  constructed.length = 0;
  releaseHang = null;
});

describe('PluginManager.whenScanned', () => {
  it('首个插件激活挂起(init 未完成)时扫描完成信号已 resolve,listAll 含全部插件', async () => {
    const { mgr } = makeManager();
    let initDone = false;
    void mgr.init().then(() => {
      initDone = true;
    });
    let scanned = false;
    void mgr.whenScanned().then(() => {
      scanned = true;
    });
    await flushMacrotasks(5);
    expect(constructed).toEqual(['a']); // a 挂在 onload,b 尚未激活
    expect(initDone).toBe(false);
    expect(scanned).toBe(true);
    expect(mgr.listAll().map((x) => x.id)).toEqual(['a', 'b']);

    releaseHang!();
    await flushMacrotasks(5);
    expect(initDone).toBe(true);
    expect(constructed).toEqual(['a', 'b']); // 激活顺序不变
  });

  it('init 之前调用 whenScanned 也会在扫描后 resolve', async () => {
    const { mgr } = makeManager({ importModule: async () => ({ default: OkPlugin }) });
    const scanned = mgr.whenScanned();
    await mgr.init();
    await expect(scanned).resolves.toBeUndefined();
  });

  it('扫描失败(listPluginDirs 抛)→ init 照常 reject,whenScanned 仍 resolve(更新检查不永久缺席)', async () => {
    const err = new Error('scan failed');
    const { mgr } = makeManager({
      listPluginDirs: () => {
        throw err;
      },
    });
    await expect(mgr.init()).rejects.toBe(err);
    await expect(mgr.whenScanned()).resolves.toBeUndefined();
  });

  it('扫描后、激活前到达的禁用 → 不激活该插件,落 disabled;排队的禁用照常落盘', async () => {
    const { mgr, mutate } = makeManager();
    const initP = mgr.init();
    await mgr.whenScanned();
    await flushMacrotasks(5); // a 挂在 onload
    const disabling = mgr.disable('b');
    releaseHang!();
    await initP;
    await disabling;
    expect(constructed).toEqual(['a']); // b 未构造
    expect(mgr.listAll().find((x) => x.id === 'b')?.status).toBe('disabled');
    expect(mutate).toHaveBeenCalledWith('b', false);
  });

  it('扫描后、激活前到达的禁用(仅同步部分 revokeImmediately,锁内停用尚未执行)→ 不激活', async () => {
    const { mgr } = makeManager();
    const initP = mgr.init();
    await mgr.whenScanned();
    await flushMacrotasks(5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mgr.revokeImmediately('b');
    releaseHang!();
    await initP;
    expect(constructed).toEqual(['a']);
    // 激活前重查意图直接落 disabled,不走一次「激活失败」(不打 activate failed、不回收 token)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('activate b failed'))).toBe(false);
    warn.mockRestore();
    expect(mgr.listAll().find((x) => x.id === 'b')?.status).toBe('disabled');
    await mgr.handleEnabledChanged('b', false); // 随后的锁内停用
    expect(mgr.listAll().find((x) => x.id === 'b')?.status).toBe('disabled');
  });

  it('扫描后、轮到激活前已被别的路径激活(重载)→ init 不重复激活(单实例)', async () => {
    const { mgr } = makeManager();
    const initP = mgr.init();
    await mgr.whenScanned();
    await flushMacrotasks(5); // a 挂在 onload,b 已登记未激活
    await mgr.reload('b'); // 走锁、按启用意图激活 b
    expect(constructed).toEqual(['a', 'b']);
    releaseHang!();
    await initP;
    expect(constructed).toEqual(['a', 'b']); // init 循环轮到 b 时跳过
    expect(mgr.listAll().find((x) => x.id === 'b')?.status).toBe('enabled');
  });

  it('扫描后、激活前本地卸载 → 不激活、entry 移除', async () => {
    const { mgr } = makeManager();
    const initP = mgr.init();
    await mgr.whenScanned();
    await flushMacrotasks(5);
    const uninstalling = mgr.uninstall('b');
    releaseHang!();
    await initP;
    await uninstalling;
    expect(constructed).toEqual(['a']);
    expect(mgr.listAll().map((x) => x.id)).toEqual(['a']);
  });
});
