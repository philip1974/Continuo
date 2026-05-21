// useTerminal hook(M-Terminal Step T4):xterm 实例 + 事件订阅 + resize observer。
// 从 MindAutonAgent 移植,简化:
//   - 删 loadTerminalConfig(我们没 config IPC,内联默认值)
//   - scrollback 改 20000(决策 #3:跑 Agent CLI 输出大)
//   - electronAPI.terminal → coApi.terminal
// theme:跟随 ThemeProvider 的 resolved(dark/light)— 与 CodeEditor 一致,
//   切主题时不重建 term,只改 term.options.theme(避免丢历史输出)。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { coApi } from '@/lib/co-api';
import { useSettingValue } from '@/plugins/settings/values-store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useTheme } from '@/theme';
import { disposeQueue, safeWrite } from './safeWrite';
import {
  applyMappedKeyOnKeydown,
  consumeMappedKeyOnData,
  createMappedKeyState,
  shouldSkipXtermKey,
} from './key-mapping';

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
// blue/red/green 等取"中等亮度"(link 600 级别),Powerline 主题(P10k 等)
// 用 ANSI 色当 segment 背景时也兼顾黑字 / 白字两种前景的可读性。
//
// white / brightWhite 的 trade-off(issue #24):
//   旧设计 brightWhite='#ffffff' = background,白底白字**完全不可见**;
//   white='#bbbbbb' 对比度仅 2.4:1 远低 WCAG AA(4.5)。Claude Code / Codex
//   等 CLI 大量用 white/brightWhite 当 dim / 状态文本,在白底直接消失。
//   修后(VSCode Light+ 同款):
//     - white = #6e7681(Primer fg.muted,~4.6:1 达 AA)
//     - brightWhite = #57606a(Primer fg.subtle,~5.7:1)
//   代价:Powerline 在彩色背景 + brightWhite fg 时不再纯白(但仍可读)。
//   普通文本可读性 > Powerline 极致 stark white。
//
// minimumContrastRatio (新增 2026-05-13, issue #24):
//   仅靠调色板修不动 \e[2m dim cells(Claude Code 状态/进度/键盘提示行)、
//   256-color grayscale 高段 250-255、truecolor 180+ 灰阶 — 这些都绕过 16-ANSI 槽。
//   xterm `minimumContrastRatio` option 在 rendering 时自动拔 fg 到对比达标,
//   是 VSCode terminal 同款策略。
//   light = 7 (AAA), dark = 1 (dark 调色板已达 AA,不动)。
//   **dim 单元 xterm 按 ratio/2 处理(红队 P0.1)**:light dim 实际保 ~3.5:1(AA Large),
//   非 AA 但可读;commit body 显式声明此点,不谎称达 AA。
//   构造时 + theme effect 同步 set,避免主题切换残留旧值。
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
  white: '#6e7681',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a371f7',
  brightCyan: '#3192aa',
  brightWhite: '#57606a',
};

function fitAndResize(
  term: Terminal,
  fitAddon: FitAddon,
  termId: string,
): boolean {
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
}

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

    // topic-07: dockview 新 group 容器初始可能尺寸 0×0(layout 完成前 mount),
    // xterm 必须等容器有真实尺寸再 open,否则 cols/rows 锁死为 0 → PTY 输出
    // 灌入也看不见。容器已有尺寸 → 直接 init;0×0 → ResizeObserver 等首次有
    // 尺寸再 init。
    let cleanupTerm: (() => void) | null = null;
    let waitRo: ResizeObserver | null = null;

    const initXterm = () => {
      if (cleanupTerm) return; // 已初始化
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      cleanupTerm = doInitXterm();
    };

    const doInitXterm = (): (() => void) => {
      const term = new Terminal({
      ...TERM_OPTIONS,
      // 用当前 settings + 主题值开局,避免初始一帧的旧值闪烁
      fontSize,
      cursorStyle,
      theme: resolved === 'dark' ? DARK_THEME : LIGHT_THEME,
      // light 7 (AAA), dark 1 — 见 LIGHT_THEME 注释 (issue #24)
      minimumContrastRatio: resolved === 'dark' ? 1 : 7,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        void coApi.shell.openExternal(url);
      }),
    );
    term.open(container);
    // 启用 webgl renderer:dom renderer 用 letter-spacing 模拟 CJK 双宽度,
    // 累加误差让 row content 实际渲染宽超过 row.style.width(= cols ×
    // cellWidth),触发 row 自带的 overflow:hidden 裁 CJK 末尾几个字。
    // webgl 用 GPU 按 cell grid 直接画字符,无 letter-spacing 路径,CJK
    // 测量精确,不会越 row 边界。VSCode 终端默认 webgl,见 issue #15。
    //
    // GPU 不可用 / context lost 时静默回退 dom(终端能用,只是 CJK 边界
    // 可能再现)。webgl context 在 main process 关 GPU 加速、用户开太多
    // canvas 时偶发不可用,不能让 terminal 崩。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn('[terminal] webgl renderer init 失败,回退 dom:', err);
    }
    const __mappedKeyState__ = createMappedKeyState();
    // Shift+Enter 等额外按键映射:keydown 只暂存映射结果,onData 转发器再把
    // xterm 默认发出的 \r 替换为映射字节,避免 \x1b\r\r 双写。见 issue #18。
    term.attachCustomKeyEventHandler((event) => {
      // topic-22: Shift+(Cmd|Ctrl)+Enter 让 xterm 不发 \r,document keydown
      // 派发 terminal.zoom.toggle 命令。pending 不污染(命中即 return false 跳过)。
      if (shouldSkipXtermKey(event)) return false;
      applyMappedKeyOnKeydown(__mappedKeyState__, event);
      return true;
    });
    termRef.current = term;
    fitRef.current = fitAddon;

    const osc7Disposable = term.parser.registerOscHandler(7, (data) => {
      try {
        const m = /^file:\/\/([^/]*)(\/.*)?$/.exec(data);
        if (!m) return true;
        const [, host, encPath] = m;
        if (host && host !== 'localhost') return true;
        if (!encPath) return true;
        const cwd = decodeURI(encPath);
        void coApi.terminal.updateCwd(termId, cwd);
      } catch {
        // malformed OSC 7 payloads must not break terminal output handling.
      }
      return true;
    });

    // 首屏 fit + 通知主进程初始尺寸。
    // 同步先试一次(useEffect 跑在 paint 后,容器一般已有尺寸,可省 1 帧);
    // cols/rows 拿到 0 说明容器还没 layout 完,fallback 到 RAF 下一帧重试。
    const doFit = () => fitAndResize(term, fitAddon, termId);
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

    // topic-07: dockview lazy-mount inactive panel 会错过 PTY spawn 后的初始
    // 输出(shell prompt 等),从 main buffer 把已有 raw chunks replay 进 xterm。
    // 先 subscribe 后 replay,中间窗口期的 chunk 走 onData 路径(虽然可能与
    // history 末尾重叠几个字符,但 xterm 容忍重复 ANSI/字符;比丢失初始 prompt 好)。
    void coApi.terminal.readHistory(termId).then((r) => {
      if (!r.ok || !r.data.data) return;
      if (firstData) {
        firstData = false;
        setIsReady(true);
      }
      safeWrite(term, r.data.data);
    });

    // 用户输入 → IPC write
    const onDataDisposable = term.onData((data: string) => {
      const outgoing = consumeMappedKeyOnData(__mappedKeyState__, data);
      void coApi.terminal.write(termId, outgoing);
    });

    // 容器尺寸变化 → fit + resize
    const ro = new ResizeObserver(() => {
      fitAndResize(term, fitAddon, termId);
    });
    ro.observe(container);

      return () => {
        unsubData();
        onDataDisposable.dispose();
        osc7Disposable.dispose();
        ro.disconnect();
        disposeQueue(term);
        term.dispose();
        // xterm.dispose() 不移除 DOM children。StrictMode 双 mount 场景下
        // 第一个 xterm 的残留 DOM 仍在 container,第二个 xterm.open 后会被
        // 覆盖 → 屏幕全黑。手动清空 container。
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
        termRef.current = null;
        fitRef.current = null;
      };
    }; // end doInitXterm

    // 尝试立即 init;容器 0×0(inactive panel)则用 ResizeObserver 等首次
    // 有尺寸再 init。
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      initXterm();
    } else {
      waitRo = new ResizeObserver(() => initXterm());
      waitRo.observe(container);
    }

    return () => {
      waitRo?.disconnect();
      cleanupTerm?.();
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
    fitAndResize(term, fit, termId);
  }, [fontSize, cursorStyle, termId]);

  // 主题切换 → 已有 term 实例同步 theme(不重建,保留历史输出)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolved === 'dark' ? DARK_THEME : LIGHT_THEME;
    // 同步 minimumContrastRatio,避免 dark→light 残留 1 / light→dark 拔亮 dim prompt
    term.options.minimumContrastRatio = resolved === 'dark' ? 1 : 7;
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
    const raf = requestAnimationFrame(() => fitAndResize(term, fit, termId));
    return () => cancelAnimationFrame(raf);
  }, [sidebarOpen, sidebarWidth, termId]);

  const fit = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;
    fitAndResize(term, fitAddon, termId);
  }, [termId]);

  // topic-22: stale-safe focus,unmount 后 termRef.current 已被 dispose 路径置 null
  // (line 291 cleanup),callback 自然 no-op,焦点不会落到已 dispose 的实例。
  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  return { containerRef, isReady, fit, focus };
}
