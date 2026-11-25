# 键盘焦点与区域导航(VSCode 对齐)

VSCode:代码编辑器里 Tab 缩进、⇧Tab 反缩进(Esc 后 Tab / ⌃M 切换「Tab 移动焦点」供键盘用户逃逸);
F6 / ⇧F6(`workbench.action.focusNextPart` / `focusPreviousPart`)在工作台各区域间循环;编辑器移到新窗口后直接获焦;
点背景 tab 的 × 活动编辑器保持焦点;tab 条只有一个 Tab 停靠点(方向键移动),焦点指示为 focusBorder 蓝;
关掉最后一个编辑器后焦点留在空编辑器组;F6 能进空编辑器组;编辑器全弹出到子窗时主窗保留带水印的空编辑器组,F6 可达。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/CodeEditor.tsx` | `keymap.of([indentWithTab])`:Tab / ⇧Tab 缩进;Esc 后 Tab 交给浏览器移出焦点(CodeMirror 内建 tab focus mode) |
| `src/shell/dock/HeaderActions.tsx` | 弹出到独立窗口成功 → `focusDockPanelSoon` 把焦点交给子窗里的面板内容 |
| `src/shell/dock/group-mru.ts` | 被移除组的活动面板仍在(随组挪进 popout / 别的组)→ 只激活该面板,不回落到同窗别的面板 |
| `src/design/TabNav.tsx` | 关闭按钮 pointerdown / mousedown 不抢焦点 |
| `src/shell/motion/SharedTab.tsx` / `src/styles/dockview.css` | 外层 `.dv-tab` 移出 Tab 顺序(去掉 tabindex,不可聚焦 —— tablist 下可聚焦的只有 role=tab,axe aria-required-children);焦点指示只在 focus-visible 时由 `::after` 显示、用 `--md-focus-ring`,`.dv-tab` / 内层 role=tab 自身不画系统 outline |
| `src/shell/dock/wrap-panel-close.ts` | `activateDockPanel`:面板已是活动组里的活动面板(`api.isActive`)时只撤销排定关闭、不再 setActive(避免 dockview 重挂内容 DOM 丢焦点) |
| `src/lib/content-focus-target.ts` | 面板内容焦点落点选择器(contenteditable / 输入框 / `data-editor-focus-target`),dock 面板聚焦与编辑器 tab 行共用 |
| `src/shell/dock/panel-focus.ts` | 面板内容无可编辑 / 可 Tab 元素时回退到面板根(`[data-editor-panel-root]` / 内容根下 tabIndex=-1 的根元素) |
| `src/shell/dock/EmptyState.tsx` / `src/shell/dock/group-mru.ts` | 主窗空态(`data-dock-empty`,tabIndex=-1);`isMainWindowDockEmpty` 按主窗内面板数判空 |
| `src/panels/Editor/EditorPanel.tsx` | 关掉最后一个 tab 后焦点给面板根(tabIndex=-1) |
| `src/shell/focus-parts.ts` | F6 / ⇧F6 命令:活动 dock 组 → 状态栏 → 侧栏循环 |
| `src/panels/Terminal/terminal-hotkeys.ts` | F6 / ⇧F6 在终端里让出给命令(VSCode commandsToSkipShell 默认含 focusNextPart / focusPreviousPart) |
| `src/plugins/command-palette/useCommandHotkeys.ts` | 无修饰的功能键(F1–F24)绑定在可编辑控件里照常分发(不是文字输入键) |

## 行为

### 1. 代码编辑器 Tab(`code-editor-tab.spec.tsx`)

- Tab 缩进当前行 / 选区(indentMore),⇧Tab 反缩进(indentLess),焦点留在编辑器
- 按 Esc 后紧接着 Tab:编辑器不处理(浏览器默认把焦点移到下一个控件);⌃M(mac ⇧⌥M)切换常驻 Tab 移动焦点模式
- Markdown「编辑」模式(Milkdown / Crepe)保持 Crepe 默认:列表项 Tab 缩进 / ⇧Tab 反缩进,代码块内 Tab 缩进,
  普通段落 Tab 不处理(焦点移出)—— 与 VSCode 的纯文本 Markdown 编辑器不同,属富文本编辑器惯例

### 2. 弹出到独立窗口(`popout-focus.spec.tsx`)

- 弹出成功(addPopoutGroup resolve true)→ 下一个 microtask 里面板仍是活动面板时,子窗里的面板内容获焦;失败 / 已不活动 → 不动焦点
- 源组随弹出被移除(浮动组弹出)时,MRU 不再把同窗别的面板设为活动(终端被激活会自己抢焦点);活动面板随面板走

### 3. 编辑器 tab 关闭按钮(`tabnav-close-focus.spec.tsx`)

- TabNav 关闭按钮的 pointerdown / mousedown 被 preventDefault:点背景 tab 的 × 不把焦点从编辑器移走

### 4. dock tab 条一个 Tab 停靠点(`dock-tab-single-stop.spec.tsx`)

- SharedTab 挂载后外层 `.dv-tab`(dockview 写死 tabIndex=0)改为 -1,Tab 顺序里只剩内层 role=tab(roving:仅活动 tab 为 0)
- `.dv-tab` 获焦指示默认透明,仅键盘焦点(focus-visible)时显示,颜色 `--md-focus-ring`
- 外层 `.dv-tab` 与内层 role=tab 的 `:focus-visible` 自身 `outline: none`(不叠 Chromium 默认系统强调色 / base 层通用焦点环),只由 `::after` 显示

### 5. 关闭最后一个编辑器 tab(`editor-empty-focus.spec.tsx`)

- 焦点在编辑器面板里关掉最后一个 tab → 焦点留在编辑器面板根(空编辑器组),不掉到 body;焦点在面板外 → 不动

### 6. F6 区域切换(`focus-parts.spec.ts`)

- `workbench.action.focusNextPart`(F6)/ `focusPreviousPart`(⇧F6),三语标题,分类「查看」
- 顺序:活动 dock 组(活动面板内容,同 `focusPanelContent`)→ 状态栏(第一个控件)→ 侧栏(Explorer 树当前项)→ 循环;
  ⇧F6 反向;不可聚焦 / 隐藏的区域跳过;焦点不在任何区域 → F6 / ⇧F6 都先到活动 dock 组(VSCode 同)
- 活动面板在 popout 子窗时,主窗 F6 不跳过 dock:激活并聚焦主窗(grid / floating)最近使用的组(组 MRU)的活动面板
  (VSCode:主窗 F6 只在主窗自己的区域循环)
- 空编辑器组(关光 tab,内容只剩 tabIndex=-1 的面板根):F6 聚焦面板根(VSCode:F6 落到空编辑器组),不跳过 dock
- 空编辑器的 Welcome 带「打开文件夹 / 显示所有命令」按钮时,F6 仍聚焦编辑器面板根而非第一个按钮(水印入口不抢焦点,Tab 再进);打开了文件时仍优先聚焦可编辑区
- 主窗没有面板(全关光,或所有组都弹出到子窗 —— DockShell 按主窗内面板数判空,显示空态):F6 聚焦主窗空态容器
- 终端里 F6 / ⇧F6 让出给命令(不发给 shell);编辑器(CodeMirror / ProseMirror)里 F6 照常触发命令

### 7. 再次激活已活动的面板不丢焦点(`reactivate-active-panel.spec.ts`)

- dockview 6 对已活动面板 `setActive` 仍 openPanel → renderPanel,把面板内容 DOM 摘下再挂回,内容里的焦点掉到 body。
  编辑器 tab 行在 editor 面板内容里:键盘 ←/→ 移到另一 tab 后 Enter / Space 激活(editorFocusPulse → DockShell 激活
  editor 面板)焦点随之丢失。VSCode:键盘激活编辑器 tab 焦点留在 tab,Tab 再进编辑区
- `activateDockPanel`:面板是活动组里的活动面板 → 不 setActive(焦点留在原处),仍撤销排定中的关闭;组不是活动组 /
  面板不是组内活动面板 → 照常激活
- 其它重挂触发点:dockview tab pointerdown 只对非活动面板 openPanel;MRU 回落 / F6 / popout 收回在激活后再聚焦内容;
  SharedTab 的 Enter / Space 焦点在 tab 条(内容之外),不受重挂影响

## 端到端

- `tests/e2e/keyboard-focus-parity.spec.ts`:代码编辑器 Tab 缩进、Esc+Tab 移出;编辑器里 F6 → 状态栏 → 侧栏 → 回编辑器;
  空编辑区 F6 进编辑区;编辑器 tab 上 ←/→ + Enter / Space 激活后焦点留在 tab,Tab 进入编辑区
