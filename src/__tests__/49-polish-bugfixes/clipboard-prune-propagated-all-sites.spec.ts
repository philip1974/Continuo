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

const EXPLORER = join(__dirname, '..', '..', 'panels', 'Explorer');
const SRC = readFileSync(join(EXPLORER, 'FolderTree.tsx'), 'utf-8');
const HELPER = readFileSync(join(EXPLORER, 'batch-transfer.ts'), 'utf-8');

// 重构后(explorer-batch-transfer):三个 move 入口的内联循环收口到 transferEntriesInto,prune 经其
// onSourcesGone 回调接入(唯一一处);trash / rename 仍在 FolderTree 直接 prune。
describe('49 第八 session · clipboard prune 传播到所有源失效入口', () => {
  it('trash / rename 直接 prune;三个 move 入口经共享 onSourcesGone → prune', () => {
    const pruneCalls = SRC.match(/useExplorerClipboardStore\.getState\(\)\.prune\(/g) ?? [];
    expect(pruneCalls.length).toBeGreaterThanOrEqual(3);
    expect(SRC).toMatch(
      /onSourcesGone: \(movedSrcs\) => useExplorerClipboardStore\.getState\(\)\.prune\(movedSrcs\)/,
    );
  });

  it('三个 move 入口(onDropItems/root-drop/onPaste)都走 runBatchTransfer', () => {
    const calls = SRC.match(/runBatchTransfer\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('rename 入口 prune([oldPath])、trash 入口 prune(removed)', () => {
    expect(SRC).toMatch(/prune\(\[oldPath\]\)/);
    expect(SRC).toMatch(/prune\(removed\)/);
  });

  it('共享实现:部分成功也回报已移走项(无 allOk 门控),在 finally 内', () => {
    // 修复前是 `if (kind === 'cut' && allOk) ...clear()`;现由 transferEntriesInto 的 finally
    // 对已移走的 movedSrcs 调 onSourcesGone(行为测试见 explorer-batch-transfer)。
    expect(SRC).not.toMatch(/allOk/);
    expect(HELPER).not.toMatch(/allOk/);
    const fin = HELPER.slice(HELPER.search(/}\s*finally\s*{/));
    expect(fin).toMatch(/if \(movedSrcs\.length > 0\) deps\.onSourcesGone\(movedSrcs\)/);
  });
});
