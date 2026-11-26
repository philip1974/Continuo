// 内置「在文件中查找」插件(VSCode Search 视图 workbench.action.findInFiles):注册单例 dock 面板 `search` 与命令
// ⇧⌘F(打开 / 激活面板并聚焦查询框,编辑器单行选区带入)、F4 / ⇧F4(下一个 / 上一个搜索结果)。
// 面板走主窗落点(openOrFocusPanel 不给 position,见 popout-open-target)。BDD: src/__tests__/workspace-search/

import { Plugin } from '@/plugins/Plugin';
import { lazyPanel, preloadableLazy } from '@/lib/lazy-panel';
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { focusNextSearchResult, useSearchStore } from '@/panels/Search/search-store';
import { editorSelectionSeed } from '@/panels/Search/editor-selection-seed';

const searchPanel = preloadableLazy(() =>
  import('@/panels/Search/SearchPanel').then((m) => ({ default: m.SearchPanel })),
);
/** 启动空闲时预取(main-app):冷启动 ⇧⌘F 后搜索框同步挂载,立刻键入不丢字。BDD: src/__tests__/open-panel-focus/ */
export const preloadSearchPanel = searchPanel.preload;

export const SEARCH_PANEL_TYPE = 'search';

export default class SearchPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: SEARCH_PANEL_TYPE,
      title: 'Search',
      titleKey: 'panels.search.title',
      factory: lazyPanel(searchPanel.Component),
    });
    this.addCommand({
      id: 'workbench.action.findInFiles',
      title: 'Find in Files',
      titleKey: 'commands.search.find_in_files.title',
      category: 'Search',
      categoryKey: 'commands.search.category',
      hotkey: 'mod+shift+f',
      fn: () => {
        // 先取选区:打开面板会把焦点移到查询框
        useSearchStore.getState().requestFocus(editorSelectionSeed());
        openOrFocusPanel(SEARCH_PANEL_TYPE, SEARCH_PANEL_TYPE, 'Search', 'panels.search.title');
      },
    });
    this.addCommand({
      id: 'search.action.focusNextSearchResult',
      title: 'Focus Next Search Result',
      titleKey: 'commands.search.next_result.title',
      category: 'Search',
      categoryKey: 'commands.search.category',
      hotkey: 'f4',
      fn: () => focusNextSearchResult(1),
    });
    this.addCommand({
      id: 'search.action.focusPreviousSearchResult',
      title: 'Focus Previous Search Result',
      titleKey: 'commands.search.previous_result.title',
      category: 'Search',
      categoryKey: 'commands.search.category',
      hotkey: 'shift+f4',
      fn: () => focusNextSearchResult(-1),
    });
  }
}
