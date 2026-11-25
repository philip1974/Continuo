// 第三方插件贡献界面的局部错误边界(BDD: src/__tests__/plugin-render-isolation/)。
//
// 插件的状态栏项 / 面板 / 设置页 / 各处 icon 在宿主 React 树里渲染;没有局部边界时,任一插件组件渲染抛错一路冒泡到
// 根,整个主窗白屏(状态栏项每次启动都渲染 → 每次启动都白屏)。对齐 VSCode:扩展出错不拖垮工作台,只有出错的视图
// 就地显示错误。模式同 EditorEngineErrorBoundary;接住后按贡献的所有者上报 PluginManager(标 failed,通知由
// plugin-failure-notify 统一出口去重发一次)。内置插件(`core:`)贡献不包。

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/design';
import { useT } from '@/i18n';
import { notifyThrownError } from '@/notifications/notify-thrown-error';
import { getUserPluginManager } from './PluginManager';
import { contributionPluginId, isThirdPartyContribution } from './scoped-app';
import { useUserPluginList } from './use-user-plugin-list';

type Variant = 'inline' | 'block';

interface Props {
  /** 注册表里的贡献 spec(或 decorator 函数):据此判断是否第三方、归属哪个插件;换新对象(重新注册)即复位。 */
  readonly owner: object;
  /** inline:状态栏项 / 图标位,紧凑错误图标;block:面板 / 设置页,带「禁用插件」「重载」的错误块。 */
  readonly variant: Variant;
  readonly children?: ReactNode;
}

interface BoundaryProps extends Props {
  readonly pluginId: string | null;
}

interface State {
  readonly failed: boolean;
  readonly owner: object;
}

class Boundary extends Component<BoundaryProps, State> {
  override state: State = { failed: false, owner: this.props.owner };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  // 同一渲染位换了新 spec(插件重载 / 重新启用后重新注册)→ 复位,渲染新贡献。
  static getDerivedStateFromProps(props: BoundaryProps, state: State): Partial<State> | null {
    return props.owner === state.owner ? null : { failed: false, owner: props.owner };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[plugin] ${this.props.pluginId ?? '(unknown)'} contribution failed to render`, error, info.componentStack);
    if (this.props.pluginId !== null) getUserPluginManager()?.markRenderFailed(this.props.pluginId, error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <RenderErrorFallback pluginId={this.props.pluginId} variant={this.props.variant} />;
  }
}

export function PluginRenderBoundary({ owner, variant, children }: Props): ReactNode {
  if (!isThirdPartyContribution(owner)) return children;
  return (
    <Boundary owner={owner} variant={variant} pluginId={contributionPluginId(owner)}>
      {children}
    </Boundary>
  );
}

// lucide circle-alert 字形
const ERROR_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </svg>
);

function RenderErrorFallback({ pluginId, variant }: { pluginId: string | null; variant: Variant }) {
  const t = useT();
  const plugins = useUserPluginList();
  const name = pluginId === null ? null : (plugins.find((p) => p.id === pluginId)?.manifest.name ?? pluginId);
  const message =
    name === null ? t('plugins_tab.render_error.unknown') : t('plugins_tab.render_error.title', { name });
  if (variant === 'inline') {
    return (
      <span role="img" aria-label={message} title={message} className="inline-flex shrink-0 items-center text-error">
        {ERROR_ICON}
      </span>
    );
  }
  const run = (op: (id: string) => Promise<unknown> | undefined) => () => {
    if (pluginId === null) return;
    void Promise.resolve(op(pluginId)).catch((err: unknown) => notifyThrownError(err));
  };
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-muted">
      <p className="flex items-center gap-2 text-error">
        {ERROR_ICON}
        <span>{message}</span>
      </p>
      {pluginId !== null && (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={run((id) => getUserPluginManager()?.disable(id))}>
            {t('plugins_tab.btn.disable_plugin')}
          </Button>
          <Button variant="secondary" size="sm" onClick={run((id) => getUserPluginManager()?.reload(id))}>
            {t('plugins_tab.btn.reload')}
          </Button>
        </div>
      )}
    </div>
  );
}
