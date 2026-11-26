// 内置「资源管理器」SettingTab + Explorer 类设置项(M-Settings v6)。
// FolderTree / FileRow 通过 useSettingValue 订阅这些项实时生效。
// 同时贡献 view 命令 explorer.toggleSidebar(⌘B,VSCode 同款)与资源管理器入口命令(新建文件 / 新建文件夹 /
// 打开文件夹 ⌘O / 显示资源管理器 ⌘⇧E,见 explorer-commands.ts)。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import {
  EXPLORER_AUTO_REVEAL,
  EXPLORER_CONFIRM_DELETE,
  EXPLORER_CONFIRM_DRAG_AND_DROP,
  EXPLORER_INDENT_SIZE,
  EXPLORER_SHOW_HIDDEN_FILES,
} from '@/plugins/settings/core-setting-specs';
import { renderCategoryTab } from './lazy-category-tab';
import { ExplorerIcon } from '@/plugins/settings/tab-icons';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { explorerCommandSpecs } from '@/panels/Explorer/explorer-commands';

export default class ExplorerTabPlugin extends Plugin {
  onload(): void {
    // priority 20:排在通用(1)/ 编辑器(10)之后,插件市场(40)之前
    this.addSettingTab({
      id: 'core.explorer',
      title: 'Explorer',
      titleKey: 'settings.explorer.tab_title',
      priority: 20,
      icon: createElement(ExplorerIcon),
      render: () => renderCategoryTab('explorer'),
    });

    this.addCommand({
      id: 'explorer.toggleSidebar',
      title: 'Toggle Explorer Sidebar',
      titleKey: 'settings.explorer.toggle_sidebar',
      category: 'Explorer',
      // i18n(I18,I17 同族缺 Key):补 categoryKey,命令面板/快捷键分类经 tk 本地化
      categoryKey: 'commands.explorer.category',
      hotkey: 'mod+b',
      fn: () => useLayoutUiStore.getState().toggleSidebar(),
    });
    for (const spec of explorerCommandSpecs()) this.addCommand(spec);

    this.addSettingItem(EXPLORER_SHOW_HIDDEN_FILES);

    this.addSettingItem(EXPLORER_INDENT_SIZE);

    this.addSettingItem(EXPLORER_CONFIRM_DELETE);

    this.addSettingItem(EXPLORER_CONFIRM_DRAG_AND_DROP);

    this.addSettingItem(EXPLORER_AUTO_REVEAL);
  }
}
