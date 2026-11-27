// BDD: markdown-outline 第 4 条 —— 大纲行模型(折叠 / 过滤 / 排序 / 稳定 id)、跟随光标落点、树键盘。见同目录 README。
import { describe, expect, it } from 'vitest';
import { parseMarkdownSymbols } from '@/panels/Editor/markdown-symbols';
import { buildOutlineRows, outlineKeyAction, rowIndexOfOrdinal } from '@/panels/Outline/outline-model';

const SRC = ['# Zeta', '## beta', '### gamma', '## Alpha', '# Delta', '## beta'].join('\n');
const outline = parseMarkdownSymbols(SRC);
const NONE = new Set<string>();

const names = (rows: ReturnType<typeof buildOutlineRows>['rows']) => rows.map((r) => `${r.level}:${r.symbol.text}`);

describe('可见行', () => {
  it('按位置:深度优先,aria-level / posinset / setsize / 有子项与展开', () => {
    const { rows } = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'position' });
    expect(names(rows)).toEqual(['1:Zeta', '2:beta', '3:gamma', '2:Alpha', '1:Delta', '2:beta']);
    expect(rows.map((r) => [r.posInSet, r.setSize])).toEqual([
      [1, 2],
      [1, 2],
      [1, 1],
      [2, 2],
      [2, 2],
      [1, 1],
    ]);
    expect(rows.map((r) => r.hasChildren)).toEqual([true, true, false, false, true, false]);
    expect(rows.every((r) => !r.hasChildren || r.expanded)).toBe(true);
  });

  it('id 稳定且唯一(同名同级按出现次序编号;与排序无关)', () => {
    const a = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'position' });
    const b = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'name' });
    expect(new Set(a.rows.map((r) => r.id)).size).toBe(a.rows.length);
    expect(new Set(b.rows.map((r) => r.id))).toEqual(new Set(a.rows.map((r) => r.id)));
    expect(a.collapsibleIds).toHaveLength(3);
  });

  it('折叠:子孙隐藏,本行 expanded=false', () => {
    const zeta = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'position' }).rows[0]!.id;
    const { rows } = buildOutlineRows(outline.roots, { collapsed: new Set([zeta]), filter: '', sortBy: 'position' });
    expect(names(rows)).toEqual(['1:Zeta', '1:Delta', '2:beta']);
    expect(rows[0]!.expanded).toBe(false);
  });

  it('按名称:同级按标题文字自然序(不分大小写)', () => {
    const { rows } = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'name' });
    expect(names(rows)).toEqual(['1:Delta', '2:beta', '1:Zeta', '2:Alpha', '2:beta', '3:gamma']);
  });

  it('过滤:只留命中项及其上级,忽略折叠;命中下标标在标题文字上', () => {
    const zeta = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'position' }).rows[0]!.id;
    const { rows } = buildOutlineRows(outline.roots, { collapsed: new Set([zeta]), filter: 'gam', sortBy: 'position' });
    expect(names(rows)).toEqual(['1:Zeta', '2:beta', '3:gamma']);
    expect(rows.map((r) => r.matches)).toEqual([null, null, [0, 1, 2]]);
    expect(rows[1]!.hasChildren && rows[1]!.expanded).toBe(true);
    expect(buildOutlineRows(outline.roots, { collapsed: NONE, filter: 'zzz', sortBy: 'position' }).rows).toEqual([]);
  });
});

describe('跟随光标', () => {
  it('当前节的可见行;被折叠时落在最近的可见祖先;无当前节 → -1', () => {
    const open = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'position' });
    expect(rowIndexOfOrdinal(open, 2)).toBe(2); // gamma
    const collapsed = buildOutlineRows(outline.roots, { collapsed: new Set([open.rows[0]!.id]), filter: '', sortBy: 'position' });
    expect(rowIndexOfOrdinal(collapsed, 2)).toBe(0); // gamma 折叠在 Zeta 下
    expect(rowIndexOfOrdinal(open, -1)).toBe(-1);
  });
});

describe('树键盘', () => {
  const { rows } = buildOutlineRows(outline.roots, { collapsed: NONE, filter: '', sortBy: 'position' });
  it('↑↓ / Home / End 移动(到头不循环);无活动行时 ↓ 到第一行', () => {
    expect(outlineKeyAction(rows, -1, 'ArrowDown')).toEqual({ kind: 'move', index: 0 });
    expect(outlineKeyAction(rows, 0, 'ArrowDown')).toEqual({ kind: 'move', index: 1 });
    expect(outlineKeyAction(rows, 5, 'ArrowDown')).toEqual({ kind: 'move', index: 5 });
    expect(outlineKeyAction(rows, 0, 'ArrowUp')).toEqual({ kind: 'move', index: 0 });
    expect(outlineKeyAction(rows, 3, 'Home')).toEqual({ kind: 'move', index: 0 });
    expect(outlineKeyAction(rows, 0, 'End')).toEqual({ kind: 'move', index: 5 });
  });

  it('→ 展开 / 进第一个子项;← 折叠 / 回上级;叶子 → 无动作', () => {
    expect(outlineKeyAction(rows, 0, 'ArrowRight')).toEqual({ kind: 'move', index: 1 });
    expect(outlineKeyAction(rows, 2, 'ArrowRight')).toBeNull();
    expect(outlineKeyAction(rows, 0, 'ArrowLeft')).toEqual({ kind: 'toggle', id: rows[0]!.id, expand: false });
    expect(outlineKeyAction(rows, 2, 'ArrowLeft')).toEqual({ kind: 'move', index: 1 });
    const folded = buildOutlineRows(outline.roots, { collapsed: new Set([rows[0]!.id]), filter: '', sortBy: 'position' }).rows;
    expect(outlineKeyAction(folded, 0, 'ArrowRight')).toEqual({ kind: 'toggle', id: rows[0]!.id, expand: true });
    expect(outlineKeyAction(folded, 0, 'ArrowLeft')).toBeNull(); // 顶层且已折叠
  });

  it('Enter / 空格 打开当前行;其它键无动作;空树无动作', () => {
    expect(outlineKeyAction(rows, 3, 'Enter')).toEqual({ kind: 'open', index: 3 });
    expect(outlineKeyAction(rows, 3, ' ')).toEqual({ kind: 'open', index: 3 });
    expect(outlineKeyAction(rows, 3, 'a')).toBeNull();
    expect(outlineKeyAction([], 0, 'ArrowDown')).toBeNull();
  });
});
