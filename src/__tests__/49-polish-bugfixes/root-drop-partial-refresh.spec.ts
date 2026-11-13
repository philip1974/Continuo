// topic 49 第六 session · P2:Explorer root-drop 批量中途失败未刷新已成功项。
//
// 根因:FolderTree 有三个文件移动调用点 —— onDropItems(拖到具体 row)、onPaste(粘贴)、
// handleDrop 的 root-drop 分支(拖到空白处)。P2-BB 给前两者加了 try/finally 部分成功
// 刷新(movedAny/okAny + finally refreshParent),但漏了 root-drop 分支。root-drop 旧实现
// 在循环中途某项 move 失败时 notify.error + 直接 return,跳过其后的 refreshParent(root) +
// 源父目录刷新 → 已移走的文件在树上凭空消失(源没刷=还显示、root 没刷=不显示)而其
// editor tab 路径已改 → 树/tab/磁盘三者不一致。
// 修复:root-drop 分支改为与 onDropItems 同款 try/finally + movedAny 累积刷新。
//
// 本守卫:静态断言三个 drop 调用点都带部分成功刷新契约(防「修复未传播到平行调用点」
// 这一本仓最高频缺陷类再次发生)。镜像 popout-consumers-use-helper 的静态守卫风格。

//
// 重构后(explorer-batch-transfer):三个调用点的内联循环已收口到 batch-transfer.ts 的
// transferEntriesInto,部分成功刷新契约由该主题的**行为测试**保证;本守卫改为断言三个调用点
// 都走共享实现、且共享实现保留 finally 刷新(调用点不可能再各自漏传播)。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXPLORER = join(__dirname, '..', '..', 'panels', 'Explorer');
const SRC = readFileSync(join(EXPLORER, 'FolderTree.tsx'), 'utf-8');
const HELPER = readFileSync(join(EXPLORER, 'batch-transfer.ts'), 'utf-8');

describe('topic49 6thS · root-drop 部分成功刷新契约', () => {
  it('root-drop 分支(拖到空白 root level)走共享 transferEntriesInto', () => {
    const marker = 'root level)';
    const start = SRC.lastIndexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const branch = SRC.slice(start, start + 1200);
    expect(branch).toMatch(/runBatchTransfer\('move', moveable, root,/);
  });

  it('三个文件移动调用点(onDropItems/onPaste/root-drop)都走 runBatchTransfer', () => {
    const calls = SRC.match(/runBatchTransfer\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(SRC).not.toMatch(/coApi\.fs\.move\(/);
  });

  it('共享实现在 finally 内刷新目标目录 + 源父目录', () => {
    const fin = HELPER.slice(HELPER.search(/}\s*finally\s*{/));
    expect(fin).toMatch(/deps\.refreshDir\(destDir\)/);
    expect(fin).toMatch(/deps\.refreshDir\(sp\)/);
  });
});
