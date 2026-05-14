import { useCallback, useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Button, IconButton } from '@/design';
import { coApi } from '@/lib/co-api';
import { useTerminalStore } from '@/stores/terminal.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useTheme } from '@/theme';
import { TerminalPanelView, type TerminalPanelViewParams } from './TerminalPanelView';
import { TerminalView } from './TerminalView';

export type TerminalPanelParams = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  originHint?: 'user' | 'agent';
};

function themedTerminalEnv(resolved: 'light' | 'dark'): Record<string, string> {
  return { COLORFGBG: resolved === 'dark' ? '15;0' : '0;15' };
}

export function TerminalPanel(
  props?: IDockviewPanelProps<TerminalPanelParams>,
) {
  if (props?.api && props.params?.sessionId) {
    return (
      <TerminalPanelView
        {...(props as IDockviewPanelProps<TerminalPanelViewParams>)}
        params={{
          ...props.params,
          sessionId: props.params.sessionId,
        }}
      />
    );
  }
  return <LegacyTerminalPanel />;
}

function LegacyTerminalPanel() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const replaceSnapshot = useTerminalStore((s) => s.replaceSnapshot);
  const setActive = useTerminalStore((s) => s.setActive);
  const workspaceRoot = useWorkspaceStore((s) => s.root);
  const { resolved } = useTheme();

  useEffect(() => {
    let cancelled = false;
    void coApi.terminal.listSessions().then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data?.sessions)) {
        replaceSnapshot(r.data.sessions);
      }
    });
    const unsub = coApi.terminal.onSessionsChanged((snapshot) => {
      replaceSnapshot(snapshot);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [replaceSnapshot]);

  const handleNew = useCallback(async () => {
    const cwd = workspaceRoot ?? undefined;
    const r = await coApi.terminal.create({
      cwd,
      env: themedTerminalEnv(resolved),
      ...(workspaceRoot !== null ? { workspaceRoot } : {}),
    });
    if (!r.ok) {
      console.warn('[terminal] create failed:', r.code, r.message);
      alert(`新建终端失败:[${r.code}] ${r.message}`);
      return;
    }
    setActive(r.data.id);
  }, [resolved, setActive, workspaceRoot]);

  const handleClose = useCallback((id: string) => {
    void coApi.terminal.remove(id);
  }, []);

  const activeSessionId = activeId ?? sessions[0]?.id ?? null;

  return (
    <div className="terminal-panel flex h-full w-full flex-col overflow-hidden bg-canvas text-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
        <Button
          size="sm"
          variant="secondary"
          aria-label="新建终端"
          onClick={handleNew}
        >
          + 新建终端
        </Button>
        {sessions.map((session) => (
          <div
            key={session.id}
            className="flex items-center gap-1 text-xs text-fg-muted"
          >
            <Button
              size="sm"
              variant={session.id === activeSessionId ? 'secondary' : 'ghost'}
              onClick={() => setActive(session.id)}
            >
              {session.title}
            </Button>
            <IconButton
              size="xs"
              aria-label={`关闭终端 ${session.title}`}
              onClick={() => handleClose(session.id)}
            >
              ×
            </IconButton>
          </div>
        ))}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {sessions.length === 0 ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <div>无活跃终端</div>
            <Button
              size="sm"
              variant="secondary"
              aria-label="新建终端"
              onClick={handleNew}
            >
              + 新建终端
            </Button>
          </div>
        ) : (
          sessions.map((session) => {
            const active = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                className="absolute inset-0"
                style={{
                  visibility: active ? 'visible' : 'hidden',
                  pointerEvents: active ? 'auto' : 'none',
                }}
                aria-hidden={active ? undefined : true}
              >
                <TerminalView termId={session.id} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function filterTabsByWorkspace<
  T extends { id: string; workspaceRoot?: string },
>(
  tabs: readonly T[],
  activeTabId: string | null,
  currentWorkspaceRoot: string | undefined,
): { visibleTabs: T[]; effectiveActiveId: string | null } {
  const visibleTabs = tabs.filter(
    (t) =>
      t.workspaceRoot === undefined || t.workspaceRoot === currentWorkspaceRoot,
  );
  const visibleIds = new Set(visibleTabs.map((t) => t.id));
  const effectiveActiveId =
    activeTabId !== null && visibleIds.has(activeTabId)
      ? activeTabId
      : visibleTabs[0]?.id ?? null;
  return { visibleTabs, effectiveActiveId };
}
