// @vitest-environment node
// 安全:插件 git 安装 / 更新的 clone 有体积与文件数上限(详见同目录 README)。
// 真实 installFromGit;只把 git 子进程换成桩:桩往真实 clone 目录写文件,按用例决定自行退出还是挂到被 kill。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  promises as fs,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ctl = vi.hoisted(() => ({
  /** 写完基础文件后的动作:返回 true = 桩随即以 0 退出;false = 挂起直到被 kill。 */
  populate: (_cloneDir: string): boolean => true,
  cloneDirs: [] as string[],
  kills: 0,
}));

vi.mock('node:child_process', async () => {
  const nodeFs = await import('node:fs');
  const np = await import('node:path');
  return {
    spawn: (_cmd: string, args: readonly string[]) => {
      const cloneDir = args[args.length - 1] as string;
      ctl.cloneDirs.push(cloneDir);
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      let exited = false;
      const exit = (code: number | null, signal: string | null): void => {
        if (exited) return;
        exited = true;
        listeners['exit']?.forEach((cb) => cb(code, signal));
      };
      const child = {
        stderr: { on() {} },
        on(ev: string, cb: (...a: unknown[]) => void) {
          (listeners[ev] ??= []).push(cb);
          return child;
        },
        kill(signal?: string) {
          // 与真实 ChildProcess 一致:已退出后 kill 是 no-op。killWithGrace 会在 1s 后补发 SIGKILL,
          // 若在此计数,上一用例迟到的 SIGKILL 会落到后续用例的 kills 上(CI 上偶发失败)。
          if (exited) return false;
          ctl.kills += 1;
          setTimeout(() => exit(null, signal ?? 'SIGTERM'), 10);
          return true;
        },
      };
      setTimeout(() => {
        nodeFs.mkdirSync(np.join(cloneDir, '.git'), { recursive: true });
        nodeFs.writeFileSync(
          np.join(cloneDir, 'manifest.json'),
          JSON.stringify({ id: 'big', name: 'Big', version: '1.0.0' }),
        );
        nodeFs.writeFileSync(np.join(cloneDir, 'main.js'), '// plugin');
        if (ctl.populate(cloneDir)) exit(0, null);
      }, 5);
      return child;
    },
  };
});

import {
  installFromGit,
  PLUGIN_CLONE_MAX_BYTES,
  PLUGIN_CLONE_MAX_ENTRIES,
} from '../../../electron/main/services/plugins.service';

const URL = 'https://example.com/big.git';
let root: string;
let baseDir: string;

/** 稀疏文件:逻辑大小即刻到位、不真占磁盘(体积按逻辑大小计)。 */
function sparse(file: string, bytes: number): void {
  const fd = openSync(file, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

beforeEach(async () => {
  root = await fs.realpath(await mkdtemp(path.join(tmpdir(), 'plugin-clone-cap-')));
  baseDir = path.join(root, 'plugins');
  await fs.mkdir(baseDir, { recursive: true });
  ctl.populate = () => true;
  ctl.cloneDirs = [];
  ctl.kills = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('插件 git 安装:clone 体积 / 文件数上限', () => {
  it('clone 进行中写超体积上限 → 终止 git、清理临时目录、PLUGIN_REPO_TOO_LARGE(不等 60s 超时)', async () => {
    ctl.populate = (d) => {
      // 第一次轮询前就已超限;git 不自行退出,只能被 kill
      sparse(path.join(d, '.git', 'pack.bin'), PLUGIN_CLONE_MAX_BYTES + 1);
      return false;
    };
    const started = Date.now();
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'PLUGIN_REPO_TOO_LARGE' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ctl.kills).toBeGreaterThan(0);
    expect(existsSync(path.dirname(ctl.cloneDirs[0]!))).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  }, 10_000);

  it('clone 在两次轮询之间就完成、检出树超体积上限 → 完成后复查同样拒绝,不落地', async () => {
    ctl.populate = (d) => {
      sparse(path.join(d, 'blob.bin'), PLUGIN_CLONE_MAX_BYTES + 1);
      return true;
    };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'PLUGIN_REPO_TOO_LARGE' });
    expect(existsSync(path.dirname(ctl.cloneDirs[0]!))).toBe(false);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it('文件数超上限 → PLUGIN_REPO_TOO_LARGE,不落地', async () => {
    ctl.populate = (d) => {
      const many = path.join(d, 'many');
      mkdirSync(many);
      for (let i = 0; i < PLUGIN_CLONE_MAX_ENTRIES; i++) writeFileSync(path.join(many, `f${i}`), '');
      return true;
    };
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'PLUGIN_REPO_TOO_LARGE' });
    expect(readdirSync(baseDir)).toEqual([]);
  }, 30_000);

  it('正常大小的仓库照常安装(不足上限的大文件 + 若干文件),不 kill git', async () => {
    ctl.populate = (d) => {
      mkdirSync(path.join(d, 'dist'));
      writeFileSync(path.join(d, 'dist', 'x.js'), '1');
      sparse(path.join(d, 'dist', 'asset.bin'), 10 * 1024 * 1024);
      return true;
    };
    await expect(installFromGit(URL, baseDir)).resolves.toMatchObject({ id: 'big' });
    expect(existsSync(path.join(baseDir, 'big', 'dist', 'x.js'))).toBe(true);
    expect(ctl.kills).toBe(0);
  });
});
