// 启动模式决策(issue #30 修复)。
//
// 冷启动时,根据 macOS dock 'open-file' 缓冲的路径决定:
//   - 有 ≥1 个有效目录 → dock 模式,只开拖入的目录窗,**不**恢复历史
//   - 否则 → restore 模式,正常开主窗 + 异步恢复历史 windows[]
//
// 修复前 bug:两条路径无条件叠加 → dock 拖文件夹冷启出现 3 个 window。

import {
  MAX_STARTUP_DIRS,
  isWithinStartupPathLimit,
} from './cli-args.service';

export type StartupMode =
  | { readonly mode: 'dock'; readonly dirs: readonly string[] }
  | { readonly mode: 'restore' };

export function pickStartupMode(
  pendingOpenPaths: readonly string[],
  isExistingDir: (p: string) => boolean,
): StartupMode {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const p of pendingOpenPaths) {
    // 边界(E58,与 pickArgvFolders 同款):目录数封顶 + 超长路径先跳过(不 stat),挡 macOS open-file
    // 缓冲被塞大量/超长路径时冷启动同步 I/O + 批量开窗。
    if (dirs.length >= MAX_STARTUP_DIRS) break;
    if (!isWithinStartupPathLimit(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    let ok = false;
    try {
      ok = isExistingDir(p);
    } catch {
      ok = false;
    }
    if (ok) dirs.push(p);
  }
  if (dirs.length === 0) return { mode: 'restore' };
  return { mode: 'dock', dirs };
}
