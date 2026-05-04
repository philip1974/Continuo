// 单 terminal 视图:挂 useTerminal hook 的容器 div。
// 父(TerminalPanel)用 display:none/flex 切 active 而非 unmount,
// 这样 xterm 实例保留(滚动位置 / scrollback 不丢)。

import { useTerminal } from './useTerminal';

interface TerminalViewProps {
  termId: string;
}

export function TerminalView({ termId }: TerminalViewProps) {
  const { containerRef } = useTerminal(termId);
  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#020617] p-1"
      // 防 ResizeObserver 接收到 0×0 → fit 抛错
      style={{ minHeight: 0 }}
    />
  );
}
