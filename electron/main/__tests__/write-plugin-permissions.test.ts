import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readPermissions,
  writePluginPermissions,
} from '../services/plugins.service';

// 数据安全(codex 复查 P1):决策存储 `_permissions.json` 此前由 renderer 整表写回,
// 每个窗口各自缓存,多窗口/并发授权时后写者会用陈旧快照覆盖先写者的权限。
// 改成 main 端按单 plugin 串行 read-merge-write(镜像 writePluginPathScopes),
// 保证写入某 plugin 不抹掉其它 plugin 已落盘的记录。
describe('writePluginPermissions(单 plugin 串行 merge)', () => {
  let baseDir: string;
  const PERM_FILE = '_permissions.json';
  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-perms-'));
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('写入 p.b 不抹掉别处已落盘的 p.a(跨 plugin lost-update 修复)', async () => {
    // 模拟「窗口 A」先落盘 p.a
    await writeFile(
      path.join(baseDir, PERM_FILE),
      JSON.stringify({
        'p.a': [{ permission: 'fs', granted: true, decidedAt: 1 }],
      }),
      'utf-8',
    );

    // 「窗口 B」基于(隐式)旧视图只写自己的 p.b
    await writePluginPermissions(baseDir, 'p.b', [
      { permission: 'network', granted: true, decidedAt: 2 },
    ]);

    const all = await readPermissions(baseDir);
    expect(all['p.a']).toEqual([
      { permission: 'fs', granted: true, decidedAt: 1 },
    ]);
    expect(all['p.b']).toEqual([
      { permission: 'network', granted: true, decidedAt: 2 },
    ]);
  });

  it('并发写不同 plugin → 串行化,两者都保留', async () => {
    await Promise.all([
      writePluginPermissions(baseDir, 'p.a', [
        { permission: 'fs', granted: true, decidedAt: 1 },
      ]),
      writePluginPermissions(baseDir, 'p.b', [
        { permission: 'network', granted: false, decidedAt: 2 },
      ]),
      writePluginPermissions(baseDir, 'p.c', [
        { permission: 'shell', granted: true, decidedAt: 3 },
      ]),
    ]);
    const all = await readPermissions(baseDir);
    expect(Object.keys(all).sort()).toEqual(['p.a', 'p.b', 'p.c']);
  });

  it('覆盖式更新同一 plugin', async () => {
    await writePluginPermissions(baseDir, 'p.a', [
      { permission: 'fs', granted: false, decidedAt: 1 },
    ]);
    await writePluginPermissions(baseDir, 'p.a', [
      { permission: 'fs', granted: true, decidedAt: 5 },
    ]);
    const all = await readPermissions(baseDir);
    expect(all['p.a']).toEqual([
      { permission: 'fs', granted: true, decidedAt: 5 },
    ]);
  });

  it('保留 pathScopes(对象形态 round-trip)', async () => {
    await writePluginPermissions(baseDir, 'p.a', {
      decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
      pathScopes: [{ path: '/tmp/x', mode: 'rw' }],
    });
    const all = await readPermissions(baseDir);
    expect(all['p.a']).toEqual({
      decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
      pathScopes: [{ path: '/tmp/x', mode: 'rw' }],
    });
  });

  it('空记录 → 删除该 id,但保留其它 plugin', async () => {
    await writePluginPermissions(baseDir, 'p.a', [
      { permission: 'fs', granted: true, decidedAt: 1 },
    ]);
    await writePluginPermissions(baseDir, 'p.b', [
      { permission: 'fs', granted: true, decidedAt: 2 },
    ]);
    await writePluginPermissions(baseDir, 'p.a', []); // 清空 p.a
    const all = await readPermissions(baseDir);
    expect(all['p.a']).toBeUndefined();
    expect(all['p.b']).toBeDefined();
  });

  it('非法 id → 忽略,不触盘', async () => {
    await writePluginPermissions(baseDir, '../evil', [
      { permission: 'fs', granted: true, decidedAt: 1 },
    ]);
    // 文件不应被创建/含 evil
    const all = await readPermissions(baseDir);
    expect(Object.keys(all)).toHaveLength(0);
  });

  // 边界(E247,E246 写读 cap 对称族):service 入口绕过 IPC schema 写超量时,写端按 MAX 收集
  //(decisions≤1000 / pathScopes≤256)**落盘**,与 readPermissions 对称 —— 断言**磁盘原始内容**已截断,
  // 不是只看 readPermissions(它自己也 re-cap,会掩盖写端无界:写 1100 落盘、读回 1000 仍丢数据)。
  async function rawDisk(): Promise<Record<string, unknown>> {
    const raw = await readFile(path.join(baseDir, PERM_FILE), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('E247 写超量 decisions(>1000)→ 服务层按 MAX(1000)截断落盘(磁盘原始内容)', async () => {
    const many = Array.from({ length: 1100 }, (_, i) => ({
      permission: 'fs',
      granted: true,
      decidedAt: i + 1,
    }));
    await writePluginPermissions(baseDir, 'p.big', many);
    const disk = await rawDisk();
    const rec = disk['p.big'];
    const decisions = Array.isArray(rec)
      ? rec
      : (rec as { decisions?: unknown[] }).decisions;
    expect(decisions?.length).toBe(1000); // 落盘即截断,非 1100
  });

  it('E247 写超量 pathScopes(>256)→ 服务层按 MAX(256)截断落盘(磁盘原始内容)', async () => {
    const scopes = Array.from({ length: 300 }, (_, i) => ({
      path: `/p/${i}`,
      mode: 'r' as const,
    }));
    await writePluginPermissions(baseDir, 'p.scopes', {
      decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
      pathScopes: scopes,
    });
    const disk = await rawDisk();
    const rec = disk['p.scopes'] as { pathScopes?: unknown[] };
    expect(rec.pathScopes?.length).toBe(256); // 落盘即截断,非 300
  });
});
