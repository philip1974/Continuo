# explorer-find-in-folder(资源管理器「在文件夹中查找…」)

行为契约:**从资源管理器的文件夹(或空白处 = 工作区根)直接打开搜索视图,范围限定在该文件夹**。

## VSCode 参照

- `FindInFolderAction`(`searchActionsFind.ts`,id `filesExplorer.findInFolder`,标题「Find in Folder...」):
  键位 `⇧⌥F`,`when: filesExplorerFocus && explorerResourceIsFolder`;菜单 `MenuId.ExplorerContext` 组 `4_search`,
  `when: ExplorerFolderContext`(文件夹与空白处 —— 空白处的上下文是根文件夹)。
- `searchWithFolderCommand`:多选资源(右键项在选中集里 → 整个选中集),文件取 `dirname`;
  `resolveResourcesForSearchIncludes`(单根):`relativePath(根, 文件夹)` → 非空则 `./` 前缀,再 `escapeGlobPattern`
  (`?` `*` `[` `]` 包进字符类);根自身得空串而**略过**。
- `SearchView.searchInFolders` → `_searchWithIncludeOrExclude`:列表为空 → 清空「要包含的文件」、聚焦查询框;否则展开详细信息
  (`toggleQueryDetails`),「要包含的文件」设为各项以「, 」连接,聚焦查询框。

## 行为

1. **菜单**:文件夹右键「新建文件 / 新建文件夹(/ 粘贴)」之后单独一组「在文件夹中查找…」(三语 `panels.explorer.ctx.find_in_folder`,
   右侧键位 ⌥⇧F / Alt+Shift+F),其后分隔线再接剪切 / 复制…;空白处菜单在新建组之后(以根为目标);文件菜单没有。
   右键项在多选集中 → 整个选中集(其中的文件取所在目录)。
2. **键位**:资源管理器聚焦、焦点项是文件夹时 ⇧⌥F(按物理键,mac 上产生的字符是 Ï 也认);焦点项是文件 → 不处理。
3. **效果**:「要包含的文件」= 各文件夹相对根的 `./a/b`(正斜杠、去重、glob 元字符按字面);全是根 → 清空「要包含的文件」。
   有内容时展开查找详细信息;打开 / 激活搜索视图,焦点进查询框(已有的查询词保留,按新范围重搜)。
4. 搜索的 glob 匹配器把 `[]]` 当作匹配 `]` 的字符类(VSCode 的转义形式;此前会编成永不匹配的正则)。

## 实现

| 文件 | 职责 |
|---|---|
| `src/panels/Search/find-in-folder.ts` | `escapeGlobPattern` / `searchIncludesForFolders` / `findInFolders` |
| `electron/shared/workspace-search.ts` | 字符类里的 `]` 转义 |
| `src/panels/Explorer/ContextMenu.tsx` / `tree-keyboard.ts` / `FolderTree.tsx` | 菜单项、⇧⌥F、文件 → 所在目录 |

## 规范

- `find-in-folder.spec.tsx`:包含路径写法(相对 / 根略过 / 去重 / 转义且匹配器按字面)、打开搜索视图、菜单位置与键位、多选、⇧⌥F
- `src/__tests__/explorer-open-to-side/folder-tree-wiring.spec.tsx`:真实文件树里的右键 / ⇧⌥F 接线、多选时文件取所在目录
- e2e `tests/e2e/explorer-find-in-folder.spec.ts`:真实右键文件夹「在文件夹中查找…」→ 搜索视图「要包含的文件」为 `./src`、焦点在查询框,键入后只出该文件夹的结果
