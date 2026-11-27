// 内置「资源管理器」SettingTab + Explorer 类设置项(M-Settings v6)。
// FolderTree / FileRow 通过 useSettingValue 订阅这些项实时生效。
// 同时贡献 view 命令 explorer.toggleSidebar(⌘B,VSCode 同款)与资源管理器入口命令(新建文件 / 新建文件夹 /
// 打开文件夹 ⌘O / 显示资源管理器 ⌘⇧E,见 explorer-commands.ts)。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import {
  EXPLORER_AUTO_REVEAL,
  EXPLORER_DECORATIONS_BADGES,
  EXPLORER_DECORATIONS_COLORS,
  EXPLORER_CONFIRM_DELETE,
  EXPLORER_CONFIRM_DRAG_AND_DROP,
  EXPLORER_INDENT_SIZE,
  EXPLORER_SHOW_HIDDEN_FILES,
  SEARCH_DECORATIONS_BADGES,
  SEARCH_DECORATIONS_COLORS,
} from '@/plugins/settings/core-setting-specs';
import { renderCategoryTab } from './lazy-category-tab';
import { ExplorerIcon } from '@/plugins/settings/tab-icons';
import { explorerCommandSpecs, toggleSidebarVisibility } from '@/panels/Explorer/explorer-commands';
import { outlineCommandSpecs } from '@/panels/Outline/outline-commands';

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
      // 隐藏含焦点的侧栏 → 焦点交给活动面板(VSCode),见 toggleSidebarVisibility
      fn: () => toggleSidebarVisibility(),
    });
    for (const spec of explorerCommandSpecs()) this.addCommand(spec);
    // 侧栏「大纲」视图(BDD: src/__tests__/markdown-outline/)
    for (const spec of outlineCommandSpecs()) this.addCommand(spec);

    this.addSettingItem(EXPLORER_SHOW_HIDDEN_FILES);

    this.addSettingItem(EXPLORER_INDENT_SIZE);

    this.addSettingItem(EXPLORER_CONFIRM_DELETE);

    this.addSettingItem(EXPLORER_CONFIRM_DRAG_AND_DROP);

    this.addSettingItem(EXPLORER_AUTO_REVEAL);

    this.addSettingItem(EXPLORER_DECORATIONS_COLORS);

    this.addSettingItem(EXPLORER_DECORATIONS_BADGES);

    // 「搜索」组:搜索结果的 git 装饰(VSCode search.decorations.*)
    this.addSettingItem(SEARCH_DECORATIONS_COLORS);

    this.addSettingItem(SEARCH_DECORATIONS_BADGES);
  }
}
