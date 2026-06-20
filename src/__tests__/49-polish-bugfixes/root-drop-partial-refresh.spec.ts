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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(__dirname, '..', '..', 'panels', 'Explorer', 'FolderTree.tsx'),
  'utf-8',
);

describe('topic49 6thS · root-drop 部分成功刷新契约', () => {
  it('root-drop 分支(拖到空白 root level)带 try/finally + movedAny 刷新', () => {
    // 定位 root-drop 分支:从其唯一注释到该分支的 return
    const marker = 'root level)';
    const start = SRC.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const branch = SRC.slice(start, start + 2400);
    // 必须出现 movedAny 累积标志 + finally + 在 finally 内 refreshParent(root)
    expect(branch).toMatch(/let movedAny = false/);
    expect(branch).toMatch(/}\s*finally\s*{/);
    expect(branch).toMatch(/refreshParent\(root\)/);
  });

  it('三个文件移动调用点(onDropItems/onPaste/root-drop)都有 finally 刷新', () => {
    // move_failed 通知出现在三个 drop 循环里;部分成功刷新契约要求每处都有 finally。
    const finallyBlocks = SRC.match(/}\s*finally\s*{/g) ?? [];
    // onDropItems + root-drop 两处用 movedAny+finally;onPaste 用 okAny+finally。
    expect(finallyBlocks.length).toBeGreaterThanOrEqual(3);
  });
});
