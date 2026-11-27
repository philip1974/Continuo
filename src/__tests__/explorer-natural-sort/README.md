# 资源管理器自然排序(explorer-natural-sort)

行为契约:**资源管理器(及复用 listDir 输出顺序的 Quick Open 平分项、在文件中查找的结果文件顺序)按 VSCode
`explorer.sortOrder: default` 排序:目录优先,同类按名字比较,名字里的数字段按数值比 —— `file-2` 在 `file-10` 前。**

对齐 VSCode `explorerViewer.ts` FileSorter(default 分支:目录优先 → `compareFileNamesDefault`)与 `comparers.ts`:
`Intl.Collator(undefined, { numeric: true })`(默认敏感度,大小写混排),numeric 使 `foo1` 与 `foo01` 相等时**短的在前**;
点文件不特殊处理(`.` 按 collator 排在字母前)。Continuo 末级再按 UTF-16 码元兜底保证全序。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/compare-file-names.ts` | `compareFileNames`:唯一的文件名比较器 |
| `electron/main/ipc/fs/list-dir.ts` | `sortDirsFirst` 的「是否已有序」快速判断与排序比较都用 `compareFileNames` |

规范:`explorer-natural-sort.spec.ts`;e2e `e2e/explorer-natural-sort.spec.ts`。
