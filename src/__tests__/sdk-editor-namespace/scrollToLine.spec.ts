import { describe, expect, it, vi } from 'vitest';
import { scrollToLine } from '@/panels/Editor/scrollToLine';

function makeView() {
  return {
    state: {
      doc: {
        lines: 3,
        line: vi.fn((line: number) => ({ from: line * 10, length: 6 })),
      },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}

describe('scrollToLine', () => {
  it('T1 dispatches selection, scrolls, focuses, and returns applied', () => {
    const view = makeView();

    const result = scrollToLine(view as never, 2);

    expect(result).toBe('applied');
    expect(view.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { anchor: 20, head: 20 },
      }),
    );
    expect(view.focus).toHaveBeenCalledTimes(1);
  });

  it.each([0, 4, Number.NaN, 1.5])(
    'T2-T4 returns out-of-range for invalid line=%s',
    (line) => {
      const view = makeView();

      const result = scrollToLine(view as never, line);

      expect(result).toBe('out-of-range');
      expect(view.dispatch).not.toHaveBeenCalled();
      expect(view.focus).not.toHaveBeenCalled();
    },
  );

  it('T5 column(1 起)落到行内对应列;超出行长落在行尾;非法 / ≤1 落在行首', () => {
    const at = (column: number | undefined) => {
      const view = makeView();
      scrollToLine(view as never, 2, column);
      return view.dispatch.mock.calls[0]![0].selection.anchor;
    };
    expect(at(3)).toBe(22);
    expect(at(99)).toBe(26);
    expect(at(undefined)).toBe(20);
    expect(at(1)).toBe(20);
    expect(at(0)).toBe(20);
    expect(at(2.5)).toBe(20);
  });
});
