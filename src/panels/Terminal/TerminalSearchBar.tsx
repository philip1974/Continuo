import { useLayoutEffect, useRef } from 'react';
import { IconButton, Input } from '@/design';
import { translateCount, useT } from '@/i18n';
import { clampSearchQuery } from '@/lib/search-query';
import { isImeComposing } from '@/design/ime';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from '@/lib/ui-icons';
import type { SearchApi } from './useTerminal';
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  type TerminalSearchOptions,
  type TerminalSearchResult,
} from './terminal-search-state';

interface TerminalSearchBarProps {
  readonly searchApi: SearchApi;
  readonly onClose: () => void;
}

// 上一个 / 下一个 / 关闭用 SVG 图标(此前是 ASCII「^ v x」,字形大小 / 基线与 .* / Aa / W 不齐)。模块级预创建。
const PREV_MATCH_ICON = <ChevronUpIcon size={14} />;
const NEXT_MATCH_ICON = <ChevronDownIcon size={14} />;
const CLOSE_SEARCH_ICON = <CloseIcon size={14} />;

function toggleOption(
  options: TerminalSearchOptions,
  key: keyof TerminalSearchOptions,
): TerminalSearchOptions {
  return { ...options, [key]: !options[key] };
}

/** 结果计数文案:达 addon 上限显示「1000+」;当前匹配不在已收集结果内(index=-1)时只显示总数。 */
function formatCount(
  result: TerminalSearchResult,
  t: ReturnType<typeof useT>,
): string {
  if (result.count <= 0) return t('panels.terminal.search.no_match');
  const capped = result.count >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT;
  const total = capped ? `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+` : String(result.count);
  if (result.index < 0) {
    // 只显示总数:按单复数(1 match / 20 matches);「1000+」恒为复数。
    return capped
      ? t('panels.terminal.search.match_total_other', { count: total })
      : translateCount('panels.terminal.search.match_total', result.count);
  }
  return t('panels.terminal.search.match_count', { n: result.index + 1, total });
}

export function TerminalSearchBar({
  searchApi,
  onClose,
}: TerminalSearchBarProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const result = searchApi.result;
  const placeholderLabel = t('panels.terminal.search.placeholder');
  const optionsGroupLabel = t('panels.terminal.search.options_group');
  const regexLabel = t('panels.terminal.search.regex');
  const caseSensitiveLabel = t('panels.terminal.search.case_sensitive');
  const wholeWordLabel = t('panels.terminal.search.whole_word');
  const previousLabel = t('panels.terminal.search.previous');
  const nextLabel = t('panels.terminal.search.next');
  const closeLabel = t('panels.terminal.search.close');

  // issue #38 R2: `autoFocus` 偶尔被 xterm textarea 在下一帧 refocus 抢走。
  // useLayoutEffect 在 paint 前同步 focus,raf 再补一次保险(xterm 内部
  // 的 refocus 通常发生在 keydown 的 microtask/animation frame 链路上)。
  // 依赖 focusRequest:已打开时再按 ⌘F 搜索条不重挂,靠它重新聚焦并全选已有词(VSCode 行为),
  // 否则焦点留在终端,输入与回车进 shell。
  const focusRequest = searchApi.focusRequest;
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
    const id = requestAnimationFrame(() => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [focusRequest]);
  const countText = formatCount(result, t);

  return (
    <div
      // z-terminal-overlay token defined in theme.css(issue #38 R2d / topic-26
      // memory L3): xterm-host 内的浮层必须用此 token,否则 z-modal 被 dockview
      // panel stacking context 困住,xterm canvas hit-test 上去。`isolation:
      // isolate` 强建独立 stacking context 配合 token 一起用。
      // 窄分栏(对齐 VSCode 查找框 reduced / collapsed):宽度封顶在终端面板内(两侧各留 0.5rem),输入框收窄(保底
      // min-w-16)始终可见;面板 < 24rem 计数只留给读屏(sr-only 仍播报),< 20rem 隐藏选项与上 / 下一个,只剩输入框 +
      // 关闭。容器 = TerminalPanelView 根节点(@container/terminal)。否则超出面板的部分被 dockview `.dv-view{overflow:clip}`
      // 裁掉,右对齐时最先被裁的就是输入框。BDD: src/__tests__/terminal-search/(S15)
      className="absolute right-2 top-2 z-terminal-overlay flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 shadow-popover"
      style={{ isolation: 'isolate' }}
      // R2c: stop mousedown propagation so dockview / xterm host's
      // mousedown handlers don't refocus xterm textarea when user clicks
      // back into the search input.
      onMouseDown={(e) => e.stopPropagation()}
      // Esc 挂在根节点:点过选项 / 跳转按钮后焦点在按钮上,Esc 也须关闭并把焦点还给终端(onClose)。
      // IME 组合中的 Esc 属于输入法(取消组合),不关闭。
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeComposing(event.nativeEvent)) return;
        event.preventDefault();
        onClose();
      }}
    >
      <Input
        ref={inputRef}
        size="sm"
        value={searchApi.term}
        onBlur={searchApi.clearActiveDecoration}
        // 边界(E280,E279 同族):截断超长 query —— 超长 pattern × 终端 scrollback 在 xterm SearchAddon
        // 同步搜索会放大 CPU/内存(regex 模式更甚)。复用统一搜索上限 clampSearchQuery。
        onChange={(event) =>
          searchApi.setTerm(clampSearchQuery(event.target.value))
        }
        onKeyDown={(event) => {
          // IME 组合中的 Enter 属于输入法(确认候选),不跳转。Esc 由根节点统一处理。
          if (isImeComposing(event.nativeEvent)) return;
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (event.shiftKey) {
            searchApi.prev();
          } else {
            searchApi.next();
          }
        }}
        placeholder={placeholderLabel}
        aria-label={placeholderLabel}
        className="w-48 min-w-16"
      />
      {/* a11y(A53,A41 同族):匹配计数/无匹配随输入与上下跳转动态变化,焦点在搜索框时须经
          live region(role=status/polite)播报当前匹配数/第几项。 */}
      <span
        role="status"
        className="min-w-12 shrink-0 text-center text-xs tabular-nums text-fg-dim @max-sm/terminal:sr-only @max-sm/terminal:min-w-0"
      >
        {countText}
      </span>
      {/* a11y(A99,A97 同族):regex/case/whole-word 三 toggle 成组,用 role=group + aria-label
          命名为「搜索选项」,否则 SR 逐个聚焦只听到单开关状态不知是选项组。inline-flex gap-1
          保持与外层 gap-1 一致的视觉间距。 */}
      <div
        role="group"
        aria-label={optionsGroupLabel}
        className="inline-flex items-center gap-1 @max-xs/terminal:hidden"
      >
        <IconButton
          size="xs"
          aria-label={regexLabel}
          title={regexLabel}
          aria-pressed={searchApi.options.regex}
          onClick={() =>
            searchApi.setOptions(toggleOption(searchApi.options, 'regex'))
          }
        >
          .*
        </IconButton>
        <IconButton
          size="xs"
          aria-label={caseSensitiveLabel}
          title={caseSensitiveLabel}
          aria-pressed={searchApi.options.caseSensitive}
          onClick={() =>
            searchApi.setOptions(
              toggleOption(searchApi.options, 'caseSensitive'),
            )
          }
        >
          Aa
        </IconButton>
        <IconButton
          size="xs"
          aria-label={wholeWordLabel}
          title={wholeWordLabel}
          aria-pressed={searchApi.options.wholeWord}
          onClick={() =>
            searchApi.setOptions(toggleOption(searchApi.options, 'wholeWord'))
          }
        >
          W
        </IconButton>
      </div>
      <IconButton
        size="xs"
        aria-label={previousLabel}
        title={previousLabel}
        className="@max-xs/terminal:hidden"
        onClick={searchApi.prev}
      >
        {PREV_MATCH_ICON}
      </IconButton>
      <IconButton
        size="xs"
        aria-label={nextLabel}
        title={nextLabel}
        className="@max-xs/terminal:hidden"
        onClick={searchApi.next}
      >
        {NEXT_MATCH_ICON}
      </IconButton>
      <IconButton
        size="xs"
        aria-label={closeLabel}
        title={closeLabel}
        // 性能:阻止 mousedown 默认的焦点转移 —— 否则输入框先 blur,clearActiveDecoration 会 flush
        // 挂起的防抖搜索(同步扫整段 scrollback),之后 click 才关闭,关闭取消挂起搜索的语义被抵消。
        // 关闭后焦点由 close 交还 xterm,按钮本身无需获焦。
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
      >
        {CLOSE_SEARCH_ICON}
      </IconButton>
    </div>
  );
}
