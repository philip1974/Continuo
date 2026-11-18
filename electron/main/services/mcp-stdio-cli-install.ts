// stdio CLI proxy 稳定路径(安全:Linux AppImage 多用户)。
//
// AppImage 运行时把 resources 挂载在 `$TMPDIR/.mount_<名字前缀><随机>`:仅运行期间存在,挂载点名对同机其他
// 用户可见(/proc/mounts、ps)。`claude mcp add ... -- <cliPath>` 会把 cliPath 持久写进 ~/.claude.json;
// Continuo 退出后挂载点消失,另一本地用户可在共享 /tmp 下建同名目录放同名脚本 → 受害者下次启动 Claude Code
// 即以自身身份执行它。故 resources 不在稳定位置时,把脚本复制到 `<userData>/bin/`(0700)并只对外给该副本路径;
// 复制失败 fail-closed(不提供命令),绝不回退到临时挂载路径。macOS / Windows / 稳定安装的 Linux 行为不变。

import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isSameOrInsidePath } from '../lib/path-inside';

export const STDIO_CLI_FILE_NAME = 'continuo-mcp-stdio.mjs';

const SHARED_TMP_DIRS = ['/tmp', '/var/tmp', '/dev/shm'] as const;
const APPIMAGE_MOUNT_MARKER = '.mount_';

/** resources 是否处于运行期临时位置(AppImage 挂载点),其路径不可持久写入外部配置。 */
export function isUnstableResourcesPath(
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  tmpDir: string = os.tmpdir(),
): boolean {
  if (platform !== 'linux') return false;
  if (env['APPIMAGE']) return true;
  // 更一般地:resources 落在任一共享临时目录内(未设 APPIMAGE 的挂载 / 解包运行)同样不稳定。TMPDIR 可能被改,
  // 只比 os.tmpdir() 会漏掉 /tmp、/var/tmp、/dev/shm —— 这些都是同机其他用户可写、可抢注的位置。
  if ([tmpDir, ...SHARED_TMP_DIRS].some((dir) => isSameOrInsidePath(dir, resourcesPath, 'linux'))) return true;
  // AppImage 挂载点目录名形如 `.mount_<前缀><随机>`,挂在别处(如 $XDG_RUNTIME_DIR)也是运行期临时路径。
  return path.posix.resolve(resourcesPath).split('/').some((seg) => seg.includes(APPIMAGE_MOUNT_MARKER));
}

/**
 * 把 sourcePath 复制为 `<userDataDir>/bin/continuo-mcp-stdio.mjs`(目录 0700、文件 0700 带可执行位,
 * 原子 temp+fsync+rename)。内容与权限都已一致则不重写;版本升级(内容变化)覆盖。返回目标路径。
 */
export async function ensureStableStdioCli(sourcePath: string, userDataDir: string): Promise<string> {
  const binDir = path.join(userDataDir, 'bin');
  const target = path.join(binDir, STDIO_CLI_FILE_NAME);
  const content = await readFile(sourcePath);

  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700); // 既有目录可能被放宽

  try {
    const st = await lstat(target); // 不跟随链接:链接 / 非普通文件一律重写替换
    if (st.isFile() && (st.mode & 0o777) === 0o700 && (await readFile(target)).equals(content)) {
      return target;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const tmp = path.join(binDir, `.${STDIO_CLI_FILE_NAME}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o700);
  try {
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, 0o700); // umask 可能去掉执行位;非 win 命令直接 exec 该文件(shebang)
    await rename(tmp, target); // rename 替换路径本身(若是链接则替换链接,不写穿)
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return target;
}

/**
 * 供 `claude mcp add` 命令使用的 cliPath:稳定位置原样返回;不稳定位置返回 userData 稳定副本,
 * 复制失败返回 undefined(调用方不提供命令),绝不返回临时挂载路径。
 */
export async function resolveStdioCliPathForConfig(opts: {
  sourcePath: string;
  userDataDir: string;
  unstable: boolean;
}): Promise<string | undefined> {
  if (!opts.unstable) return opts.sourcePath;
  try {
    return await ensureStableStdioCli(opts.sourcePath, opts.userDataDir);
  } catch (err) {
    console.warn('[mcp-stdio] failed to install stable CLI copy; claude mcp add command unavailable', err);
    return undefined;
  }
}
