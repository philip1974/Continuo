// 终端「重命名…」请求(dock tab 右键菜单发起,该终端面板内容显示重命名框)。tab 头与面板内容是两棵组件,经此小 store 交接;
// 同一时刻至多一个终端在重命名。BDD: src/__tests__/terminal-title/
import { create } from 'zustand';

interface TerminalRenameRequestState {
  readonly sessionId: string | null;
}

export const useTerminalRenameRequest = create<TerminalRenameRequestState>(() => ({ sessionId: null }));

export function requestTerminalRename(sessionId: string): void {
  useTerminalRenameRequest.setState({ sessionId });
}

export function clearTerminalRename(): void {
  useTerminalRenameRequest.setState({ sessionId: null });
}
