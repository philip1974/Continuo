import { Plugin } from '@/plugins/Plugin';
import { splitTerminal } from '@/lib/split-terminal';

export default class TerminalPanelPlugin extends Plugin {
  onload(): void {
    this.addCommand({
      id: 'terminal.splitRight',
      title: 'Split Terminal Right',
      category: 'Terminal',
      hotkey: 'mod+\\',
      fn: async () => {
        await splitTerminal('right');
      },
    });
    this.addCommand({
      id: 'terminal.splitDown',
      title: 'Split Terminal Down',
      category: 'Terminal',
      hotkey: 'mod+shift+\\',
      fn: async () => {
        await splitTerminal('below');
      },
    });
  }
}
