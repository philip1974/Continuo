import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { popoutUrlFor } from '@/lib/popout-mode';
import { IconButton, MenuItem } from '@/design';
import { coApp } from '@/plugins/co-app';

let panelCounter = 0;
const nextPanelId = (key: string) => `${key}-${++panelCounter}`;

export function HeaderActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group, activePanel } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // 动态读取已注册 panel 类型(含内置 + 未来第三方插件)
  const [panelChoices, setPanelChoices] = useState(() => coApp.panels.getAll());
  useEffect(
    () =>
      coApp.panels.subscribe(() => setPanelChoices(coApp.panels.getAll())),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);

  const addPanel = useCallback(
    (key: string, label: string) => {
      const id = nextPanelId(key);
      containerApi.addPanel({
        id,
        component: key,
        title: label,
        position: { referenceGroup: group },
      });
      setOpen(false);
    },
    [containerApi, group],
  );

  const popout = useCallback(() => {
    if (!activePanel) return;
    void containerApi.addPopoutGroup(activePanel, {
      popoutUrl: popoutUrlFor(window.location.href),
    });
  }, [activePanel, containerApi]);

  return (
    <div
      ref={ref}
      className="group/header relative flex h-full items-center gap-1 pr-1"
    >
      <IconButton
        size="sm"
        aria-label="Pop out active panel"
        title="弹出到独立窗口"
        disabled={!activePanel}
        onClick={popout}
        className="opacity-40 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M9 2h5v5M14 2L8 8M12 9v4a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </IconButton>
      <IconButton
        size="sm"
        aria-label="More actions"
        title="更多操作"
        onClick={() => setOpen((v) => !v)}
        className="opacity-40 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          {/* horizontal ellipsis ⋯ */}
          <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
          <circle cx="8" cy="8" r="1.1" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
        </svg>
      </IconButton>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/40"
        >
          {panelChoices.map((c) => (
            <MenuItem key={c.type} onClick={() => addPanel(c.type, c.title)}>
              {c.title}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}
