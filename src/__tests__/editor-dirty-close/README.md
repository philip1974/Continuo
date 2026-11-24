# 关闭未保存的编辑器 tab(保存 / 不保存 / 取消)

行为契约:**关闭脏 tab 时弹 VSCode 式确认框「是否要保存对 X 的更改?」,三个按钮:保存(主按钮、初始焦点)/
不保存 / 取消。保存成功后关闭;保存遇磁盘已被外部修改走已有「覆盖」确认,确认覆盖并写盘成功后关闭;
保存失败不关闭、弹错误提示。不保存 = 丢弃改动直接关闭;取消 = 什么都不做。**

对照 VSCode:关闭脏编辑器弹 "Do you want to save the changes you made to X?",按钮 Save / Don't Save / Cancel,
默认按钮 Save;保存失败编辑器保持打开。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/EditorPanel.tsx` | 确认框接线、保存后关闭 |
| `src/lib/ConfirmDialog.tsx` | 可选第三按钮(alternativeLabel / onAlternative) |

## 规范文件

- `dirty-close-save.spec.tsx`

## 关键行为

- 关闭脏 tab → 确认框:按钮顺序 [不保存, 取消, 保存],初始焦点在「保存」
- 保存 → 写盘当前内容 → tab 关闭
- 保存遇外部修改(EDITOR_DISK_CHANGED)→ 弹「覆盖」确认,tab 保持打开;点覆盖 → force 写盘 → tab 关闭;
  覆盖框取消 → tab 保持打开且仍脏
- 保存失败 → tab 保持打开(仍脏)+ 错误提示
- 不保存 → 不写盘,tab 关闭
