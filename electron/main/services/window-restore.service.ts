// 多窗口启动恢复(issue #23 Phase 2C)。
//
// Continuo 启动时主窗口固定先开 windowSeq=0;之后从 explorer.json 的 windows[]
// 段挑出需要恢复的非主窗段,逐个 createMainWindow({ windowSeq, workspace })。
// 跳过规则:
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
