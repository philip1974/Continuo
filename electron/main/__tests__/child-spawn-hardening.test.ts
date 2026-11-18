// 安全:插件子进程 spawn 前的兜底(git 命令行作用域配置 / Windows 命令名不查 cwd)。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isSpawnCandidate,
  mergeSpawnEnv,
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

  it('PATH 项按 libuv 切分:成对引号(" 或 \')内的 ; 不是分隔符', () => {
    const deps = win(['C:\\a;b\\tool.exe', "C:\\c;d\\x.exe"]);
    expect(resolveSpawnCommand('tool', { PATH: 'C:\\none;"C:\\a;b";C:\\z' }, deps)).toBe('C:\\a;b\\tool.exe');
    expect(resolveSpawnCommand('x', { PATH: "'C:\\c;d'" }, deps)).toBe('C:\\c;d\\x.exe');
  });

  it('含路径成分的命令由调用方显式指定,原样返回', () => {
    expect(resolveSpawnCommand('C:\\bin\\git.exe', { PATH: '' }, win([]))).toBe('C:\\bin\\git.exe');
    expect(resolveSpawnCommand('.\\tool.exe', { PATH: '' }, win([]))).toBe('.\\tool.exe');
  });
});

describe('mergeSpawnEnv(Windows env 键大小写不敏感)', () => {
  it('Windows:插件 PATH 覆盖宿主 Path,只保留一个键(后者的键名与值)', () => {
    const out = mergeSpawnEnv({ Path: 'C:\\sys', Foo: '1' }, { PATH: 'C:\\plug;C:\\sys' }, 'win32');
    expect(Object.keys(out).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(out).toMatchObject({ PATH: 'C:\\plug;C:\\sys', Foo: '1' });
  });

  it('Windows:解析与传给子进程的 env 一致 —— 用插件补充的 PATH 解析命令', () => {
    const env = mergeSpawnEnv({ Path: 'C:\\sys' }, { PATH: 'C:\\plug' }, 'win32');
    const deps = { platform: 'win32' as const, isFile: (p: string) => p === 'C:\\plug\\tool.exe' };
    expect(resolveSpawnCommand('tool', env, deps)).toBe('C:\\plug\\tool.exe');
  });

  it('非 Windows:大小写敏感,原样合并;不改入参', () => {
    const base = { Path: 'a' };
    const out = mergeSpawnEnv(base, { PATH: 'b' }, 'linux');
    expect(out).toEqual({ Path: 'a', PATH: 'b' });
    expect(base).toEqual({ Path: 'a' });
  });
});

describe('isSpawnCandidate(与 libuv search_path_join_test 对齐:存在且不是目录)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spawn-cand-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tool.exe');
  writeFileSync(file, '');
  const dir = path.join(root, 'dir.exe');
  mkdirSync(dir);

  it('普通文件 → true;目录 / 不存在 → false', () => {
    expect(isSpawnCandidate(file)).toBe(true);
    expect(isSpawnCandidate(dir)).toBe(false);
    expect(isSpawnCandidate(path.join(root, 'missing.exe'))).toBe(false);
  });

  it('reparse 点 stat 失败(如 Store 版 python.exe 的 App Execution Alias,stat 抛 EACCES)仍视为存在', () => {
    // 用目标不可解析的符号链接模拟:lstat 成功、stat 抛错。GetFileAttributesW 对其返回非目录属性,libuv 会执行。
    const alias = path.join(root, 'python.exe');
    symlinkSync(path.join(root, 'nowhere', 'target'), alias);
    expect(isSpawnCandidate(alias)).toBe(true);
  });

  it('指向目录的符号链接 → false(GetFileAttributesW 带 FILE_ATTRIBUTE_DIRECTORY)', () => {
    const link = path.join(root, 'dirlink.exe');
    symlinkSync(dir, link);
    expect(isSpawnCandidate(link)).toBe(false);
  });
});
