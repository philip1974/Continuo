// 启动模式决策(issue #30 修复)。
//
// 冷启动时,根据 macOS dock 'open-file' 缓冲的路径决定:
//   - 有 ≥1 个有效目录 → dock 模式,只开拖入的目录窗,**不**恢复历史
//   - 否则 → restore 模式,正常开主窗 + 异步恢复历史 windows[]
//
// 修复前 bug:两条路径无条件叠加 → dock 拖文件夹冷启出现 3 个 window。

import { collectExistingDirs } from './cli-args.service';

export type StartupMode =
  | { readonly mode: 'dock'; readonly dirs: readonly string[] }
  | { readonly mode: 'restore' };

export function pickStartupMode(
  pendingOpenPaths: readonly string[],
  isExistingDir: (p: string) => boolean,
): StartupMode {
  // 边界(E58,与 pickArgvFolders 同一收集器):目录数封顶 + 超长路径先跳过(不 stat)+ 候选检查预算,
  // 挡 macOS open-file 缓冲被塞大量 / 超长路径时冷启动同步 I/O + 批量开窗。
  const dirs = collectExistingDirs(pendingOpenPaths, isExistingDir);
  return dirs.length === 0 ? { mode: 'restore' } : { mode: 'dock', dirs };
}
