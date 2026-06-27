import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { isPopoutWindow, popoutUrlFor } from '@/lib/popout-mode';
import { IconButton, MenuItem } from '@/design';
import { useMenuKeyboard } from '@/lib/use-menu-keyboard';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { notify } from '@/notifications/notify';
import { useTWithFallback, t } from '@/i18n';

let panelCounter = 0;
const nextPanelId = (key: string) => `${key}-${++panelCounter}`;
const POPOUT_ICON = (
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
);
const MORE_ACTIONS_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    {/* horizontal ellipsis ⋯ */}
    <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
  </svg>
);

interface AnchorRect {
  readonly top: number;
  readonly right: number;
}

export function HeaderActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group, activePanel } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const tk = useTWithFallback();
  const popoutLabel = t('shell.dock.popout_title');
  const moreActionsLabel = t('panels.explorer.btn.more_actions');
  // 动态读取已注册 panel 类型(含内置 + 未来第三方插件)
  const panelChoices = useRegistry(coApp.panels);
  // a11y(A18,ExplorerHeader 同族):菜单打开移焦入首项 + Escape 还原焦点 + 方向键漫游。
  const {
    menuRef,
    menuNode,
    onKeyDown: onMenuKeyDown,
  } = useMenuKeyboard({
    open,
    triggerRef,
    onClose: () => setOpen(false),
  });

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
      const inMenu = menuNode.current?.contains(target) ?? false;
      if (!inTrigger && !inMenu) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open, menuNode]);

  const addPanel = useCallback(
    async (
      key: string,
      label: string,
      titleKey: string | undefined,
    ) => {
      if (key === TERMINAL_PANEL_TYPE) {
        // terminal panel session-bound:不走 containerApi.addPanel,而是经
        // createUserTerminal → coApi.terminal.create → SessionsSync → DockReconciler
        // addPanel(含 sessionId)。创建流程(等 hydrate / 错误提示 / setPendingFocus)与
        // 命令面板 terminal.new 共用(可维护性 M1);此处只负责关闭菜单 UI 收尾。
        await createUserTerminal();
        setOpen(false);
        return;
      }
      const id = nextPanelId(key);
      containerApi.addPanel({
        id,
        component: key,
        title: label,
        position: { referenceGroup: group },
        ...(titleKey ? { params: { titleKey } } : {}),
      });
      setOpen(false);
    },
    [containerApi, group],
  );

  const popout = useCallback(() => {
    if (!activePanel) return;
    // a11y(A50,A46-A49 同族):addPopoutGroup 返回 Promise<boolean>,此前直接 void 丢弃异常 →
    // 弹出失败时按钮无响应、无 toast/live 反馈。catch 后 notify.error 给可见+可播报反馈。
    void containerApi
      .addPopoutGroup(activePanel, {
        popoutUrl: popoutUrlFor(window.location.href),
      })
      .catch((err) => {
        console.warn('[dock] popout failed', err);
        notify.error(t('shell.dock.popout_failed'));
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
            // aria-label 走 i18n(打磨 R38),复用 popout title 键,与 hover title 一致
            aria-label={popoutLabel}
            title={popoutLabel}
            disabled={!activePanel}
            onClick={popout}
            className="opacity-40 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
          >
            {POPOUT_ICON}
          </IconButton>
        </>
      )}
      <IconButton
        ref={triggerRef}
        size="sm"
        // aria-label 走 i18n(打磨 R38),复用 more_actions 键,与 hover title 一致
        aria-label={moreActionsLabel}
        title={moreActionsLabel}
        // a11y(A7,A6 同族):菜单触发须告知 AT 弹 role=menu 及当前展开态。
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="opacity-40 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
      >
        {MORE_ACTIONS_ICON}
      </IconButton>
      {open && anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
            className="z-modal min-w-[140px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/40"
          >
            {panelChoices.map((c) => {
              const label = tk(c.titleKey, c.title);
              return (
                <MenuItem
                  key={c.type}
                  // race(R60,R59 同族):点击时按 type 从 live coApp.panels 复查,而非用打开菜单时
                  // 捕获的快照。菜单打开期间该 panel type 可能被插件 disable/reload unregister;
                  // 已移除则关菜单不创建(否则得到 component 不存在的空白 panel,同 type 重注册时还
                  // 可能以旧 title/params 复活)。存在则用 live title/titleKey。
                  onClick={() => {
                    const live = coApp.panels.get(c.type);
                    if (!live) {
                      setOpen(false);
                      return;
                    }
                    addPanel(c.type, tk(live.titleKey, live.title), live.titleKey);
                  }}
                >
                  {label}
                </MenuItem>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
