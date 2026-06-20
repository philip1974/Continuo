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
  manifest: { id: 'p', name: 'P', version: '1.0.0' } as Record<string, string>,
}));

vi.mock('node:child_process', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const np = await import('node:path');
  return {
    spawn: (_cmd: string, args: readonly string[]) => {
      const cloneDir = args[4] as string;
      const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on: () => {} },
        on(ev: string, cb: (arg?: unknown) => void) {
          (listeners[ev] ??= []).push(cb);
          return child;
        },
        kill() {},
      };
      queueMicrotask(() => {
        if (ctl.fail) {
          listeners['exit']?.forEach((cb) => cb(1));
          return;
        }
        mkdirSync(cloneDir, { recursive: true });
        writeFileSync(
          np.join(cloneDir, 'manifest.json'),
          JSON.stringify(ctl.manifest),
        );
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

  it('全新安装写入目标目录', async () => {
    const r = await installFromGit(URL, baseDir);
    expect(r).toMatchObject({ id: 'p', name: 'P', version: '1.0.0' });
    expect(await readVersion('p')).toBe('1.0.0');
    const entries = await fs.readdir(baseDir);
    expect(entries.filter((e) => e.startsWith('.'))).toEqual([]);
  });
});
