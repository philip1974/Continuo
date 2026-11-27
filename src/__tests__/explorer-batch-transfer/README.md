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
   (对齐 VSCode explorer 粘贴)
   - 目标就是源本身 → 实际目标改为源的父目录:copy 由 picker 生成 `A copy`;move 于是落回原父目录 → no-op。
   - move 且源已在(实际)目标目录(`dirname(src)` 与目标平台感知相等)→ 跳过(拖到原父目录 / 剪切后
     粘贴回原目录 / 剪切 A 后粘贴到 A 都是 no-op,不改名成 ` copy`、不提示、不刷新)。
   - 目标严格在源的子树内(move 或 copy)→ 整批不触发 fs,`onItemFailed(src, 'FS_MOVE_INTO_SELF', …)`
     (三语「不能把文件夹移动或粘贴到它自己的子文件夹中」;此前 rename EINVAL / fs.cp ERR_FS_CP_EINVAL →「文件 I/O 错误」)。

### 规则(dropForeignFilesInto)

7. 无文件且无被跳过目录 → 不做任何事;否则写入后刷新目标目录,被跳过目录 / 批量失败各提示一次;
   任何抛出 → `notify.error`(不产生 unhandled rejection)。
7a. 同名(误操作防护,对齐 VSCode ExternalFileImport;`drop-overwrite-confirm.spec.ts`):写入前 `listDir` 目标目录一次,
   按 `sameNameKey`(大小写 + NFC 折叠,与唯一名 picker 同口径)判重:
   - 与已有文件 / 符号链接同名 → `confirmOverwrite(names, canSkip)` 一次列出全部冲突名(同键只列一次);
     `replace` 全写、`skip` 只写不冲突项、`cancel` 一个都不写。`canSkip` = 还有不冲突的项。
   - 与已有文件夹同名 → 不提供替换(文件替换不了文件夹),该项直接归失败 `FS_EEXIST`,其余照写。
   - 目标目录读不到 → 无法判断是否覆盖,整批不写并提示(fail-closed)。
   - 对话框接线见 `explorer-confirm-drag-and-drop/`。

### 接线守卫

8. FolderTree 的三个移动入口都经组件内唯一包装 `runBatchTransfer` 调 `transferEntriesInto`,两个外部 drop 入口都调 `dropForeignFilesInto`,
   组件内不再内联 `coApi.fs.move` / `coApi.fs.copy` / `performDrop`。

### 进度、并发与失败文案(`transfer-progress.spec.tsx`)

9. 进行中的文件操作(`runBatchTransfer`:粘贴 / 拖放移动与复制;移到废纸篓;永久删除)计数 > 0 且持续满
   `EXPLORER_PROGRESS_DELAY_MS`(500ms,VSCode `ExplorerService.applyBulkEdit` 的 `withProgress({ location: Explorer, delay: 500 })`)
   → 资源管理器顶部(标题栏下、叠在树上不推动内容)出现 design `ProgressBar`(名称「正在执行文件操作…」,三语);全部结束即消失,
   很快完成的不出现。外部文件拖入(`dropForeignFilesInto`,可能停在同名确认框上)不计入。
10. `runBatchTransfer` 按目标目录逐批串行(`runSerialPerKey`,key = 目标目录):每批开始时才按目标目录列表挑名字,上一批还在写时
    再粘贴到同一目录,后一批等它写完、看得到它写出的文件 → `a copy 2.txt`(VSCode 重复粘贴同),不再两批都挑 `a copy.txt`、
    后一批报「已存在」。不同目标目录的批次互不等待(VSCode 文件操作经 BulkEditService 各自执行):慢的大目录复制进行中,
    往别的目录的移动 / 粘贴立即开始。
11. 某项失败的提示只写源的名字(`basenamePreserveTrailing`),不写绝对路径:「无法粘贴「a.txt」：{本地化原因}」/「无法移动…」/
    「无法复制…」(三语;VSCode 文件操作错误同样只给名字)。
