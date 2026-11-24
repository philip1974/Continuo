import type { AddPanelOptions, DockviewApi, IDockviewPanel } from 'dockview-react';
import { useClosingStore } from '@/stores/closing.store';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';

const patched = new WeakSet<IDockviewPanel>();
const suppressedPanelCloses = new Set<string>();
// 每个 panel id 排定中的「真 close」timer。供 cancelPendingPanelClose 在面板于
// EXIT 动画窗口(EXIT_DURATION_MS)内被重新激活时撤销,防止刚复活的面板又被关。
const pendingCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
// 排定中的 close 里由 reconciler 发起的那些(见 cancelReconcilerPanelClose)。
const pendingReconcilerCloses = new Set<string>();
// 关闭守卫(异步确认)尚未答复的 panel id:期间重复 close 不重复询问。
const guardingCloses = new Set<string>();

/**
 * 面板关闭守卫:true 放行;false 取消;Promise 时等它(如终端有子进程时弹确认)。同步返回 true 的面板
 * 行为与无守卫完全相同(立即进入关闭动画)。
 */
export type PanelCloseGuard = (panel: IDockviewPanel) => boolean | Promise<boolean>;

/**
 * 撤销某 panel 排定中的延迟 close 并清掉它的 closing 标记。用于「关了又马上点开」
 * 的复活路径:wrapPanelClose 把真 close 延后 EXIT_DURATION_MS,这段时间里 panel
 * 仍存在;若此时 DockShell editor 激活 effect 命中它并 setActive,必须取消那个已
 * 排定的真 close,否则面板(及刚打开的文件)会在动画结束时凭空消失。
 * 非 pending 时调用是无害 no-op(幂等)。
 */
export function cancelPendingPanelClose(panelId: string): void {
  const timer = pendingCloseTimers.get(panelId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingCloseTimers.delete(panelId);
  }
  pendingReconcilerCloses.delete(panelId);
  useClosingStore.getState().unmark(panelId);
}

/**
 * 激活一个**已存在**的面板:先撤销它排定中的关闭(面板可能正处于关闭 EXIT 动画窗口内 —— 刚关随即又激活),
 * 否则刚激活的面板会在 EXIT_DURATION_MS 后随排定 close 一起消失。dock 的「激活已有面板」入口共用
 *(此前 focusPanel / openOrFocusPanel / DockShell editor 各写一遍,dock-api-ref 一度漏写)。
 */
export function activateDockPanel(panel: { readonly api: Pick<IDockviewPanel['api'], 'id' | 'setActive'> }): void {
  // 按 api.id 取消:与 wrapPanelClose 登记排定 close 的键一致。
  cancelPendingPanelClose(panel.api.id);
  panel.api.setActive();
}

/**
 * reconciler 发起的关闭尚在 EXIT 动画中、会话又重新可见(如快速切走再切回 workspace)时撤销它:
 * 取消排定的 close 并清掉 suppressed 标记,面板保留。只撤销 reconciler 关闭 —— 用户主动关闭不受影响。
 * 返回是否撤销了。
 */
export function cancelReconcilerPanelClose(panelId: string): boolean {
  if (!pendingReconcilerCloses.delete(panelId)) return false;
  cancelPendingPanelClose(panelId);
  suppressedPanelCloses.delete(panelId);
  return true;
}

export function markPanelCloseSuppressed(panelId: string): void {
  suppressedPanelCloses.add(panelId);
}

export function consumePanelCloseSuppressed(panelId: string): boolean {
  const suppressed = suppressedPanelCloses.has(panelId);
  suppressedPanelCloses.delete(panelId);
  return suppressed;
}

// 给每个 panel 的 api.close 包一层:先把 id 放进 closing-store(让 PanelMount
// 走 EXIT 动画),EXIT_DURATION_MS 后再真正调 close。统一拦在 api 层而不是
// SharedTab,这样所有 close 路径(× 按钮 / 中键 / 群组级关闭 / 第三方调用)
// 都自动走动画。guard(可选)同样拦在这一层:所有关闭入口(含 ⌘W)共用同一确认(终端 confirmOnKill);
// reconciler 收敛视图的关闭(已标 suppressed)不询问。
//
// 幂等:同一 panel 多次 patch 只生效第一次(WeakSet 守);同一 panel 多次 close
// 调用,只有第一次进入 store + 设 timeout(closing-store.mark 自身去重)。
export function wrapPanelClose(panel: IDockviewPanel, guard?: PanelCloseGuard): void {
  if (patched.has(panel)) return;
  patched.add(panel);

  const original = panel.api.close.bind(panel.api);
  const startClose = () => {
    const id = panel.api.id;
    const store = useClosingStore.getState();
    if (store.ids.has(id)) return;
    store.mark(id);
    // reconciler 关闭(会话已从可见快照消失:main 已删,或被 workspace 过滤隐藏但仍存活)会先
    // markPanelCloseSuppressed 再 close。以发起关闭时为准判定,这类关闭只收敛视图、不删会话 ——
    // 否则会误报 NOT_FOUND「关闭失败」,或杀掉另一 workspace 仍在运行的终端。
    const closedByReconciler = suppressedPanelCloses.has(id);
    if (closedByReconciler) pendingReconcilerCloses.add(id);
    const timer = setTimeout(() => {
      pendingCloseTimers.delete(id);
      pendingReconcilerCloses.delete(id);
      // 会话删除只有一个入口:original() 触发 dockview 的 onDidRemovePanel → handleTerminalPanelRemoved。
      // 它凭 suppressed 标记区分「reconciler 关闭(只收敛视图)」与「用户关闭(删会话)」。用户关闭的 EXIT
      // 动画期间 reconciler 可能补标(会话恰好从可见快照消失)—— 以发起关闭时为准,这里清掉补上的标记。
      // 动画窗口内被复活(cancelPendingPanelClose 清 timer)则走不到这里,面板与会话都保留(R44)。
      if (!closedByReconciler) suppressedPanelCloses.delete(id);
      try {
        original();
      } catch {
        // panel 已被其他路径(group teardown 等)移除,忽略。
      }
    }, EXIT_DURATION_MS);
    pendingCloseTimers.set(id, timer);
  };
  Object.defineProperty(panel.api, 'close', {
    value: () => {
      const id = panel.api.id;
      if (useClosingStore.getState().ids.has(id) || guardingCloses.has(id)) return;
      const verdict = !guard || suppressedPanelCloses.has(id) ? true : guard(panel);
      if (verdict === true) {
        startClose();
        return;
      }
      if (verdict === false) return;
      guardingCloses.add(id);
      void verdict.then(
        (ok) => {
          guardingCloses.delete(id);
          if (ok) startClose();
        },
        () => {
          guardingCloses.delete(id);
          startClose(); // 守卫自身出错不应让面板关不掉
        },
      );
    },
    writable: true,
    configurable: true,
  });
}

/**
 * 加面板但不抢激活:dockview addPanel 默认激活新面板,而 `inactive: true` 会让新 group 容器处于不可见渲染态
 *(xterm 数据进了内部但屏幕全黑)。改为默认加入后立即把激活还给原活动面板(DockShell 非用户意图的 editor
 * 面板与 Reconciler 的 agent 终端共用)。
 */
export function addPanelKeepingActive(api: DockviewApi, options: AddPanelOptions): IDockviewPanel {
  const previousActivePanelId = api.activePanel?.api.id ?? null;
  const panel = api.addPanel(options);
  if (previousActivePanelId && previousActivePanelId !== panel.api.id) {
    api.getPanel(previousActivePanelId)?.api.setActive();
  }
  return panel;
}
