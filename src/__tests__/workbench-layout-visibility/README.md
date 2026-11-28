# 查看 › 外观:状态栏 / 活动栏 / 标签栏显隐、最大化编辑器组、切换全屏

行为契约:**「查看: 切换状态栏可见性」「查看: 切换活动栏可见性」「查看: 显示多个编辑器标签页 / 隐藏编辑器标签页」改对应设置
(跨窗口同步、重启保持),显示菜单的「外观」子菜单有同样的勾选项;隐藏后布局占满、F6 跳过隐藏的区域。状态栏隐藏期间受限模式 /
agent 授权这两个安全指示仍显示在一条只含它们的精简状态栏里。「查看: 切换最大化编辑器组」在命令面板可见、可在快捷键页绑键。
「查看: 切换全屏」带默认键(mac ⌃⌘F、Windows / Linux F11),可改键,菜单项是命令项、显示生效键位。**

## 对照 VSCode

- `src/vs/workbench/browser/actions/layoutActions.ts`:`workbench.action.toggleStatusbarVisibility`(翻转
  `workbench.statusBar.visible`,菜单 `MenubarAppearanceMenu` `2_workbench_layout`,toggled);`hideEditorTabs` /
  `showMultipleEditorTabs` 设 `workbench.editor.showTabs`(none / multiple;外观 › 标签栏 ▸ 子菜单 `3_workbench_layout_move`);
  显示菜单 `2_appearance` 的「外观」子菜单。
- `src/vs/workbench/browser/parts/sidebar/sidebarPart.ts`:`workbench.action.toggleActivityBarVisibility`(`workbench.activityBar.location`
  在 hidden 与之前位置间切换)。
- `src/vs/workbench/browser/parts/editor/editorTitleControl.ts` / `noEditorTabsControl.ts`:`showTabs: none` 用
  `NoEditorTabsControl`(高度 0:文件 tab 与编辑器操作工具栏都不显示,面包屑另行照常);只作用于编辑器组,面板区(终端等)tab 不受影响。
- `src/vs/workbench/browser/parts/editor/editorActions.ts` `ToggleMaximizeEditorGroupAction`:`f1: true`,默认键只有和弦 ⌘K ⌘M。
- `src/vs/workbench/browser/actions/windowActions.ts` `ToggleFullScreenAction`:F11,mac ⌃⌘F;外观菜单 `1_toggle_view` 首项;
  `DEFAULT_COMMANDS_TO_SKIP_SHELL` 含它(终端里让出)。

**刻意差异**:`workbench.activityBar.location` 只有 default / hidden(本项目活动栏只在侧边);`workbench.editor.showTabs` 只有
multiple / none(无 single);none 隐藏编辑器文件 tab 行,dock 组 tab 栏只在组里仅有一个编辑器面板时随之隐藏(此时它只是重复的
「编辑器」标题),编辑器与终端等面板同组、或只有终端的组照常显示 dock tab 栏(否则同组面板没法用鼠标切换;本项目没有面包屑);外观菜单里活动栏是勾选项(VSCode 是「活动栏位置 ▸」
子菜单),全屏不带勾选;缩放项留在显示菜单原位置;最大化编辑器组不绑默认键(项目不支持和弦);状态栏隐藏时保留安全指示的精简
状态栏(VSCode 受限模式另有不随状态栏隐藏的横幅;本项目没有横幅,撤销 agent 授权也只在状态栏)。没有可用主窗时外观菜单的全屏直接
切换获焦窗口(此前的 role 行为)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/core-setting-specs.ts` | `WORKBENCH_STATUS_BAR_VISIBLE` / `WORKBENCH_ACTIVITY_BAR_LOCATION` / `WORKBENCH_EDITOR_SHOW_TABS` |
| `src/shell/workbench-layout.ts` | 显隐命令、最大化编辑器组命令、`WorkbenchLayoutFromSettings`(<html data-editor-show-tabs>) |
| `src/shell/StatusBar.tsx` / `IconSidebar.tsx` | 按设置隐藏(状态栏保留安全指示) |
| `src/panels/Editor/EditorHeader.tsx` | `showTabs = none` 时不渲染文件 tab 行(连同编辑器操作) |
| `src/styles/dockview.css` | `data-editor-show-tabs="none"` 时隐藏只含一个编辑器面板的 dock 组的 tab 栏 |
| `src/shell/window-commands.ts` | 切换全屏默认键 |
| `electron/main/app-menu.ts` | 显示 › 外观 子菜单 |
| `src/shell/menu-commands.ts` | 外观勾选状态推送 |

## 规范文件

- `layout-visibility.spec.tsx`(renderer)
- `layout-menu.spec.ts`(应用菜单)

## 关键行为

1. 三个设置:VSCode 同 id,默认显示 / default / multiple,三语文案;通用 / 编辑器 tab 注册。
2. 命令:分类「查看」,无默认键;切换写设置(回到默认值时删掉覆盖)。
3. 状态栏隐藏 → 不渲染;有受限模式 / agent 授权时只渲染含它们的精简状态栏。活动栏隐藏 → 不渲染。
4. 标签栏隐藏 → 各窗口 `<html data-editor-show-tabs="none">`;编辑器文件 tab 行(连同编辑器操作)不渲染;只含一个编辑器面板的
   dock 组 tab 栏 `display: none`,与终端等同组 / 只有终端的组照常显示。
5. 最大化编辑器组:多组时最大化活动组、再执行还原;单组无操作。
6. 切换全屏:mac `ctrl+mod+f`、其它 `f11`;popout 子窗分发;终端获焦时让出。
7. 菜单:显示 › 外观 = 全屏(命令项,accelerator = 生效键位)| 状态栏、活动栏(勾选)| 标签栏 ▸ 多个标签页 / 隐藏(勾选);
   不再有 role togglefullscreen;勾选状态由 renderer 推送。

## e2e

`tests/e2e/presentation-mode.spec.ts`:命令隐藏状态栏、外观菜单隐藏活动栏,重启后保持;外观菜单全屏显示 ⌃⌘F;命令面板找到最大化
编辑器组与切换全屏(带键位);菜单 / 命令恢复显示。
