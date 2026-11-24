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
// 边界(MAX_STARTUP_DIRS 只数「命中」):海量不存在/非目录的绝对路径永远凑不满命中数,仍会逐个
// 同步 stat。另设候选检查预算:每次 isExistingDir 都计数(无论命中与否),耗尽即停止。
export const MAX_STARTUP_DIR_CHECKS = 256;

/** 启动目录路径是否在长度上限内(非空 string ≤ MAX_STARTUP_DIR_PATH_LEN)。
 *  E58/E59:argv / open-file 缓冲 / 运行期 open-file 三处共用,统一 string + 长度守卫。 */
export function isWithinStartupPathLimit(p: unknown): p is string {
  return (
    typeof p === 'string' && p.length > 0 && p.length <= MAX_STARTUP_DIR_PATH_LEN
  );
}

/**
 * 冷启动目录收集(argv 与 macOS open-file 缓冲共用):按出现顺序去重,只收存在的目录。
 * 边界(E58):目录数封顶;超长 / 非法路径先跳过、绝不 stat;候选检查预算(每次 isExistingDir 都计数,
 * 无效候选同样消耗)耗尽即停;isExistingDir 抛错视为不存在。固定上限数组收集,不 push 扩容。
 */
export function collectExistingDirs(
  candidates: Iterable<unknown>,
  isExistingDir: (p: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const dirs = new Array<string>(MAX_STARTUP_DIRS);
  let dirCount = 0;
  let checks = 0;
  for (const p of candidates) {
    if (dirCount >= MAX_STARTUP_DIRS) break;
    if (!isWithinStartupPathLimit(p)) continue;
    if (seen.has(p)) continue;
    if (checks >= MAX_STARTUP_DIR_CHECKS) break;
    checks += 1;
    seen.add(p);
    let ok = false;
    try {
      ok = isExistingDir(p);
    } catch {
      ok = false;
    }
    if (ok) {
      dirs[dirCount] = p;
      dirCount += 1;
    }
  }
  dirs.length = dirCount;
  return dirs;
}

/**
 * 运行期(second-instance)的 argv 路径候选:只按形态过滤(绝对路径、长度、去重),**不** stat —— 运行中的 main 同步
 * stat 遇失联网络盘 / 慢挂载会冻结整个 main;目录判定交给调用方逐个异步判定。数量按与冷启动相同的检查预算
 *(MAX_STARTUP_DIR_CHECKS)封顶,调用方再按 MAX_STARTUP_DIRS 封顶「实际打开」数(前面的无效路径不挤掉后面的目录)。
 * 冷启动仍用 pickArgvFolders(启动期同步判定决定开哪些窗口)。
 */
export function pickArgvPathCandidates(
  argv: readonly string[],
  opts: { readonly skipFirstArg: boolean },
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of absoluteArgvCandidates(argv, opts.skipFirstArg ? 2 : 1)) {
    if (out.length >= MAX_STARTUP_DIR_CHECKS) break;
    if (!isWithinStartupPathLimit(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** argv[start..] 中的绝对路径(相对路径不进 stat)。边界(E192):索引遍历原 argv,不 slice 物化尾部。 */
function* absoluteArgvCandidates(argv: readonly string[], start: number): Generator<string> {
  for (let i = start; i < argv.length; i++) {
    const p = argv[i];
    if (typeof p === 'string' && path.isAbsolute(p)) yield p;
  }
}

export function pickArgvFolders(
  argv: readonly string[],
  isExistingDir: (p: string) => boolean,
  opts: { readonly skipFirstArg: boolean; readonly skipAll?: boolean },
): string[] {
  if (opts.skipAll) return [];
  return collectExistingDirs(absoluteArgvCandidates(argv, opts.skipFirstArg ? 2 : 1), isExistingDir);
}
