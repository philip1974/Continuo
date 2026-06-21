import { describe, expect, it, vi } from 'vitest';
import {
  filterByOwnerWindow,
  type FilterDropOpts,
} from '../../stores/terminal.store';
import { makeSession } from './fixtures';

describe('dock-reconciler-windowid-filter: filterByOwnerWindow pure fn', () => {
  it('T1 空数组 -> 空', () => {
    expect(filterByOwnerWindow([], 1)).toEqual([]);
  });

  it('T2 [A:o1] wid=1 -> [A]', () => {
    const a = makeSession('A');
    expect(filterByOwnerWindow([a], 1)).toEqual([a]);
  });

  it('T3 [A:o1, B:o2] wid=1 -> [A] + 顺序保留', () => {
    const a = makeSession('A');
    const b = makeSession('B', { ownerWindowId: 2 });
    const c = makeSession('C');
    expect(filterByOwnerWindow([a, b, c], 1).map((s) => s.id)).toEqual([
      'A',
      'C',
    ]);
  });

  it('T4 [A:o2, B:o2] wid=1 -> [] 全过滤', () => {
    expect(filterByOwnerWindow([makeSession('A', { ownerWindowId: 2 }), makeSession('B', { ownerWindowId: 2 })], 1)).toEqual(
      [],
    );
  });

  it("T5 [null, A:o1] wid=1 -> [A] + onDrop('not-object', undefined)", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const a = makeSession('A');
    expect(filterByOwnerWindow([null, a], 1, { onDrop })).toEqual([a]);
    expect(onDrop).toHaveBeenCalledWith(undefined, 'not-object');
  });

  it("T6 [42, 'string', A:o1] wid=1 -> [A] + onDrop('not-object', undefined) x2", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const a = makeSession('A');
    expect(filterByOwnerWindow([42, 'string', a], 1, { onDrop })).toEqual([a]);
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop).toHaveBeenNthCalledWith(1, undefined, 'not-object');
    expect(onDrop).toHaveBeenNthCalledWith(2, undefined, 'not-object');
  });

  it("T7 [{无 ownerWindowId, id:'X', ...}, A:o1] wid=1 -> [A] + onDrop('missing-owner', 'X')", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const a = makeSession('A');
    const missingOwner = { ...makeSession('X'), ownerWindowId: undefined };
    expect(filterByOwnerWindow([missingOwner, a], 1, { onDrop })).toEqual([a]);
    expect(onDrop).toHaveBeenCalledWith('X', 'missing-owner');
  });

  it("T8 [{id:'B', ownerWindowId:2, ...其他完整}, A:o1] wid=1 -> [A] + onDrop('wrong-owner', 'B')", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const a = makeSession('A');
    const b = makeSession('B', { ownerWindowId: 2 });
    expect(filterByOwnerWindow([b, a], 1, { onDrop })).toEqual([a]);
    expect(onDrop).toHaveBeenCalledWith('B', 'wrong-owner');
  });

  it("T9 [{id:'B', ownerWindowId:1, title:undefined, ...}] wid=1 -> [] + onDrop('shape-invalid', 'B')", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const invalid = { ...makeSession('B'), title: undefined };
    expect(filterByOwnerWindow([invalid], 1, { onDrop })).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith('B', 'shape-invalid');
  });

  it('T10 filterByOwnerWindow 调 console.warn spy 0 次(纯函数无 console)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    filterByOwnerWindow([null, makeSession('B', { ownerWindowId: 2 })], 1, { onDrop: vi.fn() });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // 可维护性 M16:ingress guard 现在也校验 optional 字段形态(此前只校验必填 + as unknown 强转)。
  it('T11 合法 optional 字段(scoped/attachTarget/agentLabel/workspaceRoot)→ 通过', () => {
    const s = {
      ...makeSession('A'),
      agentLabel: 'codex',
      scoped: true,
      workspaceRoot: '/repo',
      attachTarget: { kind: 'active' },
    };
    expect(filterByOwnerWindow([s], 1).map((x) => x.id)).toEqual(['A']);
  });

  it("T12 malformed optional(scoped 非 boolean / attachTarget 形态错)→ shape-invalid drop", () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const badScoped = { ...makeSession('B'), scoped: 'yes' };
    const badAttach = { ...makeSession('C'), attachTarget: { kind: 'panel' } }; // 缺 panelId
    expect(filterByOwnerWindow([badScoped, badAttach], 1, { onDrop })).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith('B', 'shape-invalid');
    expect(onDrop).toHaveBeenCalledWith('C', 'shape-invalid');
  });
});
