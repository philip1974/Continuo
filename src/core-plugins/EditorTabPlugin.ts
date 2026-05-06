// 内置「编辑器」SettingTab + 编辑器类设置项(M-Settings v6)。
// 复用 CategoryTabContent 渲染 category='editor';items 由本 plugin 注册,
// 业务侧组件通过 useSettingValue 订阅各项实时变化。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { CategoryTabContent } from '@/plugins/settings/CategoryTabContent';

export default class EditorTabPlugin extends Plugin {
  onload(): void {
    // priority 10:排在「通用(1)」后,「插件商店(40)」前
    this.addSettingTab({
      id: 'core.editor',
      title: '编辑器',
      priority: 10,
      render: () => createElement(CategoryTabContent, { category: 'editor' }),
    });

    // 字号(应用到 CodeEditor 的 CodeMirror 实例 — CSS variable 联动)
    this.addSettingItem({
      id: 'editor.fontSize',
      category: 'editor',
      title: '字号',
      description: 'CodeEditor(代码 / Source mode)的字号,单位 px。',
      type: 'number',
      default: 13,
      min: 10,
      max: 28,
      step: 1,
      priority: 1,
    });

    // 行号(隐藏整列 gutters:行号 + fold marker)
    this.addSettingItem({
      id: 'editor.lineNumbers',
      category: 'editor',
      title: '显示行号',
      description: 'CodeEditor 是否显示行号(同时控制代码折叠 marker)。',
      type: 'boolean',
      default: true,
      priority: 2,
    });

    // 自动保存(Markdown)— EditorPanel 订阅
    this.addSettingItem({
      id: 'autoSave.markdown.enabled',
      category: 'editor',
      title: '自动保存 Markdown',
      description: '关闭后 Markdown 也需 ⌘S 显式保存。代码文件不自动保存。',
      type: 'boolean',
      default: true,
      priority: 10,
    });

    // 自动保存延迟(防抖窗口,ms)
    this.addSettingItem({
      id: 'autoSave.delayMs',
      category: 'editor',
      title: '自动保存延迟',
      description: '停止输入多久后触发自动保存,单位毫秒。',
      type: 'number',
      default: 2000,
      min: 500,
      max: 10000,
      step: 100,
      priority: 11,
    });
  }
}
