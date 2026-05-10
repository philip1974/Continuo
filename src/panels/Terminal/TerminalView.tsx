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
      {/*
        外 wrapper 持 padding,内 containerRef 无 padding。原因(issue #15
        反复修):xterm fitAddon proposeDimensions() 读 padding 时读的是 xterm
        自己创建的 .xterm 元素(总是 0 padding),而非 containerRef。Tailwind
        box-sizing:border-box 下 getComputedStyle(containerRef).width 返回
        含 padding 的全宽 → fitAddon 把 padding 区也算进可用宽 → cols 偏多 →
        最右列绘到 .xterm 边界外被裁。把 padding 上提一层后,fitAddon 量
        containerRef.width 即真实可绘制宽度。
      */}
      <div className="h-full w-full bg-canvas px-2 py-1">
        <div
          ref={containerRef}
          data-testid="terminal-xterm-host"
          // overflow-x-hidden:resize 时 xterm.Buffer.reflow 对带 ANSI 控制
          // 序列的旧行(claude/codex 输出)**不重排**(xterm.js 设计限制),
          // .xterm-screen width 按旧 cols × cellWidth 撑出 host 边界 → 视觉
          // 溢出。VSCode 终端同款修法:容器裁掉溢出。新输出按新 cols 正常
          // wrap,只有 scrollback 里的旧长行被裁(可接受妥协)。
          className="h-full w-full overflow-x-hidden"
          // 防 flex 父在 panel 收起时把它挤到 0×0 → fit 抛 NaN
          style={{ minHeight: 0 }}
        />
      </div>
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
