import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, PointerEvent } from 'react';
import { motion } from 'motion/react';
import type {
  DockviewApi,
  DockviewPanelApi,
  IDockviewPanelHeaderProps,
} from 'dockview-react';
import { IconButton } from '@/design';
import { t } from '@/i18n';
import {
  panelTitleLayoutId,
  tabIndicatorLayoutId,
  TAB_INDICATOR_SPRING,
  TAB_TITLE_SPRING,
} from './tokens';

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
  const active = useIsActive(api);
  const title = useTitle(api);
  const isMaximized = useIsThisGroupMaximized(api, containerApi);
  const groupId = api.group.id;
  const isMiddleDown = useRef(false);

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

  return (
    <div
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
          onPointerDown={(e) => e.preventDefault()}
          onClick={onExitMaximize}
          className="text-fg-muted hover:text-fg"
        >
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
        </IconButton>
      )}
      <IconButton
        size="xs"
        aria-label={`Close ${title}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
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
