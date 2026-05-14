// 多窗口启动恢复(issue #23 Phase 2C + 2026-05-14 opt-in 化)。
//
// Continuo 启动时主窗口固定先开 windowSeq=0;之后从 explorer.json 的 windows[]
// 段挑出需要恢复的非主窗段,逐个 createMainWindow({ windowSeq, workspace })。
//
// **opt-in 行为(2026-05-14 改默认)**:仅当 `restoreAllWindowsOnLaunch: true`
// 才走 multi-window restore;默认 / undefined 时只开主窗(VSCode 默认风格)。
// 之前默认 restore-all 让用户每次启动看到一堆持久化的 workspace 窗口弹出,
// UX 困惑。session-restore 设计保留为高级功能,user 可在 explorer.json 显
// 式开启或后续做 UI。
//
// 跳过规则(opt-in 后):
//   1. windowSeq === 0 — 主窗已开,不重复
//   2. workspace.root === null — 空段无恢复语义
//   3. workspace 路径不存在 / 不是目录 — 用户删了项目;段保留以防 mount
//      改回来,但启动时不开窗

import type { ExplorerPayload } from '../persistence';

export interface RestoreEntry {
  readonly windowSeq: number;
  readonly workspace: string;
}

export function pickWindowsToRestore(
  data: ExplorerPayload,
  isExistingDir: (path: string) => boolean,
): RestoreEntry[] {
  // 默认只开主窗;显式 true 才恢复其他 window (session-restore opt-in)
  if (data.restoreAllWindowsOnLaunch !== true) return [];
  const out: RestoreEntry[] = [];
  for (const entry of data.windows) {
    if (entry.windowSeq === 0) continue;
    const ws = entry.workspace.root;
    if (ws === null) continue;
    if (!isExistingDir(ws)) continue;
    out.push({ windowSeq: entry.windowSeq, workspace: ws });
  }
  return out;
}
