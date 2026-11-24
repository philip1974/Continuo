// 卸载时 path scope 清理失败须中止卸载(fail-closed)。旧实现把 writePluginPathScopes 的任何失败都当
// best-effort 吞掉再删目录:原子写失败(磁盘满等)时旧 scope 留在 _plugin-path-scopes.json,之后重装同
// manifest id 的插件 → 冷启动水合旧 scope → covers() 直接授权、不再弹窗 → 新代码继承旧的目录读写授权。
// 修复:清理失败 → 抛 PATH_SCOPE_CLEANUP_FAILED,不删目录,可整体重试。scopes 文件已损坏(JSON 解析失败)
// 时读端本就降级为 [],不会被继承 → 仍放行卸载(既有契约,见 plugins-path-scopes.test.ts)。
import { existsSync } from 'node:fs';
import fsp, { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readPluginPathScopes,
  uninstallPlugin,
  writePluginPathScopes,
} from '../../../electron/main/services/plugins.service';
import { setupTempDirs } from '../_helpers/tmp-dir';

const SCOPES_FILE = '_plugin-path-scopes.json';
const tmp = setupTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
});

async function installedPlugin(id: string): Promise<string> {
  const base = await tmp.make('continuo-uninstall-scope-');
  await mkdir(join(base, id), { recursive: true });
  await writeFile(join(base, id, 'manifest.json'), JSON.stringify({ id }), 'utf-8');
  await writePluginPathScopes(base, id, [{ path: '/ws/secret', mode: 'rw' }]);
  return base;
}

describe('49 · 卸载时 path scope 清理失败 → 中止卸载(不删目录,可重试)', () => {
  it('scopes 原子写失败(ENOSPC)→ 抛 PATH_SCOPE_CLEANUP_FAILED,目录与旧 scope 原样保留', async () => {
    const base = await installedPlugin('com.foo');
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(SCOPES_FILE)) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return realRename(from, to);
    });

    await expect(uninstallPlugin(base, 'com.foo')).rejects.toMatchObject({
      code: 'PATH_SCOPE_CLEANUP_FAILED',
    });
    // 不删目录:卸载未发生,用户可重试
    expect(existsSync(join(base, 'com.foo'))).toBe(true);
    expect(await readPluginPathScopes(base, 'com.foo')).toEqual([
      { path: '/ws/secret', mode: 'rw' },
    ]);
  });

  it('失败后重试(磁盘恢复)→ 卸载完成,旧 scope 已清,同 id 重装不继承', async () => {
    const base = await installedPlugin('com.foo');
    const realRename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(SCOPES_FILE)) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return realRename(from, to);
    });
    await expect(uninstallPlugin(base, 'com.foo')).rejects.toBeTruthy();
    spy.mockRestore();

    await expect(uninstallPlugin(base, 'com.foo')).resolves.toBeUndefined();
    expect(existsSync(join(base, 'com.foo'))).toBe(false);
    expect(await readPluginPathScopes(base, 'com.foo')).toEqual([]);
  });
});
