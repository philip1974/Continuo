# CreateInput(Explorer 新建文件 / 文件夹 sticky bar)

行为契约:**新建文件 / 文件夹时显示在 FolderTree 顶部:文档/文件夹 icon + 输入框 + 父目录提示 + 关闭按钮。
原生 keydown(capture)监听:Esc → onCancel,Enter → trim 后非空调 onSubmit,空 → onCancel。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/CreateInput.tsx` | UI |

## 关键行为

### 渲染

- type='file' → Document icon
- type='dir' → Folder icon
- placeholder 对应「新建文件名…」/「新建文件夹名…」
- 「在: ${parentDir}」标注

### 键盘

- Esc → onCancel(preventDefault + stopPropagation,先于 headless-tree)
- Enter + 非空 → onSubmit(trim 后)
- Enter + 空 / 全空白 → onCancel
- 其它键 → 正常输入
- IME 组合中(`isComposing` / `keyCode 229`)的 Enter / Esc → 不提交也不取消(属于输入法确认候选 / 取消组合)

### 提交失败(重试 / 内联错误)

- `onSubmit` 可返回 `Promise<boolean>`:结果为 `false`(创建失败)→ once 守卫复位,保留已输入的名字,
  再按 Enter 重新提交;其它结果(成功,等父层卸载)→ 守卫保持,快速重复 Enter 只提交一次
- `error` 非空 → 输入框下方 `role="alert"` 显示原因(VSCode 内联校验提示),输入框 `aria-invalid` +
  `aria-describedby` 指向提示
- 修改输入 → 调 `onEdit`(父层据此清除错误)

### 关闭按钮

- 点叉号 → onCancel

### 卸载

- 移除 keydown listener,cancelAnimationFrame
