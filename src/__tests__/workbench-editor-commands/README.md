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
4. **`workbench.action.nextEditor` / `workbench.action.previousEditor`**:在编辑器文件 tab 间循环切换(首尾相接);
   默认键按平台对齐 VSCode:mac `⌥⌘→` / `⌥⌘←`(`mod+alt+right` / `mod+alt+left`),其它 `Ctrl+PageDown` /
   `Ctrl+PageUp`。tab 数 < 2 → no-op。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-commands.ts` | 命令 id / 默认键、命令 spec、closeActiveEditor / saveActiveEditor / openAdjacentEditor,EditorPanel 动作注册 |
| `src/panels/Editor/EditorPanel.tsx` | 挂载时注册「保存 / 关当前 tab」实现(依赖面板内确认框状态) |
| `src/core-plugins/EditorPlugin.ts` | 注册上述命令 |
| `electron/main/index.ts` | File 菜单「关闭窗口」`Shift+CmdOrCtrl+W` |
| `electron/main/ipc/window.ipc.ts` | `window:close`:关闭发起方所在窗口(`win.close()`,走关窗脏确认) |

## 规范

- `editor-commands.spec.tsx`:关闭 / 保存 / 切换行为(jsdom,渲染 EditorPanel + 全局热键分发)
- `editor-commands-registration.spec.ts`:核心插件注册的 id / 默认键 / 三语标题
- 菜单项见 `dirty-close-confirm/close-confirm-flow.spec.ts`「File 菜单关闭窗口」;`window:close` 见 `window-close-ipc.spec.ts`
