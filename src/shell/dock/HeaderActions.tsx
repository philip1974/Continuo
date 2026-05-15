import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { isPopoutWindow, popoutUrlFor } from '@/lib/popout-mode';
import { IconButton, MenuItem } from '@/design';
import { coApp } from '@/plugins/co-app';
import { coApi } from '@/lib/co-api';
import { useWorkspaceStore } from '@/stores/workspace.store';

let panelCounter = 0;
const nextPanelId = (key: string) => `${key}-${++panelCounter}`;

interface AnchorRect {
  readonly top: number;
  readonly right: number;
}

export function HeaderActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group, activePanel } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  // 动态读取已注册 panel 类型(含内置 + 未来第三方插件)
  const [panelChoices, setPanelChoices] = useState(() => coApp.panels.getAll());
  useEffect(
    () =>
      coApp.panels.subscribe(() => setPanelChoices(coApp.panels.getAll())),
    [],
  );

  // 计算菜单坐标 — 用 trigger 按钮的 viewport rect。
  // 必须 portal 到 document.body:Dockview 祖先有 transform: translate3d(0,0,0)
  // 创建 stacking context,把 z-modal 困在 panel header 子树内,会被相邻
  // panel content 盖住。Portal 出去后 position:fixed 才真按 viewport 定位。
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      const inTrigger = ref.current?.contains(target) ?? false;
      const inMenu = menuRef.current?.contains(target) ?? false;
      if (!inTrigger && !inMenu) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);

  const addPanel = useCallback(
    async (key: string, label: string) => {
      if (key === 'terminal') {
        // terminal panel session-bound:不走 containerApi.addPanel,
        // 通过 coApi.terminal.create → SessionsSync → DockReconciler addPanel(含 sessionId)。
        const workspaceRoot = useWorkspaceStore.getState().root ?? undefined;
        const r = await coApi.terminal.create({
          ...(workspaceRoot !== undefined
            ? { cwd: workspaceRoot, workspaceRoot }
            : {}),
          originHint: 'user',
        });
        if (r.ok && r.data?.id) {
          const { setPendingFocus } = await import('@/shell/dock/DockReconciler');
          setPendingFocus(r.data.id);
        }
        setOpen(false);
        return;
      }
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
  const isPopout = isPopoutWindow();

  return (
    <div
      ref={ref}
      className="group/header relative flex h-full items-center gap-1 pr-1"
    >
      {!isPopout && (
        <>
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
        </>
      )}
      <IconButton
        ref={triggerRef}
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
      {open && anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
            className="z-modal min-w-[140px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/40"
          >
            {panelChoices.map((c) => (
              <MenuItem key={c.type} onClick={() => addPanel(c.type, c.title)}>
                {c.title}
              </MenuItem>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
