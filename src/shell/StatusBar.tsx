// 底部状态栏(VSCode 风,24px,参考 stitch_desktop_design_reviewer)。
// 左:workspace 名 + sidebar 收起提示 + git 分支占位。
// 右:active editor tab 文件名 + dirty + 行 / 词 / 字符 + 编码占位。

import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { useAgentAuthStore } from '@/stores/agent-auth.store';
import { coApi } from '@/lib/co-api';
import { charCount, lineCount, wordCount } from '@/lib/text-stats';
import { coApp } from '@/plugins/co-app';
import type { StatusBarItemSpec } from '@/plugins/registries/StatusBarRegistry';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { useT, t as translate } from '@/i18n';

function basename(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

function useStatusBarItems(side: 'left' | 'right'): readonly StatusBarItemSpec[] {
  const [snap, setSnap] = useState(() => coApp.statusBar.getBySide(side));
  useEffect(
    () => coApp.statusBar.subscribe(() => setSnap(coApp.statusBar.getBySide(side))),
    [side],
  );
  return snap;
}

async function handleRevokeAgentTerminals(count: number): Promise<void> {
  if (count <= 0) return;
  const confirmed = window.confirm(
    translate('permissions.revoke_all.confirm', { count }),
  );
  if (!confirmed) return;
  // 本地先撤,UI 即时反馈;main 推 sessions_changed 后 sessions 也清空
  useAgentAuthStore.getState().revoke();
  void coApi.agentAuth.revoke();
}

async function handleCopyMcpConfig(): Promise<'ok' | 'unavailable' | 'fail'> {
  const r = await coApi.mcp.getStdioConfig();
  if (!r.ok) return 'fail';
  if (!r.data.available || !r.data.claudeAddCommand) return 'unavailable';
  try {
    // PROD 下 sandboxSweep 已涂掉 navigator.clipboard,必须走 cached raw ref
    await getCachedClipboard().writeText(r.data.claudeAddCommand);
    return 'ok';
  } catch {
    return 'fail';
  }
}

export function StatusBar() {
  const t = useT();
  const root = useWorkspaceStore((s) => s.root);
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);

  const active = tabs.find((tb) => tb.id === activeTabId) ?? null;
  const leftItems = useStatusBarItems('left');
  const rightItems = useStatusBarItems('right');

  const agentSessionCount = useMemo(
    () => sessions.filter((s) => s.originHint === 'agent').length,
    [sessions],
  );

  const [mcpCopyState, setMcpCopyState] = useState<
    'idle' | 'ok' | 'unavailable' | 'fail'
  >('idle');
  const onCopyMcp = async () => {
    const r = await handleCopyMcpConfig();
    setMcpCopyState(r);
    setTimeout(() => setMcpCopyState('idle'), 1500);
  };
  const mcpLabel =
    mcpCopyState === 'ok'
      ? t('statusbar.mcp.copied')
      : mcpCopyState === 'unavailable'
        ? t('statusbar.mcp.unavailable')
        : mcpCopyState === 'fail'
          ? t('statusbar.mcp.copy_failed')
          : t('statusbar.mcp.copy');

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-2xs text-fg-dim select-none">
      <div className="flex items-center gap-3 min-w-0">
        {root ? (
          <>
            <span className="truncate" title={root}>
              {basename(root)}
            </span>
            <span
              className="flex items-center gap-1"
              title={t('statusbar.git_branch_placeholder')}
            >
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                <path
                  d="M5 3v10M11 3v3a2 2 0 01-2 2H5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  fill="none"
                />
                <circle cx="5" cy="3" r="1.4" fill="currentColor" />
                <circle cx="11" cy="3" r="1.4" fill="currentColor" />
                <circle cx="5" cy="13" r="1.4" fill="currentColor" />
              </svg>
              main
            </span>
          </>
        ) : (
          <span className="text-fg-dim/60">{t('statusbar.no_workspace')}</span>
        )}
        {!sidebarOpen && (
          <span className="text-fg-dim/60">{t('statusbar.sidebar_hidden')}</span>
        )}
        {/* 插件贡献的左侧 statusBar items */}
        {leftItems.map((item) => (
          <span key={item.id}>{item.render()}</span>
        ))}
      </div>
      <div className="flex items-center gap-3">
        {/* 插件贡献的右侧 statusBar items(在内置项左边) */}
        {rightItems.map((item) => (
          <span key={item.id}>{item.render()}</span>
        ))}
        <button
          type="button"
          onClick={() => void onCopyMcp()}
          title={t('statusbar.mcp.tooltip')}
          className="text-fg-dim hover:text-fg transition-colors"
        >
          {mcpLabel}
        </button>
        {agentSessionCount > 0 && (
          <button
            type="button"
            onClick={() => void handleRevokeAgentTerminals(agentSessionCount)}
            title={t('statusbar.mcp.revoke_tooltip', { count: agentSessionCount })}
            className="flex items-center gap-1 text-accent hover:text-fg transition-colors"
          >
            <span aria-hidden>●</span>
            {agentSessionCount} agent
          </button>
        )}
        {active ? (
          <>
            <span
              className="truncate max-w-[280px]"
              title={active.filePath ?? t('statusbar.untitled_file')}
            >
              {active.filePath
                ? basename(active.filePath)
                : t('statusbar.untitled_file')}
              {active.dirty && <span className="ml-1 text-fg-muted">●</span>}
            </span>
            <span>
              {t('statusbar.editor_stats', {
                lines: lineCount(active.content),
                words: wordCount(active.content),
                chars: charCount(active.content),
              })}
            </span>
            <span>UTF-8</span>
            <span>LF</span>
          </>
        ) : (
          <span>UTF-8</span>
        )}
      </div>
    </footer>
  );
}
