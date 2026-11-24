// 启动更新检查必须排在用户插件扫描完成之后:refresh() 先同步读 listAll() 按已安装规模裁剪网络(打磨 R54),
// 扫描尚在等 listPluginDirs IPC 时 listAll() 恒为空 → 直接落空,已装插件有新版本也
// 永远不出 IconSidebar 角标。
// perf:挂在「扫描完成」(whenScanned)而非整个 init 上 —— 某插件激活挂在授权弹窗 / onload 上时 init 可能永不完成,
// 而 refresh 只需 manifest。popout 子窗口无 IconSidebar 角标 → 在 main-app 早退,不 init 插件也不检查。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initPluginsThenCheckUpdates } from '../../marketplace/startup-update-check';
import { deferred } from '../_helpers/async';

function fakeManager() {
  const init = deferred();
  const scanned = deferred();
  return {
    init,
    scanned,
    manager: { init: vi.fn(() => init.promise), whenScanned: () => scanned.promise },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('启动更新检查排在插件扫描完成之后', () => {
  it('扫描完成前不检查;扫描完成后检查一次(即使 init 仍挂在某插件激活上)', async () => {
    const { manager, scanned } = fakeManager();
    const refresh = vi.fn(() => Promise.resolve());
    void initPluginsThenCheckUpdates(manager, refresh);
    await flush();
    expect(manager.init).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    scanned.resolve(); // init 仍未完成
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('返回值即 init 的结果(含失败),原样交给 reload-gate', async () => {
    const { manager, init, scanned } = fakeManager();
    const done = initPluginsThenCheckUpdates(manager, vi.fn(() => Promise.resolve()));
    const err = new Error('scan failed');
    init.reject(err);
    scanned.resolve();
    await expect(done).rejects.toBe(err);
  });

  it('main-app 不再在 init 发起的同一同步段直接调用 refresh', () => {
    const src = readFileSync(path.resolve(__dirname, '../../main-app.ts'), 'utf8');
    expect(src).not.toMatch(/void useUpdateStore\.getState\(\)\.refresh\(\)/);
    expect(src).toMatch(/initPluginsThenCheckUpdates\(/);
  });
});
