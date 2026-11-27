# 工作台编辑器命令(⌘W / ⌘S / 下一个·上一个编辑器)

行为契约(对齐 VSCode 同名命令):

1. **`workbench.action.closeActiveEditor`(默认 `mod+w`,三语标题「关闭编辑器」)**:
   - dock 活动面板是编辑器且有活动文件 tab → 只关当前文件 tab,走与 tab × 相同的关闭路径(脏 tab 弹
     「保存 / 不保存 / 取消」,干净 tab 直接关);窗口与编辑器面板都保留;
   - 活动面板是其它面板(终端 / 输出 / 设置 / 调试…),或编辑器面板已没有文件 tab → 关闭该面板(`panel.api.close()`,
     与 dock tab × 同一路径,含关闭动画与面板自己的关闭守卫);
   - 没有可关的面板(无 dock / 无活动面板)→ 关闭当前窗口(经 main `win.close()`,走关窗脏确认)。
2. **关窗口 = `⇧⌘W` / `Ctrl+Shift+W`**:应用菜单 File 里的「关闭窗口」自定义项(三语),accelerator
   `Shift+CmdOrCtrl+W`,所有平台一致;mac 不再用 `{ role: 'close' }`(它自带 ⌘W,直接关整窗并杀掉窗内全部终端)。
3. **`workbench.action.files.save`(默认 `mod+s`,三语标题「保存」)**:保存当前活动文件 tab,焦点在哪都生效
  (Explorer、终端让出后、dock 其它面板);与编辑器面板内 ⌘S 同一实现(含磁盘已被外部修改时的「仍然覆盖」确认),
   一次按键只保存一次;命令面板里可见可执行。编辑器面板内按键按**生效绑定**判定(用户改绑 / 解绑后跟随)。
   提示里写到保存键的文案(磁盘冲突的 `errors.EDITOR_DISK_CHANGED`、关窗保存失败的
   `dialog.unsaved_close.disk_changed_note`,三语)用 `{hotkey}` 填**当前生效绑定**(`saveHotkeyLabel`,按平台格式化;
   未绑定 → 命令标题),改绑保存后提示跟随,不再写死 Cmd/Ctrl+S(`save-hotkey-label.spec.tsx`)。
   没有可保存的 tab(无编辑器 tab 时按 ⌘S)→ 静默,不弹「没有活动标签页」(VSCode 同);真实保存失败仍提示。
4. **`workbench.action.nextEditor` / `workbench.action.previousEditor`**:在编辑器文件 tab 间循环切换(首尾相接);
   默认键按平台对齐 VSCode:mac `⌥⌘→` / `⌥⌘←`(`mod+alt+right` / `mod+alt+left`),其它 `Ctrl+PageDown` /
   `Ctrl+PageUp`。tab 数 < 2 → no-op。
5. **`workbench.action.files.revert`(无默认键,三语标题「还原文件」)**:把活动文件 tab 换回磁盘内容、丢弃未保存修改,见
   `src/__tests__/editor-revert-file/`。
6. **popout 子窗里同样生效**:焦点在 dockview popout 子窗时,关闭编辑器、重新打开已关闭的编辑器(⇧⌘T,落在该子窗,
   见 `src/__tests__/editor-reopen-closed/` 第 6 条)、⌃Tab / ⌃⇧Tab(`src/__tests__/editor-recent-cycle/`)、⌃` 切换终端
  (`src/__tests__/terminal-toggle/`)、后退 / 前进(`src/__tests__/editor-navigation-history/`,子窗与主窗共用导航栈)与下一个 / 上一个编辑器按**生效绑定**在该子窗
   分发,执行同一命令(作用于**该子窗**的活动面板,见第 7 条);mac 上 ⌘W 不再因去掉菜单 `role: 'close'` 而在
   子窗里无反应。⌃G 转到行、⌃R 打开最近、F1 显示所有命令同样在子窗分发(选择器画在该子窗,见 `src/__tests__/popout-picker/`);
   放大 / 缩小 / 重置缩放也在子窗分发(只改设置值,所有窗口统一,见 `src/__tests__/window-zoom/`)。
   颜色主题 / 切换浅深(绑了键时)同样在子窗分发(见 `src/__tests__/theme-commands/`)。
   其它命令(新终端、设置等效果画在主窗)不在子窗分发;保存由编辑器面板自己的按键处理覆盖。子窗关闭 /
   hook 卸载时移除该文档上的监听。子窗与主窗**同一张表裁决**:按键在完整分发表里的胜者属于子窗白名单才执行;别的命令经
   用户改绑占了该键(快捷键页标关闭编辑器落败)→ 子窗里该键既不关 tab 也不执行那条命令、不截事件。
7. **窗口级命令只作用于触发它的窗口**(VSCode:命令作用于按键所在窗口;辅助窗口获焦时其编辑器组成为活动组):
   - 全局热键分发经 `runInCommandDocument(按键所在文档)` 运行命令,命令用 `getCommandDocument()` 判断触发窗口(非热键入口
     —— 命令面板 / 菜单 —— 取有焦点的 popout 子窗,没有则主窗);窗口内的活动面板 = `activePanelInDocument`(主窗:主窗正
     显示的活动面板;子窗:该子窗组的活动面板)。**不看 dock 全局 activePanel**:点子窗标题栏 / ⌘` 切到子窗不改活动组,
     从子窗切回主窗时它仍在子窗;
   - ⌘W 在子窗:关该子窗的活动面板 / 编辑器 tab,**绝不关主窗的面板或主窗**;该子窗没有可关的面板 → 只关这个子窗;
   - ⌘W 在主窗(含活动组仍在子窗时):关主窗正显示的面板;主窗没有可关的面板 → 关主窗(window:close);
   - 同源命令一并按触发窗口:终端「查找」/「清屏」(`terminal.search.toggle` / `terminal.clear`)、重新打开已关闭的编辑器
     (`src/__tests__/editor-reopen-closed/` 第 6 条);
   - popout 子窗获得焦点(窗口 `focus`:点标题栏 / ⌘`;或焦点进入子窗元素 `focusin`)→ 其组成为 dock 活动组
     (`trackGroupMru` 跟踪;dockview 只在面板内容获焦时激活组)。停止跟踪 / 组移除后不再响应。
8. **编辑器组类命令作用于触发窗口的编辑器组;主窗获焦 → 主窗最近使用的组成为活动组**(VSCode 同):
   - 主窗获得焦点(窗口 `focus`:从子窗点主窗标题栏 / 资源管理器 / ⌘` 切回)而 dock 活动组在 popout 子窗 → 主窗最近使用的
     (带面板的)组成为 dock 活动组,活动编辑器组随之回到主窗;**不移 DOM 焦点**(焦点留在用户点的资源管理器等处)。活动组本就
     在主窗 → 不动;停止跟踪后不再响应;
   - 重启恢复:dockview 挂上 popout 子窗时把子窗的组设为活动组(覆盖 fromJSON 恢复的主窗活动组,活动编辑器组随之改成子窗的组
     并被写盘)→ popout 恢复落定时改回主窗最近使用的组(即恢复出的活动组);恢复期间用户已切到该子窗(子窗有焦点)→ 不改;
   - 编辑器组类命令(拆分 ⌘\ / 向下拆分、⌘S 保存、还原文件、组内关闭「其它 / 右侧 / 已保存 / 全部」、复制路径 / 相对路径、
     在 Finder 中显示、Markdown 模式切换、下一个 / 上一个编辑器)作用于 `commandEditorGroupId()`:触发窗口
     (`getCommandDocument`)的编辑器组 —— 该窗口活动面板是编辑器组 → 它;否则活动编辑器组在该窗口 → 它;否则该窗口最近使用
     的编辑器组;该窗口没有编辑器组 → no-op。**不看全局活动编辑器组**(从子窗切回主窗时它可能仍在子窗:⌘\ 在子窗新建组、
     「关闭组中的所有编辑器」关掉子窗的 tab);
   - 同源:⇧⌘Enter 最大化终端、「将组移到新窗口」作用于触发窗口的活动面板(`activePanelInDocument`);⇧⌘T 在主窗里原组已不在
     时落在主窗的编辑器组(`src/__tests__/editor-reopen-closed/`)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-commands.ts` | 命令 id / 默认键、命令 spec、closeActiveEditor / saveActiveEditor / openAdjacentEditor,EditorPanel 动作注册 |
| `src/panels/Editor/EditorPanel.tsx` | 挂载时注册「保存 / 关当前 tab」实现(依赖面板内确认框状态) |
| `src/core-plugins/EditorPlugin.ts` | 注册上述命令 |
| `src/plugins/command-palette/useCommandHotkeys.ts` | 全局热键分发;`POPOUT_HOTKEY_COMMAND_IDS` 在 popout 子窗文档分发;经 `runInCommandDocument` 标明按键所在窗口 |
| `src/shell/dock/popout-documents.ts` | `runInCommandDocument` / `getCommandDocument`:命令的触发窗口 |
| `src/shell/dock/group-mru.ts` | `popoutGroupOfDocument` / `activePanelInDocument` / `editorGroupInDocument`:触发窗口的组 / 活动面板 / 编辑器组;子窗获焦 → 其组成为活动组;主窗获焦 / popout 恢复落定 → 主窗最近使用的组成为活动组 |
| `src/panels/Editor/editor-groups-actions.ts` | `commandEditorGroupId`:编辑器组类命令作用的组 |
| `electron/main/index.ts` | File 菜单「关闭窗口」`Shift+CmdOrCtrl+W` |
| `electron/main/ipc/window.ipc.ts` | `window:close`:关闭发起方所在窗口(`win.close()`,走关窗脏确认) |

## 规范

- `editor-commands.spec.tsx`:关闭 / 保存 / 切换行为(jsdom,渲染 EditorPanel + 全局热键分发)
- `editor-commands-registration.spec.ts`:核心插件注册的 id / 默认键 / 三语标题
- `save-hotkey-label.spec.tsx`:保存键文案填当前生效绑定
- `popout-hotkeys.spec.tsx`:popout 子窗按键分发(白名单、生效绑定、监听随子窗移除)
- `popout-close-target.spec.tsx`:⌘W 只作用于按键所在窗口(子窗不关主窗、空子窗只关子窗、主窗不关子窗面板);子窗获焦 → 活动组
- `popout-editor-group-target.spec.tsx`:第 8 条(主窗获焦 / 恢复落定改回主窗活动组;编辑器组类命令、⇧⌘Enter、移到新窗口按触发窗口)
- 端到端:`tests/e2e/popout-window-scope.spec.ts`(关掉 Playwright 焦点模拟、真实切换窗口)
- 菜单项见 `dirty-close-confirm/close-confirm-flow.spec.ts`「File 菜单关闭窗口」;`window:close` 见 `window-close-ipc.spec.ts`
