# explorer-transfer-integrity(Explorer 批量移动/复制/删除/改名的完整性)

独立审计对 Explorer 报告的 4 个缺陷的行为契约。

## 行为契约

1. **嵌套选择只处理最外层**(`nested-selection.spec.ts`):一批路径同时含父目录 A 与其后代 A/B 时,
   批量移动/复制漏斗 `transferEntriesInto` 与批量删除漏斗 `removeItems` 先用 `outermostPaths`
   剔除「祖先也在批次里」的后代项(重复路径只留首个),再逐项执行 —— 复制不重复复制子树、移动不拆散
   层级也不对已随祖先移走的子项报 FS_NOT_FOUND、删除不对已随祖先删除的子项报错。`removeItems` 回报实际删掉的路径 `removed`,
   onTrash 经 `trashItemsAndCleanup` 只对它做「路径已删除」清理(关 editor tab / 剪除展开集合 / prune 剪贴板) —— 祖先删失败时被折叠的后代同样未删,不得当成功清理。祖先判断用
   `isSameOrInsidePath`(分隔符无关 + 平台感知大小写)。root-drop 把全部拖动路径交给漏斗
   (`skipSameParent`),先剔后代再跳过同父项,不在漏斗外预先剔掉 root 下的祖先。
2. **跨盘移动 rm 失败须报错**(`move-exdev-rm-fail.spec.ts`):`moveEntry` 的 EXDEV fallback 中
   cp 成功但 rm(src) 失败 → 抛 rm 的映射 errno,消息说明目标已复制但源未能完全删除;不宣告成功。
   `transferEntriesInto` 某项 `ok:false` 时仍刷新目标目录(move 另刷新该项源父目录),让已复制 /
   部分写入的内容可见;但失败项不触发 `onMoved`。
3. **硬链接不算「改名到自身」**(`rename-hardlink-eexist.spec.ts`,plugin-fs 兄弟入口见
   `49-polish-bugfixes/plugin-fs-rename-no-overwrite.spec.ts`):目标与源同 inode 时,仅当两名字只差
   大小写 / Unicode 规范化(`isCaseOrNormalizationOnlyRename`)才放行,否则 FS_EEXIST。
4. **唯一目标名大小写不敏感**(`dest-picker-case-insensitive.spec.ts`):`makeNamePicker` 按大小写折叠
   + NFC 比较已存在名与同批已分配名;返回的实际文件名保持原大小写。
