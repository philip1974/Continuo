// 内置「资源管理器」SettingTab + Explorer 类设置项(M-Settings v6)。
// FolderTree / FileRow 通过 useSettingValue 订阅这些项实时生效。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { CategoryTabContent } from '@/plugins/settings/CategoryTabContent';
import { ExplorerIcon } from '@/plugins/settings/tab-icons';

export default class ExplorerTabPlugin extends Plugin {
  onload(): void {
    // priority 20:排在通用(1)/ 编辑器(10)之后,插件商店(40)之前
    this.addSettingTab({
      id: 'core.explorer',
      title: '资源管理器',
      priority: 20,
      icon: createElement(ExplorerIcon),
      render: () =>
        createElement(CategoryTabContent, { category: 'explorer' }),
    });

    this.addSettingItem({
      id: 'explorer.showHiddenFiles',
      category: 'explorer',
      title: '显示隐藏文件',
      description: '是否显示以 . 开头的文件(如 .git / .env)。',
      type: 'boolean',
      default: false,
      priority: 1,
    });

    this.addSettingItem({
      id: 'explorer.indentSize',
      category: 'explorer',
      title: '缩进宽度',
      description: '文件树每级缩进(影响视觉层级)。',
      type: 'number',
      default: 16,
      min: 8,
      max: 32,
      step: 2,
      unit: 'px',
      priority: 2,
    });
  }
}
