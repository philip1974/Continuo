// 底部状态栏(VSCode 风,24px,参考 stitch_desktop_design_reviewer)。
// 左:workspace 名 + sidebar 收起提示 + git 分支占位。
// 右:active editor tab 文件名 + dirty + 行 / 词 / 字符 + 编码占位。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';
import { useAgentAuthStore } from '@/stores/agent-auth.store';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { computeTextStats } from '@/lib/text-stats';
import { coApp } from '@/plugins/co-app';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import type { StatusBarItemSpec } from '@/plugins/registries/StatusBarRegistry';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { useT, t as translate } from '@/i18n';
import { basenameForChrome } from './path-label';

const EMPTY_STATUS_ITEMS: readonly StatusBarItemSpec[] = [];
const EMPTY_STATUS_SPLIT = {
  left: EMPTY_STATUS_ITEMS,
  right: EMPTY_STATUS_ITEMS,
};
const GIT_BRANCH_ICON = (
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
);

// 一次订阅取全量(已按 priority 排序),再分侧(打磨 R6)。原先 left/right 各
// useRegistry 一次 = 两个订阅回调 + 两次 getBySide(Array.from+filter+sort)。
// getAll() 全局按 priority 排序,filter 保序 → 与 getBySide(side) 输出等价。
export function splitStatusItemsBySide(items: readonly StatusBarItemSpec[]): {
  readonly left: readonly StatusBarItemSpec[];
  readonly right: readonly StatusBarItemSpec[];
} {
  if (items.length === 0) return EMPTY_STATUS_SPLIT;
  if (items.length === 1) {
    return items[0]!.side === 'left'
      ? { left: items, right: EMPTY_STATUS_ITEMS }
      : { left: EMPTY_STATUS_ITEMS, right: items };
  }
  const firstSide = items[0]!.side;
  let allSameSide = true;
  for (let i = 1; i < items.length; i++) {
    if (items[i]!.side !== firstSide) {
      allSameSide = false;
      break;
    }
  }
  if (allSameSide) {
    return firstSide === 'left'
      ? { left: items, right: EMPTY_STATUS_ITEMS }
      : { left: EMPTY_STATUS_ITEMS, right: items };
  }

  const left = new Array<StatusBarItemSpec>(items.length);
  const right = new Array<StatusBarItemSpec>(items.length);
  let leftCount = 0;
  let rightCount = 0;
  for (const item of items) {
    if (item.side === 'left') {
      left[leftCount] = item;
      leftCount += 1;
    } else {
      right[rightCount] = item;
      rightCount += 1;
    }
  }
  left.length = leftCount;
  right.length = rightCount;
  return { left, right };
}

// race(R56,R55 同族):渲染时按 id 从 live coApp.statusBar 复查再调 render(),而非调订阅快照里
// 缓存的 item.render。快照(useRegistry useState 订阅)滞后 registry 一帧,item 刚 unregister 时
// 快照仍含它 → 会执行已卸载插件的 render。复查使死 item 跳过(返 null);同时 try/catch 隔离单个
// 插件 item 的 render 同步抛错,不连累整条状态栏。
function liveRenderStatusItem(item: StatusBarItemSpec): React.ReactNode {
  const live = coApp.statusBar.get(item.id);
  if (!live) return null;
  try {
    return live.render();
  } catch (err) {
    console.warn(`[statusbar] item "${item.id}" render threw`, err);
    return null;
  }
}

export function countAgentSessions(sessions: readonly TerminalSession[]): number {
  let count = 0;
  for (const session of sessions) {
    if (session.originHint === 'agent') {
      count += 1;
    }
  }
  return count;
}

// race(R92):revoke 代际。两次 revoke 并发时,失败回滚必须只由「最新」那次执行 —— 否则先发的
// 迟到失败会用其调用开始时的旧 wasGranted 快照把 sessionGranted 回滚成 true,覆盖后发已成功撤销
// 的状态 → renderer 误以为仍授权,后续 agent auth 被无提示放行,与 main 已撤销/旋转的真实态不符。
let revokeGen = 0;

async function handleRevokeAgentTerminals(count: number): Promise<void> {
  if (count <= 0) return;
  const confirmed = window.confirm(
    translate('permissions.revoke_all.confirm', { count }),
  );
  if (!confirmed) return;
  const myGen = ++revokeGen; // race(R92):本次 revoke 代际
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
    // race(R92):仅当本次仍是最新 revoke(无更晚的 revoke 覆盖)才回滚/报错。更晚的成功 revoke
    // 已把状态正确置为 revoked,先发的迟到失败不得用旧 wasGranted 把 sessionGranted 翻回 true。
    if (myGen !== revokeGen) return;
    if (wasGranted) useAgentAuthStore.setState({ sessionGranted: true });
    notify.error(translate('permissions.revoke_all.failed'), {
      code: (err as { code?: string })?.code,
    });
  }
}

async function handleCopyMcpConfig(): Promise<'ok' | 'unavailable' | 'fail'> {
  // a11y(A115,A50 同族):整体 try/catch —— getStdioConfig() IPC reject 时若不捕获,
  // onCopyMcp() 会 reject,而点击处 void onCopyMcp() 丢弃异常 → 无失败文本/无 live 播报。
  // 任何 reject 都归 'fail',复用既有失败按钮文案 + role=status live region(A51)。
  try {
    const r = await coApi.mcp.getStdioConfig();
    if (!r.ok) return 'fail';
    if (!r.data.available || !r.data.claudeAddCommand) return 'unavailable';
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
    (s) => countAgentSessions(s.sessions),
  );

  // 只订阅 active tab 的派生 primitive(打磨 R24 + 合并优化 R46)。非 active tab 的
  // content / originalContent / reloadEpoch 变化不触发状态栏重渲;active 内容变化
  // 仍更新统计(配合 R1 的统计 memo)。R24 用 4 个 selector 各 some/find;R46 合并为
  // 单次 find 返回**扁平 primitive 对象**,useShallow 逐字段 Object.is 比较——content
  // 只是 string ref(不像 EditorHeader 用 JSON 签名,这里避免序列化大文档正文)。
  const { hasActiveTab, activeFilePath, activeDirty, activeContent } =
    useEditorStore(
      useShallow((s) => {
        const found =
          s.activeTabId === null
            ? null
            : findEditorFileTabById(s.tabs, s.activeTabId);
        return {
          hasActiveTab: found !== null,
          activeFilePath: found?.filePath ?? null,
          activeDirty: found?.dirty ?? false,
          activeContent: found?.content,
        };
      }),
    );
  const statusItems = useRegistry(coApp.statusBar);
  const { left: leftItems, right: rightItems } = useMemo(
    () => splitStatusItemsBySide(statusItems),
    [statusItems],
  );

  // 行/词/字符统计按 active 内容 memo 化(codex 打磨 R1)。StatusBar 因 sessions /
  // MCP 复制态 / 插件 status item 等无关变化频繁重渲染,无 memo 时每次都重扫整篇。
  // dep 只用 activeContent 字符串值:内容编辑 → 变 → 重算;无关重渲染 → 不变 → 命中缓存。
  // 性能 P7:computeTextStats 单遍、零数组分配同时拿三项(旧版 lineCount/wordCount 各
  // 全文扫一遍 + 分配 match/split 大临时数组)。
  const stats = useMemo(
    () =>
      activeContent === undefined ? null : computeTextStats(activeContent),
    [activeContent],
  );

  const [mcpCopyState, setMcpCopyState] = useState<
    'idle' | 'ok' | 'unavailable' | 'fail'
  >('idle');
  // race(R9):复制反馈的清空 timer 须保存 + 递增 token 校验。裸 setTimeout 不清旧 timer:连续
  // 复制时第一轮的 1500ms timeout 会在第二轮反馈刚显示后把状态清回 idle(SR/用户错过真实结果);
  // 慢 handleCopyMcpConfig 先后返回也可能旧结果覆盖新结果。
  const mcpCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mcpCopyTokenRef = useRef(0);
  useEffect(
    () => () => {
      if (mcpCopyTimerRef.current !== null) clearTimeout(mcpCopyTimerRef.current);
    },
    [],
  );
  const onCopyMcp = async () => {
    const token = ++mcpCopyTokenRef.current;
    const r = await handleCopyMcpConfig();
    // 过期请求(其后已有更新的复制发起)→ 不更新状态,由最新请求负责。
    if (token !== mcpCopyTokenRef.current) return;
    if (mcpCopyTimerRef.current !== null) clearTimeout(mcpCopyTimerRef.current);
    setMcpCopyState(r);
    mcpCopyTimerRef.current = setTimeout(() => {
      mcpCopyTimerRef.current = null;
      // 仅当仍是本次反馈(无更新复制)才清回 idle —— 旧 timer 不得清掉新反馈。
      if (token === mcpCopyTokenRef.current) setMcpCopyState('idle');
    }, 1500);
  };
  const mcpLabel =
    mcpCopyState === 'ok'
      ? t('statusbar.mcp.copied')
      : mcpCopyState === 'unavailable'
        ? t('statusbar.mcp.unavailable')
        : mcpCopyState === 'fail'
          ? t('statusbar.mcp.copy_failed')
          : t('statusbar.mcp.copy');
  const mcpTooltip = t('statusbar.mcp.tooltip');
  const agentRevokeTooltip =
    agentSessionCount > 0
      ? t('statusbar.mcp.revoke_tooltip', { count: agentSessionCount })
      : '';

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
              {GIT_BRANCH_ICON}
              main
            </span>
          </>
        ) : (
          <span className="text-fg-dim/60">{t('statusbar.no_workspace')}</span>
        )}
        {!sidebarOpen && (
          <span className="text-fg-dim/60">{t('statusbar.sidebar_hidden')}</span>
        )}
        {/* 插件贡献的左侧 statusBar items(race R56:render 时 live 复查) */}
        {leftItems.map((item) => (
          <span key={item.id}>{liveRenderStatusItem(item)}</span>
        ))}
      </div>
      <div className="flex items-center gap-3">
        {/* 插件贡献的右侧 statusBar items(在内置项左边;race R56:render 时 live 复查) */}
        {rightItems.map((item) => (
          <span key={item.id}>{liveRenderStatusItem(item)}</span>
        ))}
        <button
          type="button"
          onClick={() => void onCopyMcp()}
          title={mcpTooltip}
          // a11y(A82,A74 同族):按钮可见文本 mcpLabel 随复制状态变化(idle/copied/failed),
          // 动作语义只在 title → 稳定 aria-label 表「复制 MCP 配置」,结果由下方 live region(A51)
          // 播报,按钮名不随状态漂移成结果文本。
          aria-label={mcpTooltip}
          className="text-fg-dim hover:text-fg transition-colors"
        >
          {mcpLabel}
        </button>
        {/* a11y(A51,A41 同族):复制结果只靠按钮文本短暂变化,焦点在按钮时不一定被播报 →
            视觉隐藏 role=status(polite)live region 镜像结果(仅非 idle),状态变化时播报。 */}
        <span style={SR_ONLY_STYLE} role="status">
          {mcpCopyState !== 'idle' ? mcpLabel : ''}
        </span>
        {agentSessionCount > 0 && (
          <button
            type="button"
            onClick={() => void handleRevokeAgentTerminals(agentSessionCount)}
            title={agentRevokeTooltip}
            // a11y(A74,A2 同族):按钮可见文本只表「N 个 agent 会话」,撤销动作语义仅在 title
            //(SR 有可见文本时不一定读 title)→ aria-label 用含撤销语义的 revoke_tooltip 作可访问名。
            aria-label={agentRevokeTooltip}
            className="flex items-center gap-1 text-accent hover:text-fg transition-colors"
          >
            <span aria-hidden>●</span>
            {/* i18n(I19):agent 计数走 catalog,zh/ko 不再显英文 'N agent' */}
            {t('statusbar.agent_sessions', { count: agentSessionCount })}
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
              {activeDirty && (
                <>
                  {/* a11y(A37):● 仅视觉;未保存状态用视觉隐藏的真实文本给 AT(状态栏文本流可读)。 */}
                  <span className="ml-1 text-fg-muted" aria-hidden="true">
                    ●
                  </span>
                  <span style={SR_ONLY_STYLE}>
                    {t('statusbar.unsaved_changes')}
                  </span>
                </>
              )}
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
