// @vitest-environment jsdom
// 重构守卫:CommandPalette / QuickOpen 共享的 picker 切片与列表 hook(行为契约 + 接线)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { create } from 'zustand';

const { scrollToIndexSpy, windowSize } = vi.hoisted(() => ({
  scrollToIndexSpy: vi.fn(),
  windowSize: { value: 3 },
}));
// 固定窗口(index 0..windowSize-1):证明 hook 只对渲染窗口内的选中项给 aria-activedescendant。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => opts.count * opts.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: Math.min(windowSize.value, opts.count) }, (_, i) => ({
        index: i,
        start: i * opts.estimateSize(),
        size: opts.estimateSize(),
        key: i,
      })),
    scrollToIndex: scrollToIndexSpy,
  }),
}));

import { createPickerSlice, type PickerSlice } from '../../plugins/picker/picker-slice';
import { isVirtualIndexRendered, usePickerList } from '../../plugins/picker/use-picker-list';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useCommandPaletteHotkey } from '../../plugins/command-palette/useCommandPaletteHotkey';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';
import { MAX_SEARCH_QUERY_LEN } from '../../lib/search-query';

afterEach(() => cleanup());

describe('createPickerSlice', () => {
  const makeStore = () => create<PickerSlice>((set) => createPickerSlice(set));

  it('open 重置 query / 选中行;close 只关闭', () => {
    const store = makeStore();
    store.setState({ query: 'abc', selectedIndex: 4 });
    store.getState().open();
    expect(store.getState()).toMatchObject({ isOpen: true, query: '', selectedIndex: 0 });
    store.getState().setQuery('x');
    store.getState().close();
    expect(store.getState()).toMatchObject({ isOpen: false, query: 'x' });
  });

  it('setQuery 截断超长 query 并把选中行归 0', () => {
    const store = makeStore();
    store.setState({ selectedIndex: 3 });
    store.getState().setQuery('a'.repeat(MAX_SEARCH_QUERY_LEN + 50));
    expect(store.getState().query.length).toBe(MAX_SEARCH_QUERY_LEN);
    expect(store.getState().selectedIndex).toBe(0);
  });

  it('moveSelection 循环;max<=0 归 0', () => {
    const store = makeStore();
    store.getState().moveSelection(-1, 3);
    expect(store.getState().selectedIndex).toBe(2);
    store.getState().moveSelection(1, 3);
    expect(store.getState().selectedIndex).toBe(0);
    store.setState({ selectedIndex: 2 });
    store.getState().moveSelection(1, 0);
    expect(store.getState().selectedIndex).toBe(0);
  });

  it('clampSelection 钳到 [0, len-1]', () => {
    const store = makeStore();
    store.setState({ selectedIndex: 9 });
    store.getState().clampSelection(4);
    expect(store.getState().selectedIndex).toBe(3);
    store.getState().clampSelection(0);
    expect(store.getState().selectedIndex).toBe(0);
  });

  it('无变化时不通知订阅者', () => {
    const store = makeStore();
    store.getState().open();
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().open();
    store.getState().setQuery('');
    store.getState().moveSelection(1, 1);
    store.getState().clampSelection(5);
    expect(listener).not.toHaveBeenCalled();
    store.getState().close();
    store.getState().close();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('两个真实 store 都暴露切片的全部 action', () => {
    for (const state of [useCommandPaletteStore.getState(), useQuickOpenStore.getState()]) {
      for (const k of ['open', 'close', 'setQuery', 'moveSelection', 'clampSelection'] as const) {
        expect(state[k]).toBeTypeOf('function');
      }
    }
  });
});

interface HarnessProps {
  count: number;
  selectedIndex: number;
  moveSelection?: (delta: number, max: number) => void;
  clampSelection?: (len: number) => void;
  onEnter?: (index: number) => void;
}

const noop = (): void => {};

function Harness(props: HarnessProps) {
  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'demo',
    count: props.count,
    selectedIndex: props.selectedIndex,
    rowHeight: 20,
    overscan: 2,
    moveSelection: props.moveSelection ?? noop,
    clampSelection: props.clampSelection ?? noop,
    onEnter: props.onEnter ?? noop,
  });
  return (
    <div>
      {/* 测试夹具:原生 input 仅用于承接 combobox props,不是产品 UI。 */}
      <input data-testid="input" {...comboboxProps} />
      <div ref={scrollRef}>
        {props.count > 0 && (
          <ul {...listboxProps}>
            {virtualItems.map((row) => (
              <li key={row.key} {...getOptionProps(row)}>
                row {row.index}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

describe('usePickerList', () => {
  beforeEach(() => {
    scrollToIndexSpy.mockClear();
    windowSize.value = 3;
  });

  it('combobox / listbox / option 的 ARIA 接线', () => {
    const { getByTestId, getByRole, getAllByRole } = render(<Harness count={10} selectedIndex={1} />);
    const input = getByTestId('input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('demo-listbox');
    expect(input.getAttribute('aria-activedescendant')).toBe('demo-option-1');

    const listbox = getByRole('listbox');
    expect(listbox.id).toBe('demo-listbox');
    expect(listbox.style.height).toBe('200px');
    expect(listbox.style.position).toBe('relative');

    const options = getAllByRole('option');
    expect(options.map((o) => o.id)).toEqual(['demo-option-0', 'demo-option-1', 'demo-option-2']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(options[1]!.style.transform).toBe('translateY(20px)');
    expect(options[1]!.style.position).toBe('absolute');
  });

  it('无结果:不设 aria-controls / aria-activedescendant,expanded 仍 true(A100/A101)', () => {
    const { getByTestId } = render(<Harness count={0} selectedIndex={0} />);
    const input = getByTestId('input');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.hasAttribute('aria-controls')).toBe(false);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('选中项越界或不在渲染窗口内:不设 aria-activedescendant(A111/A112)', () => {
    const outOfWindow = render(<Harness count={10} selectedIndex={7} />);
    expect(outOfWindow.getByTestId('input').hasAttribute('aria-activedescendant')).toBe(false);
    outOfWindow.unmount();
    const outOfRange = render(<Harness count={2} selectedIndex={5} />);
    expect(outOfRange.getByTestId('input').hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('键盘:上下键移动、Enter 触发,其余键不拦', () => {
    const moveSelection = vi.fn();
    const onEnter = vi.fn();
    const { getByTestId } = render(
      <Harness count={5} selectedIndex={2} moveSelection={moveSelection} onEnter={onEnter} />,
    );
    const input = getByTestId('input');
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(false); // preventDefault
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(false);
    expect(moveSelection.mock.calls).toEqual([
      [1, 5],
      [-1, 5],
    ]);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(onEnter).toHaveBeenCalledWith(2);
    expect(fireEvent.keyDown(input, { key: 'a' })).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('IME 组合中的 Enter / 方向键(isComposing 或 keyCode 229)→ 不执行、不移动、不拦默认;普通 Enter 照常', () => {
    const moveSelection = vi.fn();
    const onEnter = vi.fn();
    const { getByTestId } = render(
      <Harness count={5} selectedIndex={2} moveSelection={moveSelection} onEnter={onEnter} />,
    );
    const input = getByTestId('input');
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })).toBe(true);
    expect(onEnter).not.toHaveBeenCalled();
    expect(moveSelection).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledWith(2);
  });

  it('count 变化 → clampSelection;selectedIndex 变化 → scrollToIndex(空列表不滚)', () => {
    const clampSelection = vi.fn();
    const { rerender } = render(
      <Harness count={10} selectedIndex={0} clampSelection={clampSelection} />,
    );
    expect(clampSelection).toHaveBeenLastCalledWith(10);
    expect(scrollToIndexSpy).toHaveBeenLastCalledWith(0);

    rerender(<Harness count={10} selectedIndex={4} clampSelection={clampSelection} />);
    expect(scrollToIndexSpy).toHaveBeenLastCalledWith(4);

    rerender(<Harness count={3} selectedIndex={4} clampSelection={clampSelection} />);
    expect(clampSelection).toHaveBeenLastCalledWith(3);

    scrollToIndexSpy.mockClear();
    rerender(<Harness count={0} selectedIndex={0} clampSelection={clampSelection} />);
    expect(clampSelection).toHaveBeenLastCalledWith(0);
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
  });

  it('isVirtualIndexRendered 单趟判断', () => {
    const rows = [{ index: 0 }, { index: 1 }];
    expect(isVirtualIndexRendered(rows, 1)).toBe(true);
    expect(isVirtualIndexRendered(rows, 3)).toBe(false);
  });
});

describe('两个 picker 互斥(Quick Open ⇄ 命令面板)', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
  function BothHotkeys() {
    useQuickOpenHotkey();
    useCommandPaletteHotkey();
    return null;
  }
  const press = (shiftKey: boolean): void => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: shiftKey ? 'P' : 'p', metaKey: true, shiftKey }),
    );
  };

  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    useQuickOpenStore.getState().close();
    useCommandPaletteStore.getState().close();
  });
  afterEach(() => {
    if (origPlatform) Object.defineProperty(navigator, 'platform', origPlatform);
  });

  it('Quick Open 开着按 ⌘⇧P → 切到命令面板(Quick Open 关闭)', () => {
    render(<BothHotkeys />);
    press(false);
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    press(true);
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
  });

  it('命令面板开着按 ⌘P → 切到 Quick Open(命令面板关闭)', () => {
    render(<BothHotkeys />);
    press(true);
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    press(false);
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('同一热键再按仍是 toggle 关闭自身,不影响另一个', () => {
    render(<BothHotkeys />);
    press(false);
    press(false);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });
});

describe('接线守卫:两个 picker 走共享实现', () => {
  const read = (rel: string): string =>
    readFileSync(join(__dirname, '..', '..', 'plugins', rel), 'utf-8');

  it.each(['command-palette/store.ts', 'quick-open/store.ts'])('%s 用 createPickerSlice', (rel) => {
    const src = read(rel);
    expect(src).toContain('createPickerSlice(set)');
    expect(src).not.toMatch(/moveSelection: \(delta, max\) =>/);
  });

  it.each(['command-palette/CommandPalette.tsx', 'quick-open/QuickOpenModal.tsx'])(
    '%s 用 usePickerList,不直接 useVirtualizer',
    (rel) => {
      const src = read(rel);
      expect(src).toContain('usePickerList({');
      expect(src).not.toContain('useVirtualizer');
      expect(src).not.toContain('aria-activedescendant=');
    },
  );
});

// 选中行样式(两个 picker 共用 pickerRowClassName):弹窗内容区背景是 --md-surface-container-high(= bg-hover),
// 选中行若用 bg-hover 与背景计算值完全相同、看不出选中。改为 accent 低透明度底 + 左侧 accent 竖条,竖条对弹窗
// 背景在两主题下都 ≥ 3:1(WCAG 1.4.11 非文本对比)。
describe('picker 选中行可辨识', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8');
  const block = (css: string, sel: ':root' | '.dark'): string =>
    css.match(new RegExp(`${sel === ':root' ? ':root' : '\\.dark'}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  const hex = (b: string, name: string): string =>
    b.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1] ?? '';
  const lum = (h: string): number => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('选中行:不用 bg-hover,带 accent 左竖条;未选中行占同宽透明边(不跳动)', async () => {
    const { pickerRowClassName } = await import('../../plugins/picker/picker-row');
    const selected = pickerRowClassName(true);
    const idle = pickerRowClassName(false);
    expect(selected).not.toMatch(/(^|\s)bg-hover(\s|$)/);
    expect(selected).toContain('border-accent');
    expect(selected).toContain('border-l-2');
    expect(idle).toContain('border-l-2');
    expect(idle).toContain('border-transparent');
    expect(idle).not.toMatch(/hover:bg-hover/);
  });

  it('竖条颜色(--md-primary)对弹窗背景(Modal 的 --md-surface-container-high)两主题均 ≥ 3:1', () => {
    expect(read('design/Modal.css')).toMatch(
      /\.wm-modal-content\s*\{[^}]*background-color:\s*var\(--md-surface-container-high\)/,
    );
    const tokens = read('styles/design-tokens.css');
    for (const sel of [':root', '.dark'] as const) {
      const b = block(tokens, sel);
      const ratio = contrast(hex(b, '--md-primary'), hex(b, '--md-surface-container-high'));
      expect(ratio, sel).toBeGreaterThanOrEqual(3);
    }
  });

  // 行内次要文字(命令分类前缀 / 文件相对路径)叠在 accent 半透明底上:按 token 实值把 accent 以行底透明度
  // 合成到弹窗背景上(sRGB 线性混合近似 Tailwind 的 color-mix),次要文字对合成底两主题均须 ≥ 4.5(WCAG 1.4.3)。
  describe('选中 / 悬停行上的次要文字 ≥ 4.5', () => {
    const TOKEN_OF_TEXT_CLASS: Record<string, string> = {
      'text-fg': '--md-on-surface',
      'text-fg-muted': '--md-on-surface-variant',
      'text-fg-dim': '--md-fg-dim',
    };
    const mix = (fg: string, bg: string, alpha: number): string =>
      '#' +
      [1, 3, 5]
        .map((i) => {
          const f = parseInt(fg.slice(i, i + 2), 16);
          const b = parseInt(bg.slice(i, i + 2), 16);
          return Math.round(alpha * f + (1 - alpha) * b)
            .toString(16)
            .padStart(2, '0');
        })
        .join('');
    const tokenHex = (sel: ':root' | '.dark', name: string): string =>
      hex(block(read('styles/design-tokens.css'), sel), name) ||
      hex(block(read('styles/theme.css'), sel), name);
    const textToken = (cls: string, variant: '' | 'hover:' | 'group-hover:'): string => {
      const m = cls
        .split(/\s+/)
        .map((c) => (variant ? (c.startsWith(variant) ? c.slice(variant.length) : '') : c.includes(':') ? '' : c))
        .find((c) => c in TOKEN_OF_TEXT_CLASS);
      return m ? TOKEN_OF_TEXT_CLASS[m]! : '';
    };
    const alphaOf = (cls: string, variant: '' | 'hover:'): number => {
      const m = cls.match(new RegExp(`(?:^|\\s)${variant}bg-accent/(\\d+)(?:\\s|$)`));
      return m ? Number(m[1]) / 100 : NaN;
    };

    it('选中行:次要文字对 accent 底(合成)两主题 ≥ 4.5;竖条对合成底仍 ≥ 3', async () => {
      const { pickerRowClassName, pickerRowSecondaryClassName } = await import(
        '../../plugins/picker/picker-row'
      );
      const alpha = alphaOf(pickerRowClassName(true), '');
      expect(alpha).toBeGreaterThan(0);
      const token = textToken(pickerRowSecondaryClassName(true), '');
      expect(token).not.toBe('');
      for (const sel of [':root', '.dark'] as const) {
        const bg = mix(tokenHex(sel, '--md-primary'), tokenHex(sel, '--md-surface-container-high'), alpha);
        expect(contrast(tokenHex(sel, token), bg), `${sel} ${token}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokenHex(sel, '--md-primary'), bg), `${sel} bar`).toBeGreaterThanOrEqual(3);
      }
    });

    it('未选中行:常态次要文字对弹窗背景 ≥ 4.5;悬停时次要文字对 accent 悬停底(合成)≥ 4.5', async () => {
      const { pickerRowClassName, pickerRowSecondaryClassName } = await import(
        '../../plugins/picker/picker-row'
      );
      const row = pickerRowClassName(false);
      const alpha = alphaOf(row, 'hover:');
      expect(alpha).toBeGreaterThan(0);
      const secondary = pickerRowSecondaryClassName(false);
      const idleToken = textToken(secondary, '');
      // 悬停态:行带 group 时取 group-hover: 变体,否则沿用常态色
      const hoverToken =
        (/(^|\s)group(\s|$)/.test(row) && textToken(secondary, 'group-hover:')) || idleToken;
      expect(idleToken).not.toBe('');
      for (const sel of [':root', '.dark'] as const) {
        const panel = tokenHex(sel, '--md-surface-container-high');
        const hoverBg = mix(tokenHex(sel, '--md-primary'), panel, alpha);
        expect(contrast(tokenHex(sel, idleToken), panel), `${sel} idle`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokenHex(sel, hoverToken), hoverBg), `${sel} hover`).toBeGreaterThanOrEqual(4.5);
      }
    });

    // 命中字符(<mark>,VSCode list.highlightForeground):匹配色对弹窗底、选中行、悬停行(合成)两主题均 ≥ 4.5;背景透明。
    it('命中字符:text-list-highlight 对弹窗底 / 选中 / 悬停行两主题 ≥ 4.5,背景透明、加粗', async () => {
      const { PICKER_MATCH_CLASS_NAME, pickerRowClassName } = await import('../../plugins/picker/picker-row');
      const cls = PICKER_MATCH_CLASS_NAME.split(' ');
      expect(cls).toContain('bg-transparent');
      expect(cls).toContain('font-semibold');
      expect(cls).toContain('text-list-highlight');
      expect(read('styles/theme.css')).toMatch(/--color-list-highlight:\s*var\(--md-list-highlight\)/);
      const selAlpha = alphaOf(pickerRowClassName(true), '');
      const hoverAlpha = alphaOf(pickerRowClassName(false), 'hover:');
      for (const sel of [':root', '.dark'] as const) {
        const panel = tokenHex(sel, '--md-surface-container-high');
        const fg = tokenHex(sel, '--md-list-highlight');
        expect(fg, sel).not.toBe('');
        for (const [state, bg] of [
          ['idle', panel],
          ['selected', mix(tokenHex(sel, '--md-primary'), panel, selAlpha)],
          ['hover', mix(tokenHex(sel, '--md-primary'), panel, hoverAlpha)],
        ] as const) {
          expect(contrast(fg, bg), `${sel} ${state}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it.each(['plugins/command-palette/CommandPalette.tsx', 'plugins/quick-open/QuickOpenModal.tsx'])(
      '%s 的行内次要文字走 pickerRowSecondaryClassName,不在行内写死 text-fg-dim',
      (rel) => {
        const src = read(rel);
        expect(src).toContain('pickerRowSecondaryClassName(');
        const listStart = src.indexOf('virtualItems.map(');
        const rowBody = src.slice(listStart, src.indexOf('</li>', listStart));
        expect(rowBody).not.toContain('text-fg-dim');
      },
    );
  });

  it.each(['plugins/command-palette/CommandPalette.tsx', 'plugins/quick-open/QuickOpenModal.tsx'])(
    '%s 的行样式走共享 pickerRowClassName',
    (rel) => {
      const src = read(rel);
      expect(src).toContain('pickerRowClassName(');
      expect(src).not.toMatch(/bg-hover text-fg/);
    },
  );
});
