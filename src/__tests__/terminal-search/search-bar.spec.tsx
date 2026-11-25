// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    if (key === 'panels.terminal.search.match_total_other') {
      return `total ${params?.['count']}`;
    }
    return key;
  },
  translateCount: (key: string, count: number) =>
    key === 'panels.terminal.search.match_total' ? `total ${count}` : key,
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
    focusRequest: 1,
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
  it('复用输入与按钮 label 翻译结果,title/aria-label 不重复查 catalog', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/panels/Terminal/TerminalSearchBar.tsx'),
      'utf8',
    );

    expect(src).toContain('const placeholderLabel = t(');
    expect(src).toContain('const regexLabel = t(');
    expect(src).toContain('const closeLabel = t(');
    expect(src).toContain('placeholder={placeholderLabel}');
    expect(src).toContain('aria-label={placeholderLabel}');
    expect(src).toContain('aria-label={regexLabel}');
    expect(src).toContain('title={regexLabel}');
    expect(src).toContain('aria-label={closeLabel}');
    expect(src).toContain('title={closeLabel}');
  });

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

  it('S4b IME 组合中的 Enter / Escape 不跳转也不关闭;普通 Enter 照常', () => {
    const api = makeApi();
    const onClose = vi.fn();
    const { getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={api} onClose={onClose} />,
    );
    const input = getByPlaceholderText('panels.terminal.search.placeholder');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(api.next).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.next).toHaveBeenCalledTimes(1);
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

  // 真实鼠标点关闭:mousedown 默认动作把焦点移到按钮 → 输入框 blur(clearActiveDecoration 会 flush 挂起的
  // 防抖搜索,同步扫整段 scrollback)→ 之后才 click 关闭。关闭按钮须在 mousedown 阻止焦点转移,让关闭路径
  // 直接取消挂起搜索,而不是先被 blur 白跑一次。
  it('鼠标点关闭按钮不经输入框 blur(不 flush 挂起搜索),直接关闭', () => {
    const api = makeApi({ term: 'err' });
    const onClose = vi.fn();
    const { getByPlaceholderText, getByLabelText } = render(
      <TerminalSearchBar searchApi={api} onClose={onClose} />,
    );
    const input = getByPlaceholderText('panels.terminal.search.placeholder');
    expect(document.activeElement).toBe(input);
    const closeBtn = getByLabelText('panels.terminal.search.close');

    // 按浏览器默认动作模拟:mousedown 未被 preventDefault → 焦点移到按钮(input blur)
    const notPrevented = fireEvent.mouseDown(closeBtn);
    if (notPrevented) closeBtn.focus();
    fireEvent.mouseUp(closeBtn);
    fireEvent.click(closeBtn);

    expect(api.clearActiveDecoration).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 缺陷 A:搜索条已开时再按 ⌘F(焦点已离开输入框)—— 搜索条不重挂,须按 focusRequest 变化重新聚焦并全选,
  // 否则用户以为在搜索框里输入,字符与回车却进了 shell。
  it('S1b 已打开时再次 open(focusRequest 递增)→ 输入框重新获得焦点且全选已有搜索词', () => {
    const api = makeApi({ term: 'foo', focusRequest: 1 });
    const { getByPlaceholderText, rerender } = render(
      <TerminalSearchBar searchApi={api} onClose={vi.fn()} />,
    );
    const input = getByPlaceholderText(
      'panels.terminal.search.placeholder',
    ) as HTMLInputElement;
    input.blur();
    expect(document.activeElement).not.toBe(input);

    rerender(
      <TerminalSearchBar searchApi={{ ...api, focusRequest: 2 }} onClose={vi.fn()} />,
    );

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  // 缺陷 B:SearchAddon 只收集前 TERMINAL_SEARCH_HIGHLIGHT_LIMIT 个结果;当前匹配不在其中时 resultIndex=-1,
  // 不能显示成「0 / 1000」。达上限时总数显示「1000+」,序号未知时只显示总数。
  it('S2b 达上限显示「1000+」;resultIndex=-1 时不显示序号', () => {
    const { getByRole, rerender } = render(
      <TerminalSearchBar
        searchApi={makeApi({ result: { index: -1, count: 1000 } })}
        onClose={vi.fn()}
      />,
    );
    expect(getByRole('status').textContent).toBe('total 1000+');

    rerender(
      <TerminalSearchBar
        searchApi={makeApi({ result: { index: 4, count: 1000 } })}
        onClose={vi.fn()}
      />,
    );
    expect(getByRole('status').textContent).toBe('5 / 1000+');

    rerender(
      <TerminalSearchBar
        searchApi={makeApi({ result: { index: -1, count: 20 } })}
        onClose={vi.fn()}
      />,
    );
    expect(getByRole('status').textContent).toBe('total 20');

    rerender(
      <TerminalSearchBar
        searchApi={makeApi({ result: { index: 2, count: 20 } })}
        onClose={vi.fn()}
      />,
    );
    expect(getByRole('status').textContent).toBe('3 / 20');
  });

  // 缺陷 C:点击选项 / 上下按钮后焦点落在按钮上,Esc 也须关闭搜索条(处理挂在搜索条根节点)。
  it('S6b 焦点在选项 / 跳转按钮上时 Escape 也关闭', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <TerminalSearchBar searchApi={makeApi()} onClose={onClose} />,
    );
    for (const label of [
      'panels.terminal.search.regex',
      'panels.terminal.search.next',
    ]) {
      const btn = getByLabelText(label);
      btn.focus();
      fireEvent.keyDown(btn, { key: 'Escape' });
    }
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('S6c Escape 只关闭一次(输入框内 Esc 冒泡到根节点不重复关闭)', () => {
    const onClose = vi.fn();
    const { getByPlaceholderText } = render(
      <TerminalSearchBar searchApi={makeApi()} onClose={onClose} />,
    );
    fireEvent.keyDown(getByPlaceholderText('panels.terminal.search.placeholder'), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalSearchBar 导航 / 关闭按钮图标', () => {
  // 上一个 / 下一个 / 关闭此前是 ASCII「^ v x」:字形大小与基线和 .* / Aa / W 不齐。改为 SVG 图标(aria-hidden),
  // 按钮可访问名仍由 aria-label 提供。
  it.each([
    ['panels.terminal.search.previous', 'M4 10l4-4 4 4'],
    ['panels.terminal.search.next', 'M4 6l4 4 4-4'],
    ['panels.terminal.search.close', 'M4.5 4.5l7 7M11.5 4.5l-7 7'],
  ])('%s 按钮渲染 SVG 图标,无 ASCII 字符', (label, d) => {
    const { getByLabelText } = render(
      <TerminalSearchBar searchApi={makeApi()} onClose={vi.fn()} />,
    );
    const btn = getByLabelText(label);
    expect(btn.classList.contains('wm-icon-button')).toBe(true);
    expect(btn.textContent).toBe('');
    const svg = btn.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(d);
  });
});
