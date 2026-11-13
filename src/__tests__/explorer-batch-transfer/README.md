# explorer-batch-transfer(重构:Explorer 批量移动/复制的单一实现)

## 行为契约

FolderTree 有三个「把一批路径移动/复制进同一目录」的入口:拖到具体 row(onDropItems)、拖到空白
(root-drop)、粘贴(onPaste,cut=move / copy)。此前三处各自内联同一段循环 + try/catch/finally,
「部分成功刷新」(P2-BB)、「剪贴板 prune」(R7)、「IPC reject 须反馈」(A134/A135/A136)每次都要
逐处传播且每次都漏过一处。收口到 `src/panels/Explorer/batch-transfer.ts` 的 `transferEntriesInto`;
两处外部文件 drop(row / 空白)同理收口到 `dropForeignFilesInto`。行为与收口前一致。

### 规则(transferEntriesInto)

1. 目标名:整批只探测一次目标目录(`makeUniqueDestPicker(destDir)`),逐项 `pickDest(basename)`。
2. 逐项顺序执行;某项 `ok:false` → `onItemFailed(src, code, message)` 后**中止其余项**。
3. move 成功一项 → `onMoved(src, dest)`(调用方同步 editor tab 路径)。
4. 无论中途失败 / 抛异常,结束时:有成功项 → 刷新目标目录 + (move)已成功项的源父目录(≠目标目录);
   move 有成功项 → `onSourcesGone(已移走的源)`(调用方 prune 剪贴板)。copy 不动源,不调。
5. 目标名探测或 fs 调用 reject → `onException(err)`,不产生 unhandled rejection;规则 4 仍执行。
6. `skipSameParent`:源已在目标目录(`dirname(src) === destDir`)→ 跳过(拖到原父目录是 no-op)。

### 规则(dropForeignFilesInto)

7. 无文件且无被跳过目录 → 不做任何事;否则写入后刷新目标目录,被跳过目录 / 批量失败各提示一次;
   任何抛出 → `notify.error`(不产生 unhandled rejection)。

### 接线守卫

8. FolderTree 的三个移动入口都经组件内唯一包装 `runBatchTransfer` 调 `transferEntriesInto`,两个外部 drop 入口都调 `dropForeignFilesInto`,
   组件内不再内联 `coApi.fs.move` / `coApi.fs.copy` / `performDrop`。
