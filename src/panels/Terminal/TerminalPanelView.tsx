import { useEffect, useMemo, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useShallow } from 'zustand/react/shallow';
import { Spinner } from '@/design';
import {
  getIndexedTerminalSessionById,
  useTerminalStore,
} from '@/stores/terminal.store';
import { useTerminal } from './useTerminal';
import { useTerminalDragDrop } from './useTerminalDragDrop';
import { registerTerminalFocus } from './terminal-focus-registry';
import { registerTerminalSearch } from './terminal-search-registry';
import { TerminalSearchBar } from './TerminalSearchBar';
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
  const t = useT();
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
  // 只订阅派生 primitive(打磨 R40 + R43 + P16):dock title 只需 title / originHint /
  // 是否存在。复用 terminal.store 的 sessionId 索引缓存,多终端面板收到同一 snapshot 时只
  // 为 sessions 引用建一次 Map;再用 useShallow 比较扁平 primitive,避免 JSON 签名串分配/解析。
  const { sessionExists, sessionTitle, sessionOriginHint } = useTerminalStore(
    useShallow((s) => {
      const found = getIndexedTerminalSessionById(s.sessions, sessionId);
      return {
        sessionExists: found !== undefined,
        sessionTitle: found?.title,
        sessionOriginHint: found?.originHint,
      };
    }),
  );
  const customTitle = useTerminalStore((s) => s.customTitles.get(sessionId));
  const derivedTitle = useMemo(() => {
    const base =
      customTitle ??
      sessionTitle ??
      props.params.title ??
      `Terminal ${(sessionId ?? '').slice(0, 6) || '?'}`;
    const originHint = sessionOriginHint ?? props.params.originHint;
    return originHint === 'agent' ? `${base} (agent)` : base;
  }, [
    customTitle,
    props.params.originHint,
    props.params.title,
    sessionOriginHint,
    sessionTitle,
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
        {t('panels.terminal.missing_session_id')}
      </div>
    );
  }
  if (!sessionExists) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas text-xs text-fg-dim">
        {t('panels.terminal.session_not_available')}
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
  const { containerRef, isReady, fit, focus, searchApi } =
    useTerminal(sessionId);
  const { ref: dropZoneRef } = useTerminalDragDrop({ sessionId, focus, api });

  // topic-22: register focus callback so DockShell can pull focus back to
  // xterm after onDidMaximizedGroupChange (exit-maximize doesn't re-fire
  // onDidActiveChange when the same panel was already active).
  useEffect(() => {
    return registerTerminalFocus(api.id, focus);
  }, [api.id, focus]);

  useEffect(() => {
    const disposable = registerTerminalSearch(api.id, searchApi.open);
    return () => disposable.dispose();
  }, [api.id, searchApi.open]);

  // issue #38 R2: ref-capture latest searchApi.isOpen so the
  // onDidActiveChange handler reads fresh value without re-creating
  // dockview disposables on every search open/close.
  const searchOpenRef = useRef(searchApi.isOpen);
  searchOpenRef.current = searchApi.isOpen;

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
      // issue #38 R2: SearchBar 打开时不抢焦点回 xterm,否则用户点 input 输
      // 入框时,dockview 把 panel 再次标记 active,我们这里 focus() 强行把
      // xterm textarea 拉成 activeElement,Input 拿不到焦点。
      if (event.isActive) {
        tryFit();
        if (!searchOpenRef.current) focus();
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
    <div
      ref={dropZoneRef}
      data-terminal-drop-zone={sessionId}
      className="relative h-full w-full bg-canvas"
    >
      <div className="h-full w-full bg-canvas px-2 py-1">
        <div
          ref={containerRef}
          data-testid="terminal-panel-view-xterm-host"
          className="h-full w-full overflow-x-hidden"
          style={{ minHeight: 0 }}
        />
      </div>
      {searchApi.isOpen && (
        <TerminalSearchBar searchApi={searchApi} onClose={searchApi.close} />
      )}
      {!isReady && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]">
          {/* a11y(A103,A102 同族):启动 overlay 具体文本须 role=status 播报,Spinner aria-hidden
              抑制泛化 Loading(TerminalView 的兄弟入口,同 overlay 模式)。 */}
          <div
            role="status"
            className="flex items-center gap-2 text-xs text-fg-dim"
          >
            <Spinner size="sm" aria-hidden />
            <span>{t('panels.terminal.starting_shell')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
