// 安全:插件子进程 spawn 前的兜底(git 命令行作用域配置 / Windows 命令名不查 cwd)。
import { describe, expect, it } from 'vitest';
import {
  resolveSpawnCommand,
  withGitHardeningEnv,
} from '../lib/child-spawn-hardening';

describe('withGitHardeningEnv', () => {
  it('无既有 GIT_CONFIG_COUNT 时注入 core.fsmonitor=false,且不改入参', () => {
    const src = { PATH: '/usr/bin' };
    const out = withGitHardeningEnv(src);
    expect(out).toMatchObject({
      PATH: '/usr/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    });
    expect(src).toEqual({ PATH: '/usr/bin' });
  });

  it('调用方已带 GIT_CONFIG_COUNT 时从其后追加,不覆盖既有条目', () => {
    const out = withGitHardeningEnv({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'evil',
    });
    expect(out).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: 'false',
    });
  });
});

describe('resolveSpawnCommand(Windows 不从 cwd 解析命令名)', () => {
  const win = (files: string[]) => ({
    platform: 'win32' as const,
    isFile: (p: string) => files.includes(p),
  });

  it('非 Windows 原样返回', () => {
    expect(resolveSpawnCommand('git', { PATH: '/usr/bin' }, { platform: 'darwin', isFile: () => false })).toBe('git');
  });

  it('只在 PATH 的绝对目录中解析,跳过空项与相对项(相对项按 cwd 解析不可信)', () => {
    const deps = win(['ws\\git.exe', 'C:\\Git\\cmd\\git.exe']);
    expect(resolveSpawnCommand('git', { Path: ';.;ws;C:\\Git\\cmd' }, deps)).toBe('C:\\Git\\cmd\\git.exe');
  });

  it('PATH 中找不到 → 抛 ENOENT(fail-closed,不回退为裸名让 libuv 查 cwd)', () => {
    expect(() => resolveSpawnCommand('git', { PATH: 'C:\\none' }, win([]))).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('按 libuv 次序:带扩展名先试原名,再 .com / .exe;带引号的 PATH 项去引号', () => {
    expect(resolveSpawnCommand('git.exe', { PATH: '"C:\\a b"' }, win(['C:\\a b\\git.exe']))).toBe('C:\\a b\\git.exe');
    expect(resolveSpawnCommand('tool', { PATH: 'C:\\x' }, win(['C:\\x\\tool.com', 'C:\\x\\tool.exe']))).toBe(
      'C:\\x\\tool.com',
    );
  });

  it('含路径成分的命令由调用方显式指定,原样返回', () => {
    expect(resolveSpawnCommand('C:\\bin\\git.exe', { PATH: '' }, win([]))).toBe('C:\\bin\\git.exe');
    expect(resolveSpawnCommand('.\\tool.exe', { PATH: '' }, win([]))).toBe('.\\tool.exe');
  });
});
