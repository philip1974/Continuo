// 安全(Linux AppImage 多用户):AppImage 运行时把 resources 挂载在 `$TMPDIR/.mount_<前缀><随机>`,仅运行期间
// 存在、挂载点名对同机其他用户可见(/proc/mounts、ps)。若把 `<resourcesPath>/continuo-mcp-stdio.mjs` 写进
// `claude mcp add` 命令,该路径会被持久写入 ~/.claude.json;Continuo 退出后挂载点消失,另一本地用户在共享 /tmp
// 下建同名目录放同名脚本 → 受害者下次启动 Claude Code 即以自身身份执行它。
// 修复:非稳定位置时把脚本复制到 `<userData>/bin/`(0700 目录,0700 文件),命令只指向该稳定副本;复制失败
// fail-closed(不提供命令),绝不回退到临时挂载路径。
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureStableStdioCli, isUnstableResourcesPath, resolveStdioCliPathForConfig } from '../services/mcp-stdio-cli-install';
import { setupTempDirs } from './_helpers/temp-dirs';

const tempDirs = setupTempDirs();
function tempDir(): Promise<string> {
  return tempDirs.make('continuo-stdio-cli-');
}

async function modeOf(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777;
}

async function fixture(content = '#!/usr/bin/env node\nconsole.log(1);\n') {
  const root = await tempDir();
  const resources = join(root, 'mount', 'resources');
  await mkdir(resources, { recursive: true });
  const source = join(resources, 'continuo-mcp-stdio.mjs');
  await writeFile(source, content);
  const userData = join(root, 'userData');
  await mkdir(userData, { mode: 0o700 });
  return { root, resources, source, userData };
}

describe('isUnstableResourcesPath', () => {
  it('Linux 带 APPIMAGE 环境变量 → 不稳定', () => {
    expect(
      isUnstableResourcesPath('/opt/x/resources', { APPIMAGE: '/home/u/Continuo.AppImage' }, 'linux', '/tmp'),
    ).toBe(true);
  });
  it('Linux resourcesPath 在临时目录(AppImage 挂载点)→ 不稳定', () => {
    expect(isUnstableResourcesPath('/tmp/.mount_ContinXYZ/resources', {}, 'linux', '/tmp')).toBe(true);
  });
  it('Linux TMPDIR 被改时仍识别 /tmp、/var/tmp、/dev/shm 下的路径为不稳定', () => {
    const tmp = '/home/u/mytmp';
    expect(isUnstableResourcesPath('/tmp/.mount_X/resources', {}, 'linux', tmp)).toBe(true);
    expect(isUnstableResourcesPath('/tmp/continuo/resources', {}, 'linux', tmp)).toBe(true);
    expect(isUnstableResourcesPath('/var/tmp/continuo/resources', {}, 'linux', tmp)).toBe(true);
    expect(isUnstableResourcesPath('/dev/shm/continuo/resources', {}, 'linux', tmp)).toBe(true);
    expect(isUnstableResourcesPath('/home/u/mytmp/x/resources', {}, 'linux', tmp)).toBe(true);
    // 前缀相似的兄弟目录不算
    expect(isUnstableResourcesPath('/tmpfoo/continuo/resources', {}, 'linux', tmp)).toBe(false);
  });
  it('Linux 路径段含 .mount_(任意位置的 AppImage 挂载点)→ 不稳定', () => {
    expect(isUnstableResourcesPath('/run/user/1000/.mount_ContinAB/resources', {}, 'linux', '/tmp')).toBe(true);
    expect(isUnstableResourcesPath('/opt/x.mount_y/resources', {}, 'linux', '/tmp')).toBe(true);
  });
  it('Linux 安装在稳定目录 / macOS / Windows → 稳定(行为不变)', () => {
    expect(isUnstableResourcesPath('/opt/Continuo/resources', {}, 'linux', '/tmp')).toBe(false);
    expect(
      isUnstableResourcesPath('/Applications/Continuo.app/Contents/Resources', {}, 'darwin', '/tmp'),
    ).toBe(false);
    expect(isUnstableResourcesPath('C:\\Program Files\\Continuo\\resources', {}, 'win32', 'C:\\Temp')).toBe(
      false,
    );
  });
});

describe.skipIf(process.platform === 'win32')('ensureStableStdioCli', () => {
  it('复制到 <userData>/bin/,目录 0700、文件 0700(可执行),内容一致', async () => {
    const f = await fixture();
    const target = await ensureStableStdioCli(f.source, f.userData);
    expect(target).toBe(join(f.userData, 'bin', 'continuo-mcp-stdio.mjs'));
    expect(await readFile(target, 'utf-8')).toBe(await readFile(f.source, 'utf-8'));
    expect(await modeOf(target)).toBe(0o700);
    expect(await modeOf(join(f.userData, 'bin'))).toBe(0o700);
  });

  it('内容不变 → 不重写(mtime/inode 不变)', async () => {
    const f = await fixture();
    const target = await ensureStableStdioCli(f.source, f.userData);
    const before = await stat(target);
    await ensureStableStdioCli(f.source, f.userData);
    const after = await stat(target);
    expect(after.ino).toBe(before.ino);
  });

  it('版本升级(源内容变化)→ 覆盖为新内容', async () => {
    const f = await fixture('old');
    const target = await ensureStableStdioCli(f.source, f.userData);
    await writeFile(f.source, 'new-version');
    await ensureStableStdioCli(f.source, f.userData);
    expect(await readFile(target, 'utf-8')).toBe('new-version');
  });

  it('既有副本权限被放宽 → 收紧回 0700', async () => {
    const f = await fixture();
    const target = await ensureStableStdioCli(f.source, f.userData);
    await chmod(target, 0o777);
    await ensureStableStdioCli(f.source, f.userData);
    expect(await modeOf(target)).toBe(0o700);
  });

  it('目标是指向他处的 symlink → 替换成普通文件,不写穿链接目标', async () => {
    const f = await fixture('payload');
    const elsewhere = join(f.root, 'elsewhere.txt');
    await writeFile(elsewhere, 'untouched');
    await mkdir(join(f.userData, 'bin'), { mode: 0o700 });
    await symlink(elsewhere, join(f.userData, 'bin', 'continuo-mcp-stdio.mjs'));
    const target = await ensureStableStdioCli(f.source, f.userData);
    expect(await readFile(elsewhere, 'utf-8')).toBe('untouched');
    expect(await readFile(target, 'utf-8')).toBe('payload');
  });
});

describe.skipIf(process.platform === 'win32')('resolveStdioCliPathForConfig', () => {
  it('稳定位置 → 原样返回 resources 路径(非 AppImage 行为不变,不复制)', async () => {
    const f = await fixture();
    const p = await resolveStdioCliPathForConfig({
      sourcePath: f.source,
      userDataDir: f.userData,
      unstable: false,
    });
    expect(p).toBe(f.source);
  });

  it('不稳定位置 → 返回 <userData>/bin 稳定副本,绝不是临时挂载路径', async () => {
    const f = await fixture();
    const p = await resolveStdioCliPathForConfig({
      sourcePath: f.source,
      userDataDir: f.userData,
      unstable: true,
    });
    expect(p).toBe(join(f.userData, 'bin', 'continuo-mcp-stdio.mjs'));
    expect(p!.startsWith(f.resources)).toBe(false);
  });

  it('不稳定位置且复制失败 → fail-closed 返回 undefined,不回退临时挂载路径', async () => {
    const f = await fixture();
    // bin 被一个普通文件占位 → mkdir/写入失败
    await writeFile(join(f.userData, 'bin'), 'x');
    const p = await resolveStdioCliPathForConfig({
      sourcePath: f.source,
      userDataDir: f.userData,
      unstable: true,
    });
    expect(p).toBeUndefined();
  });
});
