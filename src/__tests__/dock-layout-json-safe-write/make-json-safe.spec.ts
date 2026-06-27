// 布局写盘前 JSON-safe 清洗的纯函数规范。见 ./README.md。
import { describe, it, expect, vi } from 'vitest';
import { makeJsonSafe } from '../../../electron/shared/make-json-safe';
import { assertJsonValue } from '../../../electron/shared/assert-json-value';

describe('makeJsonSafe', () => {
  it('保留 JSON-safe 标量与结构(无丢弃)', () => {
    const input = {
      a: null,
      b: true,
      c: 'x',
      d: 0,
      e: -1.5,
      nested: { arr: [1, 'y', false, null] },
    };
    const { value, dropped } = makeJsonSafe(input);
    expect(value).toEqual(input);
    expect(dropped).toEqual([]);
  });

  it('对象属性为非有限 number(NaN/Infinity)→ 删键并记录 path', () => {
    const { value, dropped } = makeJsonSafe({
      size: NaN,
      width: Infinity,
      height: -Infinity,
      ok: 700,
    });
    expect(value).toEqual({ ok: 700 });
    expect(dropped.sort()).toEqual(['$.height', '$.size', '$.width']);
  });

  it('对象属性为 undefined / function / symbol / bigint → 删键', () => {
    const { value } = makeJsonSafe({
      u: undefined,
      f: () => 1,
      s: Symbol('s'),
      big: 10n,
      keep: 'ok',
    });
    expect(value).toEqual({ keep: 'ok' });
  });

  it('数组元素非有限 / undefined → 置 null(保索引,同 JSON.stringify)', () => {
    const { value } = makeJsonSafe([1, NaN, 'a', undefined, Infinity]);
    expect(value).toEqual([1, null, 'a', null, null]);
  });

  it('数组清洗单趟扫描,不调用 input.map', () => {
    const input = [1, NaN, 'a'];
    const mapSpy = vi.spyOn(input, 'map');

    try {
      const { value } = makeJsonSafe(input);
      expect(value).toEqual([1, null, 'a']);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('深层 grid 树内的非有限 size → 清除,其余结构保留', () => {
    const layout = {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { views: ['editor'], id: '1' }, size: NaN },
          ],
          size: 800,
        },
        width: 1400,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: { editor: { contentComponent: 'editor' } },
    };
    const { value, dropped } = makeJsonSafe(layout);
    expect(dropped).toEqual(['$.grid.root.data[0].size']);
    const v = value as typeof layout;
    expect(v.grid.root.data[0]).toEqual({
      type: 'leaf',
      data: { views: ['editor'], id: '1' },
    }); // size 键被删除
    expect(v.grid.root.size).toBe(800);
    expect(v.panels).toEqual({ editor: { contentComponent: 'editor' } });
  });

  it('清洗结果必然通过 assertJsonValue(写端不再 BAD_INPUT)', () => {
    const dirty = {
      grid: { root: { type: 'branch', data: [{ size: NaN }], size: Infinity } },
      bad: undefined,
      arr: [NaN, undefined],
    };
    const { value } = makeJsonSafe(dirty);
    expect(() => assertJsonValue(value)).not.toThrow();
  });

  it('顶层即非安全值 → 返回 null', () => {
    expect(makeJsonSafe(NaN).value).toBeNull();
    expect(makeJsonSafe(undefined).value).toBeNull();
  });
});
