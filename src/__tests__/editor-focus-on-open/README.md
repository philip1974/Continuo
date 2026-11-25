# 打开文件后焦点进编辑器(VSCode 对齐)

VSCode:Quick Open(⌘P)回车打开文件、Explorer 新建文件 / 双击文件 / 键盘 Enter 打开文件后,焦点在该文件的编辑器里,可以直接打字。
Explorer 普通单击打开已有文件时焦点留在树里(单击预览),不在此列。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-focus-registry.ts` | 引擎按 tab 登记聚焦句柄;`requestEditorFocus` / `focusActiveEditor` 发请求 |
| `src/panels/Editor/CodeEditor.tsx` / `MilkdownEditor.tsx` | 视图就绪时登记(Milkdown 在 Crepe 异步创建完成时) |
| `src/plugins/quick-open/QuickOpenModal.tsx` | 打开成功后 `focusActiveEditor()` |
| `src/panels/Explorer/FolderTree.tsx` / `FileRow.tsx` | 新建文件、双击文件(click.detail ≥ 2)、键盘 Enter 打开成功后 `focusActiveEditor()` |
| `src/notifications/notify-open-failed.ts` | `openFileOrNotify` 返回是否打开成功 |

## 行为

### 请求的兑现(`editor-focus-registry.spec.ts`)

- 视图已就绪 → **下一帧**聚焦:Quick Open 关闭时 Modal 把焦点还给打开前的元素、旧编辑器随 key 变化卸载,都发生在
  同一次提交里,聚焦须晚于它们(否则焦点最终掉到 body)
- 视图尚未挂载(读盘、引擎 chunk 加载、Milkdown 异步创建)→ 该 tab 的视图登记时(下一帧)聚焦一次;兑现后
  之后的重挂载不再抢焦点;请求 5s 后作废
- 只兑现给被请求的 tab;新请求取代旧请求;已注销的视图不被聚焦

### Quick Open(`quick-open-focus.spec.tsx`)

- 回车 / 点击打开 → 弹窗关闭,随后焦点进该文件的编辑器
- 打开失败(弹 toast)→ 不请求聚焦

### Explorer 新建文件(`explorer-tree/folder-tree-create.spec.tsx`)

- 新建文件成功 → 编辑器打开后焦点进编辑器(树里的新行仍是树的焦点 / 选中项,只是 DOM 焦点不在树上)
- 新建文件夹 → DOM 焦点落在新文件夹行(不变)
- 普通单击打开已有文件 → 不请求聚焦编辑器
- 双击文件 → 打开成功后焦点进编辑器;打开失败不请求聚焦

### Explorer 键盘 Enter(`explorer-tree/folder-tree-keyboard.spec.tsx`)

- 焦点在文件行按 Enter → 打开成功后焦点进编辑器(VSCode Windows/Linux 键位 `explorer.openAndPassFocus`);
  打开失败不请求聚焦

## 端到端

- `tests/e2e/quick-open-focus-editor.spec.ts`:Quick Open 打开文件后直接键入,文字进入编辑器
- `tests/e2e/focus-after-close.spec.ts`:Explorer 双击文件后直接键入,文字进入编辑器
- `tests/e2e/explorer-keyboard-create-rename.spec.ts`:Explorer 键盘 Enter 打开后直接键入进编辑器;重命名 Enter 后焦点在新项;新建 Esc 后焦点回树
