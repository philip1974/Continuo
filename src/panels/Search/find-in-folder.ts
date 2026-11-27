// 资源管理器「在文件夹中查找…」(VSCode filesExplorer.findInFolder:右键菜单 / 资源管理器聚焦文件夹时 ⇧⌥F):打开搜索视图,
// 「要包含的文件」填成这些文件夹相对工作区根的路径(`./src/a`,多个以「, 」连接),展开查找详细信息,焦点进查询框。
// BDD: src/__tests__/explorer-find-in-folder/

import { isSameOrInsidePath, stripRootPrefix } from '@/lib/path-cross';
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { SEARCH_PANEL_ID, SIDE_PANEL_INITIAL_WIDTH, SIDE_PANEL_POSITION } from '@/shell/dock/side-panel';
import { useSearchStore } from './search-store';

/** glob 元字符按字面匹配(VSCode escapeGlobPattern:`?` `*` `[` `]` 各包进字符类)。 */
export function escapeGlobPattern(path: string): string {
  return path.replace(/([?*[\]])/g, '[$1]');
}

/**
 * 文件夹 → 「要包含的文件」各项(VSCode resolveResourcesForSearchIncludes,单根工作区):相对根、正斜杠、前缀 `./`、glob 元字符转义;
 * 根自身得空串而略过(根 = 不限范围);工作区外的略过;去重保序。
 */
export function searchIncludesForFolders(root: string, folders: readonly string[]): string[] {
  const out: string[] = [];
  for (const folder of folders) {
    if (!isSameOrInsidePath(root, folder)) continue;
    const rel = stripRootPrefix(root, folder).replace(/\\/g, '/').replace(/\/+$/, '');
    if (rel === '' || rel === '.') continue;
    const pattern = escapeGlobPattern(`./${rel}`);
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/**
 * 在这些文件夹中查找(VSCode SearchView.searchInFolders):有可包含的路径 → 填入「要包含的文件」并展开详细信息;没有(只选了根)
 * → 清空「要包含的文件」。随后打开 / 激活搜索视图(新建时同 ⇧⌘F 放在主窗最左侧),焦点进查询框。
 */
export function findInFolders(root: string, folders: readonly string[]): void {
  const includes = searchIncludesForFolders(root, folders);
  const s = useSearchStore.getState();
  s.setInclude(includes.join(', '));
  if (includes.length > 0 && !useSearchStore.getState().detailsOpen) s.toggleDetails();
  s.requestFocus();
  // 落点同 ⇧⌘F(SearchPlugin):新建时放主窗网格最左侧的独立组,已存在只聚焦
  openOrFocusPanel(
    SEARCH_PANEL_ID,
    SEARCH_PANEL_ID,
    'Search',
    'panels.search.title',
    SIDE_PANEL_POSITION,
    SIDE_PANEL_INITIAL_WIDTH,
  );
}
