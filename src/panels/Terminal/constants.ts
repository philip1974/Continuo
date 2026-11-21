// Single source of truth for the dockview `contentComponent` / panel `type`
// identifier used when registering the Terminal panel. Imported by:
//   - TerminalPlugin (registerPanel + terminal.search.toggle command guard)
//   - DockShell (active-panel routing checks)
//   - terminal-panel-zoom (zoom command guard)
//   - terminal-search-state (active-panel resolver for command scoping)
//
// Issue #42: replaces the magic string `'terminal'` previously duplicated
// across 6 sites.
export const TERMINAL_PANEL_TYPE = 'terminal';
