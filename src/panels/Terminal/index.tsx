// Terminal panel 入口。dockview panel 单 session 视图。
// 这里只 re-export 一次,让 main.tsx 的 `import('@/panels/Terminal')` lazy prefetch
// 把 xterm chunk 拉下来(实际 panel factory 在 TerminalPlugin.ts 直接 lazy import view)。
export { TerminalPanelView, TerminalPanelView as Terminal } from './TerminalPanelView';
