import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writePermissions,
  writePluginPathScopes,
  writeEnabledIds,
} from '../services/plugins.service';

// 数据安全(codex 复查 P1,「读失败/损坏降级为空」族的写侧对偶):
// _permissions.json / _path-scopes.json / _enabled.json 此前用裸 fs.writeFile('w')。
// 'w' 先截断已有文件再写,ENOSPC/进程被杀/写中断会留下空/半截 JSON;重启后读侧按
// 既有契约把损坏 JSON 降级为空(授权/scope/enabled 全丢)。改 temp+fsync+rename 原子写后:
// rename 成功前原文件始终完好,写失败也绝不改动原文件。
//
// 用 rename 失败模拟「fsync→rename 窗口被杀」:原子写下原文件必须保持不变;
// 旧裸写实现根本不调用 rename(且已先截断),故此测试对旧实现会失败。
describe('插件持久化原子写(写中断不损坏原文件)', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-perm-atomic-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(baseDir, { recursive: true, force: true });
  });

  function failRename(): void {
    vi.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }),
    );
  }

  it('writePermissions: rename 失败时原 _permissions.json 完好', async () => {
    const file = path.join(baseDir, '_permissions.json');
    const original = JSON.stringify({
      'p.a': [{ permission: 'fs', granted: true, decidedAt: 1 }],
    });
    await writeFile(file, original, 'utf-8');

    failRename();
    await expect(
      writePermissions(baseDir, {
        'p.a': [{ permission: 'fs', granted: true, decidedAt: 1 }],
        'p.b': [{ permission: 'network', granted: true, decidedAt: 2 }],
      }),
    ).rejects.toThrow();

    expect(await readFile(file, 'utf-8')).toBe(original); // 原文件未被截断/覆盖
  });

  it('writePluginPathScopes: rename 失败时原 _path-scopes.json 完好', async () => {
    const file = path.join(baseDir, '_plugin-path-scopes.json');
    const original = JSON.stringify({
      'p.a': [{ path: '/work/a', mode: 'r' }],
    });
    await writeFile(file, original, 'utf-8');

    failRename();
    await expect(
      writePluginPathScopes(baseDir, 'p.b', [{ path: '/work/b', mode: 'rw' }]),
    ).rejects.toThrow();

    expect(await readFile(file, 'utf-8')).toBe(original);
  });

  it('writeEnabledIds: rename 失败时原 _enabled.json 完好', async () => {
    const file = path.join(baseDir, '_enabled.json');
    const original = JSON.stringify(['p.a']);
    await writeFile(file, original, 'utf-8');

    failRename();
    await expect(writeEnabledIds(baseDir, ['p.a', 'p.b'])).rejects.toThrow();

    expect(await readFile(file, 'utf-8')).toBe(original);
  });

  it('正常路径仍原子落盘新内容(无 temp 残留)', async () => {
    await writePermissions(baseDir, {
      'p.x': [{ permission: 'fs', granted: true, decidedAt: 9 }],
    });
    const raw = JSON.parse(
      await readFile(path.join(baseDir, '_permissions.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(raw['p.x']).toBeDefined();

    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(baseDir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
