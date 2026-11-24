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
  ScrollArea,
  Tabs,
  TruncateStart,
  type TabItem,
} from '@/design';
import {
  selectDisplayedSession,
  useDebugStore,
  type DebugScope,
  type DebugSessionShadow,
  type DebugVariable,
} from '@/stores/debug.store';
import { useLocale, useT } from '@/i18n';
import { coApp } from '@/plugins/co-app';
import { basename, dirname, isAbsolutePath } from '@/lib/path-cross';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { announce } from '@/lib/announce';
import { getAnnouncingDocument } from '@/shell/dock/popout-documents';

const EMPTY_VARIABLES: readonly [] = [];

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

export function DebugPanel() {
  const t = useT();
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState('stack');
  // 已停下的会话优先,否则最近的运行中会话(见 selectDisplayedSession)。
  const session = useDebugStore(selectDisplayedSession);
  const debugTabs = useMemo<readonly TabItem[]>(
    () => {
      void locale;
      return [
        { id: 'stack', label: t('panels.debug.tab.stack') },
        { id: 'variables', label: t('panels.debug.tab.variables') },
        { id: 'breakpoints', label: t('panels.debug.tab.breakpoints') },
      ];
    },
    [locale, t],
  );

  if (!session) {
    return (
      <div className="flex h-full w-full bg-canvas text-fg">
        <EmptyState>{t('panels.debug.empty_session')}</EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full gap-3 bg-canvas p-3 text-fg">
      <aside className="w-36 shrink-0">
        <Tabs
          items={debugTabs}
          activeId={activeTab}
          onSelect={setActiveTab}
          ariaLabel={t('panels.debug.views_aria')}
        />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <DebugSessionHeader session={session} />
        <ScrollArea>
          {activeTab === 'stack' && <StackSection session={session} />}
          {activeTab === 'variables' && <VariablesSection session={session} />}
          {activeTab === 'breakpoints' && <BreakpointsSection session={session} />}
        </ScrollArea>
      </section>
    </div>
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
    <Card className="flex items-center justify-between gap-3">
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

/** 栈帧 / 断点行:整行是一个按钮(点击跳源码),右侧徽章在按钮外。title 省略时位置行即标题(断点)。 */
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
  return (
    <Card className="flex items-center justify-between gap-3">
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 flex-1 flex-col items-start text-left"
        disabled={!openable}
        onClick={openable ? () => openSource(path, line) : undefined}
        title={path === undefined ? undefined : `${path}:${line}`}
      >
        {title !== undefined && <span className="w-full truncate text-sm font-medium text-fg">{title}</span>}
        <SourceLocation path={path} line={line} emphasized={title === undefined} />
        {detail !== undefined && <span className="w-full truncate text-xs text-fg-muted">{detail}</span>}
      </Button>
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
}: {
  readonly sessionId: string;
  readonly variable: DebugVariable;
  readonly level: number;
  readonly nodeKey: string;
  readonly first: boolean;
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
      aria-label={`${variable.name}: ${variable.value}`}
      {...focusProps}
      className="rounded outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
      onKeyDown={onKeyDown}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!expanded);
      }}
    >
      <div
        className="grid cursor-default grid-cols-[0.75rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-1.5 rounded text-xs hover:bg-hover"
        style={{ paddingLeft: indentOf(level) }}
      >
        <span className="text-2xs text-fg-dim" aria-hidden="true">
          {expandable ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="truncate text-fg" title={variable.name}>
          {variable.name}
        </span>
        <span className="truncate text-fg-muted" title={variable.value}>
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
