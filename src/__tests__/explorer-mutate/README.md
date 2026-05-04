# explorer-mutate (M-Explorer Step 5)

行为契约:**资源管理器 CRUD 动作层**(rename / remove / create file / create dir)。

本主题**只测 `mutate-actions.ts` 的纯函数**:把 IPC 调用和 tree 刷新封装成单一动作,
组件层 onClick 调它即可。Radix UI 弹窗渲染、键盘交互、行内 input 留 Step 7 smoke E2E。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/mutate-actions.ts` | renameItem / removeItems / createNewFile / createNewDir |
| `src/panels/Explorer/ContextMenu.tsx` | Radix UI ContextMenu 包装 |
| `src/panels/Explorer/ConfirmDialog.tsx` | Radix UI Dialog 删除二次确认 |
| `src/panels/Explorer/RenameInput.tsx` | 行内 input(Enter 提交 / Esc 取消) |
| `src/panels/Explorer/CreateInput.tsx` | 顶部 sticky input(新建文件/夹) |

## 设计要点

- 每个 action 接 `deps: { fs }` 与 `tree: { invalidateChildrenIds }` 注入,
  spec 用 vi.fn 验证调用语义。
- 成功后调 `tree.invalidateChildrenIds(parentDir)` 触发 headless-tree 重新加载父目录;
  失败时不刷,返回结构化错误透传给 caller(组件层弹 toast / inline 错误)。
- `removeItems` 默认 `trash: true`(VSCode 风,走系统回收站);
  多路径并行删,聚合 failures,即便部分失败仍刷成功项的父目录。
- `dirname` / `basename` 复用 tree-config 同模式纯函数(跨平台,不引 path-browserify)。

## 关键行为

### renameItem(oldPath, newName, deps, tree)
- 调 `fs.rename(oldPath, newName)`
- 成功 → `tree.invalidateChildrenIds(dirname(oldPath))` → 返 `{ ok, newPath }`
- 失败 → 不刷,返 `{ ok: false, code, message }`(透传 IpcFail)

### removeItems(paths, opts, deps, tree)
- 默认 `opts.trash = true` → 调 `fs.trash(p)`;`trash: false` → 调 `fs.remove(p)`
- 多路径循环调用,各自结果聚合到 `failures` 数组
- 成功路径的父目录去重后批量 invalidate;失败路径的父不刷
- 全成功 → `{ ok: true }`;有失败 → `{ ok: false, failures: [{path, code, message}] }`
- paths 空数组 → 直接返回 `{ ok: true }`,不调任何 IPC,不刷

### createNewFile(parent, name, deps, tree) / createNewDir(parent, name, deps, tree)
- 调 `fs.createFile(parent, name)` / `fs.createDir(parent, name)`
- 成功 → `tree.invalidateChildrenIds(parent)` → 返 `{ ok, newPath }`
- 失败 → 不刷,返 `{ ok: false, code, message }`(`FS_EEXIST` / `FS_BAD_NAME` 等透传)

## 不在本主题验证

- Radix UI 弹窗 mount/unmount(留 E2E)
- 键盘 F2/Backspace/Enter/Esc 触发(留 E2E)
- 多选交互(已在 explorer-stores 测过 store 行为)
- IPC 实际跨进程行为(已在 fs-ipc-bridge 测过 schema/handler)
