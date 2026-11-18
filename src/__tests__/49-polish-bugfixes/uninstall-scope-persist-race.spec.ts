// 卸载间隙的「授权」不得把 path scope 写回磁盘(安全)。
//
// uninstallPlugin 先清 _plugin-path-scopes.json 再 rm 目录,卸载返回后 IPC 层才 revokePluginFsAccess 撤内存
// token。间隙里另一窗口挂着的授权弹窗被点「授权」→ token 仍 active → persistScopes 写盘会把 scope 写回 →
// 同 id 重装冷启动水合旧 scope,covers() 静默授权。修复:persistScopes 走 persistPluginPathScopesIfInstalled
//(同 id mutation 锁 + 锁内确认目录仍在),与卸载互斥。
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm as realRm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({
  target: null as string | null,
  entered: null as null | (() => void),
  release: null as null | Promise<void>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  const rm: typeof orig.rm = async (p, opts) => {
    if (gate.target !== null && String(p) === gate.target && gate.release) {
      gate.entered?.();
      await gate.release;
    }
    return orig.rm(p, opts);
  };
  return { ...orig, default: { ...orig, rm }, rm };
});

import {
  persistPluginPathScopesIfInstalled,
  readPluginPathScopes,
  uninstallPlugin,
} from '../../../electron/main/services/plugins.service';

const ID = 'com.foo';
const SCOPES = [{ path: '/ws/secret', mode: 'rw' as const }];
const roots: string[] = [];

afterEach(async () => {
  gate.target = null;
  gate.entered = null;
  gate.release = null;
  for (const d of roots.splice(0)) await realRm(d, { recursive: true, force: true });
});

async function installedPlugin(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'continuo-uninstall-persist-race-'));
  roots.push(base);
  await mkdir(join(base, ID), { recursive: true });
  await writeFile(join(base, ID, 'manifest.json'), JSON.stringify({ id: ID }), 'utf-8');
  return base;
}

/** 让卸载卡在 rm(目录)处:此时 scope 文件已清、目录尚在、内存 token 尚未撤。 */
function blockRm(base: string): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    gate.entered = resolve;
  });
  gate.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.target = join(base, ID);
  return { entered, release };
}

describe('49 · 卸载间隙的授权持久化不得把 path scope 写回磁盘', () => {
  it('卸载已清 scope、rm 尚未完成时到达的 persist → 卸载完成后磁盘无该插件 scope', async () => {
    const base = await installedPlugin();
    const { entered, release } = blockRm(base);

    const uninstalling = uninstallPlugin(base, ID);
    await entered; // scope 文件已清,rm 卡住
    const persisting = persistPluginPathScopesIfInstalled(base, ID, SCOPES);
    persisting.catch(() => undefined);
    // 给 persist 充分机会抢在 rm 完成前落盘(无锁实现会在这里写回)。
    await new Promise((r) => setTimeout(r, 30));
    release();
    await uninstalling;
    await expect(persisting).rejects.toMatchObject({ code: 'NOT_INSTALLED' });

    expect(existsSync(join(base, ID))).toBe(false);
    expect(await readPluginPathScopes(base, ID)).toEqual([]);
    // 同 id 重装:不从磁盘继承旧授权
    await mkdir(join(base, ID), { recursive: true });
    expect(await readPluginPathScopes(base, ID)).toEqual([]);
  });

  it('卸载开始前已发起的 persist → 先落盘,随后被卸载清掉', async () => {
    const base = await installedPlugin();
    const persisting = persistPluginPathScopesIfInstalled(base, ID, SCOPES);
    const uninstalling = uninstallPlugin(base, ID);
    await persisting;
    await uninstalling;
    expect(await readPluginPathScopes(base, ID)).toEqual([]);
  });

  it('已安装插件的正常授权持久化照常落盘', async () => {
    const base = await installedPlugin();
    await persistPluginPathScopesIfInstalled(base, ID, SCOPES);
    expect(await readPluginPathScopes(base, ID)).toEqual(SCOPES);
  });

  it('插件目录不存在 → 拒绝(NOT_INSTALLED),不写盘', async () => {
    const base = await installedPlugin();
    await realRm(join(base, ID), { recursive: true, force: true });
    await expect(persistPluginPathScopesIfInstalled(base, ID, SCOPES)).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
    });
    await mkdir(join(base, ID), { recursive: true });
    expect(await readPluginPathScopes(base, ID)).toEqual([]);
  });

  it('接线:plugin-fs IPC 的 persistScopes 走带锁入口,不直接调 writePluginPathScopes', () => {
    const src = readFileSync(
      join(__dirname, '../../../electron/main/ipc/plugin-fs.ipc.ts'),
      'utf-8',
    );
    expect(src).toMatch(/persistScopes:\s*\([^)]*\)\s*=>\s*persistPluginPathScopesIfInstalled\(/);
    expect(src).not.toMatch(/\bwritePluginPathScopes\b/);
  });
});
