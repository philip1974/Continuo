// 内置 Editor 插件(吃自家狗粮,验证 Plugin API,M-Plugin v1.7)。
// 把原 panels.tsx 硬编码的 'editor' 渲染搬进来,通过 registerPanel 贡献。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { Editor } from '@/panels/Editor';

export default class EditorPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'editor',
      title: 'Editor',
      factory: () => createElement(Editor),
    });
  }
}
