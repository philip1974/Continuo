// useTerminal hook(M-Terminal Step T4):xterm 实例 + 事件订阅 + resize observer。
// 从 MindAutonAgent 移植,简化:
//   - 删 loadTerminalConfig(我们没 config IPC,内联默认值)
//   - scrollback 改 20000(决策 #3:跑 Agent CLI 输出大)
//   - electronAPI.terminal → coApi.terminal
// theme:跟随 ThemeProvider 的 resolved(dark/light)— 与 CodeEditor 一致,
//   切主题时不重建 term,只改 term.options.theme(避免丢历史输出)。

import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { coApi } from '@/lib/co-api';
import { useSettingValue } from '@/plugins/settings/values-store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useTheme } from '@/theme';
import { disposeQueue, safeWrite } from './safeWrite';
import { mapTerminalKey } from './key-mapping';

type CursorStyle = 'block' | 'underline' | 'bar';

// GitHub Dark 调色板(原 Mind 暗色)
const DARK_THEME: ITheme = {
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
};

// Light 调色板 — 取色自 GitHub Primer link blue + Primer 语义色。
// 关键约束:Powerline 主题(P10k 等)用 ANSI 颜色当 segment 背景,前景色不固定
// (有的主题 fg=black,有的 fg=brightWhite)— 每个 ANSI 色当背景时,需要同时
// 兼顾黑字和白字两种前景的可读性。所以 blue/red/green 等取"中等亮度"
// (link 600 级别),而非 GitHub UI text 边框那种深色,也不是 dark 主题那种浅色。
// white / brightWhite 走 *terminal 语义*(浅灰 + 纯白),不是 UI 文本语义 —
// brightWhite 必须是真"白"才能在彩色背景上可读。
const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  selectionBackground: 'rgba(82, 139, 255, 0.24)',
  black: '#1f2328',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#bbbbbb',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a371f7',
  brightCyan: '#3192aa',
  brightWhite: '#ffffff',
};

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
  // settings(实时):字号 / 光标样式
  const fontSize = useSettingValue<number>('terminal.fontSize', 13);
  const cursorStyle = useSettingValue<CursorStyle>(
    'terminal.cursorStyle',
    'block',
  );
  const { resolved } = useTheme();
  // term + fit 跨 effect 共享(创建 effect 写 ref,settings effect 读 ref 改 options)
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    setIsReady(false); // 切 session 时回 loading
    const container = containerRef.current;
    if (!container || !termId) return;

    const term = new Terminal({
      ...TERM_OPTIONS,
      // 用当前 settings + 主题值开局,避免初始一帧的旧值闪烁
      fontSize,
      cursorStyle,
      theme: resolved === 'dark' ? DARK_THEME : LIGHT_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    // Shift+Enter 等额外按键映射:由 mapTerminalKey 决定是否改写。返回非 null
    // 时直接写 PTY 并阻止 xterm 默认处理(避免 \r 与 \x1b\r 同时发);返回
    // null 时放行,xterm 走默认逻辑(普通 Enter 仍发 \r)。见 issue #18。
    term.attachCustomKeyEventHandler((event) => {
      const data = mapTerminalKey(event);
      if (data !== null) {
        void coApi.terminal.write(termId, data);
        return false;
      }
      return true;
    });
    termRef.current = term;
    fitRef.current = fitAddon;

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
      termRef.current = null;
      fitRef.current = null;
    };
    // 创建只依赖 termId;fontSize/cursorStyle 走下面的 settings effect 动态改。
    // 不放 deps 是有意的(否则改字号会重建 term 丢掉历史输出)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  // settings → 已有 term 实例同步(不重建),改完 fit + resize 让 PTY 跟上新行列数
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = fontSize;
    term.options.cursorStyle = cursorStyle;
    try {
      fit.fit();
      if (term.cols > 0 && term.rows > 0) {
        void coApi.terminal.resize(termId, term.cols, term.rows);
      }
    } catch {
      /* ignore */
    }
  }, [fontSize, cursorStyle, termId]);

  // 主题切换 → 已有 term 实例同步 theme(不重建,保留历史输出)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolved === 'dark' ? DARK_THEME : LIGHT_THEME;
  }, [resolved]);

  // sidebar(显示 / 隐藏 / 拖宽)→ 强制重 fit。
  //
  // 见 issue #15 复现路径:启动时 sidebar 默认显示 → 初始 fit 算 cols=A;
  // 用户隐藏 sidebar → terminal 变宽 → ResizeObserver 触发 fit → cols=B(更大);
  // 用户再显示 sidebar → terminal 变窄 → 但 RO 在某些 React 重排时序下漏 fire,
  // cols 仍是 B,xterm .xterm-screen width = B × cellWidth > 新的 host width →
  // 文字向右溢出。
  //
  // 事件驱动 fit 兜底:订阅 layoutUi 的 sidebarOpen/Width,变化下一帧强制 fit。
  // RAF 让 React 完成 layout 提交后再量;与 RO 重叠不会有副作用(fit 幂等)。
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useLayoutUiStore((s) => s.sidebarWidth);
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0) {
          void coApi.terminal.resize(termId, term.cols, term.rows);
        }
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [sidebarOpen, sidebarWidth, termId]);

  return { containerRef, isReady };
}
