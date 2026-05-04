import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { Terminal } from '@/panels/Terminal';

export default class TerminalPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'terminal',
      title: 'Terminal',
      factory: () => createElement(Terminal),
    });
  }
}
