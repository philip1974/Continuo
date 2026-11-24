import { useCallback, useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useShallow } from 'zustand/react/shallow';
import { Spinner } from '@/design';
import {
  getIndexedTerminalSessionById,
  useTerminalStore,
} from '@/stores/terminal.store';
import { useTerminal } from './useTerminal';
import { useTerminalDragDrop } from './useTerminalDragDrop';
import { registerTerminalPanelHandles } from './terminal-panel-handles';
import { TerminalSearchBar } from './TerminalSearchBar';
import { TerminalContextMenu } from './TerminalContextMenu';
import { useT } from '@/i18n';
import type { OriginHint } from '../../../electron/shared/origin-hint';
import { terminalPanelTitle } from '@/shell/dock/terminal-panel-id';

export interface TerminalPanelViewParams {
  sessionId: string;
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
  const { sessionExists, sessionTitle, sessionOriginHint, sessionExited } = useTerminalStore(
    useShallow((s) => {
      const found = getIndexedTerminalSessionById(s.sessions, sessionId);
      return {
        sessionExists: found !== undefined,
        sessionTitle: found?.title,
        sessionOriginHint: found?.originHint,
        sessionExited: found !== undefined && found.exitCode !== null,
      };
    }),
  );
  // 每次渲染直接算(便宜的字符串拼接):useT 已订阅 locale,「(已退出)」后缀随语言切换重算。
  const derivedTitle = terminalPanelTitle({
    sessionId,
    sessionTitle,
    originHint: sessionOriginHint ?? props.params.originHint,
    exited: sessionExited,
  });

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
  // 进程非 0 退出后「按任意键关闭」:走面板关闭的公共路径(关闭动画 + 删会话)。
  const onExitDismiss = useCallback(() => api.close(), [api]);
  const { containerRef, isReady, fit, requestFit, focus, clear, readText, contextMenuActions, searchApi } =
    useTerminal(sessionId, { onExitDismiss });
  const { ref: dropZoneRef } = useTerminalDragDrop({ sessionId, focus, api });

  // 对外句柄:focus 供 DockShell 在 exit-maximize 后拉回 xterm 焦点(topic-22:
  // 同一 panel 已 active 时 onDidActiveChange 不会再触发);openSearch 供
  // terminal.search.toggle command 打开搜索条;clear 供 terminal.clear command 清屏。
  useEffect(() => {
    return registerTerminalPanelHandles(api.id, { focus, openSearch: searchApi.open, clear, readText });
  }, [api.id, focus, searchApi.open, clear, readText]);

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
    // 尺寸连续变化(分栏拖拽)走防抖入口;激活 / 显隐走立即 fit。
    // 性能:dockview splitview.layoutViews 对每个视图先写 style 再同步调 layout() → 同步派发本事件;
    // 若此刻 fit(proposeDimensions 内 getComputedStyle 读脏布局)= 强制同步回流,且多视图写-读交错。
    // 合并到下一帧只 request 一次(容器 RO 在主窗口通常也会覆盖;保留本事件兜底 popout 等 RO 不可靠场景)。
    let dimensionsRaf = 0;
    const dimensionsDisposable = api.onDidDimensionsChange(() => {
      if (dimensionsRaf) return;
      dimensionsRaf = requestAnimationFrame(() => {
        dimensionsRaf = 0;
        requestFit();
      });
    });
    const visibilityDisposable = api.onDidVisibilityChange((event) => {
      if (event.isVisible) tryFit();
    });

    return () => {
      cancelAnimationFrame(raf);
      if (dimensionsRaf) cancelAnimationFrame(dimensionsRaf);
      activeDisposable.dispose();
      dimensionsDisposable.dispose();
      visibilityDisposable.dispose();
    };
  }, [api, fit, requestFit, focus]);

  return (
    <div
      ref={dropZoneRef}
      data-terminal-drop-zone={sessionId}
      className="relative h-full w-full bg-canvas"
    >
      <TerminalContextMenu actions={contextMenuActions}>
        <div className="h-full w-full bg-canvas px-2 py-1">
          <div
            ref={containerRef}
            data-testid="terminal-panel-view-xterm-host"
            className="h-full w-full overflow-x-hidden"
            style={{ minHeight: 0 }}
          />
        </div>
      </TerminalContextMenu>
      {searchApi.isOpen && (
        <TerminalSearchBar searchApi={searchApi} onClose={searchApi.close} />
      )}
      {!isReady && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]">
          {/* a11y(A103,A102 同族):启动 overlay 具体文本须 role=status 播报,Spinner aria-hidden
              抑制泛化 Loading。 */}
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
