import { useMemo, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useT } from '@/i18n/react';
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

function PluginPanelPlaceholder(): React.ReactElement {
  const t = useT();
  return (
    <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-fg-muted">
      {t('dock.panel.plugin_unavailable')}
    </div>
  );
}

/** 按 type 渲染 live 注册的 factory;未注册时显示占位,注册表变化即重渲染(占位 ↔ 真实内容自动切换)。 */
function createPanelHost(panels: PanelRegistry, type: string): React.FC<IDockviewPanelProps> {
  const subscribe = (cb: () => void): (() => void) => panels.subscribe(cb);
  const getLive = (): PanelSpec | undefined => panels.get(type);
  // race(R59,R55-R58 同族):只捕获 type,渲染时从 **live** panels.get(type) 取当前 factory,而非闭包
  // 捕获快照里的 spec.factory —— 插件 disable/reload 后不会再实例化已移除插件的代码。
  return function PanelHost(p) {
    const live = useSyncExternalStore(subscribe, getLive);
    return (
      <PanelMount panelId={p.api.id}>
        {live ? (
          (live.factory(isThirdPartyContribution(live) ? toPluginPanelProps(p) : p) as React.ReactNode)
        ) : (
          <PluginPanelPlaceholder />
        )}
      </PanelMount>
    );
  };
}

/**
 * 把 panels 注册表桥接成 Dockview 的 components map。每个 panel 自动包 PanelMount(进出场动画)。
 *
 * 数据丢失:持久化布局可能含**尚未注册**的面板类型(第三方插件初始化远慢于布局恢复,或插件已卸载 /
 * 禁用)。dockview 取 `components[name]` 得 undefined 会在 fromJSON 中抛错并清空全部面板 → 整份布局
 * 被默认布局覆盖写盘。故对任意 name 都返回按 registry 动态查找的组件:未注册先显示占位,插件晚到注册
 * 后自动换成真实内容;已卸载插件的面板留占位由用户关闭。BDD: src/__tests__/dock-plugin-panel-placeholder/
 */
export function createPanelComponents(
  panels: PanelRegistry,
  snapshot: readonly PanelSpec[],
): Record<string, React.FC<IDockviewPanelProps>> {
  const map: Record<string, React.FC<IDockviewPanelProps>> = {};
  for (const spec of snapshot) map[spec.type] = createPanelHost(panels, spec.type);
  return new Proxy(map, {
    get(target, name, receiver) {
      if (typeof name !== 'string' || Object.prototype.hasOwnProperty.call(target, name)) {
        return Reflect.get(target, name, receiver);
      }
      // 缓存:同一未知 type 多次取到同一组件(React 组件身份稳定)。
      const host = createPanelHost(panels, name);
      target[name] = host;
      return host;
    },
  });
}

/** coApp.panels 的 components map(随注册表快照变化重建)。 */
export function usePanelComponents(): Record<string, React.FC<IDockviewPanelProps>> {
  const snapshot = useRegistry(coApp.panels);
  return useMemo(() => createPanelComponents(coApp.panels, snapshot), [snapshot]);
}
