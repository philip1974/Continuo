# fs-ipc-bridge (M-Explorer Step 2)

行为契约:**fs 通道契约层**。把 Step 1 的纯 fs 函数包成 IPC handler,
通过 `safeHandle` 注册到 `electron/main/ipc/fs.ipc.ts`,preload 暴露 `window.api.fs.*`。

本步骤**只测契约层**:schema 接受/拒绝什么、handler 把入参映射给 fs 函数对不对、
通道命名常量是否稳定。

## 边界(避免重复测试)

| 已被覆盖的不再测 | 在哪 |
|---|---|
| 纯 fs 函数行为(深度/原子写/错误码) | Step 1 `fs-adapter` |
| safeHandle 通用语义(senderFrame/IpcResult/code 透传) | `ipc-safe-handle` |
| `ipcMain.handle` 真注册、`window.api.fs` 真路由 | E2E(P1.D4 Playwright) |
| `shell.trashItem` / `dialog.showOpenDialog` 真实现 | 同上 |

## 通道清单(9 条)

| Channel | schema | handler 调 | data |
|---|---|---|---|
| `fs:list-dir`         | `{ path, options? }` | `listDir(path, options)` | `FileEntry[]` |
| `fs:read-file`        | `{ path }`           | `readFile(path)` | `string` |
| `fs:write-file`       | `{ path, content }`  | `atomicWriteFile(path, content)` | `void` |
| `fs:rename`           | `{ path, newName }`  | `renameEntry(path, newName)` | `string`(新路径) |
| `fs:remove`           | `{ path }`           | `removeEntry(path)` | `void` |
| `fs:create-file`      | `{ dir, name }`      | `createFile(dir, name)` | `string` |
| `fs:create-dir`       | `{ parent, name }`   | `createDir(parent, name)` | `string` |
| `fs:trash`            | `{ path }`           | `shell.trashItem(path)` | `void` |
| `fs:select-directory` | `undefined`          | `dialog.showOpenDialog(...)` | `string \| null` |

## 关键行为

### 通道常量表(`electron/shared/fs-channels.ts`)
- `FS_CHANNELS.LIST_DIR === 'fs:list-dir'` 等(防字符串散漂,见 ADR-010 配套 P1.D2)
- 9 个常量值唯一不重复
- 所有值满足 `fs:` 前缀

### schemas
- 正确入参 → `safeParse.success === true`
- 缺必填字段 → fail
- 类型错(path 传 number)→ fail
- `listDir.options` 全 optional,字段类型严格
- `select-directory` 接受 `undefined`,**不接受** `{}`(显式严格)
- 所有 schema 用 `.strict()`,拒绝未知字段(防 IPC 注入)

### handlers(浅断言)
- handler 接受 schema parse 后的对象作为唯一参数
- handler 把字段正确映射给 fs 函数(用临时目录跑真 fs)
- handler 抛业务 code 不被吞(由 safeHandle 透传,在另一主题已测,本主题只断言抛得出)
- `trashHandler` / `selectDirectoryHandler` 用工厂注入 deps,不真接 Electron API

## 不在本主题验证

- `registerFsIpc()` 是否真把所有 channel 注册到 ipcMain(留 E2E)
- preload 端 `window.api.fs.xxx` 真实跨进程路由(留 E2E)
- IpcResult 包装行为(在 `ipc-safe-handle` 主题已测)
- safeHandle 的 senderFrame 校验(同上)
