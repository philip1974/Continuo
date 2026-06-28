import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent, PointerEvent } from 'react';
import { motion } from 'motion/react';
import type {
  DockviewApi,
  DockviewPanelApi,
  IDockviewPanelHeaderProps,
} from 'dockview-react';
import { IconButton } from '@/design';
import { useT } from '@/i18n';
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

// dockview 把 IDockviewPanelHeaderProps + 若干 PointerEvent handler 通过展开传进来,
// 我们必须把这些 handler 转发到根 div,否则 tab 拖拽会失效。
type TabHtmlExtras = Pick<
  HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onPointerUp' | 'onPointerLeave'
>;

export function SharedTab(props: IDockviewPanelHeaderProps & TabHtmlExtras) {
  const { api, containerApi, onPointerDown, onPointerUp, onPointerLeave } = props;
  // a11y(A125):用 useT() 订阅 locale,使关闭/退出缩放/tablist 等可访问名随语言切换实时更新
  //(此前静态 t 在 locale 变化时不重渲,aria-label 停留旧语言)。
  const t = useT();
  const active = useIsActive(api);
  const title = useTitle(api);
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
      onPointerDown?.(event);
    },
    [onPointerDown],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (isMiddleDown.current && event.button === 1) {
        isMiddleDown.current = false;
        api.close();
      }
      onPointerUp?.(event);
    },
    [api, onPointerUp],
  );

  const handlePointerLeave = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      isMiddleDown.current = false;
      onPointerLeave?.(event);
    },
    [onPointerLeave],
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
      // 模型;键盘关闭改由 tab 聚焦时 Delete/Backspace 触发。
      if (event.key === 'Delete' || event.key === 'Backspace') {
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
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[role="tab"][data-panel-id="${targetId}"]`,
        );
        el?.focus();
      });
    },
    [api, isMaximized, containerApi],
  );

  return (
    <div
      ref={rootRef}
      // a11y(A119):Dock tab 须有 tab 语义 + 键盘模型。role=tab + aria-selected 暴露选中态;
      // roving tabIndex(仅 active 在 Tab 顺序);Enter/Space 激活(切到该 tab)。dockview 用
      // pointer 激活,这里补等价键盘入口。
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      // a11y(A120):data-panel-id 供方向键导航后焦点跟随定位新 active tab。
      data-panel-id={api.id}
      onKeyDown={handleKeyDown}
      className="group/tab relative flex h-full cursor-pointer items-center gap-2 pl-3 pr-2 text-sm text-fg"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      {/* 落点 ③:active tab 标题挂 layoutId,跨 group 拖动后让标题"飞"过去。
          只对 active 加,避免 inactive tab 的 portal 测量噪声(R2)。 */}
      {active ? (
        <motion.span
          layoutId={panelTitleLayoutId(api.id)}
          className="select-none"
          transition={TAB_TITLE_SPRING}
        >
          {title}
        </motion.span>
      ) : (
        <span className="select-none">{title}</span>
      )}
      {isMaximized && (
        // iTerm2-style maximize indicator. 只在 group maximized 时显示,放在 close 前。
        // 不靠 hover 隐藏 — 这是状态指示,需要始终可见。点击 = exit zoom。
        <IconButton
          size="xs"
          aria-label={t('shell.tab.exit_zoom')}
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
        // a11y(A123,A29 同族):关闭按钮移出 Tab 顺序,保「一次 Tab 进 tablist、方向键移动」
        // 复合控件模型;键盘关闭由 tab 根 Delete/Backspace 触发(见 handleKeyDown)。
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100"
      >
        {CLOSE_TAB_ICON}
      </IconButton>
      {active && (
        // 顶部 accent line(VSCode workbench tab 风格)。放底部会与下一行
        // EditorHeader 的 TabNav active underline 视觉撞,形成"双下划线"。
        <motion.span
          layoutId={tabIndicatorLayoutId(groupId)}
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent"
          transition={TAB_INDICATOR_SPRING}
        />
      )}
    </div>
  );
}
