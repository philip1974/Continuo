# EditorWelcome(无 tab 占位)

行为契约:**编辑区无 tab 时显示「未打开文件」+ VSCode 空编辑区水印式的下一步入口(按钮 + 实际快捷键)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/EditorWelcome.tsx` | UI |

## 关键行为

- 标题「未打开文件」,aria-hidden 装饰图标 svg。
- 无工作区:「打开文件夹 ⌘O」(执行已注册的 `workbench.action.files.openFolder` 命令)、「显示所有命令 ⇧⌘P」(打开命令面板)。
  不再提示「在资源管理器中单击文件打开」(无工作区时资源管理器里没有文件可点)。
- 有工作区:「快速打开文件 ⌘P」(打开 Quick Open)、「显示所有命令 ⇧⌘P」。
- 每项是可聚焦的 design `Button`(键盘可达);快捷键 KeyCap 按平台渲染(mac ⌘ / 其它 Ctrl)。
- 打开文件夹的快捷键取实际生效绑定(快捷键设置改键后跟随,解绑后不显示);⌘P / ⇧⌘P 是不可改绑的保留键。
- 三语(en / zh / ko)。
