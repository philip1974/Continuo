import { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { coApp } from '@/plugins/co-app';
import type { PanelRegistry, PanelSpec } from '@/plugins/registries/PanelRegistry';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { isThirdPartyContribution } from '@/plugins/scoped-app';
import type { PluginPanelProps } from '@/plugins/types';
import { PanelMount } from '@/shell/motion/PanelMount';

// 安全:第三方插件面板的 factory 只拿 SDK 声明的最小 props(PluginPanelProps)。dockview 原始 props 带
// containerApi(整个 dock 的 DockviewApi)与完整 panel api(group / close / moveTo …):零权限插件注册一个面板
// 就能枚举全部面板及 params(终端 sessionId)、关闭 / 新增任意面板、导出 / 重置布局,绕过 scoped
// `app.dock` 只开放 openPanel 的限制。按 dockview panel api 缓存:同一面板多次渲染拿到同一对象
//(插件把 props.api 放进 effect 依赖,每次渲染换新对象会让其反复退订 / 重订)。
const pluginPanelProps = new WeakMap<object, PluginPanelProps>();

function toPluginPanelProps(p: IDockviewPanelProps): PluginPanelProps {
  const panelApi = p.api;
  let props = pluginPanelProps.get(panelApi);
  if (!props) {
    props = Object.freeze({
      api: Object.freeze({
        id: panelApi.id,
        get isVisible(): boolean {
          return panelApi.isVisible;
        },
        onDidVisibilityChange(cb: (event: { readonly isVisible: boolean }) => void) {
          const sub = panelApi.onDidVisibilityChange((e) => cb({ isVisible: e.isVisible }));
          return { dispose: () => sub.dispose() };
        },
      }),
    });
    pluginPanelProps.set(panelApi, props);
  }
  return props;
}

/** 把 panels 注册表的 PanelSpec 桥接成 Dockview 的 components map。每个 panel 自动包 PanelMount(进出场动画)。 */
export function createPanelComponents(
  panels: PanelRegistry,
  snapshot: readonly PanelSpec[],
): Record<string, React.FC<IDockviewPanelProps>> {
  const map: Record<string, React.FC<IDockviewPanelProps>> = {};
  for (const spec of snapshot) {
    const type = spec.type;
    // race(R59,R55-R58 同族):wrapper 只捕获 type,渲染时从 **live** panels.get(type) 取
    // 当前 factory,而非闭包捕获快照里的 spec.factory。panel type 被插件 disable/reload
    // unregister 后、到 useRegistry 快照重渲前,dockview 仍会渲染本 component → 闭包捕获旧
    // factory 会实例化已移除插件代码(访问已释放资源)。live 查找:已移除则渲染空(panel 内容空,
    // 由 reconciler/关闭流程移除该 panel)。
    map[type] = (p) => {
      const live = panels.get(type);
      return (
        <PanelMount panelId={p.api.id}>
          {live
            ? (live.factory(isThirdPartyContribution(live) ? toPluginPanelProps(p) : p) as React.ReactNode)
            : null}
        </PanelMount>
      );
    };
  }
  return map;
}

/** coApp.panels 的 components map(随注册表快照变化重建)。 */
export function usePanelComponents(): Record<string, React.FC<IDockviewPanelProps>> {
  const snapshot = useRegistry(coApp.panels);
  return useMemo(() => createPanelComponents(coApp.panels, snapshot), [snapshot]);
}
