import { useLayoutEffect, useRef } from 'react';
import { IconButton, Input } from '@/design';
import { useT } from '@/i18n';
import { clampSearchQuery } from '@/lib/search-query';
import type { SearchApi } from './useTerminal';
import type { TerminalSearchOptions } from './terminal-search-state';

interface TerminalSearchBarProps {
  readonly searchApi: SearchApi;
  readonly onClose: () => void;
}

function toggleOption(
  options: TerminalSearchOptions,
  key: keyof TerminalSearchOptions,
): TerminalSearchOptions {
  return { ...options, [key]: !options[key] };
}

export function TerminalSearchBar({
  searchApi,
  onClose,
}: TerminalSearchBarProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const result = searchApi.result;

  // issue #38 R2: `autoFocus` 偶尔被 xterm textarea 在下一帧 refocus 抢走。
  // useLayoutEffect 在 paint 前同步 focus,raf 再补一次保险(xterm 内部
  // 的 refocus 通常发生在 keydown 的 microtask/animation frame 链路上)。
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const id = requestAnimationFrame(() => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const countText =
    result.count > 0
      ? t('panels.terminal.search.match_count', {
          n: result.index + 1,
          total: result.count,
        })
      : t('panels.terminal.search.no_match');

  return (
    <div
      // z-terminal-overlay token defined in theme.css(issue #38 R2d / topic-26
      // memory L3): xterm-host 内的浮层必须用此 token,否则 z-modal 被 dockview
      // panel stacking context 困住,xterm canvas hit-test 上去。`isolation:
      // isolate` 强建独立 stacking context 配合 token 一起用。
      className="absolute right-2 top-2 z-terminal-overlay flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 shadow"
      style={{ isolation: 'isolate' }}
      // R2c: stop mousedown propagation so dockview / xterm host's
      // mousedown handlers don't refocus xterm textarea when user clicks
      // back into the search input.
      onMouseDown={(e) => e.stopPropagation()}
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
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (event.shiftKey) {
            searchApi.prev();
          } else {
            searchApi.next();
          }
        }}
        placeholder={t('panels.terminal.search.placeholder')}
        aria-label={t('panels.terminal.search.placeholder')}
        className="w-48"
      />
      {/* a11y(A53,A41 同族):匹配计数/无匹配随输入与上下跳转动态变化,焦点在搜索框时须经
          live region(role=status/polite)播报当前匹配数/第几项。 */}
      <span
        role="status"
        className="min-w-12 text-center text-xs tabular-nums text-fg-dim"
      >
        {countText}
      </span>
      {/* a11y(A99,A97 同族):regex/case/whole-word 三 toggle 成组,用 role=group + aria-label
          命名为「搜索选项」,否则 SR 逐个聚焦只听到单开关状态不知是选项组。inline-flex gap-1
          保持与外层 gap-1 一致的视觉间距。 */}
      <div
        role="group"
        aria-label={t('panels.terminal.search.options_group')}
        className="inline-flex items-center gap-1"
      >
        <IconButton
          size="xs"
          aria-label={t('panels.terminal.search.regex')}
          title={t('panels.terminal.search.regex')}
          aria-pressed={searchApi.options.regex}
          onClick={() =>
            searchApi.setOptions(toggleOption(searchApi.options, 'regex'))
          }
        >
          .*
        </IconButton>
        <IconButton
          size="xs"
          aria-label={t('panels.terminal.search.case_sensitive')}
          title={t('panels.terminal.search.case_sensitive')}
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
          aria-label={t('panels.terminal.search.whole_word')}
          title={t('panels.terminal.search.whole_word')}
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
        aria-label={t('panels.terminal.search.previous')}
        title={t('panels.terminal.search.previous')}
        onClick={searchApi.prev}
      >
        ^
      </IconButton>
      <IconButton
        size="xs"
        aria-label={t('panels.terminal.search.next')}
        title={t('panels.terminal.search.next')}
        onClick={searchApi.next}
      >
        v
      </IconButton>
      <IconButton
        size="xs"
        aria-label={t('panels.terminal.search.close')}
        title={t('panels.terminal.search.close')}
        onClick={onClose}
      >
        x
      </IconButton>
    </div>
  );
}
