// P2 静态守卫(第八 session R7 完整性批判):剪贴板 prune 必须传播到 FolderTree 中**所有**
// 使「cut 源路径」失效的入口。R2 给 onTrash/onRename/onDropItems/root-drop 加了 prune,但
// 完整性批判揪出 onPaste 的 cut 分支(本身也是 move)在**部分成功**路径只在 allOk 时 clear,
// 漏了 prune —— 已移走的幻影源留在剪贴板(FileRow 灰显 + Paste 失效)。这正是本仓最高频
// 「修一族又漏一个同族」复发。修复后 onPaste 改 finally 内 prune(movedSrcs),与 onDropItems/
// root-drop 对齐。
//
// 本守卫:静态断言 5 个源失效入口都接入 prune,且 onPaste 不再用 allOk 门控 cut 清剪贴板
// (镜像 root-drop-partial-refresh / popout-consumers-use-helper 的静态守卫风格,防回退)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  join(__dirname, '..', '..', 'panels', 'Explorer', 'FolderTree.tsx'),
  'utf-8',
);

describe('49 第八 session · clipboard prune 传播到所有源失效入口', () => {
  it('5 个源失效入口(trash/rename/onDropItems/root-drop/onPaste)都调 prune', () => {
    const pruneCalls = SRC.match(/useExplorerClipboardStore\.getState\(\)\.prune\(/g) ?? [];
    expect(pruneCalls.length).toBeGreaterThanOrEqual(5);
  });

  it('三个 move 入口(onDropItems/root-drop/onPaste)都 prune(movedSrcs)', () => {
    const movedPrunes = SRC.match(/prune\(movedSrcs\)/g) ?? [];
    expect(movedPrunes.length).toBeGreaterThanOrEqual(3);
  });

  it('rename 入口 prune([oldPath])、trash 入口 prune(removed)', () => {
    expect(SRC).toMatch(/prune\(\[oldPath\]\)/);
    expect(SRC).toMatch(/prune\(removed\)/);
  });

  it('onPaste cut 不再用 allOk 门控清剪贴板(部分成功也剪已移走项)', () => {
    // 修复前是 `if (kind === 'cut' && allOk) ...clear()`;修复后无 allOk 门控,改 movedSrcs prune。
    expect(SRC).not.toMatch(/kind === 'cut' && allOk/);
    expect(SRC).toMatch(/kind === 'cut' && movedSrcs\.length > 0/);
  });
});
