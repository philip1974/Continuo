// useTerminal hook(M-Terminal Step T4):xterm 实例 + 事件订阅 + resize observer。
// 从 MindAutonAgent 移植,简化:
//   - 删 loadTerminalConfig(我们没 config IPC,内联默认值)
//   - 删 theme 切换订阅(Continuo 暗色固定)
//   - scrollback 改 20000(决策 #3:跑 Agent CLI 输出大)
//   - electronAPI.terminal → coApi.terminal

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { coApi } from '@/lib/co-api';
import { disposeQueue, safeWrite } from './safeWrite';

const TERM_OPTIONS = {
  scrollback: 20000, // 跑 Agent CLI 大输出留余量(决策 #3)
  fontSize: 13,
  lineHeight: 1.2,
  letterSpacing: 0.2,
  // Powerline / Nerd 符号 fallback 链:
  //   1. MesloLGS NF / JetBrainsMono Nerd Font Mono / Symbols Nerd Font Mono
  //      — Nerd Fonts 现代版(用户装了哪种用哪种)
  //   2. Meslo LG {L,M,S} for Powerline — 老 Powerline 项目,P10k/oh-my-zsh
  //      用户常装,兜 powerline-extra-symbols
  //   3. SF Mono / Menlo / Monaco — macOS 内置等宽,普通 ASCII
  //   4. monospace 通用兜底
  fontFamily:
    '"MesloLGS NF", "JetBrainsMono Nerd Font Mono", "Symbols Nerd Font Mono", "Meslo LG M for Powerline", "Meslo LG L for Powerline", "Meslo LG S for Powerline", "SF Mono", Menlo, Monaco, Consolas, monospace',
  smoothScrollDuration: 0,
  fastScrollModifier: 'alt' as const,
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'block' as const,
  // 沿用 Mind 暗色调,避免引入主题切换复杂度
  theme: {
    background: '#020617',
    foreground: '#e6edf3',
    cursor: '#f8fafc',
    selectionBackground: 'rgba(82, 139, 255, 0.32)',
    black: '#20252b',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
};

/**
 * 挂在 div container 上,创建 xterm 实例,监听数据流与 resize。
 * unmount 时彻底清理(订阅、observer、queue、term.dispose)。
 *
 * 注意:返回的 ref 必须由调用方放在容器 div 上;termId 变化会重建实例。
 */
export function useTerminal(termId: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 首次 PTY stdout 到达前 = 还在 spawn shell + 跑 .zshrc。让上层显示 loading
  // overlay,用户看到"启动中..."而非纯黑框,减弱"卡顿"感(尤其 .zshrc 重的用户)。
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setIsReady(false); // 切 session 时回 loading
    const container = containerRef.current;
    if (!container || !termId) return;

    const term = new Terminal(TERM_OPTIONS);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // 首屏 fit + 通知主进程初始尺寸。
    // 同步先试一次(useEffect 跑在 paint 后,容器一般已有尺寸,可省 1 帧);
    // cols/rows 拿到 0 说明容器还没 layout 完,fallback 到 RAF 下一帧重试。
    const doFit = (): boolean => {
      try {
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          void coApi.terminal.resize(termId, term.cols, term.rows);
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    };
    if (!doFit()) requestAnimationFrame(doFit);

    // 主进程 stdout → safeWrite 队列。第一次收到本 termId 的 data 就标 ready,
    // 上层移除 loading overlay。
    let firstData = true;
    const unsubData = coApi.terminal.onData((id: string, data: string) => {
      if (id !== termId) return;
      if (firstData) {
        firstData = false;
        setIsReady(true);
      }
      safeWrite(term, data);
    });

    // 用户输入 → IPC write
    const onDataDisposable = term.onData((data: string) => {
      void coApi.terminal.write(termId, data);
    });

    // 容器尺寸变化 → fit + resize
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        void coApi.terminal.resize(termId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(container);

    return () => {
      unsubData();
      onDataDisposable.dispose();
      ro.disconnect();
      disposeQueue(term);
      term.dispose();
    };
  }, [termId]);

  return { containerRef, isReady };
}
