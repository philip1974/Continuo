export type SplitDirection = 'horizontal' | 'vertical';
export type SpawnReason = 'hydrate' | 'split' | 'addTab' | 'retry';

export interface LeafPersisted {
  kind: 'leaf';
  id: string;
  cwd?: string;
  title?: string;
}

export interface SplitPersisted {
  kind: 'split';
  id: string;
  dir: SplitDirection;
  a: PaneNodePersisted;
  b: PaneNodePersisted;
  ratio: number;
}

export type PaneNodePersisted = LeafPersisted | SplitPersisted;

export interface LeafNode extends LeafPersisted {
  ptyId?: string;
  spawnFailed?: boolean;
  closing?: boolean;
  spawnPending?: boolean;
}

export interface SplitNode
  extends Omit<SplitPersisted, 'a' | 'b'> {
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = LeafNode | SplitNode;

export type PaneTreeEffect =
  | { type: 'LEAF_CLOSED'; leafId: string; ptyId: string }
  | {
      type: 'ENQUEUE_SPAWN';
      leafId: string;
      cwd?: string;
      scoped: boolean;
      reason: SpawnReason;
    };

export type PaneTreeAction =
  | {
      type: 'SPLIT';
      leafId: string;
      dir: SplitDirection;
      newLeafId: string;
      newCwd?: string;
    }
  | {
      type: 'ATTACH_LEAF_FROM_DETACHED';
      targetLeafId: string;
      dir: SplitDirection;
      ratio?: number;
      leaf: LeafNode;
    }
  | { type: 'SET_PTY_ID'; leafId: string; ptyId: string; cwd?: string }
  | { type: 'SET_PTY_FAIL'; leafId: string }
  | { type: 'CLOSE_LEAF_BEGIN'; leafId: string }
  | { type: 'CLOSE_LEAF_COMMIT'; leafId: string }
  | { type: 'FOCUS_LEAF'; leafId: string }
  | { type: 'FOCUS_PREV' }
  | { type: 'FOCUS_NEXT' }
  | { type: 'RESIZE'; splitId: string; ratio: number }
  | { type: 'UPDATE_LEAF_CWD'; leafId: string; cwd: string };

export interface PaneTreeState {
  tree: PaneNode;
  activeLeafId?: string;
}

export interface PaneTreeResult {
  tree: PaneNode | null;
  activeLeafId?: string;
  effects: PaneTreeEffect[];
}

export function hydratePaneNode(node: PaneNodePersisted): PaneNode {
  if (node.kind === 'leaf') {
    return { ...node, spawnPending: true };
  }
  return {
    ...node,
    ratio: normalizeRatio(node.ratio),
    a: hydratePaneNode(node.a),
    b: hydratePaneNode(node.b),
  };
}

export function serializePaneNode(node: PaneNode): PaneNodePersisted {
  if (node.kind === 'leaf') {
    const { kind, id, cwd, title } = node;
    return {
      kind,
      id,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  }
  return {
    kind: 'split',
    id: node.id,
    dir: node.dir,
    ratio: normalizeRatio(node.ratio),
    a: serializePaneNode(node.a),
    b: serializePaneNode(node.b),
  };
}

export function collectLeaves(node: PaneNode): LeafNode[] {
  if (node.kind === 'leaf') return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

export function collectPtyIdsFromPane(node: PaneNode): string[] {
  return collectLeaves(node)
    .map((leaf) => leaf.ptyId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function findLeaf(node: PaneNode, leafId: string): LeafNode | undefined {
  if (node.kind === 'leaf') return node.id === leafId ? node : undefined;
  return findLeaf(node.a, leafId) ?? findLeaf(node.b, leafId);
}

export function paneTreeReducer(
  state: PaneTreeState,
  action: PaneTreeAction,
): PaneTreeResult {
  switch (action.type) {
    case 'SPLIT': {
      let didSplit = false;
      let spawnCwd: string | undefined;
      const tree = mapTree(state.tree, (leaf) => {
        if (leaf.id !== action.leafId) return leaf;
        didSplit = true;
        spawnCwd = action.newCwd ?? leaf.cwd;
        const current: LeafNode = { ...leaf, closing: false };
        const next: LeafNode = {
          kind: 'leaf',
          id: action.newLeafId,
          cwd: spawnCwd,
          title: leaf.title,
          spawnPending: true,
        };
        return {
          kind: 'split',
          id: `split-${leaf.id}-${action.newLeafId}`,
          dir: action.dir,
          ratio: 50,
          a: current,
          b: next,
        };
      });
      return {
        tree,
        activeLeafId: didSplit ? action.newLeafId : state.activeLeafId,
        effects: didSplit
          ? [
              {
                type: 'ENQUEUE_SPAWN',
                leafId: action.newLeafId,
                cwd: spawnCwd,
                scoped: true,
                reason: 'split',
              },
            ]
          : [],
      };
    }
    case 'ATTACH_LEAF_FROM_DETACHED': {
      let didAttach = false;
      const tree = mapTree(state.tree, (leaf) => {
        if (leaf.id !== action.targetLeafId) return leaf;
        didAttach = true;
        const current: LeafNode = { ...leaf, closing: false };
        const incoming: LeafNode = { ...action.leaf, closing: false };
        return {
          kind: 'split',
          id: `split-${leaf.id}-${incoming.id}`,
          dir: action.dir,
          ratio: normalizeRatio(action.ratio ?? 50),
          a: current,
          b: incoming,
        };
      });
      return {
        tree,
        activeLeafId: didAttach ? action.leaf.id : state.activeLeafId,
        effects: [],
      };
    }
    case 'SET_PTY_ID':
      console.debug('[pane-split] SET_PTY_ID', action.leafId, action.ptyId);
      return {
        tree: mapTree(state.tree, (leaf) =>
          leaf.id === action.leafId
            ? {
                ...leaf,
                ptyId: action.ptyId,
                cwd: action.cwd ?? leaf.cwd,
                spawnPending: false,
                spawnFailed: false,
              }
            : leaf,
        ),
        activeLeafId: state.activeLeafId,
        effects: [],
      };
    case 'SET_PTY_FAIL':
      console.debug('[pane-split] SET_PTY_FAIL', action.leafId);
      return {
        tree: mapTree(state.tree, (leaf) =>
          leaf.id === action.leafId
            ? { ...leaf, spawnFailed: true, spawnPending: false }
            : leaf,
        ),
        activeLeafId: state.activeLeafId,
        effects: [],
      };
    case 'CLOSE_LEAF_BEGIN':
      console.debug('[pane-split] CLOSE_LEAF_BEGIN', action.leafId);
      return {
        tree: mapTree(state.tree, (leaf) =>
          leaf.id === action.leafId ? { ...leaf, closing: true } : leaf,
        ),
        activeLeafId: state.activeLeafId,
        effects: [],
      };
    case 'CLOSE_LEAF_COMMIT': {
      console.debug('[pane-split] CLOSE_LEAF_COMMIT', action.leafId);
      const effects: PaneTreeEffect[] = [];
      const tree = removeLeaf(state.tree, action.leafId, effects);
      const leaves = tree ? collectLeaves(tree) : [];
      const activeLeafId =
        state.activeLeafId === action.leafId
          ? leaves[0]?.id
          : state.activeLeafId;
      return { tree, activeLeafId, effects };
    }
    case 'FOCUS_LEAF':
      return {
        tree: state.tree,
        activeLeafId: findLeaf(state.tree, action.leafId)?.id ?? state.activeLeafId,
        effects: [],
      };
    case 'FOCUS_PREV':
    case 'FOCUS_NEXT': {
      const leaves = collectLeaves(state.tree);
      if (leaves.length === 0) {
        return { tree: state.tree, activeLeafId: undefined, effects: [] };
      }
      const currentIndex = Math.max(
        0,
        leaves.findIndex((leaf) => leaf.id === state.activeLeafId),
      );
      const delta = action.type === 'FOCUS_NEXT' ? 1 : -1;
      const next = leaves[(currentIndex + delta + leaves.length) % leaves.length];
      return { tree: state.tree, activeLeafId: next?.id, effects: [] };
    }
    case 'RESIZE':
      return {
        tree: mapSplits(state.tree, (split) =>
          split.id === action.splitId
            ? { ...split, ratio: normalizeRatio(action.ratio) }
            : split,
        ),
        activeLeafId: state.activeLeafId,
        effects: [],
      };
    case 'UPDATE_LEAF_CWD':
      return {
        tree: mapTree(state.tree, (leaf) =>
          leaf.id === action.leafId ? { ...leaf, cwd: action.cwd } : leaf,
        ),
        activeLeafId: state.activeLeafId,
        effects: [],
      };
  }
}

function mapTree(node: PaneNode, visitLeaf: (leaf: LeafNode) => PaneNode): PaneNode {
  if (node.kind === 'leaf') return visitLeaf(node);
  const a = mapTree(node.a, visitLeaf);
  const b = mapTree(node.b, visitLeaf);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

function mapSplits(
  node: PaneNode,
  visitSplit: (split: SplitNode) => SplitNode,
): PaneNode {
  if (node.kind === 'leaf') return node;
  const withChildren = {
    ...node,
    a: mapSplits(node.a, visitSplit),
    b: mapSplits(node.b, visitSplit),
  };
  return visitSplit(withChildren);
}

function removeLeaf(
  node: PaneNode,
  leafId: string,
  effects: PaneTreeEffect[],
): PaneNode | null {
  if (node.kind === 'leaf') {
    if (node.id !== leafId) return node;
    if (node.ptyId) {
      effects.push({ type: 'LEAF_CLOSED', leafId, ptyId: node.ptyId });
    }
    return null;
  }

  const a = removeLeaf(node.a, leafId, effects);
  const b = removeLeaf(node.b, leafId, effects);
  if (!a) return b;
  if (!b) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

function normalizeRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 50;
  return Math.min(95, Math.max(5, Math.round(ratio)));
}
