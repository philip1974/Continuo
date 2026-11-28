# 关闭弹窗 / tab / 面板后的焦点归属(VSCode 对齐)

VSCode:Esc 关闭 Quick Input(⌘P / ⌘⇧P)后焦点回到打开前的编辑器 / 视图;关闭活动编辑器后同组新的活动编辑器获焦,
可直接继续输入;焦点原本不在被关的编辑器 / 面板里时不抢焦点。

## 模块

| 文件 | 职责 |
|---|---|
| `src/design/Modal.tsx` | 打开时记下打开前的焦点;关闭时仅当焦点仍在弹窗里(已落到 body)才还原 |
| `src/design/focus-within-or-lost.ts` | `focusWithinOrLost`:焦点在容器内或已丢失(body / 脱离文档) |
| `src/plugins/quick-open/QuickOpenModal.tsx` / `src/plugins/command-palette/CommandPalette.tsx` | 输入框初始焦点用 `data-autofocus` |
| `src/panels/Editor/EditorPanel.tsx` | 面板内关闭 tab 的唯一入口 `closeTab`:关前焦点在本面板 / body → 关后 `focusActiveEditor()` |
| `src/shell/dock/panel-focus.ts` | `focusPanelContent` / `focusDockPanelSoon`:点 tab、关组 MRU 回落、关面板后新活动面板共用;`trackDropFocus`:拖放 tab 后焦点丢失时活动面板获焦 |
| `src/shell/dock/wrap-panel-close.ts` | 真关闭前判断焦点是否在本组;关后同组新的活动面板获焦 |
| `src/shell/dock/group-mru.ts` | 关掉整组后回落的面板(不限终端)获焦;焦点原不在该组时只换活动组 |

## 行为

### 1. Esc 关闭 Quick Open / 命令面板(`modal-esc-focus.spec.tsx`)

- 打开时输入框获焦;Esc 关闭后焦点回到打开前的元素(编辑器 / Explorer 行),不掉到 body
- Modal 内的初始焦点只用 `data-autofocus`:React `autoFocus` 在 commit 期就聚焦,Modal 随后记下的「打开前焦点」
  会变成弹窗里的输入框,关闭后聚焦已卸载的输入框 → body(静态扫描守护:渲染 `<Modal` 的组件不出现 `autoFocus`)
- 命令面板执行的命令自己把焦点移到别处 → 关闭时不还原覆盖;关闭期间焦点已在弹窗外 → 同样不还原

### 2. 关闭编辑器 tab / 同组面板(`editor-tab-close-focus.spec.tsx`、`dock-panel-close-focus.spec.ts`)

- 编辑器:焦点在编辑器面板里(编辑区 / tab 行 / 本面板的关闭确认框)或已在 body 时,⌘W / 点 × / 确认框「不保存」
  「保存」关闭活动 tab 后,新的活动 tab 的编辑器获焦;一批关闭(右键关闭其他 / 关闭已保存…)按全部关完后的活动 tab 聚焦;
  只关掉非活动 tab 时仅当焦点随被关的标签一起丢失(tab 右键菜单「关闭」先把焦点还给被右键的 tab)才交给本组活动编辑器,
  焦点仍在编辑区 / 其它标签上不动;焦点在面板外(如 Explorer)不动焦点
- dock:关闭同组里非最后一个、且是组内活动的面板(⌘W / 点 tab × / 终端以 0 退出自动关闭)前焦点在该组里或在 body →
  同组新的活动面板获焦(终端走 xterm 句柄,其它面板聚焦内容里的可编辑元素);关闭非活动面板时仅当焦点随它的 tab 一起丢失
  (右键菜单「关闭」)才交给同组活动面板;焦点在组外 / 仍在别处 → 不动焦点
- 关掉编辑器组(关掉组里最后一个编辑器):焦点移到最近使用的编辑器组;该编辑器组所在 dock 组正显示的是别的面板(冲突比较 /
  设置页 / 终端)时不切走它,激活它所在组并把焦点交给它(VSCode:MRU 组正显示的编辑器不变;`activateGroupKeepingShown`,
  `close-group-keeps-shown-panel.spec.ts`)
- 关掉整组:MRU 回落的面板(终端 / 编辑器等)获焦,仅当焦点原在被移除的组里;popout 子窗关闭收回的面板总获焦
  (见 `dock-terminal-vscode-focus` 第 3 条)

### 3. 拖放 dock tab 后(`dock-drop-focus.spec.ts`)

- dockview 移动面板后只激活不移 DOM 焦点:按下 tab 时焦点在 tab 上,tab 随移动被摘下 → 焦点落 body。拖到别的组分栏 /
  叠放 / 同组换位后,若焦点已丢失,活动面板(即被拖的面板)获焦(`trackDropFocus`,`src/shell/dock/panel-focus.ts`;终端走
  xterm 句柄)。VSCode:拖放编辑器后它成为活动编辑器并获焦
- 只认拖放(订阅 `onWillDrop`,dockview 在同一次 drop 处理里随后同步移动面板;移动的 `onDidMovePanel` 派发时拖放数据已随
  被摘下的 tab 清掉,分不出拖放);重置布局等程序化移动由调用方负责焦点(见 `dock-reset-layout`);焦点在别处(如 Explorer)不抢

## 端到端

- `tests/e2e/focus-after-close.spec.ts`:Esc 关闭 Quick Open 后焦点回编辑器;⌘W 关 tab 后直接键入进入下一个 tab;
  Explorer 双击文件后直接键入进入编辑器;三组分栏把「编辑器 2」的 dock tab 拖到组 3 右缘 / 叠放后直接键入进入编辑器 2
