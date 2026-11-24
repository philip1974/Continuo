// 安装即启用(main 侧):全新安装写 _enabled.json;更新保留原启停。
// 用 mock 的 git clone 把内容写进真实 tmp clone 目录,其余文件操作走真 fs(同 install-atomic-overwrite)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ctl = vi.hoisted(() => ({
  manifest: { id: 'p', name: 'P', version: '1.0.0' } as Record<string, string>,
}));

vi.mock('node:child_process', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const np = await import('node:path');
  return {
    spawn: (_cmd: string, args: readonly string[]) => {
      const cloneDir = args[args.length - 1] as string;
      const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on() {} },
        on(ev: string, cb: (arg?: unknown) => void) {
          (listeners[ev] ??= []).push(cb);
          return child;
        },
        kill() {},
      };
      queueMicrotask(() => {
        mkdirSync(cloneDir, { recursive: true });
        writeFileSync(np.join(cloneDir, 'manifest.json'), JSON.stringify(ctl.manifest));
        writeFileSync(np.join(cloneDir, 'main.js'), '// plugin');
        listeners['exit']?.forEach((cb) => cb(0));
      });
      return child;
    },
  };
});

import {
  installFromGit,
  readEnabledIds,
  setEnabledId,
} from '../../../electron/main/services/plugins.service';

const URL = 'https://example.com/p.git';
let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'install-enable-'));
  ctl.manifest = { id: 'p', name: 'P', version: '1.0.0' };
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true }).catch(() => {});
});

describe('installFromGit 安装即启用', () => {
  it('全新安装 → id 写入 _enabled.json(其它已启用的不受影响)', async () => {
    await setEnabledId(baseDir, 'other', true);
    await installFromGit(URL, baseDir);
    expect((await readEnabledIds(baseDir)).sort()).toEqual(['other', 'p']);
  });

  it('更新(覆盖安装)已被用户禁用的插件 → 保持禁用,不被重新打开', async () => {
    await installFromGit(URL, baseDir);
    await setEnabledId(baseDir, 'p', false);
    ctl.manifest = { id: 'p', name: 'P', version: '2.0.0' };
    await installFromGit(URL, baseDir, { overwrite: true });
    expect(await readEnabledIds(baseDir)).toEqual([]);
  });

  it('更新已启用的插件 → 仍启用', async () => {
    await installFromGit(URL, baseDir);
    ctl.manifest = { id: 'p', name: 'P', version: '2.0.0' };
    await installFromGit(URL, baseDir, { overwrite: true });
    expect(await readEnabledIds(baseDir)).toEqual(['p']);
  });
});
