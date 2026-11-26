# tab 右键菜单(对齐 VSCode 编辑器标签右键菜单)

编辑器文件 tab(`EditorHeader` 的 `TabNavItem`)与 dock 面板 tab(`SharedTab`:终端 / 设置 / Debug / 输出 / 编辑器组 / 插件
面板)右键弹出菜单;此前只处理中键,右键无反应。外壳共用 `src/lib/TabContextMenu.tsx`(Radix ContextMenu + design
`MenuItem`,同 Explorer / 终端右键菜单),菜单画在 tab 所在文档(popout 子窗里画在子窗)。

## 菜单项

| tab | 项(VSCode 同名同序) |
|---|---|
| 编辑器文件 tab | 关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭 ─ 复制路径 / 复制相对路径 ─ 在 Finder 中显示 ─ 向右拆分 / 向下拆分(见 `src/__tests__/editor-groups/`) |
| dock 面板 tab | 关闭 / 关闭其他 / 关闭右侧 ─ 全部关闭(面板无「已保存」概念,不列「关闭已保存」) |

- 「关闭其他」只有一个 tab 时禁用;「关闭右侧」在最右 tab 上禁用。
- 复制相对路径相对当前 workspace 根(无根 → 绝对路径);复制 / 显示失败给 toast(同 Explorer)。已删除(orphaned)的文件
  tab「在 Finder 中显示」禁用。
- 文案三语(`shell.tab.ctx.*`;路径项复用 `panels.explorer.ctx.*`)。

## 关闭语义(VSCode `editorGroupView.closeEditors` / `handleCloseConfirmation`)

- 目标集合(`src/lib/tab-close-targets.ts`,按 tab 顺序):关闭 = 自己;关闭其他 = 除自己外全部;关闭右侧 = 自己右边的;
  关闭已保存 = 不脏的;全部关闭 = 全部。
- **编辑器 tab**(`src/panels/Editor/tab-batch-close.ts` + `EditorPanel`):单个关闭与批量关闭同一路径。
  - 这批里**只有 1 个**仍脏的 tab:沿用「保存 / 不保存 / 取消」确认框(批量时先切到该 tab)。
  - **多于 1 个**:先弹**一个**合并确认框(VSCode `showSaveConfirm`):标题「是否要保存对以下 N 个文件的更改?」,逐行列出
    文件名(列表样式同资源管理器删除确认,最多 10 个,其余一行「…另有 N 个文件未列出」)+ 丢失提示;按钮「全部保存」(主按钮、
    初始焦点)/「不保存」/「取消」。「不保存」→ 不写盘、全部关闭;「取消」→ 整批不动。
  - 「全部保存」= 按 tab 顺序逐个保存(不再逐个询问)。遇磁盘已被外部修改 / 写保护 → 走该文件已有的覆盖确认:「覆盖」/
    「放弃并重新加载」成功 → 接着保存下一个;该确认「取消」或写盘 / 还原失败 → 整批结束、一个都不关。其它保存失败 → 失败提示
    (带文件名与原因),整批结束、一个都不关,改动留在 tab 里;之前已保存成功的文件已落盘(tab 保持打开、变为未修改),
    后面的不再保存 —— 与单文件「保存」失败不关闭的语义一致,用户处理后可再次关闭(此时合并框只列仍脏的文件)。
  - **全部处理完才一起关闭**。单文件确认框:任一处「取消」→ 整批都不关(先前选「保存」的已落盘)。
- **dock 面板 tab**(`closePanelsInOrder`,对齐 VSCode `closeEditors`):先按顺序逐个跑各面板的关闭确认(终端运行中程序;
  确认框同时只有一个),全部放行后再按序统一 `api.close()`(关闭动画照旧,此时不再重复确认);任一处选「取消」→ 整批都不关
  (含前面已放行的)。单个关闭(× / 中键 / ⌘W / 右键「关闭」)仍是 `api.close()` 先问再关。

## 焦点(`tab-context-menu-focus.spec.tsx`)

- 关闭类项(编辑器 tab 的关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭;dock tab 的关闭 / 关闭其他 / 关闭右侧 / 全部关闭)
  标 `opensDialog`:菜单先关闭、焦点按 Radix 还原到打开菜单前的 tab,**之后**才执行。否则 Radix 在菜单卸载后(setTimeout)才还原,
  抢走刚弹出的确认框的初始焦点(焦点留在背后 tab,Tab 进 CodeMirror)。期望同 VSCode:确认框模态,初始焦点在「全部保存」/
  「保存」(dock:终端运行中程序的关闭确认同理)。
- 不弹框(无脏文件)时同 ⌘W / 点 ×:动作看到的焦点在本面板的 tab 上 → 关掉活动 tab 后焦点进(全部关完后)新的活动编辑器;
  只关掉非活动 tab:被右键的 tab 随之移除(关闭 / 关闭已保存)→ 焦点不落 body,留在该组活动编辑器(VSCode 同点 ×);
  被右键的 tab 还在(关闭其他 / 关闭右侧只关了别的非活动 tab)→ 焦点没丢,留在该 tab 上(只在焦点丢失时补)。
  dock 面板 tab 同理:右键「关闭」非活动面板后焦点进同组活动面板(`wrap-panel-close`)。
- 菜单关闭后,**只在焦点已丢失**(随菜单卸载落到 body / 脱离文档)时回到**触发 tab**(右键 / Shift+F10 时的那个 tab),
  popout 子窗里同样回到子窗里的 tab(外壳自己还原:Radix FocusScope 按全局 document = 主窗记录 / 还原,子窗里会落到 body);
  随后确认框「取消」/ Esc → 焦点回该 tab(VSCode 辅助窗口同)。通用规则,不逐项标注:
  - 动作自己移动了焦点 → 以它为准:「向右拆分 / 向下拆分」新组的编辑器获焦、成为活动组(同 ⌘\,VSCode 同);
  - 不移动焦点的项(复制路径 / 复制相对路径 / 在 Finder 中显示)、Esc → 回到 tab;
  - 点菜单外部:被点处拿到了焦点(主窗点编辑器正文)→ 以它为准;没拿到(popout 子窗:菜单打开期间子窗 body 是
    `pointer-events:none`(Radix 模态菜单,菜单卸载即还原、无残留),mousedown 落到 `<html>`,Chromium 不把焦点给被点处)
    → 回到 tab,键入不丢;再点正文即进编辑器。
- 「重命名…」等随后打开自聚焦输入框的项仍是 `opensFocusedInput`(跳过还原);资源管理器右键「移到废纸篓」的确认框已由其
  `skipOnce` + FolderTree 接管焦点,不属本外壳。

## 键盘

tab 聚焦时 **Shift+F10 / 菜单键** 在 tab 左下角打开菜单(与终端右键菜单同一判定 `src/lib/context-menu-key.ts`);菜单内
方向键 / Enter / Esc 由 Radix 负责。双击 tab / 双击 tab 栏空白不做(前几轮已评估)。

## 规范

`tab-context-menu-focus.spec.tsx`(右键关闭后确认框拿到焦点、不弹框时焦点进新的活动编辑器、关掉非活动的被右键 tab 后焦点留在活动编辑器、外壳 opensDialog 语义、
动作移动焦点时不还原 / 不移动时回 tab、子窗点外部焦点丢失时回 tab);
`tab-context-menu.spec.tsx`(目标集合、批量确认推进、两类 tab 的菜单项与动作、键盘打开、dock 批量关闭先问完再关 / 遇取消
整批不动);`editor-batch-close-confirm.spec.tsx`(多个脏文件的合并确认框:列表 / 全部保存 / 不保存 / 取消;「全部保存」中途遇写保护 / 磁盘冲突确认后继续或整批结束、其它失败整批结束);
真机 e2e `tests/e2e/tab-context-menu.spec.ts`(编辑器 tab 全部关闭遇脏文件确认、多个脏文件合并框「全部保存」遇写保护覆盖后继续、dock tab 关闭其他、
popout 子窗关闭 / 点正文关闭后的焦点、右键关闭非活动 tab 后可直接键入)与 `tests/e2e/editor-split.spec.ts`(右键「向下拆分」后新组获焦)。
