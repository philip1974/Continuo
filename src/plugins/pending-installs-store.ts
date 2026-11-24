// 「已安装、待重启」记录(会话内,id → 安装结果)。全新安装后立即发起热激活(PluginManager.adoptInstalled:登记进列表并按
// main 已写的启用状态激活),落地即摘除;热激活未落地(准入不过等)期间设置页显示待重启行(带「立即重启」)、市场卡片显示
//「已安装（待重启）」。
//
// 此前设置页 Git 安装、市场卡片各用组件局部状态记、市场底部 Git URL 段不记;设置面板只挂载当前页,切页即丢 →
// 卡片又给「安装」,点击 main 抛 EEXIST(「已安装,卸载后再装」)。三个入口共用本 store,两页都从这里读。
// 不持久化:重启后插件已进列表,记录本就该消失。
import { create } from 'zustand';
import type { InstallFromGitResult } from '../../electron/shared/plugins-channels';
import { getUserPluginManager, type PluginListItem } from './PluginManager';
import { pruneLandedPendingMap } from '@/marketplace/prune-landed-pending';

const NO_PENDING_INSTALLS: ReadonlyMap<string, InstallFromGitResult> = new Map();

export const usePendingInstalls = create<{ byId: ReadonlyMap<string, InstallFromGitResult> }>(() => ({
  byId: NO_PENDING_INSTALLS,
}));

type Manager = NonNullable<ReturnType<typeof getUserPluginManager>>;
let boundManager: Manager | null = null;
let unbind: (() => void) | null = null;

function isListed(plugins: readonly PluginListItem[], id: string): boolean {
  for (const plugin of plugins) {
    if (plugin.id === id) return true;
  }
  return false;
}

function pruneLanded(plugins: readonly PluginListItem[]): void {
  const prev = usePendingInstalls.getState().byId;
  const next = pruneLandedPendingMap(prev, (id) => isListed(plugins, id));
  if (next !== prev) usePendingInstalls.setState({ byId: next });
}

// 落地摘除集中在这里:订阅 manager 的列表变化,已进列表的 id 摘除(见 prune-landed-pending),不依赖哪个页面挂着。
function bindManager(m: Manager): void {
  if (m === boundManager) return;
  unbind?.();
  boundManager = m;
  unbind = m.subscribe(() => pruneLanded(m.listAll()));
}

/**
 * 安装成功后记一笔并发起热激活。id 已在插件列表(覆盖重装 / 更新)→ 不记:watcher 热重载即生效,且此时列表不变、
 * 摘除不会跑,若在下次扫描前卸载,残留记录会成为幽灵。返回是否记下(= 全新安装)。
 */
export function recordPendingInstall(data: InstallFromGitResult): boolean {
  const m = getUserPluginManager();
  if (m && isListed(m.listAll(), data.id)) return false;
  if (m) bindManager(m);
  const { id, name, version } = data;
  usePendingInstalls.setState((s) => ({ byId: new Map(s.byId).set(id, { id, name, version }) }));
  // 热激活(不必重启):进列表即由上面的订阅摘除记录。不 await —— 激活可能停在授权弹窗上,不拖住安装按钮。
  if (m) {
    void Promise.resolve()
      .then(() => m.adoptInstalled(id))
      .catch((err: unknown) => console.warn(`[plugins] 热激活 ${id} 失败,保留待重启`, err));
  }
  return true;
}

/** 卸载后清除该 id 的记录(如有),防止记录未被摘除的时序下卸载后冒出幽灵待重启。 */
export function clearPendingInstall(id: string): void {
  const prev = usePendingInstalls.getState().byId;
  if (!prev.has(id)) return;
  const next = new Map(prev);
  next.delete(id);
  usePendingInstalls.setState({ byId: next });
}

export function _resetPendingInstallsForTest(): void {
  unbind?.();
  unbind = null;
  boundManager = null;
  usePendingInstalls.setState({ byId: NO_PENDING_INSTALLS });
}
