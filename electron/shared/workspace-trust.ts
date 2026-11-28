// 工作区信任(对齐 VSCode Workspace Trust / 受限模式)的跨进程契约。纯类型 / 常量 / 守卫,无 node 依赖:
// main(workspace-trust.service / workspace-trust.ipc)、preload、renderer 共用。
// 信任的判定与授予只在 main:renderer 只能读状态、请求 main 弹原生信任对话框、移除已信任的文件夹(收紧方向);
// 没有任何「直接设为信任」的 IPC(对话框由 main 弹、由用户在原生对话框里决定,renderer / 插件 / agent 伪造不了确认)。
// BDD: src/__tests__/workspace-trust/

export const WORKSPACE_TRUST_CHANNELS = {
  /** main → renderer:本窗口当前工作区根的信任状态(换根 / 信任变化时推送;root=null = 未打开文件夹)。 */
  CHANGED: 'workspace-trust:changed',
  /** renderer → main(invoke):管理界面要的信息(当前文件夹状态 + 已信任文件夹列表)。 */
  GET_INFO: 'workspace-trust:get-info',
  /** renderer → main(invoke):为本窗口当前文件夹弹信任对话框(main 原生对话框,用户决定);返回之后是否受信任。 */
  REQUEST_TRUST: 'workspace-trust:request-trust',
  /** renderer → main(invoke,`{ path }`):从已信任列表移除一项(只收紧,不放宽)。 */
  REMOVE_FOLDER: 'workspace-trust:remove-folder',
} as const;

/** 已信任文件夹 / 已询问过的文件夹各自的条目上限(超出丢最早的)。 */
export const WORKSPACE_TRUST_MAX_FOLDERS = 1000;

export interface WorkspaceTrustState {
  /** 本窗口当前工作区根(renderer 上报的原值);null = 未打开文件夹。 */
  readonly root: string | null;
  /** root 是否受信任(未打开文件夹时为 true)。 */
  readonly trusted: boolean;
}

export interface WorkspaceTrustInfo extends WorkspaceTrustState {
  /** 使当前文件夹受信任的已信任条目(当前文件夹本身或其上级;管理界面加粗显示)。 */
  readonly trustedBy: readonly string[];
  /** 「不信任」可用:当前文件夹只因它自己这一条而受信任(VSCode canSetWorkspaceTrust:上级也受信任时不能单独不信任)。 */
  readonly canUntrust: boolean;
  /** 全部已信任文件夹(按加入顺序)。 */
  readonly folders: readonly string[];
  /** 本次运行信任的修改存不下来(读盘失败,见 workspace-trust.service):管理界面提示。 */
  readonly persistBlocked: boolean;
}

export function isWorkspaceTrustState(p: unknown): p is WorkspaceTrustState {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (o['root'] === null || typeof o['root'] === 'string') && typeof o['trusted'] === 'boolean';
}
