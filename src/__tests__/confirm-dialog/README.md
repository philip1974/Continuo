# ConfirmDialog(通用确认对话框)

行为契约:**design Modal 包装,`open=true` 时显示 title / description / 确认 / 取消。
确认按钮 destructive=true 时为 danger variant,否则 primary。点确认 → onConfirm,
点取消 / Esc / overlay 点击 → onCancel。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/ConfirmDialog.tsx` | UI |

## 规范文件

- `confirm-dialog.spec.tsx`:组件行为(渲染 / 文案 / variant / 初始焦点 / 回调)。
- `overwrite-confirm-focus.spec.tsx`:EditorPanel 显式保存遇外部修改 →「仍然覆盖」确认框弹出后立即按回车 / 空格不 force 写盘(焦点在取消);显式点「仍然覆盖」照常覆盖。

## 关键行为

- open=false → 不渲染
- open=true → 渲染 title / description / 两个按钮
- 可选第三按钮:alternativeLabel + onAlternative 都给才渲染,排在取消左侧(顺序 [备选, 取消, 确认]),点击只调 onAlternative;不参与初始焦点
- 默认按钮文案: '确认' / '取消',可由 confirmLabel / cancelLabel 覆盖
- destructive=true → 确认按钮 .wm-btn-danger;false → primary
- 初始焦点:非 destructive → 确认按钮(`data-autofocus`);destructive → 取消按钮(破坏性操作须显式选择,防止异步弹出时用户继续敲的空格 / 回车误触发)
- `defaultAction='confirm'`:destructive 也把初始焦点放在确认按钮(回车即执行)。只给**可恢复**的破坏性操作用 —— 资源管理器「移到废纸篓」确认与撤销新建(移到废纸篓)确认(对齐 VSCode 删除确认的主按钮默认);永久删除 / 覆盖写盘 / 关闭未保存等不可恢复的确认不传,保持聚焦取消
- 点确认 → onConfirm
- 点取消 → onCancel
- Esc → Modal 内部触发 onClose,该 hook 接到 onCancel
- 说明区经 `aria-describedby` 关联、destructive 为 `role="alertdialog"`:见 `dialog-accessible-description` 主题
- 打开期间父组件重渲换新 onCancel 引用 → Modal 焦点/键盘 effect 不重跑(焦点留在用户所在按钮),Esc 调最新 onCancel
