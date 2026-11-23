// 内置 Editor 插件(吃自家狗粮,验证 Plugin API,M-Plugin v1.7)。
// 把原 panels.tsx 硬编码的 'editor' 渲染搬进来,通过 registerPanel 贡献。
// codemirror + milkdown + prosemirror + katex 全部走 lazy chunk,不进主 bundle。
// 面板 chunk 走共享加载器:openFile({line}) 冷路径预加载与这里共用同一 promise。

import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { loadEditorPanelModule } from '@/panels/Editor/editor-engine-loaders';

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
  }
}
