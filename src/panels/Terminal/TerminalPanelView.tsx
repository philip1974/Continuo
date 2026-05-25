import { useEffect, useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Spinner } from '@/design';
import { useTerminalStore } from '@/stores/terminal.store';
import { useTerminal } from './useTerminal';
import { useTerminalDragDrop } from './useTerminalDragDrop';
import { registerTerminalFocus } from './terminal-focus-registry';
import { useT } from '@/i18n';
import type { OriginHint } from '../../../electron/shared/origin-hint';

export interface TerminalPanelViewParams {
  sessionId: string;
  cwd?: string;
  title?: string;
  originHint?: OriginHint;
}

export function TerminalPanelView(
  props: IDockviewPanelProps<TerminalPanelViewParams>,
) {
  const { sessionId } = props.params;
  // stale persisted layout (旧 BSP 模型 / sanitizer 漏过) 可能 restore 出
  // params.sessionId 缺失的 terminal panel,直接 auto-close 而非 crash。
  useEffect(() => {
    if (!sessionId) {
      console.warn(
        '[terminal-panel] panel mounted without sessionId; auto-closing',
        props.api.id,
      );
      props.api.close();
    }
  }, [sessionId, props.api]);
  const session = useTerminalStore((s) =>
    s.sessions.find((x) => x.id === sessionId),
  );
  const customTitle = useTerminalStore((s) => s.customTitles.get(sessionId));
  const derivedTitle = useMemo(() => {
    const base =
      customTitle ??
      session?.title ??
      props.params.title ??
      `Terminal ${(sessionId ?? '').slice(0, 6) || '?'}`;
    const originHint = session?.originHint ?? props.params.originHint;
    return originHint === 'agent' ? `${base} (agent)` : base;
  }, [
    customTitle,
    props.params.originHint,
    props.params.title,
    session?.originHint,
    session?.title,
    sessionId,
  ]);

  useEffect(() => {
    if (props.api.title !== derivedTitle) {
      props.api.setTitle(derivedTitle);
    }
  }, [derivedTitle, props.api]);

  if (!sessionId) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas text-xs text-fg-dim">
        terminal panel without sessionId (auto-closing)
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas text-xs text-fg-dim">
        session not available
      </div>
    );
  }

  return <TerminalPanelContent api={props.api} sessionId={sessionId} />;
}

function TerminalPanelContent({
  api,
  sessionId,
}: {
  api: IDockviewPanelProps<TerminalPanelViewParams>['api'];
  sessionId: string;
}) {
  const t = useT();
  const { containerRef, isReady, fit, focus } = useTerminal(sessionId);
  const dragDrop = useTerminalDragDrop({ sessionId, focus });

  // topic-22: register focus callback so DockShell can pull focus back to
  // xterm after onDidMaximizedGroupChange (exit-maximize doesn't re-fire
  // onDidActiveChange when the same panel was already active).
  useEffect(() => {
    return registerTerminalFocus(api.id, focus);
  }, [api.id, focus]);

  useEffect(() => {
    // agent 创建的 panel 走 inactive: true(P1-1 不抢 focus),
    // dockview 此时容器可能 0×0 或隐藏 → useTerminal 内的初次 fit 拿不到尺寸
    // → 用户点击切到 active 前 xterm 一直是空。
    // 显隐切换(onDidVisibilityChange)与初次 raf 都重 fit 一次,确保容器
    // 有真实尺寸时刷一遍 cols/rows + 通知 main resize。
    const tryFit = () => fit();
    const raf = requestAnimationFrame(tryFit);

    const activeDisposable = api.onDidActiveChange((event) => {
      // topic-22: active 时同时 focus + fit。focus 是 stale-safe
      // (termRef.current?.focus()),unmount 后自动 no-op。
      if (event.isActive) {
        tryFit();
        focus();
      }
    });
    const dimensionsDisposable = api.onDidDimensionsChange(tryFit);
    const visibilityDisposable = api.onDidVisibilityChange((event) => {
      if (event.isVisible) tryFit();
    });

    return () => {
      cancelAnimationFrame(raf);
      activeDisposable.dispose();
      dimensionsDisposable.dispose();
      visibilityDisposable.dispose();
    };
  }, [api, fit, focus]);

  return (
    <div className="relative h-full w-full bg-canvas" {...dragDrop}>
      <div className="h-full w-full bg-canvas px-2 py-1">
        <div
          ref={containerRef}
          data-testid="terminal-panel-view-xterm-host"
          className="h-full w-full overflow-x-hidden"
          style={{ minHeight: 0 }}
        />
      </div>
      {!isReady && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]"
          aria-label={t('panels.terminal.aria.start_shell')}
        >
          <div className="flex items-center gap-2 text-xs text-fg-dim">
            <Spinner size="sm" />
            <span>{t('panels.terminal.starting_shell')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
