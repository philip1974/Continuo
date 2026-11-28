// 48px 竖向 Activity Bar(VSCode 风),Dockview 之外、main 之内。
// 顶部:内置导航(VSCode 活动栏默认顺序 资源管理器 / 搜索 / 源代码管理 / 运行和调试 / 扩展,取本项目有的:资源管理器、搜索、
// 运行和调试)。中段:plugin 通过 ribbon 贡献的图标。
// 底部:Settings 等元类(产品无账户体系,不放账户头像 chip)。
// Explorer 按钮 toggle 左侧 Explorer Sidebar 显隐(active 状态显示左侧 accent bar);
// Settings 按钮开关 Settings 面板。

import { useRegistry } from '@/plugins/registries/useRegistry';
import { Folder } from '@react-symbols/icons';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { NavRailButton } from '@/design';
import { coApp } from '@/plugins/co-app';
import { PluginRenderBoundary } from '@/plugins/PluginRenderBoundary';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';
import { useAvailableUpdates } from '@/marketplace/update-store';
import { runContributedAction, runRegisteredCommand } from '@/lib/run-contributed-action';
import { useT } from '@/i18n';
import { useRegisteredCommandHotkeyText, withHotkey } from '@/lib/hotkey-label';

interface IconBarItemConfig {
  id: string;
  label: string;
  /** 悬停 tooltip「名称 (⌘B)」(VSCode 活动栏):对应命令的当前生效键位;可访问名称仍是 label。 */
  tooltip?: string;
  node: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}

const ICON_SIZE = 22;
// a11y(A34):Settings 更新角标的稳定 id,供 NavRailButton aria-describedby 关联。
const SETTINGS_UPDATE_BADGE_ID = 'icon-sidebar-settings-updates';

/** Lucide Settings 齿轮 SVG(stroke 风格,跟 Folder 等图标视觉一致). */
function SettingsGearIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Lucide search(放大镜,stroke 风格同齿轮)。 */
function SearchIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.3-4.3" />
    </svg>
  );
}

/** 运行和调试(仿 VSCode codicon debug-alt:播放三角 + 小虫;stroke 风格同齿轮)。 */
function RunDebugIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 3.5v11l7.5-5.5z" />
      <rect x="14" y="12" width="7" height="9" rx="3.5" />
      <path d="M15.5 12l-1-1.5M19.5 12l1-1.5M14 16.5h-2M21 16.5h2" />
    </svg>
  );
}

const EXPLORER_ICON = <Folder width={ICON_SIZE} height={ICON_SIZE} />;
const SEARCH_ICON = <SearchIcon size={ICON_SIZE} />;
const RUN_DEBUG_ICON = <RunDebugIcon size={ICON_SIZE} />;
const SETTINGS_ICON = <SettingsGearIcon size={ICON_SIZE} />;

/** 活动栏「搜索」/「运行和调试」执行的命令(VSCode workbench.view.search ⇧⌘F / workbench.view.debug ⇧⌘D)。 */
const ACTIVITY_SEARCH_COMMAND_ID = 'workbench.action.findInFiles';
const ACTIVITY_DEBUG_COMMAND_ID = 'workbench.view.debug';

export function IconSidebar() {
  const t = useT();
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutUiStore((s) => s.toggleSidebar);
  const ribbonActions = useRegistry(coApp.ribbon);
  // Marketplace 更新数 → Settings 齿轮右上角红圈
  const updateCount = useAvailableUpdates().length;
  const toggleSidebarHotkey = useRegisteredCommandHotkeyText(coApp.commands, 'explorer.toggleSidebar');
  const settingsHotkey = useRegisteredCommandHotkeyText(coApp.commands, 'settings.toggle');
  const searchHotkey = useRegisteredCommandHotkeyText(coApp.commands, ACTIVITY_SEARCH_COMMAND_ID);
  const debugHotkey = useRegisteredCommandHotkeyText(coApp.commands, ACTIVITY_DEBUG_COMMAND_ID);

  const explorerLabel = sidebarOpen ? t('shell.iconbar.hide_explorer') : t('shell.iconbar.show_explorer');
  const explorerItem: IconBarItemConfig = {
    id: 'explorer',
    label: explorerLabel,
    tooltip: withHotkey(explorerLabel, toggleSidebarHotkey),
    node: EXPLORER_ICON,
    onClick: toggleSidebar,
    active: sidebarOpen,
  };
  // 打开 / 聚焦对应面板(与 ⇧⌘F / ⇧⌘D 同一命令;命令抛错弹 error toast)
  const commandItem = (id: string, commandId: string, label: string, hotkey: string | undefined, node: React.ReactNode) => ({
    id,
    label,
    tooltip: withHotkey(label, hotkey),
    node,
    onClick: () => void runRegisteredCommand(coApp.commands, commandId, label),
  });
  const searchItem: IconBarItemConfig = commandItem(
    'search',
    ACTIVITY_SEARCH_COMMAND_ID,
    t('shell.iconbar.search'),
    searchHotkey,
    SEARCH_ICON,
  );
  const debugItem: IconBarItemConfig = commandItem(
    'debug',
    ACTIVITY_DEBUG_COMMAND_ID,
    t('shell.iconbar.run_debug'),
    debugHotkey,
    RUN_DEBUG_ICON,
  );
  const settingsUpdateTooltip =
    updateCount > 0
      ? t('shell.iconbar.updates_tooltip', { count: updateCount })
      : '';

  const settingsItem: IconBarItemConfig = {
    id: 'settings',
    label: t('shell.iconbar.settings'),
    tooltip: withHotkey(t('shell.iconbar.settings'), settingsHotkey),
    node: SETTINGS_ICON,
    onClick: toggleSettingsPanel,
  };

  const renderItem = (item: IconBarItemConfig, describedById?: string) => (
    <NavRailButton
      key={item.id}
      title={item.label}
      tooltip={item.tooltip}
      // a11y(A33,A32 调用点传播):只有声明了状态的真 toggle(如 explorer=sidebarOpen)才传
      // active → 暴露 aria-pressed;undefined 会由 NavRailButton 视作未提供,避免 `?? false`
      // 强转出 aria-pressed="false" 被 AT 误读成切换按钮,且不再为 fallback 分配对象。
      active={item.active}
      onClick={item.onClick}
      // a11y(A34):更新角标 aria-label 在独立 span 上,经 aria-describedby 关联到按钮,聚焦时读出。
      describedById={describedById}
    >
      {item.node}
    </NavRailButton>
  );

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-line bg-panel py-2">
      <div className="flex flex-col items-center gap-1">
        {renderItem(explorerItem)}
        {renderItem(searchItem)}
        {renderItem(debugItem)}
        {ribbonActions.length > 0 && (
          <span
            className="my-1 h-px w-6 bg-line"
            aria-hidden="true"
          />
        )}
        {ribbonActions.map((r) => (
          <NavRailButton
            key={r.id}
            title={r.title}
            // ribbon onClick 可返回 Promise(契约允许);插件抛错(同步 throw 或 async
            // reject)经 runContributedAction 弹 error toast,不再静默吞。见第十四轮
            // P2-AO + 第二十一轮 P1-AX(统一到共享 helper)。
            // race(R52,R51 同族):click 时按 id 从 live coApp.ribbon 重查再执行,而非调捕获的
            // r.onClick。插件 disable/reload unregister 后、到 React 重渲移除按钮前,旧 handler 仍可
            // 触发已卸载插件 action;重查使死 action 静默忽略。
            onClick={() =>
              runContributedAction(r.title, () => {
                const live = coApp.ribbon.get(r.id);
                if (!live) return;
                return live.onClick();
              })
            }
          >
            {/* 插件图标渲染抛错只替换成错误图标(BDD: plugin-render-isolation)。 */}
            <PluginRenderBoundary owner={r} variant="inline">
              {r.icon}
            </PluginRenderBoundary>
          </NavRailButton>
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        {updateCount > 0 ? (
          <div key={settingsItem.id} className="relative">
            {renderItem(settingsItem, SETTINGS_UPDATE_BADGE_ID)}
            <span
              id={SETTINGS_UPDATE_BADGE_ID}
              className="pointer-events-none absolute right-0.5 top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-error px-1 text-2xs font-medium leading-none text-on-error"
              title={settingsUpdateTooltip}
              aria-label={settingsUpdateTooltip}
            >
              {updateCount > 9 ? '9+' : updateCount}
            </span>
          </div>
        ) : (
          renderItem(settingsItem)
        )}
      </div>
    </aside>
  );
}
