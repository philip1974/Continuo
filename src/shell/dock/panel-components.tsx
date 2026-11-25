import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useT } from '@/i18n/react';
import { coApp } from '@/plugins/co-app';
import type { PanelRegistry, PanelSpec } from '@/plugins/registries/PanelRegistry';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { contributionPluginId, isThirdPartyContribution } from '@/plugins/scoped-app';
import { getUserPluginManager } from '@/plugins/PluginManager';
import { useUserPluginList } from '@/plugins/use-user-plugin-list';
import { Button } from '@/design';
import { notifyThrownError } from '@/notifications/notify-thrown-error';
import { PluginRenderBoundary } from '@/plugins/PluginRenderBoundary';
import type { PluginPanelProps } from '@/plugins/types';
import { PanelMount } from '@/shell/motion/PanelMount';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { keepScrollWhileHidden } from './keep-scroll-while-hidden';
import { focusPanelContent } from './panel-focus';

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

/**
 * 面板 type → 最近一次注册它的第三方插件 id(注册消失后据此判断是被禁用还是被卸载)。只增不删:同一 type 的新注册覆盖。
 * popout 子窗里的面板同由主窗 React 经 portal 渲染,共用本模块状态。
 */
const lastPanelOwner = new Map<string, string>();

/**
 * 未注册面板的占位(BDD: dock-plugin-panel-placeholder,对齐 VSCode 卸载扩展后其贡献视图移除):
 * - 所有者插件已卸载(不在插件列表)→ 关闭本面板;
 * - 所有者插件已禁用 → 明确说明并给「启用」;
 * - 其余(插件晚到注册 / 尚在启动 / 失败 / 所有者不明)→ 通用占位。
 */
function PluginPanelPlaceholder({ type, panelApi }: { type: string; panelApi: IDockviewPanelProps['api'] }): React.ReactElement {
  const t = useT();
  const plugins = useUserPluginList();
  const ownerId = lastPanelOwner.get(type);
  const owner = ownerId === undefined ? undefined : plugins.find((p) => p.id === ownerId);
  const uninstalled = ownerId !== undefined && owner === undefined && getUserPluginManager() !== null;
  useEffect(() => {
    if (uninstalled) panelApi.close();
  }, [uninstalled, panelApi]);
  if (owner?.status === 'disabled') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-fg-muted">
        <p>{t('dock.panel.plugin_disabled', { name: owner.manifest.name })}</p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void Promise.resolve(getUserPluginManager()?.enable(owner.id)).catch((err: unknown) => notifyThrownError(err));
          }}
        >
          {t('plugins_tab.btn.enable')}
        </Button>
      </div>
    );
  }
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
    useEffect(() => {
      const ownerId = live ? contributionPluginId(live) : null;
      if (ownerId !== null) lastPanelOwner.set(type, ownerId);
    }, [live]);
    // 同组切换面板回来时保持内容滚动位置(dockview 卸下内容 DOM 会让其归零)。终端不用:xterm 自管视口,隐藏期间
    // 仍有输出,写回旧滚动值会与之打架。BDD: src/__tests__/dock-panel-switch-keep-view/
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const root = rootRef.current;
      if (type === TERMINAL_PANEL_TYPE || root === null) return;
      return keepScrollWhileHidden(root, p.api);
    }, [p.api]);
    return (
      <PanelMount panelId={p.api.id} ref={rootRef}>
        {live ? (
          // 插件面板渲染抛错只在本面板显示错误块(BDD: plugin-render-isolation)。
          // 错误块「禁用插件」/「重载」后焦点交给替换出的内容(占位的「启用」/ 恢复的面板内容)。
          <PluginRenderBoundary key={specKey(live)} owner={live} variant="block" refocus={() => focusPanelContent(p.api)}>
            <FactoryContent spec={live} panelProps={p} />
          </PluginRenderBoundary>
        ) : (
          <PluginPanelPlaceholder type={type} panelApi={p.api} />
        )}
      </PanelMount>
    );
  };
}

// 每个注册 spec 一个稳定 key:占位 ↔ 真实内容、插件 reload 换新 spec 时整体重新挂载 factory 产物。factory 可能直接
// 是用了 hooks 的组件(`factory: MyPanel`,类型允许);若在 PanelHost 里直接调用,切换时 hooks 数量变化 → React 抛
// "Rendered more / fewer hooks"。放进带 key 的子组件,hooks 归属子组件、切换即重挂。
const specKeys = new WeakMap<PanelSpec, number>();
let nextSpecKey = 0;
function specKey(spec: PanelSpec): number {
  let k = specKeys.get(spec);
  if (k === undefined) {
    k = ++nextSpecKey;
    specKeys.set(spec, k);
  }
  return k;
}

function FactoryContent({
  spec,
  panelProps,
}: {
  readonly spec: PanelSpec;
  readonly panelProps: IDockviewPanelProps;
}): React.ReactNode {
  return spec.factory(isThirdPartyContribution(spec) ? toPluginPanelProps(panelProps) : panelProps) as React.ReactNode;
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
