import { describe, expect, it, vi } from 'vitest';
import {
  filterByOwnerWindow,
  type FilterDropOpts,
  type TerminalSession,
} from '../../stores/terminal.store';

function session(
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
    ...overrides,
  };
}

describe('dock-reconciler-windowid-filter: runtime guard', () => {
  it("T16 输入含 null payload -> 不抛 + onDrop('not-object') 一次", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    expect(() => filterByOwnerWindow([null], 1, { onDrop })).not.toThrow();
    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(undefined, 'not-object');
  });

  it("T17 输入含 non-object(number/string) -> 不抛 + onDrop('not-object')", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    expect(() =>
      filterByOwnerWindow([42, 'string'], 1, { onDrop }),
    ).not.toThrow();
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop).toHaveBeenNthCalledWith(1, undefined, 'not-object');
    expect(onDrop).toHaveBeenNthCalledWith(2, undefined, 'not-object');
  });

  it("T18 shape-invalid 多 case: id non-string / createdAt non-number / exitCode undefined / originHint invalid / cwd 缺失", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const invalid = [
      { ...session('A'), id: 123 },
      { ...session('B'), createdAt: 'now' },
      { ...session('C'), exitCode: undefined },
      { ...session('D'), originHint: 'invalid' },
      { ...session('E'), cwd: undefined },
    ];
    expect(filterByOwnerWindow(invalid, 1, { onDrop })).toEqual([]);
    expect(onDrop).toHaveBeenCalledTimes(5);
    expect(onDrop).toHaveBeenNthCalledWith(1, undefined, 'shape-invalid');
    expect(onDrop).toHaveBeenNthCalledWith(2, 'B', 'shape-invalid');
    expect(onDrop).toHaveBeenNthCalledWith(3, 'C', 'shape-invalid');
    expect(onDrop).toHaveBeenNthCalledWith(4, 'D', 'shape-invalid');
    expect(onDrop).toHaveBeenNthCalledWith(5, 'E', 'shape-invalid');
  });
});
