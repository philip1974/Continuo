# Terminal Pane Internal Split

Terminal panel owns an internal BSP pane tree instead of creating sibling Dockview terminal panels for every split.

Behavior covered here:

- Pure reducers return `{ state, effects }` and never hide effects inside React state.
- Hydration restores the tree first, then enqueues one explicit spawn per leaf.
- Spawn queue requests carry a reason, deduplicate by tab and leaf, and can be cancelled per leaf.
- Closing a leaf, tab, and panel emits distinct effects so a multi-tab panel is not closed too early.
- Pane controllers keep stable identity while reading latest state through refs.
- xterm key handlers target the leaf that owns the terminal instance.
- IPC resolves invalid cwd values before spawning and returns the resolved cwd to renderer metadata.
- PTY removal is deduplicated across leaf, tab, and panel close paths.
