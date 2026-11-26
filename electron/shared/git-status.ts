// 资源管理器 git 状态装饰(对齐 VSCode git 扩展的 FileDecorationProvider + GitIgnoreDecorationProvider)的跨进程契约。
// 纯类型 / 常量,无 node 依赖:main(git-status.service / git.ipc)、preload、renderer 共用。
// BDD: src/__tests__/explorer-git-decorations/

export const GIT_CHANNELS = {
  /**
   * renderer → main(invoke,入参 `{ root }` = renderer 当前的工作区根):取本窗口工作区根的 git 状态;非仓库 / 未装 git / 失败 → null;
   * root 与本窗口登记的根不符(换根后 window:notify-root 尚未到达)→ GIT_STATUS_STALE(renderer 稍后重试)。
   * git 的 cwd 只用 main 登记的根,入参只用于比对,renderer 不能借此指定任意目录。
   */
  STATUS: 'git:status',
} as const;

/**
 * 装饰种类(VSCode Status → 颜色槽):
 * modified = M / T(工作区或暂存区修改、类型变化);added = A(暂存新增 / intent-to-add);
 * renamed = R / C(重命名 / 复制);untracked = U;deleted = D;conflict = !(七种合并冲突);ignored = .gitignore 命中。
 */
export type GitStatusKind =
  | 'modified'
  | 'added'
  | 'renamed'
  | 'untracked'
  | 'deleted'
  | 'conflict'
  | 'ignored';

/**
 * 一条状态:[相对工作区根的路径(`/` 分隔;目录以 `/` 结尾,表示整个目录未跟踪 / 被忽略), 种类, 徽标字母]。
 * 字母随种类之外还区分 M / T、R / C(VSCode 同款),故单独带上;ignored 无字母(空串)。
 */
export type GitStatusEntry = readonly [path: string, kind: GitStatusKind, letter: string];

export interface GitStatusSnapshot {
  /** 本次查询所用的工作区根(renderer 据此丢弃根已切换后迟到的结果)。 */
  readonly root: string;
  readonly entries: readonly GitStatusEntry[];
}

/** 期望的根与本窗口登记的根不符:不跑 git,renderer 稍后重试。 */
export const GIT_STATUS_STALE = { stale: true } as const;
export type GitStatusStale = typeof GIT_STATUS_STALE;

export type GitStatusResult = GitStatusSnapshot | null | GitStatusStale;
