# editor-action(EditorHeader 工具按钮贡献)

行为契约:**Plugin 通过 `this.registerEditorAction({ id, label, when?, fn, icon? })` 注入
EditorHeader 右侧控制区按钮**;EditorHeader 渲染时按 when 谓词过滤,显示可见 actions。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/EditorActionRegistry.ts` | 列表 + filterVisible |
| `src/plugins/Plugin.ts`(扩展) | `registerEditorAction` 代理 |
| `src/panels/Editor/EditorHeader.tsx`(扩展) | 渲染 actions |

## 关键行为

### EditorActionSpec

- `id`(全局唯一)
- `label`(button 文字 / aria-label)
- `icon?`(可选 ReactNode,优先于 label 显示)
- `when?`(谓词,接收 `{ filePath, dirty, mode }`,返 boolean;缺省永远显)
- `fn(): void | Promise<void>`(点击回调)
- `priority?`(升序,默认 100)

### Registry

- `register(spec)` → Disposable;dispose 移除
- 重复 id → 后注册赢 + warn
- subscribe / getAll(按 priority 升序)

### filterVisible(actions, ctx)

- 调每个 action.when(ctx);未提供 when 视为 true
- when 抛错 → 视为 false + warn
- 返回可见列表(保持 priority 排序)

### Plugin.registerEditorAction

- 内部 app.editorActions.register(spec) → this.register(d)
- _deactivate 自动移除
