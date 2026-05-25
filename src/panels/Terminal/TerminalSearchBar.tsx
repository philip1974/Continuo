import { useLayoutEffect, useRef } from 'react';
import { IconButton, Input } from '@/design';
import { useT } from '@/i18n';
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
      className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 shadow"
      // issue #38 R2d: xterm-link-layer canvas hit-tests above z-modal (50)
      // because z-modal is trapped inside the dockview panel's stacking
      // context together with xterm's internal canvases. zIndex 9999 +
      // isolation:isolate forces a clean stacking context above any xterm
      // layer. Discovered via document-level capture-phase mousedown trace
      // showing CANVAS xterm-link-layer received the click instead of INPUT.
      style={{ zIndex: 9999, isolation: 'isolate' }}
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
        onChange={(event) => searchApi.setTerm(event.target.value)}
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
      <span className="min-w-12 text-center text-xs tabular-nums text-fg-dim">
        {countText}
      </span>
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
