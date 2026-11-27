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
- 「在: …」标注:传 `rootPath` 时显示相对工作区根的路径(根目录本身显示工作区名),完整绝对路径放 `title`;
  不传则显示 parentDir 原值

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

### 实时校验(`validate`,VSCode `validateFileName` + `InlineEditInputBox`)

- 父层传 `validate(name)`:每次输入即校验,返回本地化错误 → 同一 `role="alert"` 位置提示、`aria-invalid`;改正后消失
- 有校验错误时 Enter → 不提交也不取消,输入保留;失焦 → `onCancel('blur')`,不提交
- `error`(上次提交失败)存在时优先显示它

### 关闭按钮

- 点叉号 → onCancel

### 失焦(VSCode `InlineEditInputBox` 同款)

- 焦点移到输入条之外(点编辑器 / 树 / 标题栏按钮、打开命令面板或右键菜单等)→ 等一个宏任务再判定(VSCode `timeout(0)`):
  - 有可创建的名字且无错误提示(含实时校验)→ `onSubmit(name, 'blur')`(同 Enter,受同一 once 守卫;第二参数让父层在失败时
    直接放弃并 toast,不留无焦点的错误输入条)
  - 空名 / 全空白,或上次提交失败(错误提示还在 = 输入无效)→ `onCancel('blur')`(父层据此不把焦点拉回树)
- 焦点仍在输入条里(点了 ✕ 按钮)或 activeElement 仍是输入框(窗口失焦:切应用 / 输入法切换)→ 继续编辑
- Enter 已提交 / Esc、空名 Enter、✕ 已放弃之后的失焦不再处理

### 卸载

- 移除 keydown / blur listener,cancelAnimationFrame;卸载后到期的失焦判定不再回调

### 每次新建都聚焦

- 父层(FolderTree)每次新建换 key 重挂载本组件(`creating.seq`)→ 挂载即聚焦、清空;见 `explorer-tree` 新建一节
