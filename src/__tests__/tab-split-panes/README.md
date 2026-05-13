# Tab Split Panes

Behavior contract for topic 02 tab split panes.

These specs define the integrated plan-v4 surface:

- Dockview panel factories must forward panel props into lazy React panels.
- Terminal split panes are scoped sessions that hydrate from panel params and do not leak into the legacy terminal tab list.
- Split commands create right/down/nested terminal panels, inherit cwd, disable popout behavior, and preserve hotkey ownership.
- OSC 7 cwd tracking is driven by shell integration and rejects remote hosts while accepting tmux passthrough.
- Closing scoped terminal panels removes terminal sessions through `terminal.remove`.
- Layout persistence strips volatile `sessionId` from restored terminal panels and flushes every window before quit.

All specs are executable assertions. They are expected to fail until Op2-Op15 land.
