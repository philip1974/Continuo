// 底部状态栏(VSCode 风,24px,参考 stitch_desktop_design_reviewer)。
// 左:workspace 名 + sidebar 收起提示。
// 右:active editor tab 文件名 + dirty + 行 / 词 / 字符。

import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';
import {
  hasAnySessionGrant,
  useAgentAuthStore,
  SESSION_GRANT_KEYS,
} from '@/stores/agent-auth.store';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { computeTextStats } from '@/lib/text-stats';
import { coApp } from '@/plugins/co-app';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import type { StatusBarItemSpec } from '@/plugins/registries/StatusBarRegistry';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { useT, t as translate } from '@/i18n';
import { basenameForChrome } from '@/lib/path-label';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { codedError, errorCodeOf } from '../../electron/shared/error-message';
import { createLatestGuard } from '@/lib/latest-wins';

const EMPTY_STATUS_ITEMS: readonly StatusBarItemSpec[] = [];
const EMPTY_STATUS_SPLIT = {
  left: EMPTY_STATUS_ITEMS,
  right: EMPTY_STATUS_ITEMS,
};

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
// 迟到失败会用其调用开始时的旧快照把授权位写回 true,覆盖后发已成功撤销的界面状态(凭空显示一个不存在的授权)。
const revokeGuard = createLatestGuard();

async function handleRevokeAgentTerminals(): Promise<void> {
  const isLatest = revokeGuard.begin(); // race(R92):本次 revoke 代际
  // 本地先撤,UI 即时反馈;main 推 sessions_changed 后 sessions 也清空。
  // 放行的权威在 main,这里的授权位只决定撤销入口是否显示。撤销失败时 main 可能仍有授权(例如 IPC 没到达 main),
  // 所以失败回滚恢复**全部**域(含外部客户端):宁可多显示一个撤销入口,也不能把仍有效的授权藏起来、让用户无从撤销。
  const before = useAgentAuthStore.getState();
  const wasGranted = SESSION_GRANT_KEYS.filter((k) => before[k]);
  useAgentAuthStore.getState().revoke();
  // 闭环:revoke IPC(kill PTY + rotate token)可能失败(revokeAndKillAgentSessions 抛错 →
  // safeHandle 返 ok:false / IPC reject)。旧实现 `void` 完全忽略结果 → 失败被静默伪成功:
  // UI 显示已撤销但 main 的 agent PTY/token 仍存活,是安全相关谎报(用户以为已断开实际没有)。
  // 该 IPC 本就设计返回 {killed,rotated} 供 renderer 反馈。失败 → 回滚本地授权态 + 弹错误,
  // 让用户知道并重试。(复审 loop R18)
  try {
    const r = await coApi.agentAuth.revoke();
    // 保留稳定 code(此前 new Error(r.code) 把 code 塞进 message,下方 catch 取不到 → toast 不带 code)。
    if (!r.ok) throw codedError(r.code, r.message ?? 'revoke failed');
    // main 撤销时已把全部 pending 授权结算为 denied 并删除 → renderer 仍显示的旧弹窗已失效,取消掉
    // (否则用户对它点了只会得到 NOT_PENDING)。以 'cancelled' 结算:main 已无该
    // pending,应答方不再 respond(否则 NOT_PENDING 误报失败)。main 的 REVOKED 广播也会到达本窗口,幂等。
    useAgentAuthStore.getState().applyMainRevoked();
  } catch (err) {
    // race(R92):仅当本次仍是最新 revoke(无更晚的 revoke 覆盖)才回滚/报错。更晚的成功 revoke
    // 已把状态正确置为 revoked,先发的迟到失败不得用旧快照把授权位翻回 true。
    if (!isLatest()) return;
    // 只恢复、不降级:撤销在途期间用户若又新授权了某个域,失败回滚不能把它写回 false。
    for (const k of wasGranted) useAgentAuthStore.setState({ [k]: true });
    notify.error(translate('permissions.revoke_all.failed'), {
      code: errorCodeOf(err),
    });
  }
}

/**
 * 撤销会终止**所有窗口**的 agent terminal,本窗口 terminal store 只含本窗口会话 → 确认框的数量向 main 现取全局数。
 * 取不到(IPC 失败 / reject)→ null,确认框改用不带数量、点明「任一窗口的 agent terminal 都会被终止」的文案。
 */
async function fetchGlobalAgentTerminalCount(): Promise<number | null> {
  try {
    const r = await coApi.agentAuth.countAgentTerminals();
    return r.ok ? r.data.count : null;
  } catch {
    return null;
  }
}

async function handleCopyMcpConfig(): Promise<'ok' | 'unavailable' | 'fail'> {
  // a11y(A115,A50 同族):整体 try/catch —— getStdioConfig() IPC reject 时若不捕获,
  // onCopyMcp() 会 reject,而点击处 void onCopyMcp() 丢弃异常 → 无失败文本/无 live 播报。
  // 任何 reject 都归 'fail',复用既有失败按钮文案 + role=status live region(A51)。
  try {
    const r = await coApi.mcp.getStdioConfig();
    if (!r.ok) return 'fail';
    if (!r.data.claudeAddCommand) return 'unavailable';
    // PROD 下 sandboxSweep 已涂掉 navigator.clipboard,必须走 cached raw ref
    await getCachedClipboard().writeText(r.data.claudeAddCommand);
    return 'ok';
  } catch {
    return 'fail';
  }
}

/**
 * 行/词/字符统计(打磨 R1 memo 化;性能 P7 单遍 computeTextStats)。
 * perf:内容每键都变,统计 O(N) 全文扫描对 useDeferredValue 后的内容计算 —— 高优先级渲染沿用旧值先提交,
 * 统计在随后可中断的低优先级渲染里更新(允许延后一帧,最终值不变)。独立 memo 子组件:延后渲染只重跑本组件,
 * 父级 StatusBar(含插件 status item 的 render())每键仍只渲染一次。
 */
const EditorStats = memo(function EditorStats({
  tabId,
  content,
}: {
  tabId: string | null;
  content: string | undefined;
}) {
  const t = useT();
  const deferredTabId = useDeferredValue(tabId);
  const deferredContent = useDeferredValue(content);
  // 只对同一 tab 内的编辑延后;切换 tab 时延后值仍属上一个文件 → 直接用当前内容,不闪旧文件统计。
  const statsContent = deferredTabId === tabId ? deferredContent : content;
  const stats = useMemo(
    () => (statsContent === undefined ? null : computeTextStats(statsContent)),
    [statsContent],
  );
  return (
    <span>
      {t('statusbar.editor_stats', {
        lines: stats?.lines ?? 0,
        words: stats?.words ?? 0,
        chars: stats?.chars ?? 0,
      })}
    </span>
  );
});

export function StatusBar() {
  const t = useT();
  const root = useWorkspaceStore((s) => s.root);
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  // 只订阅派生的 agent 计数(打磨 R39,延续 R22/R24):终端标题/退出状态/普通
  // 用户终端变化不影响 agent 数 → number 不变 → StatusBar 不重渲。
  const agentSessionCount = useTerminalStore(
    (s) => countAgentSessions(s.sessions),
  );
  // 终审 P1:只授予了调试域(外部 MCP 客户端 debug.launch)而没有 agent terminal 时也必须能撤销 ——
  // 调试授权等同任意代码执行,此前入口只看 agent 会话数,debug-only 授权只能退出应用才能撤销。
  // 插件工具域、外部客户端授权同理:任一「本次启动期间允许」都须能撤销(单一来源 hasAnySessionGrant)。
  const anyAgentGrant = useAgentAuthStore(hasAnySessionGrant);
  const showAgentRevoke = agentSessionCount > 0 || anyAgentGrant;

  // 只订阅 active tab 的派生 primitive(打磨 R24 + 合并优化 R46)。非 active tab 的
  // content / originalContent / reloadEpoch 变化不触发状态栏重渲;active 内容变化
  // 仍更新统计(配合 R1 的统计 memo)。R24 用 4 个 selector 各 some/find;R46 合并为
  // 单次 find 返回**扁平 primitive 对象**,useShallow 逐字段 Object.is 比较——content
  // 只是 string ref(不像旧 EditorHeader 的 JSON 签名 selector,这里避免序列化大文档正文)。
  const { activeTabId, activeFilePath, activeDirty, activeContent } =
    useEditorStore(
      useShallow((s) => {
        const found =
          findEditorFileTabById(s.tabs, s.activeTabId);
        return {
          activeTabId: found?.id ?? null,
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

  // 非 null = 撤销确认弹窗打开;count 为 main 给的全局 agent 终端数(取数中 / 取不到为 null)。
  const [revokeConfirm, setRevokeConfirm] = useState<{ count: number | null } | null>(null);
  const [revokeCountGuard] = useState(createLatestGuard);
  const openRevokeConfirm = async () => {
    const isLatest = revokeCountGuard.begin();
    setRevokeConfirm({ count: null });
    const count = await fetchGlobalAgentTerminalCount();
    // 过期(其后又打开过一次)不写;取数期间弹窗已关 → 保持关闭。
    if (!isLatest()) return;
    setRevokeConfirm((cur) => (cur ? { count } : cur));
  };
  const revokeConfirmCount = revokeConfirm?.count ?? null;
  const [mcpCopyState, setMcpCopyState] = useState<
    'idle' | 'ok' | 'unavailable' | 'fail'
  >('idle');
  // race(R9):复制反馈的清空 timer 须保存 + 递增 token 校验。裸 setTimeout 不清旧 timer:连续
  // 复制时第一轮的 1500ms timeout 会在第二轮反馈刚显示后把状态清回 idle(SR/用户错过真实结果);
  // 慢 handleCopyMcpConfig 先后返回也可能旧结果覆盖新结果。
  const mcpCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mcpCopyGuard] = useState(createLatestGuard);
  useEffect(
    () => () => {
      if (mcpCopyTimerRef.current !== null) clearTimeout(mcpCopyTimerRef.current);
    },
    [],
  );
  const onCopyMcp = async () => {
    const isLatest = mcpCopyGuard.begin();
    const r = await handleCopyMcpConfig();
    // 过期请求(其后已有更新的复制发起)→ 不更新状态,由最新请求负责。
    if (!isLatest()) return;
    if (mcpCopyTimerRef.current !== null) clearTimeout(mcpCopyTimerRef.current);
    setMcpCopyState(r);
    mcpCopyTimerRef.current = setTimeout(() => {
      mcpCopyTimerRef.current = null;
      // 仅当仍是本次反馈(无更新复制)才清回 idle —— 旧 timer 不得清掉新反馈。
      if (isLatest()) setMcpCopyState('idle');
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
      : t('statusbar.agent_revoke_grant_tooltip');

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-line bg-panel px-3 text-2xs text-fg-dim select-none">
      <div className="flex items-center gap-3 min-w-0">
        {root ? (
          <span className="truncate" title={root}>
            {basenameForChrome(root)}
          </span>
        ) : (
          <span>{t('statusbar.no_workspace')}</span>
        )}
        {!sidebarOpen && (
          <span>{t('statusbar.sidebar_hidden')}</span>
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
        {/* native button:24px 状态栏内的行内文本按钮,design Button 最小高度超出状态栏;颜色走语义 token。 */}
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
        {showAgentRevoke && (
          // native button:同上(24px 状态栏行内文本按钮)。
          <button
            type="button"
            data-agent-revoke
            onClick={() => void openRevokeConfirm()}
            title={agentRevokeTooltip}
            // a11y(A74,A2 同族):按钮可见文本只表「N 个 agent 会话」,撤销动作语义仅在 title
            //(SR 有可见文本时不一定读 title)→ aria-label 用含撤销语义的 revoke_tooltip 作可访问名。
            aria-label={agentRevokeTooltip}
            className="flex items-center gap-1 text-accent hover:text-fg transition-colors"
          >
            <span aria-hidden>●</span>
            {/* i18n(I19):agent 计数走 catalog,zh/ko 不再显英文 'N agent' */}
            {agentSessionCount > 0
              ? t('statusbar.agent_sessions', { count: agentSessionCount })
              : t('statusbar.agent_authorized')}
          </button>
        )}
        {activeFilePath !== null ? (
          <>
            <span className="truncate max-w-[280px]" title={activeFilePath}>
              {basenameForChrome(activeFilePath)}
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
            <EditorStats tabId={activeTabId} content={activeContent} />
          </>
        ) : null}
      </div>
      {/* 撤销确认走 design Modal(项目约束:对话框不用原生确认框)。 */}
      <ConfirmDialog
        open={revokeConfirm !== null}
        title={t('permissions.revoke_all.title')}
        description={
          <span className="whitespace-pre-line">
            {revokeConfirmCount !== null && revokeConfirmCount > 0
              ? t('permissions.revoke_all.confirm', { count: revokeConfirmCount })
              : t('permissions.revoke_all.confirm_grant_only')}
          </span>
        }
        destructive
        onCancel={() => setRevokeConfirm(null)}
        onConfirm={() => {
          setRevokeConfirm(null);
          void handleRevokeAgentTerminals();
        }}
      />
    </footer>
  );
}
