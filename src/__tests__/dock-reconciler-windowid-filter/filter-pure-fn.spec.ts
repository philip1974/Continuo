import { describe, expect, it, vi } from 'vitest';
import {
  filterByOwnerWindow,
  type FilterDropOpts,
} from '../../stores/terminal.store';
import { MAX_TERMINAL_SESSIONS_GLOBAL } from '../../../electron/shared/terminal-session-limits';
import { makeSession } from './fixtures';

describe('dock-reconciler-windowid-filter: filterByOwnerWindow pure fn', () => {
  it('T1 空数组 -> 稳定空引用', () => {
    const a: readonly unknown[] = [];
    const b: readonly unknown[] = [];
    const filtered = filterByOwnerWindow(a, 1);

    expect(filtered).toEqual([]);
    expect(filterByOwnerWindow(b, 1)).toBe(filtered);
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
    const empty = filterByOwnerWindow(
      [makeSession('A', { ownerWindowId: 2 }), makeSession('B', { ownerWindowId: 2 })],
      1,
    );
    expect(empty).toEqual([]);
    expect(filterByOwnerWindow([makeSession('C', { ownerWindowId: 2 })], 1)).toBe(
      empty,
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

  // 边界(E167,E23 同款 ingress 纵深防御):字符串字段镜像 create 长度上限(title/agentLabel≤512、
  // cwd/workspaceRoot≤8192),数字字段须有限/安全整数。畸形 payload → shape-invalid drop。
  it('T13 超长字符串字段(title/cwd/agentLabel/workspaceRoot)→ shape-invalid drop', () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const bigTitle = { ...makeSession('A'), title: 'x'.repeat(513) };
    const bigCwd = { ...makeSession('B'), cwd: '/'.repeat(8193) };
    const bigAgent = { ...makeSession('C'), agentLabel: 'z'.repeat(513) };
    const bigRoot = { ...makeSession('D'), workspaceRoot: 'w'.repeat(8193) };
    expect(
      filterByOwnerWindow([bigTitle, bigCwd, bigAgent, bigRoot], 1, { onDrop }),
    ).toEqual([]);
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(onDrop).toHaveBeenCalledWith(id, 'shape-invalid');
    }
  });

  it('T14 数字字段非有限/非安全整数(createdAt NaN / exitCode 小数 / ownerWindowId 负)→ shape-invalid', () => {
    const onDrop = vi.fn<NonNullable<FilterDropOpts['onDrop']>>();
    const nanCreated = { ...makeSession('A'), createdAt: NaN };
    const fracExit = { ...makeSession('B'), exitCode: 1.5 };
    const negOwner = { ...makeSession('C'), ownerWindowId: -1 };
    expect(filterByOwnerWindow([nanCreated, fracExit], 1, { onDrop })).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith('A', 'shape-invalid');
    expect(onDrop).toHaveBeenCalledWith('B', 'shape-invalid');
    // ownerWindowId=-1 匹配 wid=-1 通过 owner 检查,再到 shape 守卫(>=0)拒
    expect(filterByOwnerWindow([negOwner], -1, { onDrop })).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith('C', 'shape-invalid');
  });

  it('T15 合规边界值(title 恰 512 / createdAt 有限 / exitCode 安全整数)→ 通过(回归)', () => {
    const s = {
      ...makeSession('A'),
      title: 'x'.repeat(512),
      exitCode: 137,
      createdAt: 1_700_000_000_000,
    };
    expect(filterByOwnerWindow([s], 1).map((x) => x.id)).toEqual(['A']);
  });

  // 边界(E292,E167/E174 同款 IPC-ingress 防御 / 数量维度):ingress 数组超 MAX_TERMINAL_SESSIONS_GLOBAL
  // → 截断到上限 + 一次 over-capacity drop(防有 bug/被篡改的 main 推超大数组致 renderer O(n) 无界遍历)。
  it('E292 ingress 超 MAX_TERMINAL_SESSIONS_GLOBAL → 截断到上限 + over-capacity drop(一次)', () => {
    const onDrop = vi.fn();
    const many = Array.from(
      { length: MAX_TERMINAL_SESSIONS_GLOBAL + 50 },
      (_, i) => makeSession(`s${i}`),
    );
    const r = filterByOwnerWindow(many, 1, { onDrop });
    // neutralize 敏感:去计数闸则全 306 个返回,此断言失败。
    expect(r.length).toBe(MAX_TERMINAL_SESSIONS_GLOBAL);
    expect(filterByOwnerWindow.toString()).not.toContain('result.push(');
    expect(onDrop).toHaveBeenCalledWith(undefined, 'over-capacity');
  });

  it('E292 恰好 MAX 个 → 全保留,不误触 over-capacity(边界包含)', () => {
    const onDrop = vi.fn();
    const exact = Array.from(
      { length: MAX_TERMINAL_SESSIONS_GLOBAL },
      (_, i) => makeSession(`s${i}`),
    );
    const r = filterByOwnerWindow(exact, 1, { onDrop });
    expect(r.length).toBe(MAX_TERMINAL_SESSIONS_GLOBAL);
    expect(onDrop).not.toHaveBeenCalledWith(undefined, 'over-capacity');
  });
});
