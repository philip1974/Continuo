import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, PointerEvent } from 'react';
import { motion } from 'motion/react';
import type { DockviewPanelApi, IDockviewPanelHeaderProps } from 'dockview-react';
import { IconButton } from '@/design';
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

// dockview 把 IDockviewPanelHeaderProps + 若干 PointerEvent handler 通过展开传进来,
// 我们必须把这些 handler 转发到根 div,否则 tab 拖拽会失效。
type TabHtmlExtras = Pick<
  HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onPointerUp' | 'onPointerLeave'
>;

export function SharedTab(props: IDockviewPanelHeaderProps & TabHtmlExtras) {
  const { api, onPointerDown, onPointerUp, onPointerLeave } = props;
  const active = useIsActive(api);
  const title = useTitle(api);
  const groupId = api.group.id;
  const isMiddleDown = useRef(false);

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
        <motion.span
          layoutId={tabIndicatorLayoutId(groupId)}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-accent"
          transition={TAB_INDICATOR_SPRING}
        />
      )}
    </div>
  );
}
