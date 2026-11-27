import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { IconButton, MenuItem } from '@/design';
import { MoreActionsIcon } from '@/lib/ui-icons';
import { DropdownMenu, type DropdownMenuControls } from '@/lib/dropdown-menu';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { addPanelAndFocus, openOrFocusPanelNow } from '@/shell/dock/dock-api-ref';
import { nextPanelId, popoutPanel } from '@/shell/dock/dock-panel-actions';
import { notify } from '@/notifications/notify';
import { useTWithFallback, useT, t } from '@/i18n';
import { labelDockTablist } from '@/shell/dock/dock-tablist';
import { commandHotkeyText } from '@/lib/hotkey-label';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';

/**
 * 面板类型 → 打开它的命令(菜单项右侧显示该命令当前生效键位,VSCode 菜单同款):新建终端 ⌘T、在文件中查找 ⇧⌘F、设置 ⌘,。
 */
const PANEL_OPEN_COMMAND: ReadonlyMap<string, string> = new Map([
  [TERMINAL_PANEL_TYPE, 'terminal.new'],
  ['search', 'workbench.action.findInFiles'],
  ['settings', 'settings.toggle'],
]);

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
const MORE_ACTIONS_ICON = <MoreActionsIcon size={14} />;

export function HeaderActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group, activePanel } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tk = useTWithFallback();
  const tl = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  // a11y:组级补本组 tab 条的 tablist 名称 —— header actions 每个组都渲染(含无 tab 的空组),SharedTab 只在有 tab 时
  // 渲染:面板全弹出到子窗后主窗空占位组的 tablist 名称此前切语言不更新。每次渲染(useT 订阅 locale)重写。
  useEffect(() => {
    const header = rootRef.current?.closest('.dv-tabs-and-actions-container');
    labelDockTablist(header?.querySelector('.dv-tabs-container'), tl('shell.tab.dock_tablist'));
  });
  const popoutLabel = t('shell.dock.popout_title');
  const moreActionsLabel = t('panels.explorer.btn.more_actions');
  // 动态读取已注册 panel 类型(含内置 + 未来第三方插件)
  const panelChoices = useRegistry(coApp.panels);
  // 键位提示:改键 / 命令注册变化后跟随
  const overrides = useKeybindingsStore((s) => s.overrides);
  useRegistry(coApp.commands);
  // 成功新建面板时只关菜单:新面板 / 终端接管焦点(addPanelAndFocus / openOrFocusPanelNow 在内容挂载后交焦点,
  // createUserTerminal 经 setPendingFocus;BDD: open-panel-focus);失败分支 closeAndRestore,焦点回到触发按钮而非 body。
  const addPanel = useCallback(
    async (
      key: string,
      label: string,
      titleKey: string | undefined,
      multiInstance: boolean,
      menu: DropdownMenuControls,
    ) => {
      if (key === TERMINAL_PANEL_TYPE) {
        // terminal panel session-bound:不走 containerApi.addPanel,而是经
        // createUserTerminal → coApi.terminal.create → SessionsSync → DockReconciler
        // addPanel(含 sessionId)。创建流程(等 workspace root 恢复 / 错误提示 / setPendingFocus)与
        // 命令面板 terminal.new 共用(可维护性 M1);此处只负责关闭菜单 UI 收尾。
        // 失败(无可解析 cwd / IPC reject 等,内部已 notify)返回 null → 焦点还给触发按钮,不落到 body。
        const id = await createUserTerminal();
        if (id) menu.close();
        else menu.closeAndRestore();
        return;
      }
      try {
        const position = { referenceGroup: group };
        if (multiInstance) {
          addPanelAndFocus(containerApi, {
            id: nextPanelId(key, (id) => containerApi.getPanel(id) != null),
            component: key,
            title: label,
            position,
            ...(titleKey ? { params: { titleKey } } : {}),
          });
        } else {
          // 单例(PanelSpec 未声明 multiInstance):与 ⌘, / DockShell editor / app.dock.openPanel 同按固定
          // id = type 打开,已有则聚焦。
          openOrFocusPanelNow(containerApi, key, key, label, titleKey, position);
        }
      } catch (err) {
        // addPanel 同步抛(id 冲突 / component 不存在等):给可见反馈,菜单关闭并还原焦点。
        console.warn('[dock] add panel failed', err);
        notify.error(t('shell.dock.add_panel_failed'));
        menu.closeAndRestore();
        return;
      }
      menu.close();
    },
    [containerApi, group],
  );

  const popout = useCallback(() => {
    // 先关「⋯」菜单:面板弹走后主窗不再有焦点事件能关它(键盘 / 程序触发时没有 pointerdown)。
    setOpen(false);
    if (activePanel) popoutPanel(containerApi, activePanel);
  }, [activePanel, containerApi]);
  // header 由主窗 React 经 portal 渲染进子窗,window.location 恒为主窗 → 只能按组的实际位置判定。
  // 位置变化时 dockview 会以新 location 重渲 header actions。
  const isPopout = group.api.location.type === 'popout';

  return (
    <div
      ref={rootRef}
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
            // 极窄组(dockview.css 容器查询)隐藏,让出宽度给活动 tab 标题。
            data-dock-popout=""
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
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
      >
        {(menu) =>
          panelChoices.map((c) => {
            const label = tk(c.titleKey, c.title);
            return (
              <MenuItem
                key={c.type}
                shortcut={commandHotkeyText(coApp.commands.get(PANEL_OPEN_COMMAND.get(c.type) ?? ''), overrides)}
                // race(R60,R59 同族):点击时按 type 从 live coApp.panels 复查,而非用打开菜单时
                // 捕获的快照。菜单打开期间该 panel type 可能被插件 disable/reload unregister;
                // 已移除则关菜单不创建(否则得到 component 不存在的空白 panel,同 type 重注册时还
                // 可能以旧 title/params 复活)。存在则用 live title/titleKey。
                onClick={() => {
                  const live = coApp.panels.get(c.type);
                  if (!live) {
                    menu.closeAndRestore();
                    return;
                  }
                  void addPanel(
                    c.type,
                    tk(live.titleKey, live.title),
                    live.titleKey,
                    live.multiInstance === true,
                    menu,
                  );
                }}
              >
                {label}
              </MenuItem>
            );
          })
        }
      </DropdownMenu>
    </div>
  );
}
