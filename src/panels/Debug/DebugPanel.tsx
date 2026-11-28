import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  ScrollArea,
  Tabs,
  TruncateStart,
  type TabItem,
} from '@/design';
import {
  selectDisplayedSession,
  useDebugStore,
  type DebugConsoleLine,
  type DebugScope,
  type DebugSessionShadow,
  type DebugVariable,
} from '@/stores/debug.store';
import { useRegisteredCommandHotkeyText, withHotkey } from '@/lib/hotkey-label';
import { tWithFallback } from '@/i18n';
import { DEBUG_COMMANDS, displayedDebugState, runDebugAction, type DebugCommandDef } from './debug-commands';
import { useLocale, useT } from '@/i18n';
import { SR_ONLY_STYLE } from '@/lib/sr-only';
import { useCopyMcpConfig } from '@/shell/use-copy-mcp-config';
import { coApp } from '@/plugins/co-app';
import { basename, dirname, isAbsolutePath } from '@/lib/path-cross';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { announce } from '@/lib/announce';
import { getAnnouncingDocument } from '@/shell/dock/popout-documents';
import { detectPlatform, formatHotkey } from '@/plugins/command-palette/format-hotkey';

const EMPTY_VARIABLES: readonly [] = [];
const EMPTY_CONSOLE: readonly DebugConsoleLine[] = [];

/** DAP stopped 事件的 reason(规范列出的取值)→ catalog 键;徽章与读屏播报共用。 */
const STOP_REASON_KEYS: Readonly<Record<string, string>> = {
  step: 'panels.debug.stop_reason.step',
  breakpoint: 'panels.debug.stop_reason.breakpoint',
  exception: 'panels.debug.stop_reason.exception',
  pause: 'panels.debug.stop_reason.pause',
  entry: 'panels.debug.stop_reason.entry',
  goto: 'panels.debug.stop_reason.goto',
  'function breakpoint': 'panels.debug.stop_reason.function_breakpoint',
  'data breakpoint': 'panels.debug.stop_reason.data_breakpoint',
  'instruction breakpoint': 'panels.debug.stop_reason.instruction_breakpoint',
};

/** 停下原因的本地化名称;未知原因(adapter 自定义)返回 undefined,调用方只显示「已暂停」,不露原始值。 */
function stopReasonLabel(t: (key: string) => string, reason: string): string | undefined {
  const key = Object.hasOwn(STOP_REASON_KEYS, reason) ? STOP_REASON_KEYS[reason] : undefined;
  return key === undefined ? undefined : t(key);
}

/**
 * 无会话空态:说明调试会话由 Agent 经 MCP 调试工具启动(Continuo 没有自己的启动配置),给出下一步「复制 MCP 配置」——
 * 与状态栏同一动作与成功 / 失败反馈(useCopyMcpConfig)。对齐 VSCode 运行和调试视图空态:说明 + 主操作按钮。
 */
function DebugEmptyState() {
  const t = useT();
  const mcpCopy = useCopyMcpConfig();
  return (
    <div className="flex h-full w-full bg-canvas text-fg">
      <EmptyState>
        <div className="text-sm text-fg">{t('panels.debug.empty_session')}</div>
        <p className="max-w-xs">{t('panels.debug.empty_hint')}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void mcpCopy.copy()}
          // 可见文本随结果短暂变化(已复制 / 复制失败);可访问名固定为动作,结果由下方 live region 播报(同状态栏 A82)。
          aria-label={t('statusbar.mcp.copy')}
        >
          {mcpCopy.label}
        </Button>
        <span style={SR_ONLY_STYLE} role="status">
          {mcpCopy.announcement}
        </span>
      </EmptyState>
    </div>
  );
}

export function DebugPanel() {
  const t = useT();
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState('stack');
  // 已停下的会话优先,否则最近的运行中会话(见 selectDisplayedSession)。
  const session = useDebugStore(selectDisplayedSession);
  // 没有存活会话时显示刚结束的会话的控制台(程序跑完即结束时仍能看到输出)。
  const endedConsole = useDebugStore((s) => s.endedConsole);
  const debugTabs = useMemo<readonly TabItem[]>(
    () => {
      void locale;
      return [
        { id: 'stack', label: t('panels.debug.tab.stack') },
        { id: 'variables', label: t('panels.debug.tab.variables') },
        { id: 'breakpoints', label: t('panels.debug.tab.breakpoints') },
        { id: 'console', label: t('panels.debug.tab.console') },
      ];
    },
    [locale, t],
  );

  if (!session && !endedConsole) return <DebugEmptyState />;

  // 窄(侧栏宽,VSCode 调试视图在侧栏)时视图切换叠在上方,宽时在左侧(容器查询,按面板自身宽度)。
  return (
    <div className="@container h-full w-full bg-canvas text-fg">
      <div className="flex h-full w-full flex-col gap-3 p-3 @lg:flex-row">
        <aside className="shrink-0 @lg:w-36">
          <Tabs
            items={debugTabs}
            activeId={activeTab}
            onSelect={setActiveTab}
            ariaLabel={t('panels.debug.views_aria')}
          />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {session ? (
            <DebugSessionHeader session={session} />
          ) : (
            <Card className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                {endedConsole!.label ?? endedConsole!.sessionId}
              </div>
              <Badge variant="neutral">{t('panels.debug.ended')}</Badge>
            </Card>
          )}
          {activeTab === 'console' ? (
            <ConsoleSection
              sessionId={session?.id ?? null}
              lines={session ? (session.console ?? EMPTY_CONSOLE) : endedConsole!.lines}
              truncated={session ? session.consoleTruncated === true : false}
              stopSeq={session?.stopped?.stopSeq}
            />
          ) : session ? (
            <ScrollArea>
              {activeTab === 'stack' && <StackSection session={session} />}
              {activeTab === 'variables' && <VariablesSection session={session} />}
              {activeTab === 'breakpoints' && <BreakpointsSection session={session} />}
            </ScrollArea>
          ) : (
            <EmptyState>{t('panels.debug.empty_session')}</EmptyState>
          )}
        </section>
      </div>
    </div>
  );
}

/** 工具栏按钮图标(仿 VSCode codicon debug-continue / pause / step-over / step-into / step-out / stop;stroke 风格同活动栏)。 */
const DEBUG_ACTION_ICON_PATHS: Readonly<Record<string, ReactNode>> = {
  continue: <path d="M7 5v14l11-7z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  stepOver: (
    <>
      <path d="M4 13a8 8 0 0 1 15-3.5" />
      <path d="M20 5v5h-5" />
      <circle cx="12" cy="18" r="1.6" />
    </>
  ),
  stepIn: (
    <>
      <path d="M12 3v10M8 9l4 4 4-4" />
      <circle cx="12" cy="19" r="1.6" />
    </>
  ),
  stepOut: (
    <>
      <path d="M12 14V4M8 8l4-4 4 4" />
      <circle cx="12" cy="19" r="1.6" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
};

function DebugActionIcon({ action }: { readonly action: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {DEBUG_ACTION_ICON_PATHS[action]}
    </svg>
  );
}

function DebugActionButton({ def }: { readonly def: DebugCommandDef }) {
  useLocale(); // 切换语言后重渲(tWithFallback 不订阅)
  const hotkey = useRegisteredCommandHotkeyText(coApp.commands, def.id);
  const state = useDebugStore((s) => displayedDebugState(s));
  const label = tWithFallback(def.titleKey, def.title);
  return (
    <IconButton
      aria-label={label}
      title={withHotkey(label, hotkey)}
      disabled={!def.enabledIn.includes(state)}
      onClick={() => void runDebugAction(def.action)}
      data-debug-action={def.action}
    >
      <DebugActionIcon action={def.action} />
    </IconButton>
  );
}

/**
 * 调试工具栏(VSCode debug.toolBarLocation=docked:在调试视图顶部):继续 / 暂停(同一位置按状态切换)、单步跳过、单步调试、
 * 单步跳出、停止;按钮按会话状态启用,tooltip「名称 (键位)」。作用于面板显示的会话(含 agent 启动的)。
 */
function DebugToolbar({ stopped }: { readonly stopped: boolean }) {
  const t = useT();
  const defs = DEBUG_COMMANDS.filter((def) => def.action !== (stopped ? 'pause' : 'continue'));
  return (
    <div role="group" aria-label={t('panels.debug.toolbar_aria')} className="flex shrink-0 items-center gap-0.5">
      {defs.map((def) => (
        <DebugActionButton key={def.id} def={def} />
      ))}
    </div>
  );
}

/**
 * 控制台各类行的颜色(VSCode REPL:stderr 错误色、console 类别警告色、求值输入弱化)与非颜色线索:每行左侧 2px 竖条位,
 * stderr / error 实线、console / important 虚线,stdout 透明占位(强制颜色下 border-transparent 改 Canvas,不显形);
 * 求值输入另有「›」前缀。色觉差异 / 强制颜色下仍能分出错误输出(WCAG 1.4.1;VSCode REPL 只靠颜色)。
 */
const CONSOLE_LINE_CLASS: Readonly<Record<string, string>> = {
  stderr: 'text-error border-solid border-error',
  error: 'text-error border-solid border-error',
  console: 'text-warning border-dashed border-warning',
  important: 'text-warning border-dashed border-warning',
  input: 'text-fg-muted border-transparent',
};
const CONSOLE_LINE_DEFAULT_CLASS = 'text-fg border-transparent';

/** 控制台输入历史(VSCode REPL 历史:↑ 上一条 / ↓ 下一条;本次启动内各会话共用,最近 CONSOLE_HISTORY_MAX 条,连续重复只记一次)。 */
const CONSOLE_HISTORY_MAX = 100;
const consoleHistory: string[] = [];

/** 测试用:清空控制台输入历史。 */
export function resetDebugConsoleHistoryForTest(): void {
  consoleHistory.length = 0;
}

function rememberConsoleInput(text: string): void {
  if (consoleHistory[consoleHistory.length - 1] === text) return;
  consoleHistory.push(text);
  if (consoleHistory.length > CONSOLE_HISTORY_MAX) consoleHistory.splice(0, consoleHistory.length - CONSOLE_HISTORY_MAX);
}

/** 「清除控制台」的默认键:VSCode workbench.debug.panel.action.clearReplAction 只在 mac 绑 ⌘K(when 焦点在调试控制台),其它平台无默认键。 */
const CONSOLE_CLEAR_HOTKEY = 'mod+k';

function isConsoleClearKey(e: KeyboardEvent<HTMLElement>): boolean {
  return (
    detectPlatform() === 'mac' &&
    e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === 'k' &&
    !e.nativeEvent.isComposing
  );
}

/**
 * 调试控制台(VSCode Debug Console / REPL):程序输出(DAP output 事件,stdout / stderr / console 分色,ANSI 已去除,只保留最近的
 * DEBUG_VIEW_OUTPUT_ENTRIES_MAX 行)+ 底部求值输入(Enter 求值;停住时在首帧求值;↑ / ↓ 翻输入历史)。对象结果可展开(子变量懒加载,
 * 只在求值时那一停内)。工具栏「清除控制台」(mac ⌘K,焦点在控制台里时;就地处理并拦下,不落到终端的 ⌘K 清屏)。
 * 新输出到达时若已在底部则跟随滚动。
 */
function ConsoleSection({
  sessionId,
  lines,
  truncated,
  stopSeq,
}: {
  readonly sessionId: string | null;
  readonly lines: readonly DebugConsoleLine[];
  readonly truncated: boolean;
  readonly stopSeq: number | undefined;
}) {
  const t = useT();
  const evaluate = useDebugStore((s) => s.evaluate);
  const clearConsole = useDebugStore((s) => s.clearConsole);
  const [expression, setExpression] = useState('');
  // 历史游标:consoleHistory.length = 不在历史里(正在输入新内容)。
  const historyIndexRef = useRef(consoleHistory.length);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const clearLabel = t('panels.debug.console.clear');
  const clearHotkey = detectPlatform() === 'mac' ? formatHotkey(CONSOLE_CLEAR_HOTKEY, 'mac') : undefined;
  const clear = () => {
    stickRef.current = true;
    clearConsole(sessionId);
  };
  // VSCode navigateHistory:↑ = 上一条(已在最早一条则停在它),↓ = 下一条(过了最新一条则清空);读屏播报取出的内容。
  const navigateHistory = (previous: boolean): boolean => {
    if (consoleHistory.length === 0) return false;
    const index = Math.min(historyIndexRef.current, consoleHistory.length);
    const next = previous ? Math.max(index - 1, 0) : Math.min(index + 1, consoleHistory.length);
    historyIndexRef.current = next;
    const value = consoleHistory[next] ?? '';
    setExpression(value);
    if (value !== '') announce(value, { doc: getAnnouncingDocument() });
    return true;
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2"
      onKeyDown={(e) => {
        if (!isConsoleClearKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
        clear();
      }}
    >
      <div className="flex shrink-0 items-center justify-end">
        <IconButton
          size="sm"
          aria-label={clearLabel}
          title={withHotkey(clearLabel, clearHotkey)}
          disabled={lines.length === 0 && !truncated}
          onClick={clear}
          data-debug-console-action="clear"
        >
          <ClearConsoleIcon />
        </IconButton>
      </div>
      <ScrollArea
        ref={logRef}
        role="log"
        aria-label={t('panels.debug.console.log_aria')}
        tabIndex={0}
        className="min-h-0 flex-1 rounded border border-line bg-panel-soft p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
      >
        {truncated && <div className="text-fg-dim">{t('panels.debug.console.truncated')}</div>}
        {lines.length === 0 ? (
          <div className="text-fg-dim">{t('panels.debug.console.empty')}</div>
        ) : (
          lines.map((line) =>
            sessionId !== null &&
            line.variablesReference !== undefined &&
            line.stopSeq !== undefined &&
            line.stopSeq === stopSeq ? (
              <div key={line.id} data-category={line.category} role="tree" aria-label={t('panels.debug.console.expand_aria')}>
                <VariableTreeFocusProvider>
                  <VariableNode
                    sessionId={sessionId}
                    variable={{ name: '', value: line.text, variables_reference: line.variablesReference }}
                    level={1}
                    nodeKey={`console-${line.id}`}
                    first
                    hideName
                  />
                </VariableTreeFocusProvider>
              </div>
            ) : (
              <div
                key={line.id}
                data-category={line.category}
                className={`min-w-0 whitespace-pre-wrap break-all border-l-2 pl-1.5 ${CONSOLE_LINE_CLASS[line.category] ?? CONSOLE_LINE_DEFAULT_CLASS}`}
              >
                {line.category === 'input' ? `› ${line.text}` : line.text.replace(/\n$/, '')}
              </div>
            ),
          )
        )}
      </ScrollArea>
      {sessionId !== null && (
        <Input
          size="sm"
          variant="mono"
          value={expression}
          placeholder={t('panels.debug.console.input_placeholder')}
          aria-label={t('panels.debug.console.input_aria')}
          onChange={(e) => setExpression(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
              if (navigateHistory(e.key === 'ArrowUp')) e.preventDefault();
              return;
            }
            if (e.key !== 'Enter') return;
            const text = expression.trim();
            if (text === '') return;
            e.preventDefault();
            setExpression('');
            rememberConsoleInput(text);
            historyIndexRef.current = consoleHistory.length;
            stickRef.current = true;
            void evaluate(sessionId, text);
          }}
        />
      )}
    </div>
  );
}

/** 「清除控制台」图标(仿 VSCode codicon clear-all:三条横线 + 斜杠)。 */
function ClearConsoleIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7h11M4 12h8M4 17h5M14 20l6-8" />
    </svg>
  );
}

function DebugSessionHeader({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  useDebugStatusAnnouncements(session);
  const stopped = session.stopped;
  // 运行中不显示位置行(徽章已标「运行中」);已停下但栈帧未到 → 「已暂停」。
  const location = !stopped ? null : stopped.file !== undefined && stopped.line !== undefined ? (
    <SourceLocation path={stopped.file} line={stopped.line} />
  ) : (
    <div className="truncate text-xs text-fg-muted">{t('panels.debug.paused')}</div>
  );
  // 会话名(VSCode 调用栈 / 调试工具栏同样显示会话名):程序名或 launch name,main 没给时回退内部 id。
  const title = session.label ?? session.id;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      {/* 工具栏单独一行在最上(VSCode 调试视图顶部的 docked 工具栏);窄侧栏里也不挤掉会话名 */}
      <DebugToolbar stopped={session.stopped !== undefined} />
      <div className="min-w-0 basis-full" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg" title={title}>
          {title}
        </div>
        {location}
      </div>
      <Badge variant={session.stopped ? 'warning-soft' : 'neutral'}>
        {session.stopped
          ? (stopReasonLabel(t, session.stopped.reason) ?? t('panels.debug.paused'))
          : t('panels.debug.running')}
      </Badge>
    </Card>
  );
}

/** 停点位置未到时,最多等这么久再只播原因(取栈失败 / 无源码帧时位置永远不来)。 */
const PAUSE_LOCATION_WAIT_MS = 1000;
/**
 * 继续运行后等这么久仍在运行才播「运行中」:连按单步时每步都是「运行中 → 已暂停」,不延迟则 polite 队列越积越多
 *(VSCode 继续运行时不播状态);期间新的一停到达即取消。
 */
export const RUNNING_ANNOUNCE_DELAY_MS = 300;

/**
 * 停下 / 继续运行的读屏播报(VSCode aria.status「已暂停」+ 位置),写进全局播报区(src/lib/announce):面板被 dockview
 * 隐藏时 DOM 不在文档,面板内的 live region 会丢播报。每一停播一次(每次新节点,同位置同文本也会再读);位置(首帧)
 * 随栈帧稍后才到 → 等位置到了再播,一直没来则超时后只播原因。多个会话时带会话名。挂载时不播。
 */
function useDebugStatusAnnouncements(session: DebugSessionShadow): void {
  const t = useT();
  const multiSession = useDebugStore((s) => s.sessions.size > 1);
  const stopped = session.stopped;
  const stopSeq = stopped?.stopSeq;
  const reason = stopped?.reason;
  const location =
    stopped?.file !== undefined && stopped.line !== undefined
      ? `${basename(stopped.file) || stopped.file}:${stopped.line}`
      : undefined;
  const title = session.label ?? session.id;
  // 已播报(或挂载时已存在、不播)的状态:会话 + 停点序号(运行中为 undefined)
  const announcedRef = useRef({ id: session.id, stopSeq });
  useEffect(() => {
    const announced = announcedRef.current;
    if (announced.id === session.id && announced.stopSeq === stopSeq) return;
    const say = (next: string) => {
      announcedRef.current = { id: session.id, stopSeq };
      announce(multiSession ? t('common.label_detail', { label: title, detail: next }) : next, {
        doc: getAnnouncingDocument(),
      });
    };
    let text: string | undefined;
    let delay = 0;
    if (stopSeq === undefined || reason === undefined) {
      text = t('panels.debug.running');
      delay = RUNNING_ANNOUNCE_DELAY_MS;
    } else {
      const reasonLabel = stopReasonLabel(t, reason);
      const paused = t('panels.debug.paused');
      if (location !== undefined) {
        text =
          reasonLabel !== undefined
            ? t('panels.debug.paused_at', { reason: reasonLabel, location })
            : t('common.label_detail', { label: paused, detail: location });
      } else {
        text = reasonLabel !== undefined ? t('common.label_detail', { label: paused, detail: reasonLabel }) : paused;
        delay = PAUSE_LOCATION_WAIT_MS;
      }
    }
    if (delay === 0) {
      say(text);
      return;
    }
    const timer = setTimeout(() => say(text), delay);
    return () => clearTimeout(timer);
  }, [session.id, stopSeq, reason, location, multiSession, title, t]);
}

/** 点栈帧 / 断点:打开源码并定位到行(同插件 SDK editor.openFile);失败按 code 本地化提示,不静默。 */
function openSource(path: string, line: number): void {
  void openFileOrNotify(() => coApp.editor.openFile(path, { line }), basename(path));
}

/**
 * 源码位置一行(VSCode 调用栈同款):「文件名:行号」为主,父目录弱化放其后并从前截断(保留靠近文件的目录);
 * 完整「路径:行号」在 title。路径未知 → 「未知:行号」。
 */
function SourceLocation({
  path,
  line,
  emphasized = false,
}: {
  readonly path: string | undefined;
  readonly line: number;
  readonly emphasized?: boolean;
}) {
  const t = useT();
  const name = path === undefined ? t('panels.debug.unknown') : basename(path) || path;
  const parent = path === undefined || name === path ? '' : dirname(path);
  const full = path === undefined ? undefined : `${path}:${line}`;
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1.5" title={full}>
      <span
        className={`max-w-[70%] shrink-0 truncate ${emphasized ? 'text-sm font-medium text-fg' : 'text-xs text-fg-muted'}`}
      >
        {`${name}:${line}`}
      </span>
      {parent !== '' && <TruncateStart text={parent} title={full} className="min-w-0 flex-1 text-2xs text-fg-dim" />}
    </span>
  );
}

/**
 * 栈帧 / 断点行:整行是一个按钮(点击跳源码),右侧徽章在按钮外。title 省略时位置行即标题(断点)。
 * 打不开的帧(无源码 / 内部伪路径)不是按钮:VSCode 调用栈给这类帧加 .disabled(opacity 0.65)弱化;这里不叠透明度
 *(禁用按钮 opacity 0.5 把路径压到 2.34:1),改非交互元素 + 斜体 + 弱化文字色,各段对比度 ≥ 4.5。
 */
function SourceRow({
  title,
  detail,
  path,
  line,
  badge,
}: {
  readonly title?: string;
  readonly detail?: string;
  readonly path: string | undefined;
  readonly line: number;
  readonly badge: ReactNode;
}) {
  // 只有绝对路径能打开:适配器给的 source.path 可能是内部伪路径(如 node 内部模块),点了只会报 INVALID_PATH。
  const openable = path !== undefined && isAbsolutePath(path);
  const tooltip = path === undefined ? undefined : `${path}:${line}`;
  const content = (
    <>
      {title !== undefined && (
        <span className={`w-full truncate text-sm font-medium ${openable ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
      )}
      <SourceLocation path={path} line={line} emphasized={title === undefined} />
      {detail !== undefined && <span className="w-full truncate text-xs text-fg-muted">{detail}</span>}
    </>
  );
  return (
    <Card className="flex items-center justify-between gap-3">
      {openable ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 flex-col items-start text-left"
          onClick={() => openSource(path, line)}
          title={tooltip}
        >
          {content}
        </Button>
      ) : (
        // 内边距同 Button sm(--wm-space-1_5 / --wm-space-2_5),与可打开的帧左对齐
        <div
          className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-1.5 text-left italic"
          data-deemphasized=""
          title={tooltip}
        >
          {content}
        </div>
      )}
      {badge}
    </Card>
  );
}

function StackSection({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  if (session.frames.length === 0) {
    return <EmptyState>{t('panels.debug.empty_stack')}</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-2">
      {session.frames.map((frame) => (
        <SourceRow
          key={frame.id}
          title={frame.name}
          path={frame.source_path}
          line={frame.line}
          badge={<Badge variant="info">#{frame.id}</Badge>}
        />
      ))}
    </div>
  );
}

function VariablesSection({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  if (session.scopes.length === 0) {
    return <EmptyState>{t('panels.debug.empty_variables')}</EmptyState>;
  }
  // 每一停重挂(variables_reference 跨停复用,展开状态与自动加载都只属于这一停)。
  const stopSeq = session.stopped?.stopSeq ?? 0;
  return (
    <div className="flex flex-col gap-2">
      {session.scopes.map((scope, index) => (
        <ScopeCard
          key={`${stopSeq}:${scope.variables_reference}`}
          session={session}
          scope={scope}
          // 同 VSCode:第一个作用域(通常是 Locals)自动展开;expensive 的不自动取。
          autoLoad={index === 0 && !scope.expensive}
        />
      ))}
    </div>
  );
}

function ScopeCard({
  session,
  scope,
  autoLoad,
}: {
  readonly session: DebugSessionShadow;
  readonly scope: DebugScope;
  readonly autoLoad: boolean;
}) {
  const t = useT();
  const loadVariables = useDebugStore((state) => state.loadVariables);
  const [loading, setLoading] = useState(false);
  const sessionId = session.id;
  const reference = scope.variables_reference;
  const loaded = useDebugStore(
    (state) => state.sessions.get(sessionId)?.variableRefs.has(reference) ?? false,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await loadVariables(sessionId, reference);
    } finally {
      setLoading(false);
    }
  }, [loadVariables, sessionId, reference]);

  useEffect(() => {
    if (autoLoad) void load();
  }, [autoLoad, load]);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">{scope.name}</div>
          <div className="text-xs text-fg-muted">
            {t('panels.debug.scope_ref', { ref: reference })}
          </div>
        </div>
        {!loaded && (
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            {loading
              ? t('common.loading')
              : t('panels.debug.load_scope', { scope: scope.name })}
          </Button>
        )}
      </div>
      {loaded && (
        <div
          role="tree"
          aria-label={scope.name}
          className="mt-3 flex flex-col gap-0.5 border-t border-line pt-2"
        >
          <VariableTreeFocusProvider>
            <VariableList sessionId={sessionId} reference={reference} level={1} parentKey="" />
          </VariableTreeFocusProvider>
        </div>
      )}
    </Card>
  );
}

/**
 * 变量树的 roving tabindex(APG Tree View / VSCode 变量视图):整棵树只有一个节点 tabindex=0,跟随焦点;
 * Tab 离开再回来回到上次的节点。activeKey 为 null 时第一个节点可 Tab 到。节点 key = 父 key + "/" + 序号:名称
 * (「加载更多」为父 key + "/more")。pendingFocus:异步加载后要把焦点交给的节点 key(节点渲染时认领)。
 */
interface VariableTreeFocus {
  readonly activeKey: string | null;
  readonly setActiveKey: (key: string) => void;
  readonly pendingFocus: MutableRefObject<string | null>;
}
const VariableTreeFocusContext = createContext<VariableTreeFocus | null>(null);

function VariableTreeFocusProvider({ children }: { readonly children: ReactNode }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const value = useMemo(() => ({ activeKey, setActiveKey, pendingFocus }), [activeKey]);
  return <VariableTreeFocusContext.Provider value={value}>{children}</VariableTreeFocusContext.Provider>;
}

/** 树节点的焦点接线:是否可 Tab 到、获得焦点时记为 active、认领异步加载后的待定焦点。 */
function useTreeItemFocus(key: string, first: boolean) {
  const focus = useContext(VariableTreeFocusContext)!;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus.pendingFocus.current !== key) return;
    focus.pendingFocus.current = null;
    ref.current?.focus();
  });
  return {
    focus,
    props: {
      ref,
      tabIndex: focus.activeKey === key || (focus.activeKey === null && first) ? 0 : -1,
      onFocus: (e: { target: EventTarget; currentTarget: EventTarget }) => {
        if (e.target === e.currentTarget) focus.setActiveKey(key);
      },
    },
  };
}

/**
 * 树节点共用的键盘:↑↓ 在可见节点间移动,← 回到父节点;其余键交给 onKey(返回是否处理)。
 * 节点嵌套:只处理焦点所在的这一层,不冒泡到父节点。
 */
function handleTreeItemKey(e: KeyboardEvent<HTMLDivElement>, onKey: (key: string) => boolean): void {
  if (e.target !== e.currentTarget) return;
  const self = e.currentTarget;
  const move = (delta: number) => {
    const items = visibleTreeItems(self);
    items[items.indexOf(self) + delta]?.focus();
  };
  if (e.key === 'ArrowDown') move(1);
  else if (e.key === 'ArrowUp') move(-1);
  else if (!onKey(e.key)) {
    if (e.key !== 'ArrowLeft') return;
    self.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
  }
  e.preventDefault();
  e.stopPropagation();
}

/** 某 reference(作用域或对象变量)下已加载的变量,满页时末尾「加载更多」。作用域与展开的子节点共用。 */
function VariableList({
  sessionId,
  reference,
  level,
  parentKey,
}: {
  readonly sessionId: string;
  readonly reference: number;
  readonly level: number;
  readonly parentKey: string;
}) {
  const t = useT();
  const loadMoreVariables = useDebugStore((state) => state.loadMoreVariables);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreKey = `${parentKey}/more`;
  const more = useTreeItemFocus(moreKey, false);
  const variables = useDebugStore(
    (state) => state.sessions.get(sessionId)?.variableRefs.get(reference) ?? EMPTY_VARIABLES,
  );
  // main 每页有上限,满页回 next_start → 显示「加载更多」把后续页追加到本 reference 下。
  const hasMore = useDebugStore(
    (state) => state.sessions.get(sessionId)?.variableNextStart?.has(reference) ?? false,
  );

  const loadMore = async () => {
    if (loadingMore) return;
    const el = more.props.ref.current;
    const hadFocus = el !== null && el.ownerDocument.activeElement === el;
    const before = variables.length;
    setLoadingMore(true);
    try {
      await loadMoreVariables(sessionId, reference);
    } finally {
      setLoadingMore(false);
    }
    // VSCode:加载更多后焦点到新加载的第一项(「加载更多」可能随末页消失,焦点不掉到 body)
    const loaded = useDebugStore.getState().sessions.get(sessionId)?.variableRefs.get(reference);
    const first = loaded?.[before];
    if (hadFocus && first !== undefined) {
      const key = `${parentKey}/${before}:${first.name}`;
      more.focus.pendingFocus.current = key;
      more.focus.setActiveKey(key);
    }
  };

  return (
    <>
      {variables.map((variable, index) => (
        <VariableNode
          key={`${index}:${variable.name}`}
          sessionId={sessionId}
          variable={variable}
          level={level}
          nodeKey={`${parentKey}/${index}:${variable.name}`}
          first={level === 1 && index === 0}
        />
      ))}
      {hasMore && (
        // 「加载更多」是树节点(VSCode 变量视图同):方向键可到达,Enter / 空格加载下一页
        <div
          role="treeitem"
          aria-level={level}
          aria-disabled={loadingMore || undefined}
          {...more.props}
          className="cursor-default rounded text-xs text-accent outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus-ring"
          style={{ paddingLeft: `calc(${indentOf(level)} + 0.75rem + 0.375rem)` }}
          onKeyDown={(e) =>
            handleTreeItemKey(e, (key) => {
              if (key !== 'Enter' && key !== ' ') return false;
              void loadMore();
              return true;
            })
          }
          onClick={(e) => {
            // 不冒泡成父节点的展开 / 收起
            e.stopPropagation();
            void loadMore();
          }}
        >
          {loadingMore ? t('common.loading') : t('panels.debug.load_more')}
        </div>
      )}
    </>
  );
}

const indentOf = (level: number): string => `${(level - 1) * 12}px`;

/** 同一棵树里当前渲染(= 可见)的全部节点,按文档顺序。 */
function visibleTreeItems(from: HTMLElement): HTMLElement[] {
  const tree = from.closest('[role="tree"]');
  return tree ? Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')) : [];
}

/**
 * 变量树节点(WAI-ARIA tree):variables_reference > 0 的对象变量可展开,展开时按需加载子变量(loadVariables 同一停内
 * 有缓存)。键盘同 VSCode / APG:↑↓ 移动,→ 展开 / 进入第一个子节点,← 收起 / 回到父节点,Enter 切换。
 */
function VariableNode({
  sessionId,
  variable,
  level,
  nodeKey,
  first,
  hideName = false,
}: {
  readonly sessionId: string;
  readonly variable: DebugVariable;
  readonly level: number;
  readonly nodeKey: string;
  readonly first: boolean;
  /** 只显示值(调试控制台的求值结果:没有变量名)。 */
  readonly hideName?: boolean;
}) {
  const t = useT();
  const { focus, props: focusProps } = useTreeItemFocus(nodeKey, first);
  const loadVariables = useDebugStore((state) => state.loadVariables);
  const childRef = variable.variables_reference ?? 0;
  const expandable = childRef > 0;
  const [expanded, setExpanded] = useState(false);
  const childrenLoaded = useDebugStore(
    (state) => state.sessions.get(sessionId)?.variableRefs.has(childRef) ?? false,
  );

  const setOpen = (open: boolean) => {
    if (!expandable) return;
    if (open) void loadVariables(sessionId, childRef);
    // 收起:焦点记忆在其子孙上 → 回到本节点(否则整棵树没有可 Tab 到的节点)
    else if (focus.activeKey?.startsWith(`${nodeKey}/`)) focus.setActiveKey(nodeKey);
    setExpanded(open);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const self = e.currentTarget;
    handleTreeItemKey(e, (key) => {
      if (key === 'ArrowRight') {
        if (expandable && !expanded) setOpen(true);
        else if (expanded) self.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
        return true;
      }
      if (key === 'ArrowLeft' && expanded) {
        setOpen(false);
        return true;
      }
      if (key === 'Enter') {
        setOpen(!expanded);
        return true;
      }
      return false;
    });
  };

  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-expanded={expandable ? expanded : undefined}
      // APG:展开中、子节点还没加载到 → aria-busy
      aria-busy={expanded && !childrenLoaded ? true : undefined}
      aria-label={hideName ? variable.value : `${variable.name}: ${variable.value}`}
      {...focusProps}
      className="rounded outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
      onKeyDown={onKeyDown}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!expanded);
      }}
    >
      <div
        className={`grid cursor-default items-center gap-x-1.5 rounded text-xs hover:bg-hover ${
          hideName ? 'grid-cols-[0.75rem_minmax(0,1fr)]' : 'grid-cols-[0.75rem_minmax(0,1fr)_minmax(0,1fr)]'
        }`}
        style={{ paddingLeft: indentOf(level) }}
      >
        <span className="text-2xs text-fg-dim" aria-hidden="true">
          {expandable ? (expanded ? '▾' : '▸') : ''}
        </span>
        {!hideName && (
          <span className="truncate text-fg" title={variable.name}>
            {variable.name}
          </span>
        )}
        <span className={`truncate ${hideName ? 'text-fg' : 'text-fg-muted'}`} title={variable.value}>
          {variable.value}
        </span>
      </div>
      {expanded && (
        <div role="group" className="flex flex-col gap-0.5">
          {childrenLoaded ? (
            <VariableList sessionId={sessionId} reference={childRef} level={level + 1} parentKey={nodeKey} />
          ) : (
            // 视觉提示;读屏经父节点 aria-busy 得知(不是树节点,方向键不经过)
            <div aria-hidden="true" className="text-xs text-fg-dim" style={{ paddingLeft: indentOf(level + 1) }}>
              {t('common.loading')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BreakpointsSection({ session }: { readonly session: DebugSessionShadow }) {
  const t = useT();
  const rows = session.breakpoints;
  if (rows.length === 0) {
    return <EmptyState>{t('panels.debug.empty_breakpoints')}</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((breakpoint) => (
        <SourceRow
          key={`${breakpoint.file}:${breakpoint.line}`}
          {...(breakpoint.message ? { detail: breakpoint.message } : {})}
          path={breakpoint.file}
          line={breakpoint.line}
          badge={
            <Badge variant={breakpoint.verified ? 'success-soft' : 'warning-soft'}>
              {breakpoint.verified
                ? t('panels.debug.breakpoint.verified')
                : t('panels.debug.breakpoint.pending')}
            </Badge>
          }
        />
      ))}
    </div>
  );
}
