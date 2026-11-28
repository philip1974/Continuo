// popout 子窗最大化 / 全屏重启恢复(renderer 侧)。main 在子窗状态变化时推 window:popout-state(子窗名 + 状态 + 普通矩形,
// 见 electron/main/popout-window-state.ts);写布局时,最大化 / 全屏的子窗 position 改用普通矩形(dockview 存的是子窗当时的
// 铺满屏幕的尺寸),并在 popout 组上标 windowMode(layout:write 摘出存旁挂文件,重启按它恢复)。VSCode 辅助窗口 createState()
// 同样存 bounds + mode。BDD: src/__tests__/window-state-restore/popout-window-mode.spec.ts

import { isPopoutWindowStatePayload, type PopoutWindowState } from '@shared/window-channels';
import { coApi } from '@/lib/co-api';

const states = new Map<string, PopoutWindowState>();
const listeners = new Set<() => void>();

/** 主窗 renderer 启动时装上(dockview 建 popout 前)。返回退订。 */
export function installPopoutWindowStateTracking(): () => void {
  return coApi.window.onPopoutState((payload) => {
    if (!isPopoutWindowStatePayload(payload)) return;
    const prev = states.get(payload.name);
    states.set(payload.name, payload.state);
    // 只有非普通状态影响写出的布局(普通状态 dockview 自己读子窗当时的位置尺寸)。
    if ((prev?.mode ?? 'normal') !== payload.state.mode || payload.state.mode !== 'normal') {
      for (const l of [...listeners]) l();
    }
  });
}

/** 子窗状态变了、写出的布局随之变化(DockShell 据此标脏并防抖落盘)。返回退订。 */
export function onPopoutWindowStateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** DockviewApi 用到的最小面。 */
interface StateApi {
  getGroup(id: string):
    | { readonly api: { readonly location: { readonly type: string; readonly getWindow?: () => Window } } }
    | undefined;
}

/**
 * 写布局前:最大化 / 全屏的 popout 组 position 换成普通矩形并标 windowMode。没有需要改的 → 原对象返回。
 * popout 组在 toJSON 里按组 id(data.id)对应 api 里的组,组 → 子窗 → 子窗名 → main 推来的状态。
 */
export function withPopoutWindowStates<T>(layout: T, api: StateApi): T {
  const groups = (layout as { popoutGroups?: unknown }).popoutGroups;
  if (!Array.isArray(groups) || groups.length === 0 || states.size === 0) return layout;
  let changed = false;
  const next = groups.map((g: unknown) => {
    const id = (g as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof id !== 'string') return g;
    const location = api.getGroup(id)?.api.location;
    let name: string | undefined;
    try {
      name = location?.type === 'popout' ? location.getWindow?.().name : undefined;
    } catch {
      name = undefined; // 子窗已关
    }
    const state = name === undefined ? undefined : states.get(name);
    if (!state || state.mode === 'normal') return g;
    changed = true;
    return { ...(g as object), position: { ...state.bounds }, windowMode: state.mode };
  });
  return changed ? { ...layout, popoutGroups: next } : layout;
}

/** 测试用。 */
export function _resetPopoutWindowStates(): void {
  states.clear();
  listeners.clear();
}
