// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSearchBar } from '@/panels/Terminal/TerminalSearchBar';
import type { SearchApi } from '@/panels/Terminal/useTerminal';
import { MAX_SEARCH_QUERY_LEN } from '@/lib/search-query';

vi.mock('@/panels/Terminal/useTerminal', async () => {
  const actual =
    await vi.importActual<typeof import('@/panels/Terminal/useTerminal')>(
      '@/panels/Terminal/useTerminal',
    );
  return {
    ...actual,
    useTerminal: vi.fn(),
  };
});

vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => {
    if (key === 'panels.terminal.search.match_count') {
      return `${params?.['n']} / ${params?.['total']}`;
    }
    return key;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeApi(overrides: Partial<SearchApi> = {}): SearchApi {
  return {
    isOpen: true,
    term: '',
    options: { regex: false, caseSensitive: false, wholeWord: false },
    result: { index: -1, count: 0 },
    open: vi.fn(),
    close: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    setTerm: vi.fn(),
    setOptions: vi.fn(),
    clearActiveDecoration: vi.fn(),
    ...overrides,
  };
}

describe('TerminalSearchBar UI', () => {
  it('S1 renders focused search input with no-match state', () => {
    const api = makeApi();
    const { getByPlaceholderText, getByText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );

    const input = getByPlaceholderText(
      'panels.terminal.search.placeholder',
    ) as HTMLInputElement;
    expect(input).toBe(document.activeElement);
    expect(getByText('panels.terminal.search.no_match')).toBeTruthy();
  });

  it('S2 typing a query calls setTerm and match count reflects props', () => {
    const api = makeApi({ result: { index: 1, count: 4 }, term: 'error' });
    const { getByPlaceholderText, getByText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );

    fireEvent.change(getByPlaceholderText('panels.terminal.search.placeholder'), {
      target: { value: 'warn' },
    });

    expect(api.setTerm).toHaveBeenCalledWith('warn');
    expect(getByText('2 / 4')).toBeTruthy();
    // a11y(A53):匹配计数须在 live region(role=status)播报,焦点在搜索框时也能听到。
    const count = getByText('2 / 4');
    expect(count.closest('[role=status]')).not.toBeNull();
  });

  it('S3 empty query is forwarded to the state machine', () => {
    const api = makeApi({ term: 'abc' });
    const { getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );

    fireEvent.change(getByPlaceholderText('panels.terminal.search.placeholder'), {
      target: { value: '' },
    });

    expect(api.setTerm).toHaveBeenCalledWith('');
  });

  it('S4 Enter navigates next and Shift+Enter navigates previous', () => {
    const api = makeApi();
    const { getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );
    const input = getByPlaceholderText('panels.terminal.search.placeholder');

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(api.next).toHaveBeenCalledTimes(1);
    expect(api.prev).toHaveBeenCalledTimes(1);
  });

  it('S5 option toggles request updated options', () => {
    const api = makeApi();
    const { getByLabelText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );

    fireEvent.click(getByLabelText('panels.terminal.search.regex'));
    fireEvent.click(getByLabelText('panels.terminal.search.case_sensitive'));
    fireEvent.click(getByLabelText('panels.terminal.search.whole_word'));

    expect(api.setOptions).toHaveBeenNthCalledWith(1, {
      regex: true,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(api.setOptions).toHaveBeenNthCalledWith(2, {
      regex: false,
      caseSensitive: true,
      wholeWord: false,
    });
    expect(api.setOptions).toHaveBeenNthCalledWith(3, {
      regex: false,
      caseSensitive: false,
      wholeWord: true,
    });
  });

  // a11y(A99,A97 同族):regex/case/whole-word 三 toggle 成组,须 role=group + 组名(aria-label)。
  it('S8 a11y · 搜索选项三 toggle 在 role=group 内且组有可访问名', () => {
    const api = makeApi();
    const { container, getByLabelText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );
    const group = container.querySelector('[role=group][aria-label]');
    expect(group).not.toBeNull();
    expect((group!.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    // 三个选项 toggle 都在该组内
    expect(group!.contains(getByLabelText('panels.terminal.search.regex'))).toBe(true);
    expect(
      group!.contains(getByLabelText('panels.terminal.search.case_sensitive')),
    ).toBe(true);
    expect(group!.contains(getByLabelText('panels.terminal.search.whole_word'))).toBe(
      true,
    );
    expect(group!.querySelectorAll('button[aria-pressed]').length).toBe(3);
  });

  it('S6 Escape and close button call onClose', () => {
    const onClose = vi.fn();
    const { getByLabelText, getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={makeApi()} onClose={onClose} />,
    );

    fireEvent.keyDown(getByPlaceholderText('panels.terminal.search.placeholder'), {
      key: 'Escape',
    });
    fireEvent.click(getByLabelText('panels.terminal.search.close'));

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('S7 input blur clears only the active decoration', () => {
    const api = makeApi();
    const { getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );

    fireEvent.blur(getByPlaceholderText('panels.terminal.search.placeholder'));

    expect(api.clearActiveDecoration).toHaveBeenCalledTimes(1);
  });

  // 边界(E280,E279 同族):超长 query 截断到 MAX_SEARCH_QUERY_LEN 再进 setTerm → xterm SearchAddon
  // (防超长 pattern × scrollback 同步放大;regex 模式更甚)。
  it('E280 超长 query 截断后才进 setTerm', () => {
    const api = makeApi();
    const { getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );
    fireEvent.change(getByPlaceholderText('panels.terminal.search.placeholder'), {
      target: { value: 'x'.repeat(MAX_SEARCH_QUERY_LEN + 5000) },
    });
    const passed = (api.setTerm as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(passed.length).toBe(MAX_SEARCH_QUERY_LEN);
  });
});
