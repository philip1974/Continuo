// dock 面板动作:dock 标题栏「⋯」菜单 / 「弹出到独立窗口」按钮(HeaderActions)与命令共用。
// 命令:显示输出 / 显示调试(已有同类面板 → 激活;没有 → 新建)、把活动面板所在组移到新窗口(VSCode
// workbench.action.moveEditorGroupToNewWindow)、重置布局(workbench.action.resetViewLocations)。WindowPlugin 注册。BDD: src/__tests__/command-discoverability/

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { popoutUrlFor } from '@/lib/popout-mode';
import { coApp } from '@/plugins/co-app';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { notify } from '@/notifications/notify';
import { t, tWithFallback } from '@/i18n';
import { addPanelAndFocus, getDockApi, revealDockPanel, runWhenDockLayoutReady } from './dock-api-ref';
import { activePanelInDocument, mainWindowAddPosition } from './group-mru';
import { getCommandDocument } from './popout-documents';
import { focusDockPanelSoon } from './panel-focus';
import { resetDockLayout } from './layout.default';

let panelCounter = 0;
/**
 * 下一个未被占用的面板 id。计数器是模块级、每次启动归零,而持久化布局会恢复 `output-1` 这类旧 id;
 * dockview 对重复 id 直接抛错,所以跳过已存在的。
 */
export function nextPanelId(key: string, isTaken: (id: string) => boolean): string {
  let id: string;
  do {
    id = `${key}-${++panelCounter}`;
  } while (isTaken(id));
  return id;
}

/** 把 panel 所在组弹出到独立窗口;失败(被拦截 / 抛错)给可见反馈,成功后焦点交给面板内容。 */
export function popoutPanel(api: DockviewApi, panel: IDockviewPanel): void {
  // a11y(A50,A46-A49 同族):addPopoutGroup 返回 Promise<boolean>,此前直接 void 丢弃异常 →
  // 弹出失败时按钮无响应、无 toast/live 反馈。catch 后 notify.error 给可见+可播报反馈。
  // 弹窗被拦截(window.open 返 null / 窗口立即被关)时 dockview resolve false 而非 reject → 同样反馈。
  const onFailed = (err: unknown): void => {
    console.warn('[dock] popout failed', err);
    notify.error(t('shell.dock.popout_failed'));
  };
  void api
    .addPopoutGroup(panel, {
      popoutUrl: popoutUrlFor(window.location.href),
    })
    .then((opened) => {
      if (opened === false) {
        onFailed('addPopoutGroup resolved false');
        return;
      }
      // VSCode:移到新窗口的编辑器直接获焦。子窗打开后焦点在其 body;面板内容随组挪进子窗,交给它(仍是活动面板才交)。
      // BDD: src/__tests__/keyboard-focus-parity/
      focusDockPanelSoon(panel, () => panel.api.isActive);
    }, onFailed);
}

/**
 * 显示某类面板:已有 → 在其所在窗口激活;没有 → 新建(主窗落点,同 ⌘, / app.dock.openPanel)。两者都把焦点交给面板内容
 *(VSCode openView(id, focus=true);BDD: open-panel-focus)。类型未注册 → 无操作。
 */
export function showPanelOfType(type: string): void {
  runWhenDockLayoutReady((api) => {
    const existing = api.panels.find((p) => p.view.contentComponent === type);
    if (existing) {
      revealDockPanel(api, existing);
      return;
    }
    const spec = coApp.panels.get(type);
    if (!spec) return;
    const position = mainWindowAddPosition(api);
    try {
      addPanelAndFocus(api, {
        id: spec.multiInstance === true ? nextPanelId(type, (id) => api.getPanel(id) != null) : type,
        component: type,
        title: tWithFallback(spec.titleKey, spec.title),
        ...(position ? { position } : {}),
        ...(spec.titleKey ? { params: { titleKey: spec.titleKey } } : {}),
      });
    } catch (err) {
      console.warn('[dock] add panel failed', err);
      notify.error(t('shell.dock.add_panel_failed'));
    }
  });
}

/** 弹出触发窗口的活动面板所在组(VSCode:命令作用于触发它的窗口);无活动面板 / 已在子窗 → 无操作。 */
function popoutActiveGroup(): void {
  const api = getDockApi();
  const panel = api && activePanelInDocument(api, getCommandDocument());
  if (!api || !panel || panel.group.api.location.type === 'popout') return;
  popoutPanel(api, panel);
}

export function dockCommandSpecs(): CommandSpec[] {
  return [
    {
      // 默认键对齐 VSCode(workbench.action.output.toggleOutput ⇧⌘U / Ctrl+Shift+U;Linux 为和弦 Ctrl+K Ctrl+H,项目不支持和弦、
      // 也不区分 Linux → 同 Windows)。BDD: src/__tests__/workbench-vscode-default-keys/
      id: 'workbench.view.output',
      hotkey: 'mod+shift+u',
      title: 'Show Output',
      titleKey: 'commands.view.show_output.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => showPanelOfType('output'),
    },
    {
      // VSCode「运行和调试」视图 ⇧⌘D / Ctrl+Shift+D
      id: 'workbench.view.debug',
      hotkey: 'mod+shift+d',
      title: 'Show Debug',
      titleKey: 'commands.view.show_debug.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => showPanelOfType('debug'),
    },
    {
      id: 'workbench.action.moveEditorGroupToNewWindow',
      title: 'Move Group into New Window',
      titleKey: 'commands.view.move_group_to_new_window.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: popoutActiveGroup,
    },
    {
      // VSCode workbench.action.resetViewLocations(View: Reset View Locations):有面板时也能把布局收回默认形态。
      // BDD: src/__tests__/dock-reset-layout/
      id: 'workbench.action.resetViewLocations',
      title: 'Reset Layout',
      titleKey: 'commands.view.reset_layout.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: () => runWhenDockLayoutReady(resetDockLayout),
    },
  ];
}
