# explorer-batch-transfer(重构:Explorer 批量移动/复制的单一实现)

## 行为契约

FolderTree 有三个「把一批路径移动/复制进同一目录」的入口:拖到具体 row(onDropItems)、拖到空白
(root-drop)、粘贴(onPaste,cut=move / copy)。此前三处各自内联同一段循环 + try/catch/finally,
「部分成功刷新」(P2-BB)、「剪贴板 prune」(R7)、「IPC reject 须反馈」(A134/A135/A136)每次都要
逐处传播且每次都漏过一处。收口到 `src/panels/Explorer/batch-transfer.ts` 的 `transferEntriesInto`;
两处外部文件 drop(row / 空白)同理收口到 `dropForeignFilesInto`。行为与收口前一致。

### 规则(transferEntriesInto)

0. 只处理最外层路径:父目录与其子项同批时剔除子项(`outermostPaths`,见 `explorer-transfer-integrity/`)。
1. 目标名:整批只探测一次目标目录(`makeUniqueDestPicker(destDir)`),逐项 `pickDest(basename)`。
2. 逐项顺序执行;某项 `ok:false` → `onItemFailed(src, code, message)` 后**中止其余项**。
3. move 成功一项 → `onMoved(src, dest)`(调用方做「路径已移走」清理:editor tab / 展开集合 / 剪贴板,
   见 `explorer-expanded-state/path-gone-cleanup.spec.ts`)。部分成功也只对已移走项调,未移项留给调用方重试。
4. 无论中途失败 / 抛异常,结束时:有成功项 → 刷新目标目录 + (move)已成功项的源父目录(≠目标目录);
   copy 不动源,不调 `onMoved`。
   某项 `ok:false` 也刷新目标目录(move 另刷新该项源父目录):失败可能已部分落盘(跨盘 move 已复制
   但源未删净 / 递归 cp 中途失败);失败项不调 `onMoved`。
5. 目标名探测或 fs 调用 reject → `onException(err)`,不产生 unhandled rejection;规则 4 仍执行。
6. 目标与源的相对位置(漏斗内判定,不靠调用方传参;拖动与粘贴同一行为,`canDrop` 与漏斗共用
   `path-utils.isDestInsideSource`):
   - move 且源已在目标目录(`dirname(src)` 与 `destDir` 平台感知相等)→ 跳过(拖到原父目录 / 剪切后
     粘贴回原目录是 no-op,不改名成 ` copy`、不提示、不刷新)。
   - move 且目标是源本身或在其子树内 → 整批不触发 fs,`onItemFailed(src, 'FS_MOVE_INTO_SELF', …)`
     (三语「不能把文件夹移动到它自身或子文件夹中」;此前落到 rename EINVAL →「文件 I/O 错误」)。
   - copy 且目标是源本身或在其子树内 → 改投源的父目录,由 picker 生成 `A copy`(VSCode 同款;此前
     fs.cp 报 ERR_FS_CP_EINVAL →「文件 I/O 错误」)。

### 规则(dropForeignFilesInto)

7. 无文件且无被跳过目录 → 不做任何事;否则写入后刷新目标目录,被跳过目录 / 批量失败各提示一次;
   任何抛出 → `notify.error`(不产生 unhandled rejection)。

### 接线守卫

8. FolderTree 的三个移动入口都经组件内唯一包装 `runBatchTransfer` 调 `transferEntriesInto`,两个外部 drop 入口都调 `dropForeignFilesInto`,
   组件内不再内联 `coApi.fs.move` / `coApi.fs.copy` / `performDrop`。
