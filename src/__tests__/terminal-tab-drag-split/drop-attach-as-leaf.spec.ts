/**
 * R2-2: drop 到本 panel 内部 pane 区时,PANE_ACTION ATTACH_LEAF_FROM_DETACHED
 * 把 detach 出来的 LeafNode 接到目标 leaf 的某方向,形成 SplitNode。
 * 不 enqueue spawn(P2-1: 保持独立 action 守住 "不 spawn" invariant)。
 */
import { describe, expect, it } from 'vitest';
import {
  paneTreeReducer,
  type LeafNode,
  type PaneNode,
} from '../../panels/Terminal/paneTree';

describe('terminal-tab-drag-split: ATTACH_LEAF_FROM_DETACHED', () => {
  it('attaches incoming leaf as split sibling at target', () => {
    const tree: PaneNode = { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a', cwd: '/a' };
    const incoming: LeafNode = {
      kind: 'leaf',
      id: 'leaf-b',
      ptyId: 'pty-b',
      cwd: '/b',
      spawnPending: false,
    };
    const result = paneTreeReducer(
      { tree, activeLeafId: 'leaf-a' },
      {
        type: 'ATTACH_LEAF_FROM_DETACHED',
        targetLeafId: 'leaf-a',
        dir: 'horizontal',
        leaf: incoming,
      },
    );
    expect(result.tree?.kind).toBe('split');
    if (result.tree?.kind === 'split') {
      expect(result.tree.dir).toBe('horizontal');
      expect(result.tree.ratio).toBe(50);
      expect(result.tree.a.kind).toBe('leaf');
      expect(result.tree.b.kind).toBe('leaf');
      if (result.tree.a.kind === 'leaf') expect(result.tree.a.ptyId).toBe('pty-a');
      if (result.tree.b.kind === 'leaf') expect(result.tree.b.ptyId).toBe('pty-b');
    }
    // 关键:effects 空(不 enqueue spawn,因为 incoming 自带 ptyId)
    expect(result.effects).toEqual([]);
    expect(result.activeLeafId).toBe('leaf-b');
  });

  it('preserves ratio override', () => {
    const tree: PaneNode = { kind: 'leaf', id: 'a', ptyId: 'p1' };
    const result = paneTreeReducer(
      { tree, activeLeafId: 'a' },
      {
        type: 'ATTACH_LEAF_FROM_DETACHED',
        targetLeafId: 'a',
        dir: 'vertical',
        ratio: 70,
        leaf: { kind: 'leaf', id: 'b', ptyId: 'p2' },
      },
    );
    if (result.tree?.kind === 'split') {
      expect(result.tree.ratio).toBe(70);
      expect(result.tree.dir).toBe('vertical');
    }
  });

  it('no-op when target leaf does not exist', () => {
    const tree: PaneNode = { kind: 'leaf', id: 'a', ptyId: 'p1' };
    const result = paneTreeReducer(
      { tree, activeLeafId: 'a' },
      {
        type: 'ATTACH_LEAF_FROM_DETACHED',
        targetLeafId: 'missing',
        dir: 'horizontal',
        leaf: { kind: 'leaf', id: 'b', ptyId: 'p2' },
      },
    );
    expect(result.tree).toBe(tree);
    expect(result.activeLeafId).toBe('a');
  });
});
