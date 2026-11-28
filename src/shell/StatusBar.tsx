// 底部状态栏(VSCode 风,24px,参考 stitch_desktop_design_reviewer)。
// 左:workspace 名 + sidebar 收起提示。
// 右:active editor tab 文件名 + dirty + 行 / 词 / 字符 + 光标位置 + 缩进 + 编码 / 行尾。
// 可点击项占满栏高、左右留白、悬停有底色(VSCode .statusbar-item:点击区域即整格;STATUS_ITEM_BUTTON_CLASS)。

import { memo, useDeferredValue, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { groupActiveTabIdOf, useEditorStore, usesMilkdownEngine } from '@/stores/editor.store';
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
import { PluginRenderBoundary } from '@/plugins/PluginRenderBoundary';
import { useT, t as translate, translateCount } from '@/i18n';
import { basenameForChrome } from '@/lib/path-label';
import { editorTabTitle, isUntitledPath } from '@/panels/Editor/untitled';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { codedError, errorCodeOf } from '../../electron/shared/error-message';
import { createLatestGuard } from '@/lib/latest-wins';
import { useCopyMcpConfig } from './use-copy-mcp-config';
import { isImagePreviewPath } from '../../electron/shared/image-preview';
import { useActiveNonEditorPanel, useMainWindowEditorGroupId } from '@/shell/dock/main-window-active-panel';
import { encodingLabelShort, lineEndingOf } from '@/panels/Editor/editor-encoding';
import { openChangeEncoding, openChangeEol } from '@/plugins/editor-encoding/encoding-actions';
import { openIndentationPicker } from '@/plugins/editor-encoding/indentation-actions';
import { useTabIndentation } from '@/panels/Editor/editor-indentation';
import { selectionStatusLabel, useEditorSelectionStatus } from '@/panels/Editor/editor-selection-status';
import { GOTO_LINE_COMMAND } from '@/panels/Editor/editor-commands';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { useRegisteredCommandHotkeyText, withHotkey } from '@/lib/hotkey-label';
import type { TextEncodingId } from '../../electron/shared/text-encoding';
import { RestrictedModeStatusItem } from './workspace-trust/WorkspaceTrust';

/** MCP 复制按钮在窄状态栏下的图标(lucide copy 字形;只在容器 < xl 时显示,替代文字)。 */
const MCP_COPY_ICON = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="hidden @max-xl:block"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

/**
 * 状态栏项的外框(VSCode .statusbar-item:占满栏高、左右 5px 留白)。可点击项另加悬停底色(VSCode statusBarItem.hoverBackground)
 * 与内嵌焦点环(组容器 overflow-hidden,外扩的焦点环会被上下裁掉)。
 */
const STATUS_ITEM_CLASS = 'flex shrink-0 items-center self-stretch whitespace-nowrap px-1.5';
export const STATUS_ITEM_BUTTON_CLASS = `${STATUS_ITEM_CLASS} text-fg-dim transition-colors hover:bg-hover hover:text-fg focus-visible:-outline-offset-1`;

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

// VSCode:状态栏条目有最大宽度、超长省略号截断,插件项不能把内置项挤没。插件项 min-w-0 + max-w-[40vw] + truncate,
// 收缩权重 shrink-[1000] 远高于内置项(当前文件名默认 1,MCP / Agent 授权指示 shrink-0):空间不够时先缩插件项。
// 渲染结果是字符串时 title 给出全文(截断后仍可悬停查看)。
const PLUGIN_STATUS_ITEM_CLASS_NAME = 'min-w-0 max-w-[40vw] shrink-[1000] truncate px-1.5';

// race(R56,R55 同族):渲染时按 id 从 live coApp.statusBar 复查再调 render(),而非调订阅快照里
// 缓存的 item.render。快照(useRegistry useState 订阅)滞后 registry 一帧,item 刚 unregister 时
// 快照仍含它 → 会执行已卸载插件的 render。复查使死 item 跳过。
// render() 的同步抛错与它返回的组件在 React 渲染期抛的错都由 PluginRenderBoundary 就地接住(紧凑错误图标),
// 不冒泡到根让整个主窗白屏(BDD: plugin-render-isolation)。
function PluginStatusItem({ item }: { item: StatusBarItemSpec }) {
  const live = coApp.statusBar.get(item.id);
  if (!live) return null;
  return (
    <PluginRenderBoundary owner={live} variant="inline">
      <PluginStatusItemContent spec={live} />
    </PluginRenderBoundary>
  );
}

function PluginStatusItemContent({ spec }: { spec: StatusBarItemSpec }) {
  const node = spec.render();
  return (
    <span className={PLUGIN_STATUS_ITEM_CLASS_NAME} title={typeof node === 'string' ? node : undefined}>
      {node}
    </span>
  );
}

/** 本窗口仍在运行的 agent 终端数(已退出的不算:撤销终止的也只是运行中的,与 main countAgentTerminalSessions 同口径)。 */
export function countAgentSessions(sessions: readonly TerminalSession[]): number {
  let count = 0;
  for (const session of sessions) {
    if (session.originHint === 'agent' && session.exitCode === null) {
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
  // 窄宽(状态栏容器 < 2xl)最先隐藏:次要信息,VSCode 空间不够时整项隐藏而不是折行。
  return (
    <span className="whitespace-nowrap px-1.5 @max-2xl:hidden">
      {t('statusbar.editor_stats', {
        lines: translateCount('statusbar.editor_stats.lines', stats?.lines ?? 0),
        words: translateCount('statusbar.editor_stats.words', stats?.words ?? 0),
        chars: translateCount('statusbar.editor_stats.chars', stats?.chars ?? 0),
      })}
    </span>
  );
});

/**
 * 编码 / 行尾项(VSCode status.editor.encoding / status.editor.eol):显示 tab 的磁盘编码(UTF-8 / UTF-16 LE / GBK …)与行尾
 *(LF / CRLF),点击打开更改文件编码 / 更改行尾序列。行尾按内容判定(O(N)),同 EditorStats 对延后的内容计算。
 * BDD: src/__tests__/editor-text-encoding/
 */
const EditorEncodingItems = memo(function EditorEncodingItems({
  tabId,
  content,
  encoding,
}: {
  tabId: string;
  content: string;
  encoding: TextEncodingId;
}) {
  const t = useT();
  const deferredTabId = useDeferredValue(tabId);
  const deferredContent = useDeferredValue(content);
  const eolContent = deferredTabId === tabId ? deferredContent : content;
  const eol = useMemo(() => lineEndingOf(eolContent), [eolContent]);
  // native button:同 MCP 按钮(24px 状态栏内的行内文本按钮,design Button 最小高度超出状态栏);颜色走语义 token。
  // 可访问名称 = 可见文字(UTF-8 / LF),动作说明在 title(VSCode tooltip「选择编码」/「选择行尾序列」)。
  // 状态栏容器 < lg 时隐藏(在统计之后、文件名之前让位)。
  const itemClass = `${STATUS_ITEM_BUTTON_CLASS} @max-lg:hidden`;
  return (
    <>
      <button
        type="button"
        data-statusbar-encoding=""
        title={t('statusbar.encoding.tooltip')}
        onClick={() => openChangeEncoding(tabId)}
        className={itemClass}
      >
        {encodingLabelShort(encoding)}
      </button>
      <button
        type="button"
        data-statusbar-eol=""
        title={t('statusbar.eol.tooltip')}
        onClick={() => openChangeEol(tabId)}
        className={itemClass}
      >
        {eol}
      </button>
    </>
  );
});

/**
 * 缩进项(VSCode status.editor.indentation):「空格: 4」/「制表符长度: 4」,点击打开缩进动作选择器。文档缩进由代码编辑器打开时确定
 *(未确定 —— 如 Markdown 编辑 / 预览模式 —— 不显示)。BDD: src/__tests__/editor-indentation/
 */
const EditorIndentationItem = memo(function EditorIndentationItem({ tabId }: { tabId: string }) {
  const t = useT();
  const indent = useTabIndentation(tabId);
  if (!indent) return null;
  // native button:同编码 / 行尾项(24px 状态栏行内文本按钮);可访问名称 = 可见文字,动作说明在 title(VSCode「选择缩进」)。
  return (
    <button
      type="button"
      data-statusbar-indentation=""
      title={t('statusbar.indent.tooltip')}
      onClick={() => openIndentationPicker(tabId)}
      className={`${STATUS_ITEM_BUTTON_CLASS} @max-lg:hidden`}
    >
      {indent.insertSpaces
        ? t('statusbar.indent.spaces', { size: indent.tabSize })
        : t('statusbar.indent.tabs', { size: indent.tabSize })}
    </button>
  );
});

/**
 * 光标位置项(VSCode status.editor.selection):「行 16，列 1」/「行 16，列 1（已选择12）」/「3 选择」/「3 选择（已选择 9 个字符）」,
 * 点击 = 转到行/列(workbench.action.gotoLine)。只在代码编辑器 / Markdown 源码模式有登记(编辑 / 预览模式不显示,VSCode 的
 * Markdown 预览同样没有)。BDD: src/__tests__/statusbar-editor-selection/
 */
const EditorSelectionItem = memo(function EditorSelectionItem({ tabId, groupId }: { tabId: string; groupId: string }) {
  const t = useT();
  const status = useEditorSelectionStatus(tabId, groupId);
  if (!status) return null;
  const { key, params } = selectionStatusLabel(status);
  const tooltip = t('statusbar.selection.tooltip');
  // native button:同缩进 / 编码项(24px 状态栏行内文本按钮);可访问名称 = 可见文字,动作说明在 title(VSCode「转到行/列」)。
  return (
    <button
      type="button"
      data-statusbar-selection=""
      title={tooltip}
      onClick={() => void runRegisteredCommand(coApp.commands, GOTO_LINE_COMMAND.id, tooltip)}
      className={`${STATUS_ITEM_BUTTON_CLASS} @max-md:hidden`}
    >
      {t(key, params)}
    </button>
  );
});

/** 切换侧栏的命令(状态栏「侧栏已隐藏」悬停提示显示其当前生效键位)。 */
const TOGGLE_SIDEBAR_COMMAND_ID = 'explorer.toggleSidebar';
/** 显示资源管理器并聚焦(workbench.view.explorer:侧栏打开 + 焦点进文件树,无工作区 → 「打开文件夹」)。 */
const SHOW_EXPLORER_COMMAND_ID = 'workbench.view.explorer';

/**
 * 「侧栏已隐藏」:点击显示侧栏并把焦点交给资源管理器树(经命令注册表执行 workbench.view.explorer),悬停「显示侧栏 (⌘B)」
 *(键位随改绑)。不走 ⌘B 的 toggle:显示侧栏后本按钮随即消失,⌘B 不动焦点(VSCode 显示侧栏也不抢焦点)→ 焦点会掉到 body。
 * 可访问名 = 可见文字,动作说明在 title(作可访问描述,同 MCP 复制按钮)。
 */
function SidebarHiddenItem({ label, showLabel }: { readonly label: string; readonly showLabel: string }) {
  const hotkey = useRegisteredCommandHotkeyText(coApp.commands, TOGGLE_SIDEBAR_COMMAND_ID);
  return (
    // native button:24px 状态栏内的行内文本按钮(同 MCP 复制按钮);颜色走语义 token。
    <button
      type="button"
      onClick={() => void runRegisteredCommand(coApp.commands, SHOW_EXPLORER_COMMAND_ID, showLabel)}
      title={withHotkey(showLabel, hotkey)}
      className={STATUS_ITEM_BUTTON_CLASS}
    >
      {label}
    </button>
  );
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
  // 取主窗正显示的编辑器组的活动 tab(活动编辑器组可能在 popout 子窗,主窗状态栏不显示子窗的文件)。
  const mainGroupId = useMainWindowEditorGroupId();
  const { activeTabId, activeFilePath, activeDirty, activeContent, activeEncoding, activeMilkdown } =
    useEditorStore(
      useShallow((s) => {
        const found = findEditorFileTabById(s.tabs, mainGroupId === null ? null : groupActiveTabIdOf(s, mainGroupId));
        return {
          activeTabId: found?.id ?? null,
          activeFilePath: found?.filePath ?? null,
          activeDirty: found?.dirty ?? false,
          activeContent: found?.content,
          activeEncoding: found?.encoding ?? 'utf8',
          // Markdown 编辑 / 预览(Milkdown)不涉及缩进:不显示缩进项(mode 在同一 store,随之重算)
          activeMilkdown: found ? s.mode !== 'source' && usesMilkdownEngine(found.filePath, found) : false,
        };
      }),
    );
  // 主窗活动的是终端等非编辑器面板 → 编辑器专属项(文件名、统计)隐藏(VSCode 同)
  const editorHidden = useActiveNonEditorPanel() !== null;
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
  // 复制 MCP 配置:动作 + 结果反馈(R9 timer / 过期守卫、A115 失败兜底)与 Debug 面板空态共用。
  const mcpCopy = useCopyMcpConfig();
  const mcpTooltip = t('statusbar.mcp.tooltip');
  const agentRevokeTooltip =
    agentSessionCount > 0
      ? t('statusbar.mcp.revoke_tooltip', { count: agentSessionCount })
      : t('statusbar.agent_revoke_grant_tooltip');
  // i18n(I19):agent 计数走 catalog,zh/ko 不再显英文 'N agent'
  const agentRevokeText =
    agentSessionCount > 0
      ? translateCount('statusbar.agent_sessions', agentSessionCount)
      : t('statusbar.agent_authorized');

  return (
    // data-statusbar:ToastViewport.css 据此(:has)在有状态栏的窗口把 toast 抬到状态栏上方;高度 token 两处共用。
    // data-workbench-part:F6 / ⇧F6 区域切换的「状态栏」区域(src/shell/focus-parts.ts)。
    <footer
      data-statusbar=""
      data-workbench-part="statusbar"
      // 对齐 VSCode:状态栏项从不折行(条目 whitespace-nowrap / truncate),两组 min-w-0 可收缩、溢出裁掉;@container 供
      // 窄宽按优先级隐藏(先隐藏统计,再把 MCP 按钮缩成图标)。组 self-stretch,项占满栏高;按钮焦点环内嵌(focus-visible:-outline-offset-1),overflow-hidden 不裁掉它。
      className="@container flex h-statusbar shrink-0 items-center justify-between gap-3 border-t border-line bg-panel px-1.5 text-2xs text-fg-dim select-none"
    >
      <div className="flex min-w-0 items-center gap-0.5 self-stretch overflow-hidden">
        {/* 工作区信任:未受信任时最左侧显示「受限模式」(VSCode status.workspaceTrust 位于左侧最前),点击打开管理。 */}
        <RestrictedModeStatusItem
          className={`${STATUS_ITEM_CLASS} transition-colors hover:bg-hover hover:text-fg focus-visible:-outline-offset-1`}
        />
        {root ? (
          <span className="truncate px-1.5" title={root}>
            {basenameForChrome(root)}
          </span>
        ) : (
          <span className="whitespace-nowrap px-1.5">{t('statusbar.no_workspace')}</span>
        )}
        {!sidebarOpen && <SidebarHiddenItem label={t('statusbar.sidebar_hidden')} showLabel={t('statusbar.show_sidebar')} />}
        {/* 插件贡献的左侧 statusBar items(race R56:render 时 live 复查) */}
        {leftItems.map((item) => (
          <PluginStatusItem key={item.id} item={item} />
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-0.5 self-stretch overflow-hidden">
        {/* 插件贡献的右侧 statusBar items(在内置项左边;race R56:render 时 live 复查) */}
        {rightItems.map((item) => (
          <PluginStatusItem key={item.id} item={item} />
        ))}
        {/* native button:24px 状态栏内的行内文本按钮,design Button 最小高度超出状态栏;颜色走语义 token。 */}
        <button
          type="button"
          onClick={() => void mcpCopy.copy()}
          title={mcpTooltip}
          // a11y(A82,A74 同族):按钮可见文本 mcpCopy.label 随复制状态变化(idle/copied/failed),
          // 稳定 aria-label 表「复制 MCP 配置」,结果由下方 live region(A51)播报,按钮名不随状态漂移成结果文本。
          // WCAG 2.5.3(Label in Name):名称 = 默认可见文字(窄宽只剩图标时亦然),长说明留在 title(作可访问描述)。
          aria-label={t('statusbar.mcp.copy')}
          className={STATUS_ITEM_BUTTON_CLASS}
        >
          {/* 状态栏容器 < xl 时只显示图标(文字隐藏;动作语义仍在 title / aria-label,复制结果由下方 live region 播报)。 */}
          {MCP_COPY_ICON}
          <span className="@max-xl:hidden">{mcpCopy.label}</span>
        </button>
        {/* a11y(A51,A41 同族):复制结果只靠按钮文本短暂变化,焦点在按钮时不一定被播报 →
            视觉隐藏 role=status(polite)live region 镜像结果(仅非 idle),状态变化时播报。 */}
        <span style={SR_ONLY_STYLE} role="status">
          {mcpCopy.announcement}
        </span>
        {showAgentRevoke && (
          // native button:同上(24px 状态栏行内文本按钮)。
          <button
            type="button"
            data-agent-revoke
            onClick={() => void openRevokeConfirm()}
            title={agentRevokeTooltip}
            // a11y(A74,A2 同族):按钮可见文本只表「N 个 agent 会话」,撤销动作语义仅在 title
            //(SR 有可见文本时不一定读 title)→ 名称补上撤销说明;WCAG 2.5.3(Label in Name):以可见文字开头
            //(「N 个 agent，撤销授权并终止…」),语音控制按可见文字能点到。
            aria-label={t('statusbar.agent_revoke_aria', { label: agentRevokeText, action: agentRevokeTooltip })}
            className={`${STATUS_ITEM_CLASS} gap-1 text-accent transition-colors hover:bg-hover hover:text-fg focus-visible:-outline-offset-1`}
          >
            <span aria-hidden>●</span>
            {agentRevokeText}
          </button>
        )}
        {activeFilePath !== null && !editorHidden ? (
          <>
            <span className="truncate max-w-[280px] px-1.5" title={isUntitledPath(activeFilePath) ? editorTabTitle(activeFilePath) : activeFilePath}>
              {editorTabTitle(activeFilePath)}
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
            {/* 图片 tab 的内容是 stat 指纹,不是文本:不显示统计(尺寸 / 大小在图片视图里)。 */}
            {!isImagePreviewPath(activeFilePath) && <EditorStats tabId={activeTabId} content={activeContent} />}
            {!isImagePreviewPath(activeFilePath) && activeTabId !== null && !activeMilkdown && mainGroupId !== null && (
              <EditorSelectionItem tabId={activeTabId} groupId={mainGroupId} />
            )}
            {!isImagePreviewPath(activeFilePath) && activeTabId !== null && !activeMilkdown && (
              <EditorIndentationItem tabId={activeTabId} />
            )}
            {!isImagePreviewPath(activeFilePath) && activeTabId !== null && activeContent !== undefined && (
              <EditorEncodingItems tabId={activeTabId} content={activeContent} encoding={activeEncoding} />
            )}
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
