// topic 49 · 审计 #5 + #2: installFromGit 原子 swap + overwrite + 失败回滚。
// 用 mock 的 git clone 把内容写进真实 tmp clone 目录,其余 cp/rename/rm 走真 fs,
// 验证: 覆盖安装替换旧版本 / overwrite=false 仍 EEXIST / clone 失败保留旧版本且无残留。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// mutable 控制 mock clone 行为(在测试里改)。
const ctl = vi.hoisted(() => ({
  fail: false,
  oversize: false, // E27:写 >1MiB 的 manifest.json 模拟畸形/超大 clone
  stderrChunk: '' as string, // E62:fail 时 git 子进程 stderr 输出(模拟超大错误输出)
  manifest: { id: 'p', name: 'P', version: '1.0.0' } as Record<string, string>,
}));

vi.mock('node:child_process', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const np = await import('node:path');
  return {
    spawn: (_cmd: string, args: readonly string[]) => {
      const cloneDir = args[4] as string;
      const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const stderrListeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: {
          on(ev: string, cb: (arg?: unknown) => void) {
            (stderrListeners[ev] ??= []).push(cb);
          },
        },
        on(ev: string, cb: (arg?: unknown) => void) {
          (listeners[ev] ??= []).push(cb);
          return child;
        },
        kill() {},
      };
      queueMicrotask(() => {
        if (ctl.fail) {
          if (ctl.stderrChunk) {
            stderrListeners['data']?.forEach((cb) => cb(ctl.stderrChunk));
          }
          listeners['exit']?.forEach((cb) => cb(1));
          return;
        }
        mkdirSync(cloneDir, { recursive: true });
        const manifestJson = ctl.oversize
          ? JSON.stringify({ ...ctl.manifest, pad: 'x'.repeat(1024 * 1024 + 1024) })
          : JSON.stringify(ctl.manifest);
        writeFileSync(np.join(cloneDir, 'manifest.json'), manifestJson);
        writeFileSync(np.join(cloneDir, 'main.js'), '// plugin');
        listeners['exit']?.forEach((cb) => cb(0));
      });
      return child;
    },
  };
});

import { installFromGit } from '../../../electron/main/services/plugins.service';

const URL = 'https://example.com/p.git';
let baseDir: string;

async function readVersion(id: string): Promise<string> {
  const text = await fs.readFile(path.join(baseDir, id, 'manifest.json'), 'utf-8');
  return (JSON.parse(text) as { version: string }).version;
}

describe('topic 49 · installFromGit 原子覆盖 + 回滚', () => {
  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'topic49-plugins-'));
    ctl.fail = false;
    ctl.oversize = false;
    ctl.stderrChunk = '';
    ctl.manifest = { id: 'p', name: 'P', version: '1.0.0' };
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  });

  it('overwrite=true 原子替换旧版本', async () => {
    await installFromGit(URL, baseDir);
    expect(await readVersion('p')).toBe('1.0.0');

    ctl.manifest = { id: 'p', name: 'P', version: '2.0.0' };
    const r = await installFromGit(URL, baseDir, { overwrite: true });
    expect(r.version).toBe('2.0.0');
    expect(await readVersion('p')).toBe('2.0.0');
  });

  it('git URL scheme 校验走字符扫描,不调用 RegExp.test', async () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      await expect(
        installFromGit('ftp://example.com/p.git', baseDir),
      ).rejects.toMatchObject({
        code: 'BAD_URL',
      });
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('git URL scheme 大小写不敏感(HTTPS:// 仍允许)', async () => {
    const r = await installFromGit('HTTPS://example.com/p.git', baseDir);
    expect(r).toMatchObject({ id: 'p', name: 'P', version: '1.0.0' });
  });

  it('已安装且 overwrite!=true → 抛 EEXIST,旧版本不动', async () => {
    await installFromGit(URL, baseDir);
    ctl.manifest = { id: 'p', name: 'P', version: '9.9.9' };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readVersion('p')).toBe('1.0.0');
  });

  it('overwrite 时 clone 失败 → 保留旧版本,baseDir 无 staging/backup 残留', async () => {
    await installFromGit(URL, baseDir);
    ctl.fail = true;
    await expect(
      installFromGit(URL, baseDir, { overwrite: true }),
    ).rejects.toBeTruthy();
    // 旧版本仍在
    expect(await readVersion('p')).toBe('1.0.0');
    // 无 .p.installing-* / .p.old-* 残留
    const entries = await fs.readdir(baseDir);
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]);
    expect(entries).toContain('p');
  });

  // 数据安全(codex 复查 P1,「只认 ENOENT」族):targetDir 的 access 非 ENOENT 错误
  // (EACCES/EIO)= 状态未知,旧实现 catch-all 当「不存在」→ overwrite 守卫绕过 / backup=null
  // 直接 rename 覆盖可达目标(无备份不可回滚)。修后:非 ENOENT 在 cp/rename 前 fail-closed 抛。
  it('targetDir access EACCES(非 ENOENT)→ fail-closed 抛,不覆盖已安装、无残留', async () => {
    await installFromGit(URL, baseDir); // 先装 v1
    ctl.manifest = { id: 'p', name: 'P', version: '2.0.0' };

    const realAccess = fs.access.bind(fs);
    const target = path.join(baseDir, 'p');
    vi.spyOn(fs, 'access').mockImplementation((async (
      p: Parameters<typeof realAccess>[0],
      ...rest: unknown[]
    ) => {
      if (String(p) === target) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return (realAccess as (...a: unknown[]) => Promise<void>)(p, ...rest);
    }) as unknown as typeof fs.access);

    await expect(
      installFromGit(URL, baseDir, { overwrite: true }),
    ).rejects.toMatchObject({ code: 'EACCES' });

    vi.restoreAllMocks();
    // 状态未知 → 不动 target:v1 仍在,无 .p.installing-* / .p.old-* 残留
    expect(await readVersion('p')).toBe('1.0.0');
    const entries = await fs.readdir(baseDir);
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]);
  });

  // 边界(E27,E24 兄弟):安装路径读 clone 的 manifest.json 走 readFileCapped(同
  // MANIFEST_MAX_BYTES=1MiB),与 listPluginDirs 启动扫描一致。超大 manifest 不整块读入,
  // 抛 BAD_MANIFEST,且在任何 cp/rename 复制替换之前 fail-fast → 目标目录不被创建/覆盖。
  it('E27 clone 的 manifest 超 1MiB → 抛 BAD_MANIFEST,不安装、无残留', async () => {
    ctl.oversize = true;
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({
      code: 'BAD_MANIFEST',
    });
    const entries = await fs.readdir(baseDir);
    expect(entries).not.toContain('p'); // 未复制/替换任何插件目录
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]); // 无 staging/backup 残留
  });

  it('E27 超大 manifest 覆盖安装 → 抛 BAD_MANIFEST,旧版本原样保留', async () => {
    await installFromGit(URL, baseDir); // 先装 v1
    ctl.oversize = true;
    ctl.manifest = { id: 'p', name: 'P', version: '2.0.0' };
    await expect(
      installFromGit(URL, baseDir, { overwrite: true }),
    ).rejects.toMatchObject({ code: 'BAD_MANIFEST' });
    expect(await readVersion('p')).toBe('1.0.0'); // 旧版本不动
    const entries = await fs.readdir(baseDir);
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]);
  });

  // 边界(E62,E1/E61 累积缓冲族):runGit 的 git stderr 累积有 64KB 上限,失败 message 截断 +
  // 标记,不无界把超大错误串拼进 Error / 传到 renderer。
  it('E62 git stderr 超 64KB → 失败 message 截断到 ~64KB + 标记', async () => {
    ctl.fail = true;
    ctl.stderrChunk = 'E'.repeat(200 * 1024); // 200KB 超大 stderr
    const err = await installFromGit(URL, baseDir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    // 截断到 ~64KB(含前缀 "git clone exit 1: "),远小于 200KB,且带截断标记。
    expect(msg.length).toBeLessThan(70 * 1024);
    expect(msg).toContain('stderr truncated');
  });

  it('E62 正常大小 stderr → 完整保留,无截断标记', async () => {
    ctl.fail = true;
    ctl.stderrChunk = 'fatal: repository not found';
    const err = await installFromGit(URL, baseDir).catch((e: unknown) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain('fatal: repository not found');
    expect(msg).not.toContain('stderr truncated');
  });

  it('全新安装写入目标目录', async () => {
    const r = await installFromGit(URL, baseDir);
    expect(r).toMatchObject({ id: 'p', name: 'P', version: '1.0.0' });
    expect(await readVersion('p')).toBe('1.0.0');
    const entries = await fs.readdir(baseDir);
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]);
  });

  // 边界(E100):安装路径复用 parseManifest(ManifestSchema)—— 与启动扫描同契约。畸形 manifest
  // (非 semver / 超长 name / id 路径穿越)在安装前 fail-fast BAD_MANIFEST,不留半装目录。
  it('E100 version 非 semver → BAD_MANIFEST,不安装', async () => {
    ctl.manifest = { id: 'p', name: 'P', version: 'not-semver' };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({
      code: 'BAD_MANIFEST',
    });
    expect(await fs.readdir(baseDir)).not.toContain('p');
  });

  it('E100 name 超长(>256)→ BAD_MANIFEST', async () => {
    ctl.manifest = { id: 'p', name: 'x'.repeat(300), version: '1.0.0' };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({
      code: 'BAD_MANIFEST',
    });
  });

  it('E100 id 路径穿越(..)→ BAD_MANIFEST(ManifestSchema 正则放行但 isSafePluginId 拦)', async () => {
    ctl.manifest = { id: '..', name: 'P', version: '1.0.0' };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({
      code: 'BAD_MANIFEST',
    });
  });
});
