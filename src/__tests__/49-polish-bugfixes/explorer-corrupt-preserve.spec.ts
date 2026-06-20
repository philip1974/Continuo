import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultExplorerV3,
  loadExplorer,
} from '../../../electron/main/persistence';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-explorer-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// P2 回归:explorer.json 损坏时旧实现 loadExplorer 直接返 null,运行期写路径
// `(await loadExplorer()) ?? defaultExplorerV3()` 会在下一次窗口关闭/布局写时把
// 整个文件静默覆盖成默认值 → recentRoots/pinned/所有 window 段不可恢复地丢失。
// 修复:加载损坏文件时先保留 `.corrupt` sidecar,仍返 null(不改运行期降级行为)。
describe('49 · loadExplorer 损坏文件保留快照', () => {
  it('损坏 JSON → 返 null 且写出 .corrupt sidecar', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await fs.writeFile(file, '{not json at all');

    expect(await loadExplorer(file)).toBeNull();

    const backup = await fs.readFile(`${file}.corrupt`, 'utf-8');
    expect(backup).toBe('{not json at all');
  });

  it('合法 JSON 但未知 schema → 返 null 且保留快照', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await fs.writeFile(file, JSON.stringify({ version: 999, junk: true }));

    expect(await loadExplorer(file)).toBeNull();
    await expect(fs.access(`${file}.corrupt`)).resolves.toBeUndefined();
  });

  it('缺失文件 → 返 null 且不写 sidecar(首次启动语义)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');

    expect(await loadExplorer(file)).toBeNull();
    await expect(fs.access(`${file}.corrupt`)).rejects.toThrow();
  });

  it('已有 .corrupt 备份时不覆盖(只保第一次损坏快照)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await fs.writeFile(`${file}.corrupt`, 'FIRST-SNAPSHOT');
    await fs.writeFile(file, '{second corruption');

    expect(await loadExplorer(file)).toBeNull();
    // wx flag → 不覆盖已有备份
    expect(await fs.readFile(`${file}.corrupt`, 'utf-8')).toBe('FIRST-SNAPSHOT');
  });

  it('合法 v3 文件正常读回,不写 sidecar', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await fs.writeFile(file, JSON.stringify(defaultExplorerV3()));

    const loaded = await loadExplorer(file);
    expect(loaded).not.toBeNull();
    await expect(fs.access(`${file}.corrupt`)).rejects.toThrow();
  });
});
