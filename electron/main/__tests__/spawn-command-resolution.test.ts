// 安全(Windows):libuv 解析无路径命令名时先查子进程 cwd 再查 PATH,workspace 根放 `git.exe`,插件刷新
// (cwd=workspace)即执行它。三个 spawn 入口须先经 resolveSpawnCommand 在 PATH 的绝对目录中解析;
// 解析不到 fail-closed(不 spawn)。mock platform=win32 + 空 PATH,验证三入口都不把裸名交给 spawn。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const spawnCalls: string[] = [];
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string) => {
    spawnCalls.push(cmd);
    const c = new FakeChild();
    queueMicrotask(() => c.emit('close', 0, null));
    return c;
  },
}));

import { execShell } from '../services/shell.service';
import { registerPluginShellStreamHandlers } from '../services/plugin-shell-stream.service';
import { readGitBlob } from '../services/plugin-fs.service';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { installFromGit } from '../services/plugins.service';
import { processTreeKillable } from '../lib/kill-with-grace';
import { FakeChild } from './_helpers/fake-child';

const realPlatform = process.platform;
const realPath = process.env.PATH;
const realSystemRoot = process.env.SystemRoot;

beforeEach(() => {
  spawnCalls.length = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  // 只有相对项(按 cwd 解析,不可信)→ 必须解析失败
  process.env.PATH = '.;ws';
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  process.env.PATH = realPath;
  if (realSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = realSystemRoot;
});

describe('Windows 无路径命令名不从 cwd 解析(三个 spawn 入口)', () => {
  it('shell.exec:PATH 中解析不到 → spawn failed(ENOENT),不 spawn 裸名', async () => {
    const r = await execShell({ cmd: 'git', args: ['status'], cwd: 'C:\\ws' });
    expect(spawnCalls).toEqual([]);
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('流式 shell:PATH 中解析不到 → START reject,不 spawn', async () => {
    const handlers = new Map<string, (...a: unknown[]) => Promise<void>>();
    registerPluginShellStreamHandlers({
      handle: (ch: string, h: (...a: unknown[]) => Promise<void>) => handlers.set(ch, h),
    } as never);
    const sender = { id: 9101, isDestroyed: () => false, send: () => {}, once: () => {}, on: () => {} };
    await expect(
      handlers.get(PLUGIN_SHELL_STREAM_CHANNELS.START)!(
        { sender, senderFrame: { url: 'file:///app/index.html' } },
        's1',
        'git',
        ['status'],
        { cwd: 'C:\\ws' },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawnCalls).toEqual([]);
  });

  it('readGitBlob:PATH 中解析不到 → reject,不 spawn', async () => {
    await expect(readGitBlob('C:\\ws', 'a'.repeat(40))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawnCalls).toEqual([]);
  });
});

// 主进程自身的 spawn 入口:CLI 启动时主进程 cwd 即用户所在目录(可能是不可信仓库),同样不得按 cwd 解析裸名。
describe('Windows 主进程自身 spawn 不从 cwd 解析(git clone / taskkill)', () => {
  it('插件 git 安装:PATH 中解析不到 git → reject,不 spawn 裸名', async () => {
    await expect(installFromGit('https://example.com/p.git', 'C:\\plugins')).rejects.toThrow(/ENOENT/);
    expect(spawnCalls).toEqual([]);
  });

  it('进程树终止:taskkill 用 %SystemRoot%\\System32 下的绝对路径', () => {
    process.env.SystemRoot = 'C:\\Windows';
    const child = { pid: 4321, kill: vi.fn(() => true) };
    processTreeKillable(child).kill('SIGTERM');
    expect(spawnCalls).toEqual(['C:\\Windows\\System32\\taskkill.exe']);
  });

  it('进程树终止:无 SystemRoot 且 PATH 中解析不到 → 不 spawn 裸名,回退直杀根进程', () => {
    delete process.env.SystemRoot;
    const child = { pid: 4321, kill: vi.fn(() => true) };
    processTreeKillable(child).kill('SIGTERM');
    expect(spawnCalls).toEqual([]);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
