// 内置 Editor 插件(吃自家狗粮,验证 Plugin API,M-Plugin v1.7)。
// 把原 panels.tsx 硬编码的 'editor' 渲染搬进来,通过 registerPanel 贡献。
// codemirror + milkdown + prosemirror + katex 全部走 lazy chunk,不进主 bundle。

import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';

const Editor = lazy(() =>
  import('@/panels/Editor').then((m) => ({ default: m.Editor })),
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
