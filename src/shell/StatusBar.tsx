// 底部状态栏(VSCode 风,22px)。
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
    `将终止 ${count} 个 agent terminal 并撤销本次启动期间的授权。\n\n` +
      `已运行的 agent CLI 持有的 token 将立刻 401;新开 terminal 仍可重新授权。\n\n` +
      `确定继续?`,
  );
  if (!confirmed) return;
  // 本地先撤,UI 即时反馈;main 推 sessions_changed 后 sessions 也清空
  useAgentAuthStore.getState().revoke();
  void coApi.agentAuth.revoke();
}

export function StatusBar() {
  const root = useWorkspaceStore((s) => s.root);
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);

  const active = tabs.find((t) => t.id === activeTabId) ?? null;
  const leftItems = useStatusBarItems('left');
  const rightItems = useStatusBarItems('right');

  const agentSessionCount = useMemo(
    () => sessions.filter((s) => s.originHint === 'agent').length,
    [sessions],
  );

  return (
    <footer className="flex h-[22px] shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-[10px] text-fg-dim select-none">
      <div className="flex items-center gap-3 min-w-0">
        {root ? (
          <>
            <span className="truncate" title={root}>
              {basename(root)}
            </span>
            <span className="flex items-center gap-1" title="git 分支(占位)">
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
          <span className="text-fg-dim/60">无工作区</span>
        )}
        {!sidebarOpen && <span className="text-fg-dim/60">侧栏已隐藏</span>}
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
        {agentSessionCount > 0 && (
          <button
            type="button"
            onClick={() => void handleRevokeAgentTerminals(agentSessionCount)}
            title={`终止全部 ${agentSessionCount} 个 agent terminal 并撤销授权`}
            className="flex items-center gap-1 text-accent hover:text-fg transition-colors"
          >
            <span aria-hidden>●</span>
            {agentSessionCount} agent
          </button>
        )}
        {active ? (
          <>
            <span className="truncate max-w-[280px]" title={active.filePath ?? '未命名'}>
              {active.filePath ? basename(active.filePath) : '未命名'}
              {active.dirty && <span className="ml-1 text-fg-muted">●</span>}
            </span>
            <span>
              {lineCount(active.content)} 行 · {wordCount(active.content)} 词 ·{' '}
              {charCount(active.content)} 字符
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
