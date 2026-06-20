import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// P2 一致性回归(第七 session R6 完整性批判):Explorer 右键「移到废纸篓」批量操作。
// 规范 helper mutate-actions.removeItems(遍历全部项、失败不早退、收集所有 failures、
// 刷新所有成功项父目录,已由 explorer-mutate/mutate-actions.spec「部分失败」用例严验)
// 此前在生产代码**从未被调用** —— FolderTree.onTrash 自己内联实现 trash 循环且
// **首次失败即 return**,静默跳过其余选中项(多选删除时后续项不删也不报错)。
// 同 onDropItems/onPaste/root-drop 的「修复未传播到平行调用点」族(P2-BB / 第六 session)。
// 修复:onTrash 改走 removeItems。
//
// onTrash 是 createTreeConfig 内联 handler(闭包,无法干净单测),用静态结构守卫
// (popout-consumers 风格)锁定:走规范 helper 且不退回内联早退循环。
const FILE = join(
  __dirname,
  '..',
  '..',
  'panels',
  'Explorer',
  'FolderTree.tsx',
);

function onTrashBody(src: string): string {
  const start = src.indexOf('onTrash:');
  expect(start).toBeGreaterThan(0);
  // 取到下一个顶层 handler(onCut:)之前,作为 onTrash 实现体。
  const end = src.indexOf('onCut:', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('49 · onTrash 走规范 removeItems 而非内联早退', () => {
  const src = readFileSync(FILE, 'utf-8');

  it('从 mutate-actions 导入 removeItems', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bremoveItems\b[^}]*\}\s*from\s*'\.\/mutate-actions'/s);
  });

  it('onTrash 调用 removeItems(走规范批量删除)', () => {
    const body = onTrashBody(src);
    expect(body).toMatch(/removeItems\(/);
  });

  it('onTrash 不再用「裸 await coApi.fs.trash(p) 后 return」的内联早退模式', () => {
    const body = onTrashBody(src);
    // 旧 bug 模式:循环里直接 await coApi.fs.trash 再 return。改用 helper 后应消失。
    expect(body).not.toMatch(/await\s+coApi\.fs\.trash\(/);
  });
});
