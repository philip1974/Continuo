import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { m } from 'motion/react';
import type {
  DockviewApi,
  DockviewPanelApi,
  IDockviewPanelHeaderProps,
} from 'dockview-react';
import { IconButton } from '@/design';
import { useT } from '@/i18n';
import { focusPanelContent } from '@/shell/dock/panel-focus';
import { closePanelsInOrder } from '@/shell/dock/wrap-panel-close';
import { TabContextMenu, type TabMenuEntry } from '@/lib/TabContextMenu';
import { tabCloseTargets, type TabCloseKind } from '@/lib/tab-close-targets';
import {
  panelTitleLayoutId,
  tabIndicatorLayoutId,
  TAB_INDICATOR_SPRING,
  TAB_TITLE_SPRING,
} from './tokens';

const EXIT_ZOOM_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    {/* 两组对角线箭头朝中心,语义 "exit fullscreen / shrink"。
        取 VSCode codicon screen-normal 简化版。 */}
    <path
      d="M6 3v3H3M3 6h3V3M10 3v3h3M13 6h-3V3M6 13v-3H3M3 10h3v3M10 13v-3h3M13 10h-3v3"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);
const CLOSE_TAB_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path
      d="M4 4l8 8M12 4l-8 8"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

function useIsActive(api: DockviewPanelApi): boolean {
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange((e) => setActive(e.isActive));
    return () => d.dispose();
  }, [api]);
  return active;
}

function useTitle(api: DockviewPanelApi): string {
  const [title, setTitle] = useState(api.title ?? '');
  useEffect(() => {
    const d = api.onDidTitleChange((e) => setTitle(e.title ?? ''));
    return () => d.dispose();
  }, [api]);
  return title;
}

// topic-22 follow-up: iTerm2 风 maximize 指示。订阅全局 onDidMaximizedGroupChange,
// 仅当事件中的 group 与本 tab 所属 group 相同时同步本地状态(其它 group max/exit
// 不影响)。初值用 api.group.api.isMaximized() 同步取。
function useIsThisGroupMaximized(
  api: DockviewPanelApi,
  containerApi: DockviewApi,
): boolean {
  const [maxed, setMaxed] = useState<boolean>(() => {
    try {
      return api.group.api.isMaximized();
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const d = containerApi.onDidMaximizedGroupChange((evt) => {
      if (evt.group !== api.group) return;
      setMaxed(evt.isMaximized);
    });
    return () => d.dispose();
  }, [api, containerApi]);
  return maxed;
}

export function SharedTab(props: IDockviewPanelHeaderProps) {
  const { api, containerApi } = props;
  // a11y(A125):用 useT() 订阅 locale,使关闭/退出缩放/tablist 等可访问名随语言切换实时更新
  //(此前静态 t 在 locale 变化时不重渲,aria-label 停留旧语言)。
  const t = useT();
  const active = useIsActive(api);
  const title = useTitle(api);
  // a11y:tab 名称只取标题(aria-labelledby),不按内容把关闭 / 退出最大化按钮的名称拼进来(对齐 VSCode tab)。
  const titleId = useId();
  const isMaximized = useIsThisGroupMaximized(api, containerApi);
  const groupId = api.group.id;
  const isMiddleDown = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // a11y(A121):SharedTab 子项是 role="tab",但 dockview 生成的父 tab-strip 容器
  // (.dv-tabs-container)没有 role="tablist"/名称 → role=tab 孤立,AT 不知这些 tab 同属一组,
  // 方向键 composite 模型也缺父语义。挂载时给最近的 tabs 容器补 role=tablist + 本地化 aria-label
  // (幂等:同容器多 tab 重复设无副作用;dockview 不控的 DOM 用 setAttribute 补语义)。
  useEffect(() => {
    const container = rootRef.current?.closest('.dv-tabs-container');
    if (!container) return;
    if (container.getAttribute('role') !== 'tablist') {
      container.setAttribute('role', 'tablist');
    }
    // a11y(A125):每次(含 locale 变化 → useT 重渲)重写 aria-label,使组名随语言更新,不再用
    // 「仅缺失时设」守卫(否则切语言后停留旧语言)。
    container.setAttribute('aria-label', t('shell.tab.dock_tablist'));
  });

  // dockview 的 Tab 构造时把外层 .dv-tab 写死 tabIndex=0:每个 tab 多一个无键盘行为的 Tab 停靠点,抵消下方内层
  // role=tab 的 roving。移出 Tab 顺序(鼠标仍可点),tab 条只剩活动 tab 一个停靠点(VSCode 同)。面板挪到别的组时
  // dockview 新建外层 tab、复用本组件的 DOM(不重挂载)→ 组变化后再设一次。BDD: src/__tests__/keyboard-focus-parity/
  useEffect(() => {
    const leaveTabOrder = (): void => {
      const outer = rootRef.current?.closest<HTMLElement>('.dv-tab');
      if (outer && outer.tabIndex !== -1) outer.tabIndex = -1;
    };
    leaveTabOrder();
    let disposed = false;
    const sub = api.onDidGroupChange(() => {
      queueMicrotask(() => {
        if (!disposed) leaveTabOrder();
      });
    });
    return () => {
      disposed = true;
      sub.dispose();
    };
  }, [api]);

  // topic-22 follow-up: 点击 icon = exitMaximizedGroup(整 group 退,与 zoom toggle
  // 命令对称)。stopPropagation 防止 tab pointerDown 把 drag 起来。
  const onExitMaximize = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        containerApi.exitMaximizedGroup();
      } catch {
        /* ignore — group 不再处于 maximized */
      }
    },
    [containerApi],
  );

  // close 路径的"标记 + 延迟"逻辑统一在 wrap-panel-close.ts 拦在 api.close 上,
  // 这里直接调 api.close() 即可。
  const onClose = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      api.close();
    },
    [api],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      isMiddleDown.current = event.button === 1;
    },
    [],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (isMiddleDown.current && event.button === 1) {
        isMiddleDown.current = false;
        api.close();
      }
    },
    [api],
  );

  const handlePointerLeave = useCallback(() => {
    isMiddleDown.current = false;
  }, []);

  // 鼠标点 tab(含已激活的 tab):mousedown 默认把焦点放到可获焦的 tab 根上,用户接着打字时按键落在 tab 而非
  // 终端 / 编辑器。click 时把焦点交回面板内容(VSCode 同款)。detail=0 是键盘(Enter/Space)合成的 click:
  // 保持 tablist 键盘模型,焦点留在 tab。关闭 / 退出缩放按钮的 click 已 stopPropagation,不会到这里。
  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.detail === 0 || event.button !== 0) return;
      focusPanelContent(api);
    },
    [api],
  );

  // a11y(A119/A120):tab 根键盘模型。Enter/Space 激活当前 tab;A120 补完整 WAI-ARIA tablist
  // 方向键模型 —— ArrowLeft/Right 在同组 tab 间循环移动并激活,Home/End 到首尾,且焦点跟随到
  // 新 active tab(经 data-panel-id 定位)。否则键盘用户 Tab 只能落到 active tab,无法切其它。
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        api.setActive();
        return;
      }
      // a11y(A123,A29 同族):tab 内关闭按钮移出 Tab 顺序(下方 tabIndex=-1)保 roving 复合控件
      // 模型;键盘关闭改由 tab 聚焦时 Delete 触发。不认 Backspace:焦点停在 tab 上时用户常以为还在终端 /
      // 编辑器里打字,退格即关 tab(终端 = 杀 PTY)。VSCode 的 tab 上也没有退格关闭。
      if (event.key === 'Delete') {
        event.preventDefault();
        api.close();
        return;
      }
      // a11y(A124,A123 后续):退出最大化按钮已移出 Tab 顺序(tabIndex=-1),须给键盘等价入口 —
      // 最大化状态下 Escape 退出缩放(覆盖任意 Dock group,非仅 terminal.zoom.toggle 的 terminal)。
      if (event.key === 'Escape' && isMaximized) {
        event.preventDefault();
        try {
          containerApi.exitMaximizedGroup();
        } catch {
          /* ignore — group 不再处于 maximized */
        }
        return;
      }
      const isArrow =
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'Home' ||
        event.key === 'End';
      if (!isArrow) return;
      // 同组有序 panel 列表;每个 panel 暴露 id + api.setActive()。
      const panels = api.group.panels as ReadonlyArray<{
        id: string;
        api: { setActive: () => void };
      }>;
      if (panels.length <= 1) return;
      event.preventDefault();
      let idx = -1;
      for (let i = 0; i < panels.length; i += 1) {
        if (panels[i]?.id === api.id) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      let targetIdx: number;
      if (event.key === 'Home') targetIdx = 0;
      else if (event.key === 'End') targetIdx = panels.length - 1;
      else {
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        targetIdx = (idx + delta + panels.length) % panels.length;
      }
      const target = panels[targetIdx];
      if (!target || target.id === api.id) return;
      target.api.setActive();
      // 焦点跟随到新 active tab(roving:WAI-ARIA tablist 焦点须随选中移动)。best-effort:
      // setActive 触发重渲后该 tab tabIndex 变 0,下一帧用 data-panel-id 定位并聚焦。
      const targetId = target.id;
      // 在 tab 所在文档里找(popout 子窗的 tab 条经 portal 渲染,全局 document 是主窗,找不到 → 焦点不跟随)。
      const doc = rootRef.current?.ownerDocument ?? document;
      requestAnimationFrame(() => {
        const el = doc.querySelector<HTMLElement>(
          `[role="tab"][data-panel-id="${targetId}"]`,
        );
        el?.focus();
      });
    },
    [api, isMaximized, containerApi],
  );

  // 右键菜单(VSCode 标签右键:关闭 / 关闭其他 / 关闭右侧 / 全部关闭)。dock 面板无「已保存」概念,不列「关闭已保存」。
  // 先逐个跑关闭确认(终端运行中程序),全部放行后再统一经 api.close() 关闭(含关闭动画);任一确认取消 → 整批不关。
  // BDD: src/__tests__/tab-context-menu/
  const menuEntries = useCallback((): TabMenuEntry[] => {
    const panels = api.group.panels;
    const close = (kind: TabCloseKind) => () => {
      const ids = new Set(tabCloseTargets(panels, api.id, kind));
      void closePanelsInOrder(panels.filter((p) => ids.has(p.id)));
    };
    const index = panels.findIndex((p) => p.id === api.id);
    return [
      { label: t('shell.tab.ctx.close'), onSelect: close('close') },
      { label: t('shell.tab.ctx.close_others'), onSelect: close('others'), disabled: panels.length <= 1 },
      { label: t('shell.tab.ctx.close_right'), onSelect: close('right'), disabled: index >= panels.length - 1 },
      'separator',
      { label: t('shell.tab.ctx.close_all'), onSelect: close('all') },
    ];
  }, [api, t]);

  return (
    <TabContextMenu entries={menuEntries}>
    <div
      ref={rootRef}
      // a11y(A119):Dock tab 须有 tab 语义 + 键盘模型。role=tab + aria-selected 暴露选中态;
      // roving tabIndex(仅 active 在 Tab 顺序);Enter/Space 激活(切到该 tab)。dockview 用
      // pointer 激活,这里补等价键盘入口。
      role="tab"
      aria-selected={active}
      aria-labelledby={titleId}
      tabIndex={active ? 0 : -1}
      // a11y(A120):data-panel-id 供方向键导航后焦点跟随定位新 active tab。
      data-panel-id={api.id}
      onKeyDown={handleKeyDown}
      className="group/tab relative flex h-full min-w-0 cursor-pointer items-center gap-2 pl-3 pr-2 text-sm text-fg"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
    >
      {/* 落点 ③:active tab 标题挂 layoutId,跨 group 拖动后让标题"飞"过去。
          只对 active 加,避免 inactive tab 的 portal 测量噪声(R2)。 */}
      {active ? (
        <m.span
          id={titleId}
          layoutId={panelTitleLayoutId(api.id)}
          className="min-w-0 truncate select-none"
          transition={TAB_TITLE_SPRING}
        >
          {title}
        </m.span>
      ) : (
        <span id={titleId} className="min-w-0 truncate select-none">{title}</span>
      )}
      {isMaximized && (
        // iTerm2-style maximize indicator. 只在 group maximized 时显示,放在 close 前。
        // 不靠 hover 隐藏 — 这是状态指示,需要始终可见。点击 = exit zoom。
        <IconButton
          size="xs"
          aria-label={t('shell.tab.exit_zoom')}
          title={t('shell.tab.exit_zoom')}
          data-testid="tab-maximize-indicator"
          // a11y(A123):移出 Tab 顺序保 tablist roving 复合控件模型(同关闭按钮)。
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={onExitMaximize}
          className="text-fg-muted hover:text-fg"
        >
          {EXIT_ZOOM_ICON}
        </IconButton>
      )}
      <IconButton
        size="xs"
        // a11y(A105):icon-only 关闭按钮可访问名须本地化(原硬编码英文 `Close ${title}`,
        // zh/ko 界面 SR 读英文);含 title 区分多 tab。
        aria-label={t('shell.tab.close', { title })}
        title={t('shell.tab.close', { title })}
        // a11y(A123,A29 同族):关闭按钮移出 Tab 顺序,保「一次 Tab 进 tablist、方向键移动」
        // 复合控件模型;键盘关闭由 tab 根 Delete 触发(见 handleKeyDown)。
        tabIndex={-1}
        // 极窄组(dockview.css 容器查询)隐藏,让出宽度给标题;仍可 ⌘W / 中键 / Delete 关闭。
        data-tab-close=""
        onPointerDown={(e) => e.preventDefault()}
        onClick={onClose}
        // 激活 tab 常显(同编辑器 tab,TabNav);其余悬停 / 键盘聚焦时显示。
        className={active ? undefined : 'opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100'}
      >
        {CLOSE_TAB_ICON}
      </IconButton>
      {active && (
        // 顶部 accent line(VSCode workbench tab 风格)。放底部会与下一行
        // EditorHeader 的 TabNav active underline 视觉撞,形成"双下划线"。
        <m.span
          layoutId={tabIndicatorLayoutId(groupId)}
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent"
          transition={TAB_INDICATOR_SPRING}
        />
      )}
    </div>
    </TabContextMenu>
  );
}
