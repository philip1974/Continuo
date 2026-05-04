// Terminal panel 入口。re-export Terminal(panels.tsx 已 import { Terminal });
// 实际渲染由 TerminalPanel 编排多 tab + xterm 实例。
export { TerminalPanel as Terminal } from './TerminalPanel';
