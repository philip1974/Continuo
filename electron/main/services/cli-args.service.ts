// CLI argv 文件夹路径拾取(issue #45)。
//
// Windows/Linux 拖文件夹到 app 图标冷启动时,路径会通过 process.argv 进入
// main process。这里把 argv 里的目录路径拉进与 macOS open-file 相同的
// dock-mode 缓冲池;等 packaging 加上 folder file-association 后即可生效。

import * as path from 'node:path';

// 边界(E58,E55 外部输入族):启动目录来自 process.argv / OS open-file —— 畸形命令行或 file-open
// 可塞大量绝对路径或超长路径。pickArgvFolders 对每个候选同步 stat(isExistingDir),且下游 index.ts
// 为每个 extra 目录 allocateWindowSeq + createMainWindow。无上限时冷启动阻塞主进程做大量同步 I/O +
// 批量开窗 + 写爆 explorer window 段。路径超长先跳过(不 stat),目录数封顶。
export const MAX_STARTUP_DIR_PATH_LEN = 8192;
export const MAX_STARTUP_DIRS = 32;

/** 启动目录路径是否在长度上限内(非空 string ≤ MAX_STARTUP_DIR_PATH_LEN)。
 *  E58/E59:argv / open-file 缓冲 / 运行期 open-file 三处共用,统一 string + 长度守卫。 */
export function isWithinStartupPathLimit(p: unknown): p is string {
  return (
    typeof p === 'string' && p.length > 0 && p.length <= MAX_STARTUP_DIR_PATH_LEN
  );
}

export function pickArgvFolders(
  argv: readonly string[],
  isExistingDir: (p: string) => boolean,
  opts: { readonly skipFirstArg: boolean; readonly skipAll?: boolean },
): string[] {
  if (opts.skipAll) return [];

  const start = opts.skipFirstArg ? 2 : 1;
  const seen = new Set<string>();
  const dirs: string[] = [];

  // 边界(E192,E176/E189 有界迭代族):索引遍历原 argv,不 argv.slice(start) —— slice 在循环截断前
  // 就把尾部全量复制成新数组,畸形超长 process.argv 冷启动即产生不必要内存峰值。索引推进,凑满即 break。
  for (let i = start; i < argv.length; i++) {
    if (dirs.length >= MAX_STARTUP_DIRS) break; // 边界(E58):目录数封顶,停止收集 + 同步 stat
    const p = argv[i];
    // 边界(E58):超长/非法路径先跳过,绝不对其 isExistingDir(同步 stat)。
    if (!isWithinStartupPathLimit(p)) continue;
    if (!path.isAbsolute(p)) continue;
    if (seen.has(p)) continue;
    if (!isExistingDir(p)) continue;
    seen.add(p);
    dirs.push(p);
  }

  return dirs;
}
