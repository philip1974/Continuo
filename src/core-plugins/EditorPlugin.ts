// 内置 Editor 插件(吃自家狗粮,验证 Plugin API,M-Plugin v1.7)。
// 把原 panels.tsx 硬编码的 'editor' 渲染搬进来,通过 registerPanel 贡献。
// codemirror + milkdown + prosemirror + katex 全部走 lazy chunk,不进主 bundle。
// 面板 chunk 走共享加载器:openFile({line}) 冷路径预加载与这里共用同一 promise。

import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { loadEditorPanelModule } from '@/panels/Editor/editor-engine-loaders';
import { editorCommandSpecs } from '@/panels/Editor/editor-commands';
import { editorTextCommandSpecs } from '@/panels/Editor/editor-text-commands';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { installNavigationHistory } from '@/panels/Editor/navigation-history';
import { installEditorPreviewSettingSync } from '@/panels/Editor/editor-preview';

const Editor = lazy(() =>
  loadEditorPanelModule().then((m) => ({ default: m.EditorPanel })),
);

export default class EditorPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'editor',
      title: 'Editor',
      titleKey: 'panels.editor.title',
      factory: lazyPanel(Editor),
    });
    // ⌘W 关闭编辑器 / ⌘S 保存 / 下一个·上一个编辑器(VSCode 同名命令)。
    for (const spec of editorCommandSpecs(detectPlatform())) this.addCommand(spec);
    // 文本编辑命令(切换注释 / 移动行 / 选中行 / 折叠 …;BDD: src/__tests__/editor-text-commands/)
    for (const spec of editorTextCommandSpecs(detectPlatform())) this.addCommand(spec);
    // 后退 / 前进的导航记录(活动编辑器 / 路径变更 / 工作区根订阅;BDD: src/__tests__/editor-navigation-history/)
    this.register({ dispose: installNavigationHistory() });
    // 预览编辑器设置关闭 → 已有预览 tab 转常驻(BDD: src/__tests__/editor-preview-tab/)
    this.register({ dispose: installEditorPreviewSettingSync() });
  }
}
