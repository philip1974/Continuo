# ConfirmDialog(通用确认对话框)

行为契约:**design Modal 包装,`open=true` 时显示 title / description / 确认 / 取消。
确认按钮 destructive=true 时为 danger variant,否则 primary。点确认 → onConfirm,
点取消 / Esc / overlay 点击 → onCancel。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/ConfirmDialog.tsx` | UI |

## 关键行为

- open=false → 不渲染
- open=true → 渲染 title / description / 两个按钮
- 默认按钮文案: '确认' / '取消',可由 confirmLabel / cancelLabel 覆盖
- destructive=true → 确认按钮 .wm-btn-danger;false → primary
- 确认按钮 autoFocus
- 点确认 → onConfirm
- 点取消 → onCancel
- Esc → Modal 内部触发 onClose,该 hook 接到 onCancel
