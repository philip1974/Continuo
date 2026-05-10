// 窗口生命周期辅助(issue #23)。
//
// nextWindowSeqFromDisk:从磁盘 explorer.json 计算下一个 windowSeq。
//   max(nextWindowSeq, max(windows[*].windowSeq)+1, 1) — 1 是下限,主窗占 0。
//   每次创建新窗口前重读磁盘,因为多个 renderer 都可能写 explorer.json,
//   main 端不维护 in-memory counter 避免与磁盘状态漂移。
//
// IPC handler 与 application menu 共用此函数。

import { loadExplorer } from '../persistence';

export async function nextWindowSeqFromDisk(file: string): Promise<number> {
  const data = await loadExplorer(file);
  if (!data) return 1;
  const fromWindows = data.windows.reduce(
    (m, w) => Math.max(m, w.windowSeq + 1),
    1,
  );
  return Math.max(data.nextWindowSeq, fromWindows);
}
