// useTerminal hook(M-Terminal Step T4):xterm 实例 + 事件订阅 + resize observer。
// 从维护者早期原型移植,简化:
//   - 删 loadTerminalConfig(我们没 config IPC,内联默认值)
//   - scrollback 改 20000(决策 #3:跑 Agent CLI 输出大)
//   - electronAPI.terminal → coApi.terminal
// theme:跟随 ThemeProvider 的 resolved(dark/light)— 与 CodeEditor 一致,
//   切主题时不重建 term,只改 term.options.theme(避免丢历史输出)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { coApi } from '@/lib/co-api';
import { basename, isWindowsRuntime } from '@/lib/path-cross';
import { coApp } from '@/plugins/co-app';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { createTerminalFileLinkProvider } from './terminal-file-links';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  EDITOR_FONT_FAMILY,
  TERMINAL_CURSOR_STYLE,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
} from '@/plugins/settings/core-setting-specs';
import { resolveTerminalFontFamily, resolveTerminalLineHeight } from '@/plugins/settings/font-settings';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import {
  getIndexedTerminalSessionById,
  useTerminalStore,
} from '@/stores/terminal.store';
import { useTheme } from '@/theme';
import {
  disposeQueue,
  installAtlasGuards,
  registerOsc7Cwd,
  safeWrite,
} from '@continuo-terminal/react-terminal';
import {
  applyMappedKeyOnKeydown,
  consumeMappedKeyOnData,
  createMappedKeyState,
} from '@continuo-terminal/react-terminal';
import {
  isTerminalContextMenuKey,
  isTerminalKeptHotkey,
  isTerminalSearchHotkey,
  isTerminalZoomHotkey,
  runTerminalCommandFromKey,
  runTerminalZoomFromKey,
  terminalSendSequenceForKey,
  terminalYieldedCommandId,
} from './terminal-hotkeys';
import { createOutputCoalescer } from './output-coalescer';
import { installTerminalPasteSanitizer, sanitizeTerminalPaste } from './terminal-paste-sanitize';
import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { notify } from '@/notifications/notify';
import {
  applyTerminalSearchEffect,
  invalidateTerminalSearchDecorations,
  INITIAL_TERMINAL_SEARCH_STATE,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  terminalSearchReducer,
  type TerminalSearchAction,
  type TerminalSearchOptions,
  type TerminalSearchResult,
  type TerminalSearchState,
} from './terminal-search-state';
import { notifyFailure, notifyIfFailed, notifyThrownError } from '@/notifications/notify-thrown-error';
import { errorCodeOf } from '../../../electron/shared/error-message';
import { debounce, type DebouncedFn } from '@/lib/debounce';
import { t } from '@/i18n';
import { shouldAutoCloseExitedSession } from '@/shell/dock/terminal-panel-id';
import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import { hasOpenModalIn } from '@/design/Modal';


export interface SearchApi {
  readonly isOpen: boolean;
  readonly term: string;
  readonly options: TerminalSearchOptions;
  readonly result: TerminalSearchResult;
  /** 每次 open(含已打开时再 open)递增;搜索条据此重新聚焦并全选输入框。 */
  readonly focusRequest: number;
  readonly open: () => void;
  readonly close: () => void;
  readonly next: () => void;
  readonly prev: () => void;
  readonly setTerm: (term: string) => void;
  readonly setOptions: (options: TerminalSearchOptions) => void;
  readonly clearActiveDecoration: () => void;
}

// GitHub Dark 调色板(原 Mind 暗色)。background = 画布色(design-tokens.css `.dark` 的 --md-surface),终端与
// 周围面板同底色;字面值(xterm 只收 #RRGGBB,主题切换时子组件 effect 早于 <html> class 切换,运行时读 token 会
// 读到旧主题)由 design-system/tokens.spec(「终端与窗口底色跟随画布色」)守护与 token 一致。
const DARK_THEME: ITheme = {
  background: '#11131b',
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
  // = 画布色(design-tokens.css `:root` 的 --md-surface),同 DARK_THEME。
  background: '#fffbff',
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

/**
 * OSC7 cwd 接受的 host:空 / localhost + 本机 hostname。shell 集成(bash/fish)与 oh-my-zsh 等发
 * `file://<真实 hostname>$PWD`,parser 默认只收空 host / localhost → 这些 cwd 更新会被静默丢弃。
 * hostname 与 shell 同源(gethostname),按原样精确匹配;他机 hostname(ssh 远端)仍拒。
 */
export function osc7AcceptedHosts(hostname: string | null | undefined): string[] {
  return hostname ? ['', 'localhost', hostname] : ['', 'localhost'];
}

// 性能 P9:仅当网格(cols/rows)真变化才发 resize IPC。lastSize 即上次发往 PTY 的尺寸 = PTY 当前尺寸,
// 故相等时 PTY resize 是 no-op(还会触发多余 SIGWINCH)。
function syncPtySize(
  term: Terminal,
  termId: string,
  lastSize: { current: { cols: number; rows: number } | null },
): void {
  const prev = lastSize.current;
  if (prev && prev.cols === term.cols && prev.rows === term.rows) return;
  // race(R96):乐观更新 lastSize 阻止在途重复 resize;但 resize IPC 失败(ok:false / reject)
  // 时必须回滚,否则 lastSize 谎称该尺寸已同步 → 后续相同 cols/rows 不再重试 → xterm DOM 与
  // PTY 尺寸长期不一致(TUI 换行/光标错乱)。回滚到 prev(与 target 不同 → 同尺寸可重试);
  // 仅当 lastSize 仍是本次 target 时回滚(被更新的 resize 覆盖则不动 = latest-wins)。
  const target = { cols: term.cols, rows: term.rows };
  lastSize.current = target;
  void coApi.terminal.resize(termId, target.cols, target.rows).then(
    (r) => {
      if (!r.ok && lastSize.current === target) lastSize.current = prev;
    },
    () => {
      if (lastSize.current === target) lastSize.current = prev;
    },
  );
}

export function fitAndResize(
  term: Terminal,
  fitAddon: FitAddon,
  termId: string,
  lastSize: { current: { cols: number; rows: number } | null },
): boolean {
  try {
    // fit() 每次都跑(调 xterm DOM 布局);返回值 = 网格是否有效(供 RAF 重试)。
    fitAddon.fit();
    if (term.cols > 0 && term.rows > 0) {
      syncPtySize(term, termId, lastSize);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// 拖拽改尺寸的 reflow 防抖(对齐 VSCode TerminalResizeDebouncer,见 src/__tests__/terminal-resize-debounce)。
// 列变化要 reflow 整个 scrollback 并让 PTY 里的 TUI 全屏重绘,拖拽时每帧触发;行变化不 reflow。
const START_DEBOUNCING_THRESHOLD = 200;
const DEBOUNCE_RESIZE_X_DELAY_MS = 100;

export function createResizeDebouncer(
  term: Terminal,
  fitAddon: FitAddon,
  termId: string,
  lastSize: { current: { cols: number; rows: number } | null },
): { request: () => void; flush: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const fitNow = () => {
    cancel();
    fitAndResize(term, fitAddon, termId, lastSize);
  };
  return {
    request() {
      try {
        if (term.buffer.normal.length < START_DEBOUNCING_THRESHOLD) {
          fitNow();
          return;
        }
        const dims = fitAddon.proposeDimensions();
        if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return;
        if (dims.rows !== term.rows) {
          term.resize(term.cols, dims.rows);
          syncPtySize(term, termId, lastSize);
        }
        if (dims.cols !== term.cols) {
          cancel();
          timer = setTimeout(fitNow, DEBOUNCE_RESIZE_X_DELAY_MS);
        }
      } catch {
        /* ignore(同 fitAndResize:term 已 dispose / 容器未布局) */
      }
    },
    // 切回可见 / 激活:立即按最新尺寸 fit(VSCode 可见时 flush),不让隐藏期间的宽度变化再晚 100ms。
    flush() {
      fitNow();
    },
    dispose: cancel,
  };
}

/**
 * 暂存的实时推送能否整体替代历史快照:首批不晚于快照起点,且各批首尾相接(overflow 截断过的批次有缺口,
 * 不算)一直覆盖到快照终点。见 src/__tests__/terminal-history-replay-dedup。
 */
function queueCoversSnapshot(
  queue: ReadonlyArray<readonly [string, number | undefined]>,
  startOffset: number | undefined,
  endOffset: number | undefined,
): boolean {
  if (startOffset === undefined || endOffset === undefined) return false;
  const first = queue[0]?.[1];
  if (first === undefined || first > startOffset) return false;
  let next = first;
  for (const [data, offset] of queue) {
    if (offset !== next) return false;
    next = offset + data.length;
  }
  return next >= endOffset;
}

/** 侧栏拖宽停下后补一次 fit 的等待时间(RO 漏报兜底,见 sidebarWidth 订阅)。 */
export const SIDEBAR_WIDTH_FIT_SETTLE_MS = 100;

/** 搜索词输入 → SearchAddon.findNext 的防抖间隔(见 pendingSearchTimerRef)。 */
export const TERMINAL_SEARCH_DEBOUNCE_MS = 100;

/**
 * OSC7 cwd → updateCwd IPC 的尾随合并窗口。每个 prompt 都发 OSC7,readHistory 回放(最多 1MB)还会把
 * 历史里每个 OSC7 重新触发一遍:窗口内只发最终值,且与上次已发送值相同则不发(main 同值虽提前返回,
 * IPC 管线与 sessions_changed 广播照跑,回放时 cwd 还会短暂回退到历史值)。
 */
export const CWD_REPORT_DEBOUNCE_MS = 50;
/**
 * 尾随合并的 maxWait(lodash 语义,同 makeDebouncePerPath):持续 OSC7(间隔 < 窗口)下窗口不会无限顺延,
 * 自本轮首个值起至多此时长必发一次最新值。
 */
export const CWD_REPORT_MAX_WAIT_MS = 200;

function cancelTimer(ref: { current: ReturnType<typeof setTimeout> | null }): void {
  if (ref.current === null) return;
  clearTimeout(ref.current);
  ref.current = null;
}

// 字号 / 行高 / 字体族 / 光标样式取设置(创建时 initOptionsRef,之后 settings effect 同步);字体族回退链见 font-settings
// DEFAULT_TERMINAL_FONT_FAMILY(Nerd Font / Powerline 符号)。
const TERM_OPTIONS = {
  scrollback: 20000, // 跑 Agent CLI 大输出留余量(决策 #3)
  letterSpacing: 0.2,
  smoothScrollDuration: 0,
  fastScrollModifier: 'alt' as const,
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'block' as const,
};

/** node-pty 默认后端判定:Windows build ≥ 18309 用 ConPTY,更低回落 winpty(node-pty windowsPtyAgent)。 */
const NODE_PTY_CONPTY_MIN_BUILD = 18309;

/**
 * Windows 上告诉 xterm PTY 后端与系统 build 号(同 VS Code)。xterm 6 未设 buildNumber 时 Windows 仍开
 * reflow:ConPTY(build < 21376)自己会重绘,xterm 再对整段 scrollback 做 O(N) reflow 既白做又与之冲突;
 * 设了之后 xterm 按 `backend === 'conpty' && buildNumber >= 21376` 决定是否 reflow。
 * 非 Windows / 拿不到 build 号 → 不设(维持旧行为,不猜)。
 */
export function terminalWindowsPtyOptions(
  isWindows: boolean,
  build: number | null | undefined,
): { windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber: number } } {
  if (!isWindows || typeof build !== 'number' || build <= 0) return {};
  return {
    windowsPty: {
      backend: build >= NODE_PTY_CONPTY_MIN_BUILD ? 'conpty' : 'winpty',
      buildNumber: build,
    },
  };
}

/** 终端链接需修饰键单击才打开(VSCode):mac ⌘+单击,其它 Ctrl+单击。避免选文本 / 点击定位时误开浏览器。 */
export function isTerminalLinkActivation(event: MouseEvent, platform: Platform = detectPlatform()): boolean {
  return platform === 'mac' ? event.metaKey : event.ctrlKey;
}

/** 悬停链接时的提示(VSCode「Follow link (cmd + click)」)。 */
export function terminalLinkHoverHint(platform: Platform = detectPlatform()): string {
  return t('panels.terminal.link_hover', { key: platform === 'mac' ? '⌘' : 'Ctrl' });
}

/** 悬停本地文件链接时的提示(「⌘+单击打开文件」)。 */
export function terminalFileLinkHoverHint(platform: Platform = detectPlatform()): string {
  return t('panels.terminal.file_link_hover', { key: platform === 'mac' ? '⌘' : 'Ctrl' });
}

/**
 * 终端状态上报 main 的尾随合并 + 去重(OSC 7 cwd,见 CWD_REPORT_DEBOUNCE_MS):窗口内只发最新值,
 * 与上次已发送值相同不发;发送失败(ok:false / reject)复位去重基线(仅当基线仍是本值),同值之后可重发。
 */
function createLatestValueReporter(
  send: (value: string) => Promise<{ readonly ok: boolean }> | { readonly ok: boolean },
): DebouncedFn<[string]> {
  let lastSent: string | undefined;
  return debounce(
    (value: string) => {
      if (value === lastSent) return;
      lastSent = value;
      const forget = () => {
        if (lastSent === value) lastSent = undefined;
      };
      Promise.resolve(send(value))
        .then((r) => {
          if (!r.ok) forget();
        })
        .catch(forget);
    },
    CWD_REPORT_DEBOUNCE_MS,
    { maxWait: CWD_REPORT_MAX_WAIT_MS },
  );
}

/** 终端内提示行(VSCode formatMessageForTerminal 同款:反显的「 * 」前缀,复位属性)。 */
export function formatTerminalNotice(message: string, leadingNewLine = true): string {
  return `${leadingNewLine ? '\r\n' : ''}\x1b[0m\x1b[7m * \x1b[0m ${message} \x1b[0m\n\r`;
}

/**
 * 退出后「按任意键关闭」认的键(对齐 VSCode 监听 keypress):产生字符的键与 Enter;带 ⌘/Ctrl/Alt 的组合(复制等)、
 * 单独的修饰键、输入法组合中都不算。
 */
function isDismissKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key.length === 1 || event.key === 'Enter';
}

export interface UseTerminalOptions {
  /** 进程非 0 退出(或 agent 会话退出)后用户按任意键:关闭该终端面板。 */
  readonly onExitDismiss?: () => void;
  /**
   * xterm 创建(可能因 0 尺寸推迟)那一刻询问:是否把焦点给它。面板挂载时已是活动面板(新建终端 setActive 早于
   * lazy 面板挂载,激活事件已错过)→ 返回 true,用户可直接键入;后台创建(agent 会话不抢焦点)→ false。
   */
  readonly focusOnInit?: () => boolean;
}

/**
 * 挂在 div container 上,创建 xterm 实例,监听数据流与 resize。
 * unmount 时彻底清理(订阅、observer、queue、term.dispose)。
 *
 * 注意:返回的 ref 必须由调用方放在容器 div 上;termId 变化会重建实例。
 */
export function useTerminal(termId: string, options?: UseTerminalOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitDismissRef = useRef(options?.onExitDismiss);
  onExitDismissRef.current = options?.onExitDismiss;
  const focusOnInitRef = useRef(options?.focusOnInit);
  focusOnInitRef.current = options?.focusOnInit;
  // 首次 PTY stdout 到达前 = 还在 spawn shell + 跑 .zshrc。让上层显示 loading
  // overlay,用户看到"启动中..."而非纯黑框,减弱"卡顿"感(尤其 .zshrc 重的用户)。
  const [isReady, setIsReady] = useState(false);
  // settings(实时):字号 / 字体族(空 → 跟随 editor.fontFamily)/ 行高 / 光标样式
  const fontSize = useSettingValue(TERMINAL_FONT_SIZE.id, TERMINAL_FONT_SIZE.default);
  const fontFamily = resolveTerminalFontFamily(
    useSettingValue(TERMINAL_FONT_FAMILY.id, TERMINAL_FONT_FAMILY.default),
    useSettingValue(EDITOR_FONT_FAMILY.id, EDITOR_FONT_FAMILY.default),
  );
  const lineHeight = resolveTerminalLineHeight(useSettingValue(TERMINAL_LINE_HEIGHT.id, TERMINAL_LINE_HEIGHT.default));
  const cursorStyle = useSettingValue(TERMINAL_CURSOR_STYLE.id, TERMINAL_CURSOR_STYLE.default);
  const { resolved } = useTheme();
  // 创建 xterm 时读这里的最新值。创建 effect 只依赖 termId,其闭包里的字号 / 光标 / 主题是挂载时的;
  // 0 尺寸挂载会推迟创建,期间的变化同步 effect 又因 term 尚不存在而跳过 → 不读 ref 就会用旧值创建。
  const initOptionsRef = useRef({ fontSize, fontFamily, lineHeight, cursorStyle, resolved });
  initOptionsRef.current = { fontSize, fontFamily, lineHeight, cursorStyle, resolved };
  // term + fit 跨 effect 共享(创建 effect 写 ref,settings effect 读 ref 改 options)
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  // 拖拽等高频尺寸变化入口(容器 RO / 侧栏 / dock 尺寸)走它:长 buffer 时列变化防抖。
  const resizeDebouncerRef = useRef<ReturnType<typeof createResizeDebouncer> | null>(null);
  // 性能 P9:本终端上次发往 main/PTY 的网格尺寸。fit() 后只有 cols/rows 真变化才发
  // resize IPC —— 侧栏拖拽/窗口 resize 多为像素级变化不改格子数,跳过无效 IPC+PTY resize。
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const mountedRef = useRef(false);
  const [searchState, setSearchState] = useState(
    INITIAL_TERMINAL_SEARCH_STATE,
  );
  // 搜索条聚焦请求序号(见 SearchApi.focusRequest);每次 open 递增。
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  // issue #42 #1: single mirror ref of searchState replaces previous
  // separate searchTermRef / searchOptionsRef. dispatchSearchAction reads
  // pre-reduce state here. issue #42 v2 (review round 2 A.1/B.1):
  // sync ref INSIDE the setSearchState updater rather than via
  // useEffect — eliminates same-tick stale-ref window when two
  // dispatches fire before React commits.
  // xterm key handler(在下方 init effect 内注册)调用搜索入口用;入口本身在更后面声明。
  const dispatchSearchActionRef = useRef<((action: TerminalSearchAction) => void) | null>(null);
  const searchStateRef = useRef<TerminalSearchState>(
    INITIAL_TERMINAL_SEARCH_STATE,
  );
  // 性能:输入搜索词时 SearchAddon.findNext 同步扫描整段 scrollback(最多 2 万行)并重建高亮,
  // 每次按键都跑会卡输入。输入框状态立即更新,findNext 副作用防抖到停顿后再跑;其它搜索动作
  // (Enter/上下跳转/选项切换/失焦)先 flush,关闭/卸载/切 session 则取消。
  const pendingSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    setIsReady(false); // 切 session 时回 loading
    // race(R47):lastSentSizeRef 是 hook 级、跨 termId 持久;若同一 useTerminal 实例切 session
    // (TerminalPanelContent 未按 sessionId 加 key,React 复用 hook 实例),新 xterm 首次
    // fitAndResize 算出的 cols/rows 若与上个 session 残留值相同,会被 P9 去重跳过 → 新 PTY 永远
    // 停在默认 80×24(直到窗口尺寸再变),换行/全屏 TUI 尺寸错乱。切 session 即重置,保证每个新
    // session 至少发一次初始 resize。
    lastSentSizeRef.current = null;
    const container = containerRef.current;
    if (!container || !termId) {
      return () => {
        mountedRef.current = false;
      };
    }

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
      // init 作用域的 teardown 标志:cleanup 时置位。用它(而非 mountedRef)守卫
      // 异步 readHistory 回调 —— mountedRef 在 StrictMode 双 mount 时会被第二次
      // mount 重置回 true,导致第一次 mount 的迟到 readHistory 误判仍挂载、写进
      // 已 dispose 的 term。见第十六轮 P1-AR。
      let teardownDone = false;
      const initOptions = initOptionsRef.current;
      const term = new Terminal({
      ...TERM_OPTIONS,
      ...terminalWindowsPtyOptions(isWindowsRuntime(), coApi.system?.windowsBuild),
      // 用当前 settings + 主题值开局,避免初始一帧的旧值闪烁
      fontSize: initOptions.fontSize,
      fontFamily: initOptions.fontFamily,
      lineHeight: initOptions.lineHeight,
      cursorStyle: initOptions.cursorStyle,
      theme: initOptions.resolved === 'dark' ? DARK_THEME : LIGHT_THEME,
      // light 7 (AAA), dark 1 — 见 LIGHT_THEME 注释 (issue #24)
      minimumContrastRatio: initOptions.resolved === 'dark' ? 1 : 7,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(
      new WebLinksAddon(
        (event, url) => {
          if (!isTerminalLinkActivation(event)) return;
          // a11y(A118,A117 同族):外链打开须检查 IpcResult.ok + catch reject,否则 URL 被拒绝
          // 或系统打开失败时无 toast/live 反馈,用户只感知链接「无响应」。与 EditorPanel 同步。
          notifyIfFailed(coApi.shell.openExternal(url));
        },
        {
          // 悬停提示用容器 title(原生 tooltip,不另建浮层)。
          hover: () => {
            container.title = terminalLinkHoverHint();
          },
          leave: () => {
            container.removeAttribute('title');
          },
        },
      ),
    );
    term.open(container);
    // 安全(pastejacking):粘贴先剥离控制字符(防伪造 \x1b[201~ 跳出 bracketed paste),见 terminal-paste-sanitize。
    const disposePasteSanitizer = installTerminalPasteSanitizer(container, term);
    // 性能(Phase-5 终端新建加载):WebGL renderer 安装是**同步 GPU 初始化**(创建
    // canvas + getContext('webgl2') + 读 GPU 参数 + glyph/rectangle/atlas 状态)~tens
    // of ms。挪到首屏接线(open + listener + readHistory + 首字节渲染 + 清 loading)之后,
    // 下一帧 fire-and-forget 安装 —— 让「能输入 / 看到 prompt」更快;steady-state 仍用
    // WebGL。在 webglRaf 回调里安装(见下方 listener 注册之后)。
    let webgl: WebglAddon | null = null;
    let atlasGuards: ReturnType<typeof installAtlasGuards> | null = null;
    const searchAddon = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT });
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    const searchResultsDisposable = searchAddon.onDidChangeResults((event) => {
      // issue #42 v2 (review round 2 C.1): early-return after unmount.
      if (!mountedRef.current) return;
      const result = {
        index: event.resultIndex,
        count: event.resultCount,
      };
      // issue #42 v3 (user-reported "matches highlighted but count shows
      // no match"): SearchAddon fires onDidChangeResults SYNCHRONOUSLY
      // inside findNext, which is called by applyTerminalSearchEffect
      // INSIDE dispatchSearchAction. If we only updated React state here,
      // dispatchSearchAction's subsequent `setSearchState(next)` plain-
      // value call would overwrite the result with stale {-1, 0}. By
      // also synchronously mutating searchStateRef here, dispatch's
      // post-effect re-read picks up the fresh result and folds it into
      // `next`.
      searchStateRef.current = {
        ...searchStateRef.current,
        result,
      };
      setSearchState((state) =>
        terminalSearchReducer(state, {
          type: 'results',
          mounted: true,
          result,
        }),
      );
    });
    const __mappedKeyState__ = createMappedKeyState();
    // 进程退出(见 onSessionMaybeExited):inputClosed = 不再把输入发给已不存在的 PTY(否则每次键入都 NOT_FOUND
    // 限流 toast);awaitingDismiss = 已写出退出说明,任意键关闭面板。
    let inputClosed = false;
    let awaitingDismiss = false;
    // Shift+Enter 等额外按键映射:keydown 只暂存映射结果,onData 转发器再把
    // xterm 默认发出的 \r 替换为映射字节,避免 \x1b\r\r 双写。见 issue #18。
    term.attachCustomKeyEventHandler((event) => {
      if (isTerminalSearchHotkey(event)) {
        queueMicrotask(() => {
          // race(R84):用本次 init 作用域的 teardownDone 守卫,而非 hook 级 mountedRef。session
          // 切换 / StrictMode remount 同一 tick 内,旧 term 排队的这个微任务会在新 term 已 mount
          // 后才跑;mountedRef 此刻已被新 mount 置回 true → 旧微任务误把搜索框打开到新实例。
          // teardownDone 是 per-term 的(旧 term cleanup 时置位),旧微任务据此直接丢弃。与本文件
          // 其它异步回调(readHistory/safeWrite/resize)一致。
          // 必须走 dispatchSearchAction(唯一入口:同步更新 searchStateRef + state)。此前这里直接
          // setSearchState(reducer(open)),ref 仍停在「关闭」→ 下一次 dispatch 以 ref 为基底把刚打开的
          // 搜索条关掉。经 ref 取最新回调:本 effect 先于 dispatchSearchAction 声明。
          if (!teardownDone) dispatchSearchActionRef.current?.({ type: 'open' });
        });
        return false;
      }
      // topic-22: 缩放热键(生效绑定,默认 shift+mod+enter,按平台)让 xterm 不发 \r,由终端直接执行
      // terminal.zoom.toggle 并截住冒泡(runTerminalZoomFromKey)。pending 不污染(命中即 return false 跳过)。
      if (isTerminalZoomHotkey(event)) {
        runTerminalZoomFromKey(event);
        return false;
      }
      // 让出给工作台命令(清屏 / 关闭 / 保存,VSCode commandsToSkipShell):不交给 xterm / shell。
      const yielded = terminalYieldedCommandId(event);
      if (yielded) {
        runTerminalCommandFromKey(event, yielded);
        return false;
      }
      // Shift+F10 / 菜单键:在终端光标处打开右键菜单。派发在容器上(不经 xterm 元素:其 contextmenu 处理会按坐标选词);
      // preventDefault 免得 Windows 再按默认行为派发一次 contextmenu。
      if (isTerminalContextMenuKey(event)) {
        event.preventDefault();
        const r = (term.textarea ?? container).getBoundingClientRect();
        container.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }),
        );
        return false;
      }
      // 进程已退出:按键不再交给 xterm;已显示「按任意键关闭」时任意键关闭面板。
      if (inputClosed) {
        if (awaitingDismiss && isDismissKey(event)) onExitDismissRef.current?.();
        return false;
      }
      // mac ⌘← / ⌘→ / ⌘⌫ / ⌥← / ⌥→ → 行首 / 行尾 / 删到行首 / 按词移动(VSCode sendSequence 默认绑定,见
      // terminalSendSequenceForKey)。排在「让出给工作台命令」之后:这些键被用户绑给终端负责的命令时仍让出。
      // 经 term.input 走 onData 同一条写入路径(退出后不发、映射状态照常清)。
      const sequence = terminalSendSequenceForKey(event);
      if (sequence !== null) {
        event.preventDefault();
        event.stopPropagation();
        term.input(sequence, true);
        return false;
      }
      // 终端自己的键(⌃- 后退、⌃R 反向搜索、⌥Z 等,见 isTerminalKeptHotkey):照常交给 xterm,截住冒泡 —— 否则全局分发
      // 再执行后退 / 打开最近,焦点离开终端(VSCode 终端获焦时这些键不触发工作台命令)。
      if (isTerminalKeptHotkey(event)) event.stopPropagation();
      applyMappedKeyOnKeydown(__mappedKeyState__, event);
      return true;
    });
    termRef.current = term;
    fitRef.current = fitAddon;
    // 有 Modal 开着(删除确认 / 授权框等)时不抢焦点:xterm 晚挂载(0 尺寸延后创建)时把焦点从对话框夺走,
    // 之后的 Enter 就进了 shell。
    if (focusOnInitRef.current?.() && !hasOpenModalIn(container.ownerDocument)) term.focus();

    // per-term 去重 + 尾随合并(见 createLatestValueReporter):只发窗口内最新值,且与上次已发送值不同才发。
    const reportCwd = createLatestValueReporter((cwd) => coApi.terminal.updateCwd(termId, cwd));
    const osc7Disposable = registerOsc7Cwd(
      term,
      reportCwd,
      // 测试桩常不带 system → 可选链。
      { acceptedHosts: osc7AcceptedHosts(coApi.system?.hostname) },
    );
    // 本地文件链接(VSCode TerminalLocalLinkDetector):存在的文件路径 + 行列号,修饰键单击在编辑器打开并定位。
    const fileLinksDisposable = term.registerLinkProvider(
      createTerminalFileLinkProvider(term, {
        getCwd: () => getIndexedTerminalSessionById(useTerminalStore.getState().sessions, termId)?.cwd,
        resolve: (paths) =>
          Promise.resolve()
            .then(() => coApi.terminal.resolveLinks(termId, paths))
            .then(
              (r) => (r.ok && Array.isArray(r.data) && r.data.length === paths.length ? r.data : null),
              () => null,
            ),
        open: (absPath, line, column, event) => {
          if (!isTerminalLinkActivation(event)) return;
          void openFileOrNotify(
            () => coApp.editor.openFile(absPath, line === undefined ? undefined : { line, column }),
            basename(absPath) || absPath,
          );
        },
        hover: () => {
          container.title = terminalFileLinkHoverHint();
        },
        leave: () => {
          container.removeAttribute('title');
        },
      }),
    );

    // 首屏 fit + 通知主进程初始尺寸。
    // 同步先试一次(useEffect 跑在 paint 后,容器一般已有尺寸,可省 1 帧);
    // cols/rows 拿到 0 说明容器还没 layout 完,fallback 到 RAF 下一帧重试。
    const doFit = () => fitAndResize(term, fitAddon, termId, lastSentSizeRef);
    const fitRetryRaf = doFit() ? 0 : requestAnimationFrame(doFit);

    // 主进程 stdout → 写入合并 → safeWrite 队列。第一次写入本 termId 的输出就标 ready,上层移除 loading overlay。
    // 性能 P1:safeWrite 按 chunk 数节流,主进程每 ~5ms 一条的小块直接灌入会持续积压;先合并成接近
    // 16KB 的一次调用(空闲首块立即写,不加首字节延迟)。见 output-coalescer.ts。
    let firstData = true;
    const clearLoadingOverlay = () => {
      if (firstData) {
        firstData = false;
        setIsReady(true);
      }
    };
    const outputCoalescer = createOutputCoalescer((data) => safeWrite(term, data));
    const writeOutput = (data: string) => {
      clearLoadingOverlay();
      outputCoalescer.push(data);
    };

    // topic-07: dockview lazy-mount inactive panel 会错过 PTY spawn 后的初始输出(shell prompt 等),
    // 从 main buffer 把已有 raw chunks replay 进 xterm。先 subscribe 后 replay。
    // 历史与实时流衔接(见 src/__tests__/terminal-history-replay-dedup):订阅到 readHistory 回复之间
    // 到达的推送可能已含于快照(主进程合批窗口里的在途输出已入 ring buffer)—— 直接写会让同段输出
    // 写两次(流式 TUI 错乱 / prompt 重复)。回复前先暂存;回复后按主进程累计偏移过滤:偏移 <
    // endOffset 的已在快照里,丢弃(含回复之后才迟到的)。无 endOffset(读失败 / 会话已不在)→ 全写。
    let liveBeforeHistory: Array<[string, number | undefined]> | null = [];
    let historyEndOffset: number | undefined;
    const writeLive = (data: string, offset: number | undefined) => {
      if (
        historyEndOffset !== undefined &&
        offset !== undefined &&
        offset < historyEndOffset
      ) {
        return;
      }
      writeOutput(data);
    };
    const releaseLiveAfterHistory = (endOffset: number | undefined) => {
      historyEndOffset = endOffset;
      const queued = liveBeforeHistory ?? [];
      liveBeforeHistory = null;
      for (const [data, offset] of queued) writeLive(data, offset);
    };
    // 性能 P1:onData 现按 termId 订阅(preload 整窗单 listener 分发),cb 只收本
    // session 的 data,无需再 `if (id !== termId) return` 自行过滤。
    const unsubData = coApi.terminal.onData(termId, (data: string, offset?: number) => {
      if (liveBeforeHistory) {
        liveBeforeHistory.push([data, offset]);
        return;
      }
      writeLive(data, offset);
    });

    // PTY 退出 → 清 loading overlay。否则若 shell 在产出任何字节之前就退出(自定义
    // shell 立即失败 / 零输出即 exit),firstData 恒真、isReady 恒假 →「Starting
    // shell…」spinner 永久悬浮在已死终端上。isReady 状态机此前只有 onData /
    // readHistory 两条 set-true 入口,漏了 exit 这条终态(典型「标记建了未覆盖所有
    // 终态」)。退出后终端缓冲(含任何错误输出)已可见,移掉 overlay 才能让用户看到。
    // 「已退出」的唯一事实源是会话快照的 exitCode(main 的 setExited 经 sessions_changed 广播)。
    // 退出后(对齐 VSCode _onProcessExit):停止向 PTY 发输入;用户会话以 0 退出 → 面板由 reconciler 关闭,不写说明;
    // 其余在终端内写退出码说明 +「按任意键关闭」。说明须排在历史回放之后:回放未完成时只关输入,
    // 由 readHistory 回调再调一次补写。
    let exitHandled = false;
    const onSessionMaybeExited = (): void => {
      if (teardownDone || exitHandled) return;
      const session = getIndexedTerminalSessionById(useTerminalStore.getState().sessions, termId);
      if (session === undefined || session.exitCode === null) return;
      clearLoadingOverlay();
      inputClosed = true;
      if (liveBeforeHistory) return;
      exitHandled = true;
      if (shouldAutoCloseExitedSession(session)) return;
      awaitingDismiss = true;
      writeOutput(
        formatTerminalNotice(t('panels.terminal.exit_notice', { code: session.exitCode })) +
          formatTerminalNotice(t('panels.terminal.exit_press_any_key'), false),
      );
    };
    const unsubExit = useTerminalStore.subscribe(onSessionMaybeExited);

    // a11y(A143):readHistory 失败(reject 或 !r.ok)此前只 return / 无 .catch,而 lazy-mount
    // 终端的初始输出(prompt)在 PTY 已 spawn 后、panel mount 前产出,只在 history 里 —— history
    // 读失败则 onData 不会补发,firstData 恒真 →「Starting shell…」spinner 永久悬浮 + 无反馈。
    // 失败分支也清 loading(setIsReady(true))并 notify.error。空历史(ok+无 data)仍留 loading
    // 给 onData 补(prompt 尚未产出的正常态)。
    void coApi.terminal
      .readHistory(termId)
      .then((r) => {
        // panel 已卸载 / term 已 dispose → 不写已死 xterm。disposeQueue 删了 WeakMap
        // 条目,迟到的 safeWrite 会新建一个 disposed:false 的队列绕过其 disposed 守卫,
        // 直接 term.write() 到已拆除的 core(报 "Object has been disposed")。见 P1-AR。
        if (teardownDone) return;
        if (!r.ok) {
          clearLoadingOverlay();
          notifyFailure(r);
          releaseLiveAfterHistory(undefined);
          onSessionMaybeExited();
          return;
        }
        // 订阅到回复之间涌入的输出超过 ring buffer 容量 → 快照开头已被挤掉,而暂存队列从更早处连续
        // 开始(更完整):不写快照,按序照写暂存队列,否则被挤掉的中段两边都没有。
        const queueCoversHistory = queueCoversSnapshot(
          liveBeforeHistory ?? [],
          r.data.startOffset,
          r.data.endOffset,
        );
        if (queueCoversHistory) {
          releaseLiveAfterHistory(undefined);
        } else {
          if (r.data.data) writeOutput(r.data.data);
          releaseLiveAfterHistory(r.data.endOffset);
        }
        // 挂载前就已退出(含零输出 / 快照被淘汰)→ 之后不会再有快照变更:清 loading、关输入、补写退出说明。
        onSessionMaybeExited();
      })
      .catch((err) => {
        if (teardownDone) return;
        clearLoadingOverlay();
        notifyThrownError(err);
        releaseLiveAfterHistory(undefined);
        onSessionMaybeExited();
      });

    // 用户输入 → IPC write
    // a11y(A144,A141 同族):write 此前 fire-and-forget 既不判 ok:false 也无 catch,写入失败
    // (PTY 已死 / IPC 异常)用户键入「没反应」却无反馈。但每个按键都 write,无差别弹 toast
    // 会刷屏 —— 用 3s 限流(连续失败只提示一次,对齐 A132 dock autosave 限流思路)。
    let lastWriteFailAt = 0;
    const notifyWriteFail = (code: string, message?: string) => {
      if (teardownDone) return;
      const now = Date.now();
      if (now - lastWriteFailAt < 3000) return;
      lastWriteFailAt = now;
      notifyFailure({ code, message });
    };
    const onDataDisposable = term.onData((data: string) => {
      if (inputClosed) return; // 进程已退出(粘贴 / 鼠标上报等也不再发)
      const outgoing = consumeMappedKeyOnData(__mappedKeyState__, data);
      void coApi.terminal
        .write(termId, outgoing)
        .then((r) => {
          if (!r.ok) notifyWriteFail(r.code, r.message);
        })
        .catch((err) => {
          notifyWriteFail(
            errorCodeOf(err),
            (err as Error)?.message,
          );
        });
    });

    // 容器尺寸变化 → fit + resize(长 buffer 列变化防抖,见 createResizeDebouncer)
    const resizeDebouncer = createResizeDebouncer(term, fitAddon, termId, lastSentSizeRef);
    resizeDebouncerRef.current = resizeDebouncer;
    const ro = new ResizeObserver(() => resizeDebouncer.request());
    ro.observe(container);

    // 性能(Phase-5):首屏接线已完成,下一帧再装 WebGL renderer(同步 GPU init 不阻塞
    // 上面的 open/listener/首渲染)。dom renderer 用 letter-spacing 模拟 CJK 双宽度,累加
    // 误差会裁 CJK 末尾几字;WebGL 按 cell grid 直接画,CJK 精确(VSCode 默认 webgl,issue
    // #15)。首帧短暂走 dom(prompt 多 ASCII),下一帧切 WebGL。GPU 不可用/context lost 静默
    // 回退 dom(终端能用)。installAtlasGuards 跟随 WebGL(只对启用的 WebGL 有意义:在三个
    // wake-up 事件 clearTextureAtlas 修 glyph 索引错乱;DOM 时 no-op)。teardown 已发生则不装。
    const webglRaf = requestAnimationFrame(() => {
      if (teardownDone) return;
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl?.dispose());
        term.loadAddon(webgl);
        atlasGuards = installAtlasGuards(term);
      } catch (err) {
        console.warn('[terminal] webgl renderer init 失败,回退 dom:', err);
      }
    });

      return () => {
        teardownDone = true;
        cancelAnimationFrame(webglRaf); // 取消未触发的 WebGL 延后安装
        cancelAnimationFrame(fitRetryRaf); // 首屏 fit 重试未触发时,别用已拆除的 term 发 resize
        unsubData();
        unsubExit();
        onDataDisposable.dispose();
        disposePasteSanitizer();
        osc7Disposable.dispose();
        reportCwd.cancel(); // 卸载丢弃待发 cwd(会话将随面板关闭/改绑)
        fileLinksDisposable.dispose();
        searchResultsDisposable.dispose();
        ro.disconnect();
        resizeDebouncer.dispose();
        atlasGuards?.dispose(); // 已装才有 guards(rAF 未触发时为 null)
        // 合并缓冲里未写出的输出随 safeWrite 队列一并丢弃(term 即将 dispose),且撤销窗口定时器,
        // 否则迟到的 flush 会经 safeWrite 新建队列写已死 xterm(同 P1-AR)。
        outputCoalescer.dispose();
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
        searchAddonRef.current = null;
        resizeDebouncerRef.current = null;
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
      mountedRef.current = false;
      // 未触发的防抖搜索属于即将拆除的 term,别让它落到新 session 的 addon 上
      cancelTimer(pendingSearchTimerRef);
      waitRo?.disconnect();
      cleanupTerm?.();
    };
    // 创建只依赖 termId;fontSize/cursorStyle 走下面的 settings effect 动态改。
    // 不放 deps 是有意的(否则改字号会重建 term 丢掉历史输出)。
  }, [termId]);

  // settings → 已有 term 实例同步(不重建),改完 fit + resize 让 PTY 跟上新行列数。字体族 / 字号变化时 xterm 重新测量
  // 字符尺寸(CharSizeService 监听这两项),WebGL 渲染器按新字体配置换用另一份纹理图集(图集按字体 / 字号 / 行高等配置
  // 缓存共享),行高变化同样重算单元格;随后 fit 按新单元格尺寸重排行列。只改光标样式不影响单元格 → 不重新 fit。
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const next = { fontSize, fontFamily, lineHeight, cursorStyle } as const;
    let layoutChanged = false;
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (term.options[key] === next[key]) continue;
      (term.options as Record<string, unknown>)[key] = next[key];
      if (key !== 'cursorStyle') layoutChanged = true;
    }
    if (layoutChanged) fitAndResize(term, fit, termId, lastSentSizeRef);
  }, [fontSize, fontFamily, lineHeight, cursorStyle, termId]);

  // 主题切换 → 已有 term 实例同步 theme(不重建,保留历史输出)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolved === 'dark' ? DARK_THEME : LIGHT_THEME;
    // 同步 minimumContrastRatio,避免 dark→light 残留 1 / light→dark 拔亮 dim prompt
    term.options.minimumContrastRatio = resolved === 'dark' ? 1 : 7;
  }, [resolved]);

  // 主题切换 → 搜索装饰色作废并重画。addon 不比较 decorations(同词重搜不重画高亮),故先清旧高亮连带其缓存词;
  // 搜索条开着且有词时,下一帧(ThemeProvider 已切 <html class>,取到新 token)按当前词重搜:按新色重画,
  // 计数经 onDidChangeResults 同步(只清不重搜会让高亮消失而计数仍显示旧值)。首次挂载跳过。
  const decoratedThemeRef = useRef(resolved);
  useEffect(() => {
    if (decoratedThemeRef.current === resolved) return;
    decoratedThemeRef.current = resolved;
    invalidateTerminalSearchDecorations();
    searchAddonRef.current?.clearDecorations();
    const raf = requestAnimationFrame(() => {
      const s = searchStateRef.current;
      if (s.isOpen && s.term.length > 0) {
        dispatchSearchActionRef.current?.({ type: 'setTerm', term: s.term });
      }
    });
    return () => cancelAnimationFrame(raf);
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
  useEffect(() => {
    const debouncer = resizeDebouncerRef.current;
    if (!debouncer) return;
    const raf = requestAnimationFrame(() => debouncer.request());
    return () => cancelAnimationFrame(raf);
  }, [sidebarOpen, termId]);

  // 性能:侧栏拖宽每个 mousemove 都写 sidebarWidth。拖动期间的连续 fit 由容器 ResizeObserver
  // 负责;这里只是 RO 漏报的兜底,不走 React 订阅(否则每像素让所有终端重渲染),改为 imperative
  // subscribe + 尾随防抖:拖动停下后必定补一次 fit。
  useEffect(() => {
    let prevWidth = useLayoutUiStore.getState().sidebarWidth;
    const settleFit = debounce(() => resizeDebouncerRef.current?.request(), SIDEBAR_WIDTH_FIT_SETTLE_MS);
    const unsubscribe = useLayoutUiStore.subscribe((state) => {
      if (state.sidebarWidth === prevWidth) return;
      prevWidth = state.sidebarWidth;
      settleFit();
    });
    return () => {
      unsubscribe();
      settleFit.cancel();
    };
  }, [termId]);

  // 激活 / 切回可见:立即 fit。
  const fit = useCallback(() => {
    resizeDebouncerRef.current?.flush();
  }, []);
  // 连续尺寸变化(dock 分栏拖拽):长 buffer 时列变化防抖。
  const requestFit = useCallback(() => {
    resizeDebouncerRef.current?.request();
  }, []);

  // topic-22: stale-safe focus,unmount 后 termRef.current 已被 dispose 路径置 null
  // (teardown 里),callback 自然 no-op,焦点不会落到已 dispose 的实例。
  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  // terminal.clear / 右键菜单「清除」:清空屏幕与滚动缓冲(xterm clear 保留当前提示行,同 VSCode)。
  const clear = useCallback(() => {
    termRef.current?.clear();
  }, []);

  const readText = useCallback((): string => {
    const buffer = termRef.current?.buffer.active;
    if (!buffer) return '';
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }, []);

  // 右键菜单动作(TerminalContextMenu)。剪贴板走缓存的原生引用(sandbox-sweep 会在 PROD 清掉 navigator.clipboard)。
  const contextMenuActions = useMemo(
    () => ({
      hasSelection: () => termRef.current?.hasSelection() ?? false,
      copy: () => {
        const text = termRef.current?.getSelection();
        if (!text) return;
        Promise.resolve()
          .then(() => getCachedClipboard().writeText(text))
          .catch(() => notify.error(t('panels.terminal.ctx.copy_failed')));
      },
      // 与 Cmd+V 同样先净化控制字符(pastejacking,见 terminal-paste-sanitize)再经 term.paste。
      paste: () => {
        const term = termRef.current;
        if (!term) return;
        Promise.resolve()
          .then(() => getCachedClipboard().readText())
          .then(
            (text) => {
              const clean = sanitizeTerminalPaste(text);
              if (clean && termRef.current === term) term.paste(clean);
            },
            () => notify.error(t('panels.terminal.ctx.paste_failed')),
          );
      },
      selectAll: () => termRef.current?.selectAll(),
      clear,
      focus,
    }),
    [clear, focus],
  );

  // issue #42 #1: single dispatch routes through applyTerminalSearchEffect
  // (previously the production path had inline side-effect logic in each
  // callback; the helper was only exercised by state-machine.spec.ts,
  // leaving the real path uncovered). All 7 search callbacks now share this
  // one chokepoint; behavior is identical, state machine + side effects
  // now share a single tested implementation.
  const runSearchAction = useCallback((action: TerminalSearchAction) => {
    // issue #42 round-3 (D.4/E.2): React state updater MUST be pure.
    // Compute synchronously: read ref → apply side effect → assign ref →
    // enqueue plain state value.
    //
    // issue #42 v3 (user-reported): SearchAddon's onDidChangeResults
    // fires SYNCHRONOUSLY inside findNext (called by
    // applyTerminalSearchEffect). The handler updates searchStateRef.
    // RE-READ ref after the side effect so `next` folds the fresh
    // result count into the reducer output; otherwise our plain-value
    // setSearchState(next) would overwrite the result handler's update
    // with stale {-1, 0} (matches highlight but counter shows 0).
    const prev = searchStateRef.current;
    const searched = applyTerminalSearchEffect(
      searchAddonRef.current,
      prev,
      action,
      termRef.current,
    );
    // 非法正则未交给 addon(见 applyTerminalSearchEffect)→ 表现为「无匹配」,搜索条显示 no_match。
    const afterEffect = searched
      ? searchStateRef.current
      : { ...searchStateRef.current, result: INITIAL_TERMINAL_SEARCH_STATE.result };
    const next = terminalSearchReducer(afterEffect, action);
    searchStateRef.current = next;
    setSearchState(next);
  }, []);

  // 立即执行挂起的「按当前词搜索」:与未防抖时最后一次按键触发的 findNext 等价。
  const flushPendingSearch = useCallback(() => {
    if (pendingSearchTimerRef.current === null) return;
    cancelTimer(pendingSearchTimerRef);
    runSearchAction({ type: 'setTerm', term: searchStateRef.current.term });
  }, [runSearchAction]);

  const dispatchSearchAction = useCallback(
    (action: TerminalSearchAction) => {
      if (action.type === 'setTerm' && action.term.length > 0) {
        // 只更新输入框状态(reducer 纯函数,不碰 addon),findNext 防抖
        const next = terminalSearchReducer(searchStateRef.current, action);
        searchStateRef.current = next;
        setSearchState(next);
        cancelTimer(pendingSearchTimerRef);
        pendingSearchTimerRef.current = setTimeout(() => {
          pendingSearchTimerRef.current = null;
          runSearchAction({ type: 'setTerm', term: searchStateRef.current.term });
        }, TERMINAL_SEARCH_DEBOUNCE_MS);
        return;
      }
      // 已打开时再 open(⌘F / 命令面板)reducer 无可见变化、搜索条不重挂 → 发聚焦请求让搜索条重新聚焦并全选,
      // 否则焦点留在终端,用户以为在搜索框输入,字符与回车却进了 shell。
      if (action.type === 'open') setSearchFocusRequest((n) => n + 1);
      if (action.type === 'close' || action.type === 'setTerm') {
        // 关闭会清高亮、空词会清高亮:挂起的搜索已无意义,直接取消
        cancelTimer(pendingSearchTimerRef);
      } else {
        flushPendingSearch();
      }
      runSearchAction(action);
    },
    [runSearchAction, flushPendingSearch],
  );
  dispatchSearchActionRef.current = dispatchSearchAction;

  const openSearch = useCallback(() => {
    dispatchSearchAction({ type: 'open' });
  }, [dispatchSearchAction]);

  const closeSearch = useCallback(() => {
    dispatchSearchAction({ type: 'close' });
    focus();
  }, [dispatchSearchAction, focus]);

  const nextSearch = useCallback(() => {
    dispatchSearchAction({ type: 'next' });
  }, [dispatchSearchAction]);

  const previousSearch = useCallback(() => {
    dispatchSearchAction({ type: 'prev' });
  }, [dispatchSearchAction]);

  const setSearchTerm = useCallback(
    (term: string) => {
      dispatchSearchAction({ type: 'setTerm', term });
    },
    [dispatchSearchAction],
  );

  const setSearchOptions = useCallback(
    (options: TerminalSearchOptions) => {
      dispatchSearchAction({ type: 'setOptions', options });
    },
    [dispatchSearchAction],
  );

  const clearActiveSearchDecoration = useCallback(() => {
    dispatchSearchAction({ type: 'clearActiveDecoration' });
  }, [dispatchSearchAction]);

  // issue #42 #2: memoize searchApi 防止 TerminalSearchBar 在 useTerminal 每
  // 次 re-render 时拿到新引用 / 不必要 re-render。所有 callbacks 经依赖链均稳定
  // (底层 runSearchAction / focus 为空 deps),只在 searchState 改时重新打包。
  const searchApi: SearchApi = useMemo(
    () => ({
      isOpen: searchState.isOpen,
      term: searchState.term,
      options: searchState.options,
      result: searchState.result,
      focusRequest: searchFocusRequest,
      open: openSearch,
      close: closeSearch,
      next: nextSearch,
      prev: previousSearch,
      setTerm: setSearchTerm,
      setOptions: setSearchOptions,
      clearActiveDecoration: clearActiveSearchDecoration,
    }),
    [
      searchState,
      searchFocusRequest,
      openSearch,
      closeSearch,
      nextSearch,
      previousSearch,
      setSearchTerm,
      setSearchOptions,
      clearActiveSearchDecoration,
    ],
  );

  return { containerRef, isReady, fit, requestFit, focus, clear, readText, contextMenuActions, searchApi };
}
