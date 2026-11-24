// @vitest-environment jsdom
// 热重载不得绕过禁用 / 卸载意图(终审 P1):
// A. 旧实例 onunload 挂起期间(热重载正在拆旧实例)点禁用 / 卸载 —— 此前 revokeImmediately 只在 activating 时记中止,
//    重载随后创建全新 scoped app 并激活,新实例继续持有 shell 等能力;新实例 onload 挂起时禁用 / 卸载永远排不上。
// B. init 期间(onload 挂起)插件文件变化 → reload 排在挂起的激活之后;随后别窗禁用 —— 激活被中止后先执行 reload
//    (读到旧的启用意图)再执行禁用 → 重新激活。
// 修复:per-id「停用意图」在禁用 / 卸载请求到达时同步记录,所有激活路径在导入模块前检查;只有显式启用清除。
// 见同目录 README.md「1d」。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ shellExec: vi.fn() }));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok' }),
      _unregisterPlugin: async () => undefined,
    },
    shell: { exec: h.shellExec },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { wirePluginEvents } from '../../plugins/plugin-events';
import { createTestCoApp } from '../../plugins/test-utils';
import { flushMacrotasks } from '../_helpers/async';

const ID = 'com.x.intent';

/** 每个构造出的实例留一个「延迟回调」(模拟定时器调用 shell)。 */
const execs: Array<() => Promise<unknown>> = [];
let hangOnload = false;
let releaseUnload: (() => void) | null = null;
let hangUnload = false;

class P extends Plugin {
  onload(): Promise<void> | void {
    execs.push(() => this.app.shell.exec('echo', ['hi']));
    if (hangOnload) return new Promise<void>(() => {});
  }
  onunload(): Promise<void> | void {
    if (hangUnload) {
      return new Promise<void>((r) => {
        releaseUnload = r;
      });
    }
  }
}

function makeManager(enabled: boolean): {
  mgr: PluginManager;
  mutate: ReturnType<typeof vi.fn>;
  removeDir: ReturnType<typeof vi.fn>;
} {
  const mutate = vi.fn();
  const removeDir = vi.fn().mockResolvedValue(undefined);
  const host: ManagerHost = {
    listPluginDirs: () => [
      { id: ID, manifestText: JSON.stringify({ id: ID, name: 'i', version: '0.1.0' }), moduleUrl: 'mod://i' },
    ],
    readEnabledIds: () => new Set(enabled ? [ID] : []),
    mutateEnabledId: mutate,
    importModule: async () => ({ default: P }),
    removePluginDir: removeDir,
    killPluginShellProcesses: vi.fn().mockResolvedValue(undefined),
  };
  return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), mutate, removeDir };
}

/** 按 main-app 的接线方式(先发起 init,再 wirePluginEvents),返回文件变化 / 广播触发器。 */
function wire(mgr: PluginManager): {
  emitChanged: (id: string) => void;
  emitEnabled: (id: string, enabled: boolean) => void;
  emitUninstalled: (id: string) => void;
} {
  let onChanged!: (id: string) => void;
  let onEnabled!: (id: string, enabled: boolean) => void;
  let onUninstalled!: (id: string) => void;
  void mgr.init().catch(() => {});
  wirePluginEvents(
    mgr,
    {
      onChanged: (cb) => {
        onChanged = cb;
      },
      onUninstalled: (cb) => {
        onUninstalled = cb;
      },
      onEnabledChanged: (cb) => {
        onEnabled = cb;
      },
    },
    () => {},
  );
  return {
    emitChanged: (id) => onChanged(id),
    emitEnabled: (id, on) => onEnabled(id, on),
    emitUninstalled: (id) => onUninstalled(id),
  };
}

beforeEach(() => {
  execs.length = 0;
  hangOnload = false;
  hangUnload = false;
  releaseUnload = null;
  h.shellExec.mockReset().mockResolvedValue({ ok: true, data: { stdout: '', stderr: '', exitCode: 0 } });
});

describe('A. 热重载拆旧实例(onunload 挂起)期间禁用 / 卸载 → 重载不激活新实例', () => {
  async function startReloadWithHangingUnload(): Promise<{
    mgr: PluginManager;
    mutate: ReturnType<typeof vi.fn>;
    removeDir: ReturnType<typeof vi.fn>;
    reloading: Promise<void>;
  }> {
    const m = makeManager(true);
    await m.mgr.init();
    expect(execs).toHaveLength(1);
    hangUnload = true;
    hangOnload = true; // 若重载错误地激活新实例,其 onload 挂起 → 排在后面的禁用 / 卸载永远执行不到
    const reloading = m.mgr.reload(ID);
    await flushMacrotasks(5);
    expect(releaseUnload).not.toBeNull(); // 旧实例 onunload 已开始并挂起
    return { ...m, reloading };
  }

  it('本地禁用:不构造新实例、shell.exec 被拒;禁用完成并落盘 enabled=false', async () => {
    const { mgr, mutate, reloading } = await startReloadWithHangingUnload();
    const disabling = mgr.disable(ID);
    releaseUnload!();
    await flushMacrotasks(5);

    expect(execs).toHaveLength(1); // 未构造新实例
    await expect(execs[0]!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.shellExec).not.toHaveBeenCalled();
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    expect(mutate).toHaveBeenCalledWith(ID, false);
    await reloading;
    await disabling;
  });

  it('别窗禁用广播:不构造新实例;禁用完成', async () => {
    const { mgr, reloading } = await startReloadWithHangingUnload();
    // init 已完成(扫描早已完成):同步部分立即执行,锁内部分随后排队。
    mgr.revokeImmediately(ID);
    const handling = mgr.handleEnabledChanged(ID, false);
    releaseUnload!();
    await flushMacrotasks(5);

    expect(execs).toHaveLength(1);
    await expect(execs[0]!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    await reloading;
    await handling;
  });

  it('本地卸载:不构造新实例;卸载完成(删目录、entry 移除)', async () => {
    const { mgr, removeDir, reloading } = await startReloadWithHangingUnload();
    const uninstalling = mgr.uninstall(ID);
    releaseUnload!();
    await flushMacrotasks(5);

    expect(execs).toHaveLength(1);
    await expect(execs[0]!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(removeDir).toHaveBeenCalledWith(ID);
    expect(mgr.listAll()).toEqual([]);
    await reloading;
    await uninstalling;
  });

  it('禁用后显式启用:清除停用意图,正常激活并落盘 enabled=true', async () => {
    const { mgr, mutate, reloading } = await startReloadWithHangingUnload();
    const disabling = mgr.disable(ID);
    releaseUnload!();
    await reloading;
    await disabling;

    hangOnload = false;
    hangUnload = false;
    await mgr.enable(ID);
    expect(execs).toHaveLength(2);
    expect(mgr.listAll()[0]!.status).toBe('enabled');
    expect(mutate).toHaveBeenCalledWith(ID, true);
    await execs[1]!();
    expect(h.shellExec).toHaveBeenCalledTimes(1);
  });
});

describe('本地卸载失败(目录未删、entry 仍在)', () => {
  it('停用意图降为禁用:显式启用可重新激活', async () => {
    const { mgr, removeDir } = makeManager(true);
    await mgr.init();
    removeDir.mockRejectedValueOnce(new Error('EBUSY'));
    await expect(mgr.uninstall(ID)).rejects.toThrow('EBUSY');
    expect(mgr.listAll()[0]!.status).toBe('disabled');

    await mgr.enable(ID);
    expect(execs).toHaveLength(2);
    expect(mgr.listAll()[0]!.status).toBe('enabled');
  });
});

describe('B. init 期间(onload 挂起)文件变化的 reload 排在锁后,随后禁用 / 卸载 → reload 不重新激活', () => {
  it('别窗禁用广播:init 结束后不重新激活,shell.exec 被拒,最终 disabled', async () => {
    hangOnload = true;
    const { mgr } = makeManager(true);
    const { emitChanged, emitEnabled } = wire(mgr);
    await flushMacrotasks(5);
    expect(execs).toHaveLength(1); // init 的激活挂在 onload

    emitChanged(ID); // 扫描已完成、init 未完成 → reload 排在挂起的激活之后(生命周期锁)
    emitEnabled(ID, false);
    await flushMacrotasks(5);

    expect(execs).toHaveLength(1);
    await expect(execs[0]!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.shellExec).not.toHaveBeenCalled();
    expect(mgr.listAll()[0]!.status).toBe('disabled');
  });

  it('别窗卸载广播:不重新激活,entry 最终移除', async () => {
    hangOnload = true;
    const { mgr } = makeManager(true);
    const { emitChanged, emitUninstalled } = wire(mgr);
    await flushMacrotasks(5);
    emitChanged(ID);
    emitUninstalled(ID);
    await flushMacrotasks(5);

    expect(execs).toHaveLength(1);
    expect(mgr.listAll()).toEqual([]);
  });

  it('禁用后又收到 enabled=true 广播(显式启用)→ 正常激活', async () => {
    hangOnload = true;
    const { mgr } = makeManager(true);
    const { emitChanged, emitEnabled } = wire(mgr);
    await flushMacrotasks(5);
    emitChanged(ID);
    emitEnabled(ID, false);
    await flushMacrotasks(5);
    expect(mgr.listAll()[0]!.status).toBe('disabled');

    hangOnload = false;
    emitEnabled(ID, true);
    await flushMacrotasks(5);
    expect(execs).toHaveLength(2);
    expect(mgr.listAll()[0]!.status).toBe('enabled');
  });
});
