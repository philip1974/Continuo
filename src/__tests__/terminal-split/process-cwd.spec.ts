// BDD: terminal-split 5 —— 读进程真实当前目录(VSCode TerminalProcess.getCwd):macOS lsof(execFile、不经 shell)、
// Linux /proc/<pid>/cwd、其它平台 null;结果须是存在的绝对目录。
import { describe, expect, it, vi } from 'vitest';
import { parseLsofCwd, readProcessCwd } from '../../../electron/main/services/terminal-process-cwd';

const isDir = vi.fn(async () => true);

describe('readProcessCwd', () => {
  it('macOS:lsof -a -d cwd -p <pid> -Fn,取 n 字段', async () => {
    const runLsof = vi.fn(async () => 'p4242\nfcwd\nn/Users/me/repo/sub\n');
    expect(await readProcessCwd(4242, { platform: 'darwin', runLsof, isDirectory: isDir })).toBe('/Users/me/repo/sub');
    expect(runLsof).toHaveBeenCalledWith(['-a', '-d', 'cwd', '-p', '4242', '-Fn']);
  });

  it('Linux:readlink /proc/<pid>/cwd', async () => {
    const readlink = vi.fn(async () => '/home/me/repo');
    expect(await readProcessCwd(7, { platform: 'linux', readlink, isDirectory: isDir })).toBe('/home/me/repo');
    expect(readlink).toHaveBeenCalledWith('/proc/7/cwd');
  });

  it('Windows → null(VSCode 同:回退初始目录)', async () => {
    const runLsof = vi.fn(async () => 'n/x');
    expect(await readProcessCwd(7, { platform: 'win32', runLsof, isDirectory: isDir })).toBeNull();
    expect(runLsof).not.toHaveBeenCalled();
  });

  it('lsof 失败 / 超时、输出无路径、相对路径、目录已不存在(Linux「(deleted)」)、非法 pid → null', async () => {
    const fail = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect(await readProcessCwd(7, { platform: 'darwin', runLsof: fail, isDirectory: isDir })).toBeNull();
    expect(await readProcessCwd(7, { platform: 'darwin', runLsof: async () => 'p7\n', isDirectory: isDir })).toBeNull();
    expect(await readProcessCwd(7, { platform: 'linux', readlink: async () => 'rel/dir', isDirectory: isDir })).toBeNull();
    expect(
      await readProcessCwd(7, {
        platform: 'linux',
        readlink: async () => '/gone (deleted)',
        isDirectory: async () => false,
      }),
    ).toBeNull();
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(await readProcessCwd(pid, { platform: 'darwin', runLsof: fail, isDirectory: isDir })).toBeNull();
    }
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('parseLsofCwd:没有 n 字段 → null', () => {
    expect(parseLsofCwd('')).toBeNull();
    expect(parseLsofCwd('p1\nfcwd\nn/a b\n')).toBe('/a b');
  });
});
