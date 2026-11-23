// Single source of truth for the dockview `contentComponent` / panel `type`
// identifier used when registering the Terminal panel. Imported by:
//   - TerminalPlugin (registerPanel + terminal.search.toggle command guard)
//   - DockShell / DockReconciler / HeaderActions / strip-terminal-layout (panel type checks)
//   - terminal-panel-zoom (zoom command guard)
//
// Issue #42: replaces the magic string `'terminal'` previously duplicated
// across 6 sites.
export const TERMINAL_PANEL_TYPE = 'terminal';
