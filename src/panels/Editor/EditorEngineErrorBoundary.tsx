// 编辑引擎(CodeEditor / MilkdownEditor lazy chunk)的局部错误边界(perf E2 复审 #3)。
//
// 引擎 chunk 加载失败(缺失/损坏/HMR 失配)会作为渲染错误抛出;没有局部边界时一路冒泡到
// 根节点,整个窗口崩掉。这里只接住引擎区:显示可见错误 + 重试,面板其余部分(tab 栏、模式
// 切换)照常可用。重试由父级新建 lazy 实例并换 key 重挂本边界 —— React.lazy 会永久缓存首个
// rejection,复用旧实例永远失败。

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/design';
import { t as translate } from '@/i18n';

type Props = {
  readonly onRetry: () => void;
  readonly children: ReactNode;
};

type State = { readonly failed: boolean };

export class EditorEngineErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[editor] engine failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // 文案随 locale:父级 EditorPanel 订阅 locale,重渲时本组件随之重渲。
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-fg-muted"
      >
        <p>{translate('panels.editor.engine_load_failed')}</p>
        <Button variant="secondary" size="sm" onClick={this.props.onRetry}>
          {translate('panels.editor.engine_load_retry')}
        </Button>
      </div>
    );
  }
}
