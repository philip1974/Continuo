// 单 terminal 视图:挂 useTerminal hook 的容器 div。
// 父(TerminalPanel)用 display:none/flex 切 active 而非 unmount,
// 这样 xterm 实例保留(滚动位置 / scrollback 不丢)。
//
// Loading overlay:首次 PTY stdout 到达前显示"启动 shell..." spinner,
// 让用户在 .zshrc 慢加载期间(常见 1-2s)有视觉反馈,而非黑屏等待。

import { Spinner } from '@/design';
import { useTerminal } from './useTerminal';

interface TerminalViewProps {
  termId: string;
}

export function TerminalView({ termId }: TerminalViewProps) {
  const { containerRef, isReady } = useTerminal(termId);
  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        // px-2 给 fitAddon 字宽测量误差留缓冲(防最右字符贴 / 穿右边缘,
        // 见 issue #15);py-1 顶/底各 4px,保持原行密度
        className="h-full w-full bg-canvas px-2 py-1"
        // 防 ResizeObserver 接收到 0×0 → fit 抛错
        style={{ minHeight: 0 }}
      />
      {!isReady && (
        <div
          // pointer-events-none 让 overlay 不挡住 xterm 焦点(用户立刻可输入,
          // 即使 prompt 还没出来,字符会缓冲到 PTY)
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]"
          aria-label="启动 shell"
        >
          <div className="flex items-center gap-2 text-xs text-fg-dim">
            <Spinner size="sm" />
            <span>启动 shell…</span>
          </div>
        </div>
      )}
    </div>
  );
}
