import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, PointerEvent } from 'react';
import { motion } from 'motion/react';
import type { DockviewPanelApi, IDockviewPanelHeaderProps } from 'dockview-react';
import { tabIndicatorLayoutId, TAB_INDICATOR_SPRING } from './tokens';

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
      className="group/tab relative flex h-full cursor-pointer items-center gap-2 pl-3 pr-2 text-sm text-neutral-300"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <span className="select-none">{title}</span>
      <button
        type="button"
        aria-label={`Close ${title}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 transition hover:bg-white/10 hover:text-neutral-100 focus-visible:opacity-100 group-hover/tab:opacity-100"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {active && (
        <motion.span
          layoutId={tabIndicatorLayoutId(groupId)}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-sky-400"
          transition={TAB_INDICATOR_SPRING}
        />
      )}
    </div>
  );
}
