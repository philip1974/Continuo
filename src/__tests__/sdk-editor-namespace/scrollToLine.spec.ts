import { describe, expect, it, vi } from 'vitest';
import { scrollToLine } from '@/panels/Editor/scrollToLine';

function makeView() {
  return {
    state: {
      doc: {
        lines: 3,
        line: vi.fn((line: number) => ({ from: line * 10 })),
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
});

