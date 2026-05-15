import { useEffect, useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Spinner } from '@/design';
import { useTerminalStore } from '@/stores/terminal.store';
import { useTerminal } from './useTerminal';

export interface TerminalPanelViewParams {
  sessionId: string;
  cwd?: string;
  title?: string;
  originHint?: 'user' | 'agent';
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
  const { containerRef, isReady, fit } = useTerminal(sessionId, undefined);

  useEffect(() => {
    const activeDisposable = api.onDidActiveChange((event) => {
      if (event.isActive) fit();
    });
    const dimensionsDisposable = api.onDidDimensionsChange(() => fit());

    return () => {
      activeDisposable.dispose();
      dimensionsDisposable.dispose();
    };
  }, [api, fit]);

  return (
    <div className="relative h-full w-full bg-canvas">
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
          aria-label="Terminal shell starting"
        >
          <div className="flex items-center gap-2 text-xs text-fg-dim">
            <Spinner size="sm" />
            <span>启动 shell...</span>
          </div>
        </div>
      )}
    </div>
  );
}
