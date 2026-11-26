import { useEffect, useLayoutEffect, useRef } from 'react';
import { IconButton, Input } from '@/design';
import { translateCount, useT } from '@/i18n';
import { clampSearchQuery, regexSyntaxError } from '@/lib/search-query';
import { matchFindOptionHotkey } from '@/lib/find-options';
import { FindOptionToggles } from '@/lib/FindOptionToggles';
import { isImeComposing } from '@/design/ime';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from '@/lib/ui-icons';
import type { FindHistory } from '@/panels/Editor/find-widget-model';
import type { SearchApi } from './useTerminal';
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  type TerminalSearchOptions,
  type TerminalSearchResult,
} from './terminal-search-state';

interface TerminalSearchBarProps {
  readonly searchApi: SearchApi;
  readonly onClose: () => void;
  /** 计数文案(缺省为终端文案);Markdown 查找复用本查找条时传编辑器查找控件的文案(find-widget-model)。 */
  readonly formatResult?: (result: TerminalSearchResult) => string;
  /** 输入框标签与占位文案(缺省为终端的「搜索」);编辑器场景传「查找」,与代码编辑器查找面板一致。 */
  readonly label?: string;
  /**
   * 查找框 ↑ / ↓ 历史(VSCode 查找框历史;Markdown 查找传与代码编辑器共享的 editorFindHistory)。缺省不启用 ——
   * 终端保持现状。回车与查找条卸载(关闭)时把当前词记入。
   */
  readonly history?: FindHistory;
  /**
   * Enter 向上(更早的输出)找、⇧Enter 向下(VSCode 终端查找:findPrevious 绑 Enter、findNext 绑 ⇧Enter —— 输入时已从底部
   * 向上落在最近的匹配,Enter 继续往更早处找,不绕回缓冲顶部)。缺省 false:Enter 向下(编辑器查找)。
   */
  readonly enterFindsPrevious?: boolean;
}

// 上一个 / 下一个 / 关闭用 SVG 图标(此前是 ASCII「^ v x」,字形大小 / 基线与 Aa / ab / .* 不齐)。模块级预创建。
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
  formatResult,
  label,
  history,
  enterFindsPrevious = false,
}: TerminalSearchBarProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const result = searchApi.result;
  const placeholderLabel = label ?? t('panels.terminal.search.placeholder');
  const previousLabel = t('panels.terminal.search.previous');
  const nextLabel = t('panels.terminal.search.next');
  const closeLabel = t('panels.terminal.search.close');

  // issue #38 R2: `autoFocus` 偶尔被 xterm textarea 在下一帧 refocus 抢走。
  // useLayoutEffect 在 paint 前同步 focus,raf 再补一次保险(xterm 内部
  // 的 refocus 通常发生在 keydown 的 microtask/animation frame 链路上)。
  // 依赖 focusRequest:已打开时再按 ⌘F 搜索条不重挂,靠它重新聚焦并全选已有词(VSCode 行为),
  // 否则焦点留在终端,输入与回车进 shell。
  // focusRequest = 0:不是用户打开(切回 tab 时恢复显示),不抢焦点(VSCode 恢复编辑器时焦点在正文)。
  const focusRequest = searchApi.focusRequest;
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || focusRequest === 0) return;
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
  // 历史:挂载时从最新开始翻;卸载(关闭 / 切走)时记入当前词(同代码编辑器查找面板)。
  const termRef = useRef(searchApi.term);
  termRef.current = searchApi.term;
  useEffect(() => {
    if (!history) return;
    history.resetCursor();
    return () => history.add(termRef.current);
  }, [history]);

  // 非法正则(VSCode 查找框弹出正则错误):计数区提示「正则表达式无效」,错误信息作 title(悬停可见,也是输入框的
  // 可访问描述)。按不带 flag 的语法校验 —— 终端(xterm SearchAddon)与 Markdown 查找(buildFindRegExp)最终都按它编译。
  const regexError = searchApi.options.regex && searchApi.term ? regexSyntaxError(searchApi.term) : null;
  const countText = regexError
    ? t('editor.find.invalid_regex')
    : formatResult
      ? formatResult(result)
      : formatCount(result, t);

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
      // 选项切换键 ⌥⌘C / ⌥⌘W / ⌥⌘R(Windows / Linux Alt+C / W / R)同样挂在根节点(VSCode 查找框内生效)。
      // IME 组合中的按键属于输入法(Esc 取消组合),不处理。
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        const option = event.key === 'Escape' ? null : matchFindOptionHotkey(event.nativeEvent);
        if (option) {
          event.preventDefault();
          searchApi.setOptions(toggleOption(searchApi.options, option));
          return;
        }
        if (event.key !== 'Escape') return;
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
        onChange={(event) => {
          history?.resetCursor();
          searchApi.setTerm(clampSearchQuery(event.target.value));
        }}
        onKeyDown={(event) => {
          // IME 组合中的 Enter / 方向键属于输入法(确认候选 / 选候选),不跳转、不翻历史。Esc 由根节点统一处理。
          if (isImeComposing(event.nativeEvent)) return;
          if (
            history &&
            (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
            !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
          ) {
            event.preventDefault();
            const term = event.key === 'ArrowUp' ? history.previous(searchApi.term) : history.next();
            if (term !== undefined) searchApi.setTerm(term);
            return;
          }
          if (event.key !== 'Enter') return;
          event.preventDefault();
          history?.add(searchApi.term);
          if (event.shiftKey !== enterFindsPrevious) {
            searchApi.prev();
          } else {
            searchApi.next();
          }
        }}
        placeholder={placeholderLabel}
        aria-label={placeholderLabel}
        aria-invalid={regexError ? true : undefined}
        title={regexError ?? undefined}
        className="w-48 min-w-16"
      />
      {/* a11y(A53,A41 同族):匹配计数/无匹配随输入与上下跳转动态变化,焦点在搜索框时须经
          live region(role=status/polite)播报当前匹配数/第几项。 */}
      <span
        role="status"
        title={regexError ?? undefined}
        className={`min-w-12 shrink-0 text-center text-xs tabular-nums ${regexError ? 'text-error' : 'text-fg-dim'} @max-sm/terminal:sr-only @max-sm/terminal:min-w-0`}
      >
        {countText}
      </span>
      {/* 选项 toggle 组(Aa / ab / .*,role=group「搜索选项」)与在文件中查找视图共用同一组件,顺序 / 字形 / 样式一致。 */}
      <FindOptionToggles
        values={searchApi.options}
        onToggle={(option) => searchApi.setOptions(toggleOption(searchApi.options, option))}
        className="@max-xs/terminal:hidden"
      />
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
