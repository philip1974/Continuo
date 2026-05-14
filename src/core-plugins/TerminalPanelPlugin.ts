import { Plugin } from '@/plugins/Plugin';
import { focusTerminalPane, splitTerminal } from '@/lib/split-terminal';

export default class TerminalPanelPlugin extends Plugin {
  onload(): void {
    this.addCommand({
      id: 'terminal.splitRight',
      title: 'Split Terminal Right',
      category: 'Terminal',
      hotkey: 'mod+\\',
      fn: async () => {
        // Note:xterm focus uses attachCustomKeyEventHandler to call the
        // controller directly and returns false, so this command is for the
        // command palette / non-xterm focus path and does not double-trigger.
        await splitTerminal('horizontal');
      },
    });
    this.addCommand({
      id: 'terminal.splitDown',
      title: 'Split Terminal Down',
      category: 'Terminal',
      hotkey: 'mod+shift+\\',
      fn: async () => {
        // Note:xterm focus uses attachCustomKeyEventHandler to call the
        // controller directly and returns false, so this command is for the
        // command palette / non-xterm focus path and does not double-trigger.
        await splitTerminal('vertical');
      },
    });
    this.addCommand({
      id: 'terminal.focusPrevPane',
      title: 'Focus Previous Terminal Pane',
      category: 'Terminal',
      hotkey: 'mod+[',
      fn: () => {
        // Note:xterm focus uses attachCustomKeyEventHandler to call the
        // controller directly and returns false, so this command is for the
        // command palette / non-xterm focus path and does not double-trigger.
        focusTerminalPane('prev');
      },
    });
    this.addCommand({
      id: 'terminal.focusNextPane',
      title: 'Focus Next Terminal Pane',
      category: 'Terminal',
      hotkey: 'mod+]',
      fn: () => {
        // Note:xterm focus uses attachCustomKeyEventHandler to call the
        // controller directly and returns false, so this command is for the
        // command palette / non-xterm focus path and does not double-trigger.
        focusTerminalPane('next');
      },
    });
  }
}
