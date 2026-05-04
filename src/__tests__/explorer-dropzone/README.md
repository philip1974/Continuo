# explorer-dropzone (M-Explorer Step 5d)

行为契约:**外部 Finder 拖文件入 Explorer 面板,上传到 workspace**。

只测 `drop-handlers.ts` 与 `atomic-write` 的二进制扩展;
真实 dragover/drop 事件、DropOverlay 渲染留 E2E。

## 决策(草案确认)

1. 二进制走 `Uint8Array` 直接传 IPC(structured clone),`z.instanceof(Uint8Array)` 校验
2. 静默覆盖同名(VSCode 默认,atomic write 自带原子覆盖)
3. drop 落点判定:文件夹 → 进该文件夹;文件 → 进文件父目录;空白 → root
4. UI 反馈:整面板蓝色 overlay + 文字"放下以上传到 X"
5. 多文件支持;**文件夹拖入 skip 并提示**(递归复制 webkitGetAsEntry 留下里程碑)

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/ipc/fs/atomic-write.ts` | **改**:接 `string \| Uint8Array`,二进制走 fd.writeFile(buffer) |
| `electron/main/ipc/fs.ipc.ts` | 加 `fs:write-binary` handler(z.instanceof(Uint8Array)) |
| `electron/shared/fs-channels.ts` | 加 `WRITE_BINARY` |
| `electron/preload/index.ts` | 加 `window.api.fs.writeBinary(path, Uint8Array)` |
| `src/panels/Explorer/drop-handlers.ts` | 纯函数:resolveDropTarget / partitionDropItems / performDrop |
| `src/panels/Explorer/DropOverlay.tsx` | 蓝色半透明覆盖 + 提示文字 |
| `src/panels/Explorer/FolderTree.tsx` | onDragEnter/Over/Leave/Drop 接入 + hover 行高亮 |

## BDD 覆盖

### `atomic-write-binary`(在既有 fs-adapter 主题追加 1 用例,不新增主题)
- atomicWriteFile(path, Uint8Array) → 文件字节内容正确

### `drop-handlers.spec.ts`(本主题新增,~15 用例)
- `resolveDropTarget(null, root)` → root
- `resolveDropTarget(folder, root)` → folder.path
- `resolveDropTarget(file, root)` → dirname(file.path)
- `partitionDropItems(null)` → 全空
- `partitionDropItems` 仅 file kind 处理(string kind 跳)
- `partitionDropItems` 检测目录 → skippedDirs 收集
- `performDrop([])` → ok, written 空
- `performDrop` 单文件成功 → 调 writeBinary 一次,target=`{dir}/{name}`
- `performDrop` 多文件全成功
- `performDrop` 部分写失败 → ok:false + failed 列出
- `performDrop` file.arrayBuffer() 抛 → failed READ_ERROR
- `performDrop` 不主动跳过同名(由 atomic write 静默覆盖)

## 不在本主题验证

- React DnD 事件实际触发(留 E2E 手动)
- DropOverlay 渲染、hover 行高亮(留 E2E)
- IPC writeBinary 真跨进程(留 E2E,但 schema 通过 fs-ipc-bridge 风格补)
- 文件夹递归复制(留下里程碑)
