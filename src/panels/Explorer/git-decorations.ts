// 资源管理器 git 装饰的纯逻辑:main 的 git 状态快照 → 每行(文件 / 文件夹)的装饰。对齐 VSCode:
// - 文件:名称按状态着色 + 右侧徽标字母(M / A / U / D / R / C / T / !);.gitignore 命中只置灰、无字母。
// - 文件夹:继承子项颜色(VSCode FileDecoration.propagate),不显示字母;删除项不向上传播(VSCode 同款),
//   忽略项不传播(GitIgnoreDecorationProvider 无 propagate)。整个未跟踪 / 被忽略的目录(`dir/` 条目)其下各项同样处理。
// BDD: src/__tests__/explorer-git-decorations/

import { isSameOrInsidePath, pathEquals, stripRootPrefix } from '@/lib/path-cross';
import type { GitStatusEntry, GitStatusKind } from '../../../electron/shared/git-status';

export interface GitRowDecoration {
  readonly kind: GitStatusKind;
  /** 徽标字母;文件夹 / 忽略项为空串。 */
  readonly letter: string;
}

export interface GitDecorationIndex {
  /** 文件(及子模块等非目录条目)→ 装饰。 */
  readonly exact: ReadonlyMap<string, GitRowDecoration>;
  /** 整目录条目(`dir/`,去掉尾部 `/`;'' = 工作区根本身)→ 种类(untracked / ignored)。 */
  readonly wholeDirs: ReadonlyMap<string, GitStatusKind>;
  /** 文件夹继承的颜色(子项中优先级最高的种类)。 */
  readonly folders: ReadonlyMap<string, GitStatusKind>;
}

/** 文件夹继承颜色时多个子项种类的优先级(高者胜):冲突 > 修改 > 新增 > 重命名 > 未跟踪。 */
const PROPAGATE_PRIORITY: Partial<Record<GitStatusKind, number>> = {
  conflict: 5,
  modified: 4,
  added: 3,
  renamed: 2,
  untracked: 1,
};

function propagate(folders: Map<string, GitStatusKind>, rel: string, kind: GitStatusKind): void {
  const pri = PROPAGATE_PRIORITY[kind];
  if (pri === undefined) return;
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
    const dir = rel.slice(0, i);
    const cur = folders.get(dir);
    if (cur !== undefined && (PROPAGATE_PRIORITY[cur] ?? 0) >= pri) continue;
    folders.set(dir, kind);
  }
}

export function buildGitDecorationIndex(entries: readonly GitStatusEntry[]): GitDecorationIndex {
  const exact = new Map<string, GitRowDecoration>();
  const wholeDirs = new Map<string, GitStatusKind>();
  const folders = new Map<string, GitStatusKind>();
  for (const [path, kind, letter] of entries) {
    if (path === '' || path.endsWith('/')) {
      const dir = path.slice(0, -1);
      wholeDirs.set(dir, kind);
      // 目录本身的颜色由 wholeDirs 给,这里只向其祖先传播(拼一个子路径让 propagate 从目录本身算起)
      if (dir !== '') propagate(folders, `${dir}/_`, kind);
      continue;
    }
    exact.set(path, { kind, letter });
    if (kind !== 'deleted') propagate(folders, path, kind);
  }
  return { exact, wholeDirs, folders };
}

/** 树行路径 → 相对工作区根的 `/` 分隔路径。 */
export function gitRelPath(root: string, path: string): string {
  return stripRootPrefix(root, path).replace(/\\/g, '/');
}

/** 某行的 git 装饰;无 → null。rel 为 gitRelPath 结果。 */
export function gitDecorationOf(
  index: GitDecorationIndex,
  rel: string,
  isDirectory: boolean,
): GitRowDecoration | null {
  const hit = index.exact.get(rel);
  if (hit) return isDirectory ? { kind: hit.kind, letter: '' } : hit;
  if (index.wholeDirs.size > 0) {
    // 自身(目录)或最近的整目录祖先
    let p = rel;
    for (;;) {
      const kind = p === rel && !isDirectory ? undefined : index.wholeDirs.get(p);
      if (kind !== undefined) {
        return { kind, letter: !isDirectory && kind === 'untracked' ? 'U' : '' };
      }
      if (p === '') break;
      const i = p.lastIndexOf('/');
      p = i < 0 ? '' : p.slice(0, i);
    }
  }
  if (isDirectory) {
    const kind = index.folders.get(rel);
    if (kind !== undefined) return { kind, letter: '' };
  }
  return null;
}

/**
 * 任意文件路径(编辑器 tab、搜索结果)的 git 装饰:工作区根外 / 无快照 / 无状态 → null。
 * BDD: src/__tests__/editor-search-git-decorations/
 */
export function fileGitDecoration(
  index: GitDecorationIndex | null,
  root: string | null,
  path: string,
): GitRowDecoration | null {
  if (index === null || root === null || !isSameOrInsidePath(root, path) || pathEquals(root, path)) return null;
  return gitDecorationOf(index, gitRelPath(root, path), false);
}

/** 名称 / 徽标颜色(语义 token,见 theme.css --md-git-*)。字面量写全,Tailwind 才能扫描生成。 */
export const GIT_KIND_TEXT_CLASS: Record<GitStatusKind, string> = {
  modified: 'text-git-modified',
  added: 'text-git-added',
  renamed: 'text-git-untracked',
  untracked: 'text-git-untracked',
  deleted: 'text-git-deleted',
  conflict: 'text-git-conflict',
  ignored: 'text-git-ignored',
};

/** 读屏 / 悬浮提示文案(VSCode Resource.tooltip:Modified / Untracked …)。 */
export const GIT_KIND_LABEL_KEY: Record<GitStatusKind, string> = {
  modified: 'panels.explorer.git.modified',
  added: 'panels.explorer.git.added',
  renamed: 'panels.explorer.git.renamed',
  untracked: 'panels.explorer.git.untracked',
  deleted: 'panels.explorer.git.deleted',
  conflict: 'panels.explorer.git.conflict',
  ignored: 'panels.explorer.git.ignored',
};
