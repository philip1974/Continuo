// 启动更新检查必须排在用户插件 init 之后:refresh() 先同步读 listAll() 按已安装规模裁剪网络(打磨 R54),
// init 尚在等 listPluginDirs IPC 时 listAll() 恒为空 → 直接落空并盖上 lastCheckedAt,已装插件有新版本也
// 永远不出 IconSidebar 角标。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initPluginsThenCheckUpdates } from '../../marketplace/startup-update-check';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('启动更新检查排在插件 init 之后', () => {
  it('init 未完成前不检查;完成后检查一次', async () => {
    const init = deferred();
    const refresh = vi.fn(() => Promise.resolve());
    const done = initPluginsThenCheckUpdates(() => init.promise, refresh);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    init.resolve();
    await done;
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('init 失败仍检查(不让角标永久缺席),且失败照常向上传递给 reload-gate', async () => {
    const init = deferred();
    const refresh = vi.fn(() => Promise.resolve());
    const done = initPluginsThenCheckUpdates(() => init.promise, refresh);
    const err = new Error('scan failed');
    init.reject(err);
    await expect(done).rejects.toBe(err);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('main-app 不再在 init 发起的同一同步段直接调用 refresh', () => {
    const src = readFileSync(path.resolve(__dirname, '../../main-app.ts'), 'utf8');
    expect(src).not.toMatch(/void useUpdateStore\.getState\(\)\.refresh\(\)/);
    expect(src).toMatch(/initPluginsThenCheckUpdates\(/);
  });
});
