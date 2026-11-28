import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type WheelEvent } from 'react';
import { Button, EmptyState, IconButton, MenuItem } from '@/design';
import { useT } from '@/i18n';
import { DropdownMenu } from '@/lib/dropdown-menu';
import { ChevronDownIcon, ClearAllIcon, LockIcon } from '@/lib/ui-icons';
import {
  clearOutputChannel,
  setActiveOutputChannel,
  setOutputAutoScroll,
  useActiveOutputChannelId,
  useOutputAutoScroll,
  useOutputChannelSnapshot,
  useOutputChannels,
} from '@/plugins/output/output-channels';

const CHEVRON = <ChevronDownIcon size={12} />;
const CLEAR_ICON = <ClearAllIcon size={14} />;
const LOCKED_ICON = <LockIcon size={14} locked />;
const UNLOCKED_ICON = <LockIcon size={14} locked={false} />;
/** 离底部不超过这么多像素算「在底部」(智能滚动:滚回底部即恢复自动滚动)。 */
const BOTTOM_SLACK_PX = 4;
/**
 * 用户滚动输入(滚轮 / 按键 / 指针 / 非补偿引起的 scroll 事件)之后这么久内不做丢行补偿:补偿要设 scrollTop,会打断
 * Chromium 的滚轮 / 键盘平滑滚动动画;高频写入时用户就再也滚不到底部解锁。
 */
const USER_SCROLL_SETTLE_MS = 250;
/** 让视图往上滚的按键(滚动区聚焦时):按下即锁定自动滚动。 */
const UP_SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'PageUp', 'Home']);
/**
 * 每块的行数。按绝对行号分块渲染(块 k = 行 [k·N, (k+1)·N)):写入时只有末块(追加)与首块(环形缓冲丢最早的行)变,
 * 其余块的 DOM 原样不动 —— 不再像整段 `<pre>` 文本那样每次写入替换并重排全部 1 万行。
 */
export const OUTPUT_CHUNK_LINES = 100;

/**
 * 锁定滚动时的参照行(每次提交后记下):视口顶部所在行与最后一个完整行(绝对行号)及它们当时的 offsetTop。下次提交丢了
 * 最早的行 → 参照行新旧 offsetTop 之差就是它上方被丢掉的行的实际高度(含折行),scrollTop 减去它。优先用视口顶部那行
 *(其下方的排版变化不影响补偿);它本身已被丢掉(用户滚到了最早的几行)→ 用最后一个完整行。只用位移、不用「参照行相对
 * 视口的偏移」:用户滚动后、scroll 事件派发前就来了一次写入时,后者会把视图拽回滚动前的位置。
 */
interface ScrollReference {
  readonly channelId: string;
  readonly firstLine: number;
  readonly lines: ReadonlyArray<{ readonly line: number; readonly offsetTop: number }>;
}

/** 视口顶部所在的行元素(二分:先块、后块内的行;块 / 行的 offsetTop 相对滚动区递增)。 */
function lineAtTop(body: HTMLElement): HTMLElement | null {
  const content = body.firstElementChild;
  if (!content) return null;
  const top = body.scrollTop;
  const lastAtOrAbove = (list: HTMLCollection): HTMLElement | null => {
    let lo = 0;
    let hi = list.length - 1;
    let found = (list[0] as HTMLElement | undefined) ?? null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = list[mid] as HTMLElement;
      if (el.offsetTop <= top) {
        found = el;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const chunk = lastAtOrAbove(content.children);
  if (!chunk) return null;
  return chunk.hasAttribute('data-line') ? chunk : lastAtOrAbove(chunk.children);
}

function captureReference(body: HTMLElement, channelId: string, firstLine: number, lastLine: number): ScrollReference {
  const lines: Array<{ line: number; offsetTop: number }> = [];
  const top = lineAtTop(body);
  const topLine = top ? Number(top.dataset['line']) : NaN;
  if (top && Number.isFinite(topLine)) lines.push({ line: topLine, offsetTop: top.offsetTop });
  const last = lastLine >= firstLine ? body.querySelector<HTMLElement>(`[data-line="${lastLine}"]`) : null;
  if (last && lastLine !== topLine) lines.push({ line: lastLine, offsetTop: last.offsetTop });
  return { channelId, firstLine, lines };
}

function renderLines(lines: readonly string[], firstLine: number, from: number, to: number): ReactNode[] {
  const out = new Array<ReactNode>(to - from);
  for (let n = from; n < to; n += 1) {
    out[n - from] = (
      <div key={n} data-line={n} className="min-h-[1lh]">
        {lines[n - firstLine]}
      </div>
    );
  }
  return out;
}

/** 一块行(绝对行号 [from, to))。行一经写入不再改变(清除后行号也不复用),同通道同 from / to 的块内容必然相同 → 只比 from / to。 */
const OutputChunk = memo(
  function OutputChunk({ lines, firstLine, from, to }: { lines: readonly string[]; firstLine: number; from: number; to: number }) {
    return <div>{renderLines(lines, firstLine, from, to)}</div>;
  },
  (a, b) => a.from === b.from && a.to === b.to,
);

/**
 * 输出面板(BDD: src/__tests__/plugin-output-channel/)。对齐 VSCode 输出视图(src/vs/workbench/contrib/output/browser/
 * outputView.ts、output.contribution.ts):标题栏的通道下拉切换通道,「清除输出」,「自动滚动」开关(锁);内容变化时
 * 未锁定则滚到最后一行,手动向上滚即锁定、滚回底部即解锁(output.smartScroll;高频写入时也成立)。没有任何通道时只显示空状态。
 */
/** 按绝对行号分块渲染;末尾未换行的部分作为最后一行(行号 = 下一个完整行的行号)。 */
function renderChunks({ lines, firstLine, partial }: { lines: readonly string[]; firstLine: number; partial: string }): ReactNode[] {
  const end = firstLine + lines.length;
  const out: ReactNode[] = [];
  for (let k = Math.floor(firstLine / OUTPUT_CHUNK_LINES); k * OUTPUT_CHUNK_LINES < end; k += 1) {
    const from = Math.max(k * OUTPUT_CHUNK_LINES, firstLine);
    const to = Math.min((k + 1) * OUTPUT_CHUNK_LINES, end);
    out.push(<OutputChunk key={k} lines={lines} firstLine={firstLine} from={from} to={to} />);
  }
  if (partial.length > 0) {
    out.push(
      <div key="partial" data-line={end} className="min-h-[1lh]">
        {partial}
      </div>,
    );
  }
  return out;
}

export function Output() {
  const t = useT();
  const channels = useOutputChannels();
  const activeId = useActiveOutputChannelId();
  const active = channels.find((c) => c.id === activeId) ?? channels[0] ?? null;
  const snapshot = useOutputChannelSnapshot(active?.id ?? null);
  const autoScroll = useOutputAutoScroll();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * 本组件最近一次程序滚动后的 scrollTop(用户输入后清空)。其 scroll 事件回声只用来区分「程序滚到底」与「用户滚到底」,
   * 不再像旧实现那样吞掉下一个 scroll 事件:高频写入时程序滚动与用户滚轮落在同一帧,被吞的就是用户那一下。
   */
  const programmaticTop = useRef<number | null>(null);
  /**
   * 满 1 万行后每次写入都丢最早的行:锁定时按参照行(见 ScrollReference)的位移把 scrollTop 补回去,正在看的内容不动
   *(VSCode 锁定后同)。浏览器自带的 scroll anchoring 关掉(overflow-anchor: none),只由这里补偿,免得两边叠加。
   */
  const referenceRef = useRef<ScrollReference | null>(null);
  /** 最近一次用户滚动输入的时刻(见 USER_SCROLL_SETTLE_MS)。 */
  const userScrollAt = useRef(Number.NEGATIVE_INFINITY);
  /** 补偿设下的 scrollTop:它的 scroll 事件回声不算用户滚动。 */
  const compensatedTop = useRef<number | null>(null);
  const activeChannelId = active?.id ?? null;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || activeChannelId === null) return;
    if (autoScroll) {
      body.scrollTop = body.scrollHeight;
      programmaticTop.current = body.scrollTop;
      referenceRef.current = null;
      return;
    }
    const ref = referenceRef.current;
    // 用户正在滚动 / 已滚到底部(下一个 scroll 事件据此解锁)→ 不补偿。
    const userScrolling = performance.now() - userScrollAt.current < USER_SCROLL_SETTLE_MS;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= BOTTOM_SLACK_PX;
    if (!userScrolling && !atBottom && ref !== null && ref.channelId === activeChannelId && snapshot.firstLine > ref.firstLine) {
      const survivor = ref.lines.find((r) => r.line >= snapshot.firstLine);
      const el = survivor ? body.querySelector<HTMLElement>(`[data-line="${survivor.line}"]`) : null;
      if (survivor && el) {
        body.scrollTop = Math.max(0, body.scrollTop - (survivor.offsetTop - el.offsetTop));
        compensatedTop.current = body.scrollTop;
      }
    }
    const lastLine = snapshot.firstLine + snapshot.lines.length - 1;
    referenceRef.current = captureReference(body, activeChannelId, snapshot.firstLine, lastLine);
  }, [snapshot.version, snapshot.firstLine, snapshot.lines.length, autoScroll, activeChannelId]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    // 程序滚到底的回声:不据此改锁(用户刚滚轮上滚锁定时,同帧排队的这个回声仍停在底部,不能把锁解掉)。
    if (programmaticTop.current !== null && body.scrollTop === programmaticTop.current) return;
    if (compensatedTop.current === null || body.scrollTop !== compensatedTop.current) userScrollAt.current = performance.now();
    compensatedTop.current = null;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= BOTTOM_SLACK_PX;
    setOutputAutoScroll(atBottom);
  };

  // 用户滚动意图直接看输入事件,不等 scroll 事件:Chromium 的滚轮 / 键盘滚动是动画,下一次写入的程序滚动会取消它,
  // scroll 事件里根本看不到「离开底部」。往上滚的输入 → 立即锁定(保留回声标记:同帧排队的回声停在底部,不能把锁解掉);
  // 其余滚动输入 → 清掉回声标记,之后的 scroll 事件按位置判定(滚回底部即解锁)。
  const lockOrRelease = (up: boolean, target: HTMLElement) => {
    userScrollAt.current = performance.now();
    if (up && target.scrollTop > 0) setOutputAutoScroll(false);
    else programmaticTop.current = null;
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => lockOrRelease(e.deltaY < 0, e.currentTarget);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => lockOrRelease(UP_SCROLL_KEYS.has(e.key), e.currentTarget);
  const onPointerDown = () => {
    userScrollAt.current = performance.now();
    programmaticTop.current = null;
  };

  if (active === null) {
    return (
      // 没有任何控件:根是打开 / 显示输出后的焦点落点(只经脚本聚焦,不进 Tab 顺序;BDD: open-panel-focus)。
      <div tabIndex={-1} data-panel-focus-root="" className="flex h-full w-full overflow-auto outline-none">
        <EmptyState>{t('panels.output.empty')}</EmptyState>
      </div>
    );
  }

  const channelLabel = t('panels.output.channel');
  const autoScrollLabel = t(autoScroll ? 'panels.output.auto_scroll_off' : 'panels.output.auto_scroll_on');
  return (
    <div tabIndex={-1} data-panel-focus-root="" className="flex h-full w-full flex-col outline-none">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${channelLabel}: ${active.name}`}
          title={channelLabel}
          data-output-channel-picker=""
          onClick={() => setMenuOpen((v) => !v)}
          className="min-w-0 max-w-[60%] !gap-1"
        >
          <span className="truncate">{active.name}</span>
          <span aria-hidden="true" className="shrink-0 text-fg-muted">
            {CHEVRON}
          </span>
        </Button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} triggerRef={triggerRef}>
          {({ closeAndRestore }) =>
            channels.map((c) => (
              <MenuItem
                key={c.id}
                checked={c.id === active.id}
                checkKind="radio"
                title={c.ownerId ?? undefined}
                onClick={() => {
                  closeAndRestore();
                  setActiveOutputChannel(c.id);
                }}
              >
                {c.name}
              </MenuItem>
            ))
          }
        </DropdownMenu>
        <div className="flex-1" />
        <IconButton
          size="xs"
          title={t('panels.output.clear')}
          aria-label={t('panels.output.clear')}
          onClick={() => clearOutputChannel(active.id)}
        >
          {CLEAR_ICON}
        </IconButton>
        <IconButton
          size="xs"
          title={autoScrollLabel}
          aria-label={autoScrollLabel}
          aria-pressed={!autoScroll}
          onClick={() => setOutputAutoScroll(!autoScroll)}
        >
          {autoScroll ? UNLOCKED_ICON : LOCKED_ICON}
        </IconButton>
      </div>
      <div
        ref={bodyRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        role="document"
        aria-label={active.name}
        data-output-channel={active.id}
        className="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
      >
        {/* key = 通道:块按「绝对行号区间」判等,不同通道的同号区间内容不同,切换通道时整体重建。 */}
        <div key={active.id} className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-fg">
          {renderChunks(snapshot)}
        </div>
      </div>
    </div>
  );
}
