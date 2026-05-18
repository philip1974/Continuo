import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { Output } from '@/panels/Output';

export default class OutputPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'output',
      title: 'Output',
      titleKey: 'panels.output.title',
      factory: () => createElement(Output),
    });
  }
}
