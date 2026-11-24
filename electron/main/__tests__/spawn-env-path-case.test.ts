// 功能回归(Windows):宿主 `{...process.env}` 带 `Path`,插件 shell.exec 的 env 传 `PATH`,旧合并后两键并存 ——
// resolveSpawnCommand 按插入顺序取到宿主 `Path`,而 Node 给子进程按排序选键(`PATH`),插件补充的 PATH 在命令
// 解析时被忽略,且解析用的 env 与子进程实际 env 不一致。契约:Windows 上合并 env 大小写不敏感(后者覆盖前者,只留
// 一个键),解析与传给 spawn 的 env 一致。mock platform=win32 + lstatSync,验证 shell.exec 入口。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const spawnCalls: Array<{ cmd: string; env: NodeJS.ProcessEnv }> = [];
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ cmd, env: opts.env });
    const c = new FakeChild();
    queueMicrotask(() => c.emit('close', 0, null));
    return c;
  },
}));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  // 命令候选判定用 lstat(与 libuv「存在且不是目录」对齐,见 child-spawn-hardening isSpawnCandidate)
  const lstatSync = ((p: string) =>
    p === 'C:\\plug\\tool.exe'
      ? { isDirectory: () => false, isSymbolicLink: () => false }
      : real.lstatSync(p)) as typeof real.lstatSync;
  return { ...real, lstatSync, default: { ...real, lstatSync } };
});

import { execShell } from '../services/shell.service';
import { FakeChild } from './_helpers/fake-child';

const realPlatform = process.platform;
const realPath = process.env.PATH;

beforeEach(() => {
  spawnCalls.length = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.PATH = 'C:\\sys';
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  process.env.PATH = realPath;
});

describe('shell.exec(Windows)插件 env 的 Path 与宿主 PATH 大小写不同', () => {
  it('用插件补充的 Path 解析命令,子进程 env 只有一个 PATH 键', async () => {
    const r = await execShell({ cmd: 'tool', args: [], cwd: 'C:\\ws', env: { Path: 'C:\\plug' } });
    expect(r.stderr).toBe('');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toBe('C:\\plug\\tool.exe');
    const env = spawnCalls[0]!.env;
    const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    expect(pathKeys).toEqual(['Path']);
    expect(env.Path).toBe('C:\\plug');
  });
});
