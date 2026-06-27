import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  // 数据安全(codex 复查 P1):loadExplorer 旧实现把**所有**读错误当「首次启动」返 null。
  // EACCES/EIO 等「文件不可读但仍存在」时返 null → 写路径 `?? default`/merge(null) 后
  // atomicWriteJson 覆盖 explorer.json(recentRoots/pinned/窗口段全丢)。只有 ENOENT 才 null,
  // 其它读错误抛出中止后续写入(写路径在 file-mutex 回调内 reject,不落盘)。
  it('缺文件(ENOENT)→ 返 null(首次启动语义)', async () => {
    const dir = await tempDir();
    await expect(loadExplorer(join(dir, 'nope.json'))).resolves.toBeNull();
  });

  // 边界(E160):readExplorerCapped 改单 fd 后,EACCES 经 fs.open 抛出(原 mock readFile 改 mock open)。
  it('非 ENOENT 读错误(EACCES 等)→ 抛出,不返 null(防覆盖)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await fs.writeFile(file, '{}');
    const spy = vi
      .spyOn(fs, 'open')
      .mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
    await expect(loadExplorer(file)).rejects.toThrow();
    spy.mockRestore();
  });

  // 边界(E67,E18/E26/E66 stat-before-read 族;E160 TOCTOU 修正):explorer.json 读前经单 fd fstat
  // 硬拦(16MiB)。超大不整块读入(防启动/窗口恢复 OOM/CPU 峰值),且抛出(同 EACCES「当前态未知」)
  // 而非返 null —— 绝不触发 `?? default` 覆盖;也不进 preserveCorrupt 二次写 .corrupt。用真实稀疏文件。
  it('E67/E160 文件超 16MiB(单 fd fstat 预检)→ 抛出,不返 null、不写 .corrupt', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    await fs.writeFile(file, '{}');
    await fs.truncate(file, 17 * 1024 * 1024); // 真实稀疏超大文件
    await expect(loadExplorer(file)).rejects.toThrow(/too large/i);
    await expect(fs.access(`${file}.corrupt`)).rejects.toThrow(); // 不写 sidecar
  });

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

  // 边界(E84,数据完整性):重复 windowSeq 段 load 后 canonicalize,同 seq 只保留首段
  //(与 ensureWindowEntry/find「命中首个」一致),防多窗共享同段互相覆盖会话。
  it('E84 重复 windowSeq 段 → 去重保留首段(不落 corrupt)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'explorer.json');
    const mkWin = (windowSeq: number, root: string | null) => ({
      windowSeq,
      workspace: { root },
      explorer: {
        activePath: null,
        expandedPaths: [],
        sort: { by: 'name' as const, reverse: false },
      },
    });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 3,
        workspace: { recentRoots: [] },
        pinned: { paths: [] },
        nextWindowSeq: 3,
        windows: [
          mkWin(0, null),
          mkWin(1, '/first'),
          mkWin(1, '/second-dup'), // 重复 windowSeq=1
          mkWin(2, '/p2'),
        ],
      }),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = await loadExplorer(file);
    expect(loaded).not.toBeNull();
    const seqs = loaded!.windows.map((w) => w.windowSeq);
    expect(seqs).toEqual([0, 1, 2]); // 重复的第二个 windowSeq=1 段被丢弃
    expect(loaded!.windows.find((w) => w.windowSeq === 1)?.workspace.root).toBe(
      '/first', // 保留首段
    );
    expect(warn).toHaveBeenCalled();
    // 去重是 canonicalize 而非 corrupt:不写 .corrupt sidecar
    await expect(fs.access(`${file}.corrupt`)).rejects.toThrow();
  });
});
