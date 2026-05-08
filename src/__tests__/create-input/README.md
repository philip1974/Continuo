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

### 关闭按钮

- 点叉号 → onCancel

### 卸载

- 移除 keydown listener,cancelAnimationFrame
