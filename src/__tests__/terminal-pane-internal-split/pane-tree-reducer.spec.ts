import { describe, expect, it } from 'vitest';
import {
  collectLeaves,
  collectPtyIdsFromPane,
  hydratePaneNode,
  paneTreeReducer,
  serializePaneNode,
  type PaneNode,
} from '../../panels/Terminal/paneTree';

function splitTree(): PaneNode {
  return {
    kind: 'split',
    id: 'split-1',
    dir: 'horizontal',
    ratio: 50,
    a: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a', cwd: '/a' },
    b: { kind: 'leaf', id: 'leaf-b', ptyId: 'pty-b', cwd: '/b' },
  };
}

describe('paneTreeReducer', () => {
  it('hydrates persisted leaves with spawnPending', () => {
    const tree = hydratePaneNode({
      kind: 'split',
      id: 's',
      dir: 'vertical',
      ratio: 42,
      a: { kind: 'leaf', id: 'a' },
      b: { kind: 'leaf', id: 'b' },
    });

    expect(collectLeaves(tree).every((leaf) => leaf.spawnPending)).toBe(true);
  });

  it('serializes without volatile pty state', () => {
    const serialized = serializePaneNode({
      kind: 'leaf',
      id: 'leaf-a',
      cwd: '/repo',
      ptyId: 'pty-a',
      spawnFailed: true,
      closing: true,
    });

    expect(serialized).toEqual({ kind: 'leaf', id: 'leaf-a', cwd: '/repo' });
  });

  it('collects leaves in stable left-to-right order', () => {
    expect(collectLeaves(splitTree()).map((leaf) => leaf.id)).toEqual([
      'leaf-a',
      'leaf-b',
    ]);
  });

  it('collects only existing pty ids', () => {
    expect(
      collectPtyIdsFromPane({
        kind: 'split',
        id: 's',
        dir: 'horizontal',
        ratio: 50,
        a: { kind: 'leaf', id: 'a' },
        b: { kind: 'leaf', id: 'b', ptyId: 'pty-b' },
      }),
    ).toEqual(['pty-b']);
  });

  it('splits the requested leaf and emits one split spawn effect', () => {
    const result = paneTreeReducer(
      { tree: { kind: 'leaf', id: 'leaf-a', cwd: '/repo' }, activeLeafId: 'leaf-a' },
      {
        type: 'SPLIT',
        leafId: 'leaf-a',
        dir: 'horizontal',
        newLeafId: 'leaf-b',
      },
    );

    expect(result.tree?.kind).toBe('split');
    expect(result.activeLeafId).toBe('leaf-b');
    expect(result.effects).toEqual([
      {
        type: 'ENQUEUE_SPAWN',
        leafId: 'leaf-b',
        cwd: '/repo',
        scoped: true,
        reason: 'split',
      },
    ]);
  });

  it('does not split an unknown leaf', () => {
    const tree = splitTree();
    const result = paneTreeReducer(
      { tree, activeLeafId: 'leaf-a' },
      {
        type: 'SPLIT',
        leafId: 'missing',
        dir: 'vertical',
        newLeafId: 'leaf-c',
      },
    );

    expect(result.tree).toBe(tree);
    expect(result.effects).toEqual([]);
    expect(result.activeLeafId).toBe('leaf-a');
  });

  it('sets pty id and resolved cwd on a leaf', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'SET_PTY_ID', leafId: 'leaf-b', ptyId: 'pty-new', cwd: '/resolved' },
    );

    expect(collectLeaves(result.tree!).find((leaf) => leaf.id === 'leaf-b')).toMatchObject({
      ptyId: 'pty-new',
      cwd: '/resolved',
      spawnPending: false,
      spawnFailed: false,
    });
  });

  it('marks spawn failure on a leaf', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'SET_PTY_FAIL', leafId: 'leaf-b' },
    );

    expect(collectLeaves(result.tree!).find((leaf) => leaf.id === 'leaf-b')).toMatchObject({
      spawnFailed: true,
      spawnPending: false,
    });
  });

  it('marks leaf closing before commit', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-b' },
      { type: 'CLOSE_LEAF_BEGIN', leafId: 'leaf-b' },
    );

    expect(collectLeaves(result.tree!).find((leaf) => leaf.id === 'leaf-b')?.closing).toBe(
      true,
    );
  });

  it('commits leaf close and unwraps sibling', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-b' },
      { type: 'CLOSE_LEAF_COMMIT', leafId: 'leaf-b' },
    );

    expect(result.tree).toEqual({ kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a', cwd: '/a' });
    expect(result.activeLeafId).toBe('leaf-a');
    expect(result.effects).toEqual([
      { type: 'LEAF_CLOSED', leafId: 'leaf-b', ptyId: 'pty-b' },
    ]);
  });

  it('commits root leaf close to empty tree', () => {
    const result = paneTreeReducer(
      { tree: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a' }, activeLeafId: 'leaf-a' },
      { type: 'CLOSE_LEAF_COMMIT', leafId: 'leaf-a' },
    );

    expect(result.tree).toBeNull();
    expect(result.effects).toEqual([
      { type: 'LEAF_CLOSED', leafId: 'leaf-a', ptyId: 'pty-a' },
    ]);
  });

  it('focuses an existing leaf', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'FOCUS_LEAF', leafId: 'leaf-b' },
    );

    expect(result.activeLeafId).toBe('leaf-b');
  });

  it('ignores focus of a missing leaf', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'FOCUS_LEAF', leafId: 'missing' },
    );

    expect(result.activeLeafId).toBe('leaf-a');
  });

  it('cycles focus next and previous', () => {
    const next = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'FOCUS_NEXT' },
    );
    const prev = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'FOCUS_PREV' },
    );

    expect(next.activeLeafId).toBe('leaf-b');
    expect(prev.activeLeafId).toBe('leaf-b');
  });

  it('resizes split ratio with clamping', () => {
    const high = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'RESIZE', splitId: 'split-1', ratio: 120 },
    );
    const low = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'RESIZE', splitId: 'split-1', ratio: -10 },
    );

    expect(high.tree).toMatchObject({ ratio: 95 });
    expect(low.tree).toMatchObject({ ratio: 5 });
  });

  it('updates leaf cwd from OSC 7', () => {
    const result = paneTreeReducer(
      { tree: splitTree(), activeLeafId: 'leaf-a' },
      { type: 'UPDATE_LEAF_CWD', leafId: 'leaf-a', cwd: '/new' },
    );

    expect(collectLeaves(result.tree!).find((leaf) => leaf.id === 'leaf-a')?.cwd).toBe(
      '/new',
    );
  });
});
