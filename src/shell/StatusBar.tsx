// 底部状态栏(VSCode 风,24px,参考 stitch_desktop_design_reviewer)。
// 左:workspace 名 + sidebar 收起提示 + git 分支占位。
// 右:active editor tab 文件名 + dirty + 行 / 词 / 字符 + 编码占位。

import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { useAgentAuthStore } from '@/stores/agent-auth.store';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { charCount, lineCount, wordCount } from '@/lib/text-stats';
import { coApp } from '@/plugins/co-app';
import type { StatusBarItemSpec } from '@/plugins/registries/StatusBarRegistry';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { useT, t as translate } from '@/i18n';
import { basenameForChrome } from './path-label';

// 一次订阅取全量(已按 priority 排序),再分侧(打磨 R6)。原先 left/right 各
// useRegistry 一次 = 两个订阅回调 + 两次 getBySide(Array.from+filter+sort)。
// getAll() 全局按 priority 排序,filter 保序 → 与 getBySide(side) 输出等价。
function splitBySide(items: readonly StatusBarItemSpec[], side: 'left' | 'right') {
  return items.filter((it) => it.side === side);
}

async function handleRevokeAgentTerminals(count: number): Promise<void> {
  if (count <= 0) return;
  const confirmed = window.confirm(
    translate('permissions.revoke_all.confirm', { count }),
  );
  if (!confirmed) return;
  // 本地先撤,UI 即时反馈;main 推 sessions_changed 后 sessions 也清空。
  const wasGranted = useAgentAuthStore.getState().sessionGranted;
  useAgentAuthStore.getState().revoke();
  // 闭环:revoke IPC(kill PTY + rotate token)可能失败(revokeAndKillAgentSessions 抛错 →
  // safeHandle 返 ok:false / IPC reject)。旧实现 `void` 完全忽略结果 → 失败被静默伪成功:
  // UI 显示已撤销但 main 的 agent PTY/token 仍存活,是安全相关谎报(用户以为已断开实际没有)。
  // 该 IPC 本就设计返回 {killed,rotated} 供 renderer 反馈。失败 → 回滚本地授权态 + 弹错误,
  // 让用户知道并重试。(codex 复审 loop R18)
  try {
    const r = await coApi.agentAuth.revoke();
    if (!r.ok) throw new Error(r.code ?? 'revoke failed');
  } catch (err) {
    if (wasGranted) useAgentAuthStore.setState({ sessionGranted: true });
    notify.error(translate('permissions.revoke_all.failed'), {
      code: (err as { code?: string })?.code,
    });
  }
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
  // 只订阅派生的 agent 计数(打磨 R39,延续 R22/R24):终端标题/退出状态/普通
  // 用户终端变化不影响 agent 数 → number 不变 → StatusBar 不重渲。
  const agentSessionCount = useTerminalStore(
    (s) => s.sessions.filter((x) => x.originHint === 'agent').length,
  );

  // 只订阅 active tab 的派生 primitive(打磨 R24 + 合并优化 R46)。非 active tab 的
  // content / originalContent / reloadEpoch 变化不触发状态栏重渲;active 内容变化
  // 仍更新统计(配合 R1 的统计 memo)。R24 用 4 个 selector 各 some/find;R46 合并为
  // 单次 find 返回**扁平 primitive 对象**,useShallow 逐字段 Object.is 比较——content
  // 只是 string ref(不像 EditorHeader 用 JSON 签名,这里避免序列化大文档正文)。
  const { hasActiveTab, activeFilePath, activeDirty, activeContent } =
    useEditorStore(
      useShallow((s) => {
        const found = s.tabs.find((tb) => tb.id === s.activeTabId);
        return {
          hasActiveTab: found !== undefined,
          activeFilePath: found?.filePath ?? null,
          activeDirty: found?.dirty ?? false,
          activeContent: found?.content,
        };
      }),
    );
  const statusItems = useRegistry(coApp.statusBar);
  const leftItems = useMemo(
    () => splitBySide(statusItems, 'left'),
    [statusItems],
  );
  const rightItems = useMemo(
    () => splitBySide(statusItems, 'right'),
    [statusItems],
  );

  // 行/词/字符统计按 active 内容 memo 化(codex 打磨 R1)。lineCount/wordCount
  // 会全文扫描并分配中间数组;StatusBar 因 sessions / MCP 复制态 / 插件 status
  // item 等无关变化频繁重渲染,无 memo 时每次都重扫整篇。dep 只用 activeContent
  // 字符串值:内容编辑 → 变 → 重算;无关重渲染 → 不变 → 命中缓存。
  const stats = useMemo(
    () =>
      activeContent === undefined
        ? null
        : {
            lines: lineCount(activeContent),
            words: wordCount(activeContent),
            chars: charCount(activeContent),
          },
    [activeContent],
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
              {basenameForChrome(root)}
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
        {hasActiveTab ? (
          <>
            <span
              className="truncate max-w-[280px]"
              title={activeFilePath ?? t('statusbar.untitled_file')}
            >
              {activeFilePath
                ? basenameForChrome(activeFilePath)
                : t('statusbar.untitled_file')}
              {activeDirty && <span className="ml-1 text-fg-muted">●</span>}
            </span>
            <span>
              {t('statusbar.editor_stats', {
                lines: stats?.lines ?? 0,
                words: stats?.words ?? 0,
                chars: stats?.chars ?? 0,
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
