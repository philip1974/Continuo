// 单行 Header:左 tab 列表 / 右 插件 actions。
//
// 与 VSCode 对齐:
//   - tabs=0  → 整个 header 不渲染(EditorWelcome 接管)
//   - tabs≥1 → 统一 TabNav,单 tab 也按内容宽收紧(TabNavItem flex-shrink:0
//              + max-width:220px),右侧 panel 留空,不再撑满整行。
//   - 不显文字「保存」按钮 — dirty 由 TabNavItem 自带的 ● 指示,⌘S 保存。
//   - markdown 模式切换(Edit/Source/Preview)已搬到 EditorPanel 内的模式切换行(SegmentedControl)
//     —— tab 行下方独立一行,与编辑器同宽,视觉上更干净。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type WheelEvent } from 'react';
import {
  getEffectiveMode,
  useEditorStore,
  type EditorMode,
  type EditorTab,
} from '@/stores/editor.store';
import { useT } from '@/i18n';
import { runContributedAction } from '@/lib/run-contributed-action';
import {
  Button,
  IconButton,
  TabNav,
  TabNavItem,
} from '@/design';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { findEditorFileTabById } from './editor-tab-lookup';
import {
  filterVisible,
  isEditorActionVisible,
  type EditorActionSpec,
} from '@/plugins/registries/EditorActionRegistry';
import { basename } from '@/lib/path-cross';
import { tabLabelDescriptions } from './tab-label-description';

/**
 * Tab 栏渲染所需的"chrome"子集(打磨 R23):只含标题/脏态相关字段,**不含
 * content** —— 让 EditorHeader 脱离编辑正文热路径。关闭确认也只需这三个字段。
 */
export interface TabChrome {
  readonly id: string;
  readonly filePath: string;
  readonly dirty: boolean;
  /** 文件已删除、tab 因未保存修改保留(EditorTab.orphaned):标题删除线 +「(已删除)」。 */
  readonly orphaned?: boolean;
}

interface EditorHeaderProps {
  onCloseRequest: (tab: TabChrome) => void;
}

const EMPTY_TAB_CHROME: TabChrome[] = [];

// 编辑区里接焦点的可编辑元素(CodeMirror / ProseMirror 的 contenteditable、输入框),同 dock tab SharedTab。
const EDITABLE_SELECTOR =
  '[contenteditable="true"], textarea:not([disabled]), input:not([disabled]):not([type="hidden"])';

/**
 * 鼠标点 tab 后把焦点交给编辑区(VSCode:点编辑器 tab 即聚焦该编辑器)。等一帧:切 tab 后新编辑器在本次
 * 渲染才挂上。只在 tab 行之外(编辑面板内)找;找不到(预览模式 / 编辑器仍在加载)焦点留在 tab 上 ——
 * 无害,tab 上只有 Delete 会关闭。
 */
function focusEditorContentNextFrame(header: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const host = header?.parentElement;
    if (!host) return;
    for (const el of host.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR)) {
      if (header.contains(el)) continue;
      el.focus();
      return;
    }
  });
}


/** tab 栏两侧渐隐遮罩:只在该方向确有被遮住的 tab 时显示(溢出提示)。 */
const TAB_FADE_BASE_CLASS_NAME =
  'pointer-events-none absolute inset-y-0 z-decor w-6 from-canvas to-transparent transition-opacity';

function useTabOverflowFades(wrapper: RefObject<HTMLDivElement | null>, tabsKey: unknown) {
  const [fades, setFades] = useState({ start: false, end: false });
  useEffect(() => {
    const host = wrapper.current;
    const list = host?.querySelector<HTMLElement>('[role=tablist]');
    if (!host || !list) return;
    const update = (): void => {
      const start = list.scrollLeft > 0;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setFades((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    // scroll 不冒泡:在外层用捕获阶段监听 tablist 的滚动。
    host.addEventListener('scroll', update, true);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(list);
    return () => {
      host.removeEventListener('scroll', update, true);
      ro?.disconnect();
    };
  }, [wrapper, tabsKey]);
  return fades;
}

/**
 * 把激活 tab 滚入 tab 栏可视区(VSCode revealActiveTab):在左侧外 → 左缘贴齐;在右侧外 → 右缘贴齐(比可视区还宽时
 * 左缘贴齐)。只改 tab 栏自身的 scrollLeft —— scrollIntoView 会连带滚动 dock 等外层容器。
 */
function revealActiveTab(list: HTMLElement): void {
  const active = list.querySelector<HTMLElement>('[role=tab][aria-selected="true"]');
  if (!active) return;
  const item = active.closest<HTMLElement>('.wm-tab-nav-item') ?? active;
  const view = list.getBoundingClientRect();
  const tab = item.getBoundingClientRect();
  const before = tab.left - view.left;
  const after = tab.right - view.right;
  if (before < 0) list.scrollLeft += before;
  else if (after > 0) list.scrollLeft += Math.min(after, before);
}

/** 激活 tab 变化(切换 / 新开 / 关闭后落到别的 tab)以及 tab 栏尺寸变化(窗口 / 面板缩放)时把激活 tab 滚入可见区。 */
function useRevealActiveTab(wrapper: RefObject<HTMLDivElement | null>, activeTabId: string | null, tabsKey: unknown) {
  useLayoutEffect(() => {
    const list = wrapper.current?.querySelector<HTMLElement>('[role=tablist]');
    if (list) revealActiveTab(list);
  }, [wrapper, activeTabId, tabsKey]);
  useEffect(() => {
    const list = wrapper.current?.querySelector<HTMLElement>('[role=tablist]');
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => revealActiveTab(list));
    ro.observe(list);
    return () => ro.disconnect();
  }, [wrapper, tabsKey]);
}

/** 竖向滚轮在 tab 栏上横向滚动(VSCode 同款;触控板横向手势照常)。 */
function scrollTabsOnWheel(e: WheelEvent<HTMLDivElement>): void {
  if (e.deltaX !== 0 || e.deltaY === 0) return;
  const list = e.currentTarget.querySelector<HTMLElement>('[role=tablist]');
  if (list && list.scrollWidth > list.clientWidth) list.scrollLeft += e.deltaY;
}

export function buildEditorTabChrome(tabs: readonly EditorTab[]): TabChrome[] {
  if (tabs.length === 0) return EMPTY_TAB_CHROME;
  const out = new Array<TabChrome>(tabs.length);
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    out[i] = {
      id: tab.id,
      filePath: tab.filePath,
      dirty: tab.dirty,
      ...(tab.orphaned ? { orphaned: true } : {}),
    };
  }
  return out;
}

/**
 * 抽出 actions 段为 memo 子组件:plugin 启停 actions 变化时,只本子组件
 * 重渲,父 EditorHeader 的 tabs 列表那段不动。
 *
 * memo 比较入参三个 primitive(filePath / dirty / mode)— 文件 / 脏态 /
 * 模式没变 + 子组件内订阅的 editorActions snapshot 也没变 → 跳过 reconcile。
 *
 * (filterVisible 仍每次 props 或 actions 变化时跑;空数组也安然 memo。)
 */
interface EditorActionsAreaProps {
  readonly filePath: string | null;
  readonly dirty: boolean;
  readonly mode: EditorMode;
}

const EditorActionsArea = memo(function EditorActionsArea({
  filePath,
  dirty,
  mode,
}: EditorActionsAreaProps) {
  // 订阅 editorActions registry,渲染时按 ctx 过滤。
  const allActions = useRegistry(coApp.editorActions);
  // race(R53,R51/R52 同族):点击时按 id 从 live registry 重查 + 按当前 ctx 重检 when 再执行,
  // 而非调渲染时捕获的 a.fn。插件 disable/reload unregister 后、到重渲移除按钮前旧 handler 仍可
  // 触发;重查使死 action / 当前 ctx 下不可见的 action 静默忽略,不执行已卸载插件代码。
  const runAction = useCallback(
    (a: EditorActionSpec) => {
      runContributedAction(a.label, () => {
        const live = coApp.editorActions.get(a.id);
        if (!live) return;
        if (!isEditorActionVisible(live, { filePath, dirty, mode })) return;
        return live.fn();
      });
    },
    [filePath, dirty, mode],
  );
  const visibleActions = useMemo(
    () => filterVisible(allActions, { filePath, dirty, mode }),
    [allActions, filePath, dirty, mode],
  );
  return (
    <>
      {visibleActions.map((a) =>
        a.icon ? (
          <IconButton
            key={a.id}
            size="xs"
            // 插件贡献的编辑器 action,抛错经 runContributedAction 弹 error toast,不再
            // 静默吞(旧 `void a.fn()` 连 console 都没有)。见第二十一轮 P1-AX。
            onClick={() => runAction(a)}
            title={a.label}
            aria-label={a.label}
          >
            {a.icon}
          </IconButton>
        ) : (
          <Button
            key={a.id}
            variant="ghost"
            size="sm"
            onClick={() => runAction(a)}
            title={a.label}
          >
            {a.label}
          </Button>
        ),
      )}
    </>
  );
});

// perf E3:memo —— EditorPanel 每按键(active tab 正文变)都重渲;本组件唯一 prop onCloseRequest
// 是父级稳定 useCallback,所需 store 状态全走自身窄订阅(chromeVersion/activeTabId/mode/locale),
// 父级重渲时跳过,不再每键重建全部 TabNavItem 与闭包。
export const EditorHeader = memo(function EditorHeader({
  onCloseRequest,
}: EditorHeaderProps) {
  const t = useT(); // 订阅 locale 让 basename 改语言时 re-render
  // 只订阅派生的 tab chrome(打磨 R23 + 性能 P12)。旧实现每次 store 更新都在 selector 里
  // `tabs.map(...)+JSON.stringify`(O(tab 数) 分配+序列化),虽阻止重渲但不阻止每按键计算。
  // 现订阅 store 维护的 chromeVersion(number):仅 chrome 真变化(增删/改名/dirty 翻转)
  // 才递增,用户编辑正文(dirty 不变)时不变 → selector 返同一 number → O(1) 跳过;再用
  // useMemo 仅在 version 变化时从 getState() 重建 chrome 对象数组。
  const chromeVersion = useEditorStore((s) => s.chromeVersion);
  const tabsChrome = useMemo<readonly TabChrome[]>(
    () => buildEditorTabChrome(useEditorStore.getState().tabs),
    // chromeVersion 作"失效键":body 用 getState() 读最新 tabs,version 变(chrome 真
    // 变)才重建对象数组。lint 看不到 body 引用 chromeVersion 故误判 unnecessary。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chromeVersion],
  );
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const switchTab = useEditorStore((s) => s.switchTab);
  // active tab 的派生 primitive,供右侧 action 区(打磨 R23/R45 + 性能 P14)。旧实现每次
  // store 更新都 `tabs.find(...) + JSON.stringify([filePath, dirty, effectiveMode])`
  // (O(tab 数) find + 小分配/序列化)。现复用 chromeVersion(P12 已扩展为也在
  // milkdownUnsafe 翻转时 bump)+ mode:订阅 activeTabId + chromeVersion + mode(均 O(1)),
  // 仅 active 切换 / chrome 真变化 / mode 变化时从 getState() 读 active tab 派生
  // [filePath, dirty, effectiveMode]。持续输入已脏 tab → 三者不变 → O(1) 跳过。
  const requestedMode = useEditorStore((s) => s.mode);
  const { activeFilePath, dirty, effectiveMode } = useMemo(() => {
    const found = findEditorFileTabById(useEditorStore.getState().tabs, activeTabId);
    return {
      activeFilePath: found?.filePath ?? null,
      dirty: found?.dirty ?? false,
      effectiveMode: getEffectiveMode(found),
    };
    // chromeVersion/requestedMode/activeTabId 作失效键:覆盖 filePath/dirty/milkdownUnsafe
    // (经 chromeVersion)+ mode + active 切换。eslint 看不到 body 引用故误判 unnecessary。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, chromeVersion, requestedMode]);

  const headerRef = useRef<HTMLDivElement>(null);
  const focusEditorContent = useCallback(() => focusEditorContentNextFrame(headerRef.current), []);
  // 同名文件 tab 的区分后缀(VSCode:重名时文件名后弱化显示最短区分父路径)。
  const descriptions = useMemo(() => tabLabelDescriptions(tabsChrome.map((c) => c.filePath)), [tabsChrome]);
  const tabsWrapperRef = useRef<HTMLDivElement>(null);
  const fades = useTabOverflowFades(tabsWrapperRef, tabsChrome);
  useRevealActiveTab(tabsWrapperRef, activeTabId, tabsChrome);

  if (tabsChrome.length === 0) return null;

  return (
    <div ref={headerRef} className="flex h-9 shrink-0 items-stretch bg-canvas">
      {/* 溢出:tab 栏横向滚动(不显示滚动条,竖向滚轮也可滚),两侧渐隐遮罩提示还有被遮住的 tab。 */}
      <div ref={tabsWrapperRef} className="relative flex min-w-0 flex-1" onWheel={scrollTabsOnWheel}>
      {/* a11y(A107):给 tablist 注入本地化组名(design 层无 i18n)。 */}
      <TabNav
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
        ariaLabel={t('shell.tab.editor_tablist')}
      >
        {tabsChrome.map((tab, i) => {
          const tabTitle = basename(tab.filePath);
          const description = descriptions[i];
          return (
            <TabNavItem
              key={tab.id}
              active={tab.id === activeTabId}
              dirty={tab.dirty}
              // a11y(A35):未保存状态文本传给 design TabNavItem(design 层无 i18n),AT 聚焦读出。
              dirtyLabel={t('panels.editor.unsaved_indicator')}
              // a11y(A106):icon-only 关闭按钮可访问名本地化(design 层无 i18n,调用点注入)。
              closeLabel={t('shell.tab.close', { title: tabTitle })}
              title={tab.filePath}
              onSelect={() => switchTab(tab.id)}
              onMouseSelect={focusEditorContent}
              onClose={() => onCloseRequest(tab)}
            >
              {tab.orphaned ? (
                <>
                  <span className="line-through">{tabTitle}</span>
                  <span className="ml-1.5">{t('panels.editor.tab_deleted')}</span>
                </>
              ) : (
                tabTitle
              )}
              {description != null && (
                <span data-testid="tab-description" className="ml-1.5 text-fg-dim">
                  {description}
                </span>
              )}
            </TabNavItem>
          );
        })}
      </TabNav>
      <div
        aria-hidden="true"
        data-testid="tab-overflow-fade-start"
        className={`${TAB_FADE_BASE_CLASS_NAME} left-0 bg-linear-to-r ${fades.start ? '' : 'opacity-0'}`}
      />
      <div
        aria-hidden="true"
        data-testid="tab-overflow-fade-end"
        className={`${TAB_FADE_BASE_CLASS_NAME} right-0 bg-linear-to-l ${fades.end ? '' : 'opacity-0'}`}
      />
      </div>

      {/* empty:hidden — 当无可见插件 action 时,本 div 的 children 全是 falsy
          /空 fragment,DOM 上是 :empty。隐藏避免空边框 + padding 在 tab 右侧
          形成"奇怪小矩形"。 */}
      <div className="flex shrink-0 items-center gap-2 border-l border-line px-3 text-xs empty:hidden">
        {/* 与 VSCode 对齐:不显「保存」按钮,dirty 走 TabNavItem 自带 ● + ⌘S */}

        {/* 插件贡献的 editor action(memo 子组件,plugin 启停时只本段重渲) */}
        <EditorActionsArea
          filePath={activeFilePath}
          dirty={dirty}
          mode={effectiveMode}
        />
      </div>
    </div>
  );
});
