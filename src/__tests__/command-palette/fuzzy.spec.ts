import { describe, it, expect, vi } from 'vitest';
import { fuzzyScore, fuzzyFilter, fuzzyMatchIndices } from '../../plugins/command-palette/fuzzy';

describe('fuzzyScore', () => {
  it('空 query → 0(全匹配)', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('完全匹配 target 起始 → 高分', () => {
    const score = fuzzyScore('save', 'save file');
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(20);
  });

  it('子序列匹配 → 非 null', () => {
    expect(fuzzyScore('sf', 'save file')).not.toBeNull();
  });

  it('字符不全在 target 中 → null', () => {
    expect(fuzzyScore('xyz', 'save file')).toBeNull();
  });

  it('字符有但顺序不对 → null', () => {
    // 'es' 在 'save' 中:e 在位置 3,要找 s 在 3 之后,但 s 只在位置 0 → null
    expect(fuzzyScore('es', 'save')).toBeNull();
    // 'as' 在 'save' 中:a 在位置 1,要找 s 在 1 之后,但 s 只在 0 → null
    expect(fuzzyScore('as', 'save')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(fuzzyScore('SAVE', 'save file')).toEqual(fuzzyScore('save', 'save file'));
  });

  it('词边界匹配比中间匹配分高', () => {
    // 'sf' on 'save file' -> s at 0(boundary), f at 5(boundary after space)
    const onBoundary = fuzzyScore('sf', 'save file')!;
    // 'sf' on 'sufficient' -> s at 0(boundary), f at 2(non-boundary)
    const inMiddle = fuzzyScore('sf', 'sufficient')!;
    expect(onBoundary).toBeGreaterThan(inMiddle);
  });

  it('连续匹配额外加分', () => {
    // 'sa' 在 'save'(s 在 0,a 在 1,连续)
    // vs 'sa' 在 'space'(s 在 0,a 在 2,中间隔 'p',非连续且非词边界)
    const consecutive = fuzzyScore('sa', 'save')!;
    const split = fuzzyScore('sa', 'space')!;
    expect(consecutive).toBeGreaterThan(split);
  });

  it('词边界判断不通过 RegExp.test 热路径调用', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(fuzzyScore('sf', 'save file')).not.toBeNull();
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });
});

describe('fuzzyFilter', () => {
  it('按 score 降序,过滤掉不匹配项', () => {
    const items = [
      { id: 'a', name: 'save file' },
      { id: 'b', name: 'open folder' },
      { id: 'c', name: 'save all' },
      { id: 'd', name: 'reload' },
    ];
    const r = fuzzyFilter(items, 'save', (i) => i.name.toLowerCase());
    expect(r.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('空 query → 原序返回全部', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const r = fuzzyFilter(items, '', (i) => i.id.toLowerCase());
    expect(r).toEqual(items);
    expect(r).toBe(items);
  });

  it('空 items → 原引用返回,不 lower query', () => {
    const items: { id: string }[] = [];
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      const r = fuzzyFilter(items, 'save', (i) => i.id.toLowerCase());
      expect(r).toBe(items);
      expect(lowerSpy).not.toHaveBeenCalled();
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('匹配结果输出不通过 scored.map 二次物化', () => {
    const items = [
      { id: 'a', name: 'save file' },
      { id: 'b', name: 'save all' },
      { id: 'c', name: 'reload' },
    ];
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      const r = fuzzyFilter(items, 'save', (i) => i.name.toLowerCase());
      const mapCallsDuringFilter = mapSpy.mock.calls.length;
      expect(r.map((x) => x.id)).toEqual(['a', 'b']);
      expect(mapCallsDuringFilter).toBe(0);
      expect(fuzzyFilter.toString()).not.toContain('scored.push(');
      expect(fuzzyFilter.toString()).not.toContain('item, score');
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('匹配结果少于两项时不调用 sort', () => {
    const items = [
      { id: 'a', name: 'save file' },
      { id: 'b', name: 'open folder' },
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(fuzzyFilter(items, 'save', (i) => i.name.toLowerCase()).map((x) => x.id)).toEqual(['a']);
      expect(fuzzyFilter(items, 'zzzz', (i) => i.name.toLowerCase())).toEqual([]);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('匹配结果已按 score 降序时不调用 sort', () => {
    const items = [
      { id: 'a', name: 'save file' },
      { id: 'b', name: 'save all' },
      { id: 'c', name: 'open file' },
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(fuzzyFilter(items, 'save', (i) => i.name.toLowerCase()).map((x) => x.id)).toEqual(['a', 'b']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单项匹配时直接复用原列表引用', () => {
    const items = [{ id: 'a', name: 'save file' }];

    expect(fuzzyFilter(items, 'save', (i) => i.name.toLowerCase())).toBe(items);
    expect(fuzzyFilter(items, 'zzzz', (i) => i.name.toLowerCase())).toEqual([]);
  });

  it('无匹配结果 → 复用稳定空列表', () => {
    const items = [
      { id: 'a', name: 'save file' },
      { id: 'b', name: 'open folder' },
    ];

    const a = fuzzyFilter(items, 'zzzz', (i) => i.name.toLowerCase());
    const b = fuzzyFilter(items, 'yyyy', (i) => i.name.toLowerCase());

    expect(a).toEqual([]);
    expect(b).toBe(a);
  });

  it('多项无匹配路径不预分配 matched/scores 数组', () => {
    expect(fuzzyFilter.toString()).toContain('let matched = null');
    expect(fuzzyFilter.toString()).not.toContain('const matched = new Array(items.length)');
    expect(fuzzyFilter.toString()).not.toContain('const scores = new Array(items.length)');
  });

  it('fuzzyFilter 自身只 lower 一次 query,不 lower target(target 由调用方预小写)', () => {
    const items = [
      { id: 'a', name: 'a' },
      { id: 'b', name: 'bb' },
    ];
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      expect(fuzzyFilter(items, 'abcdef', (i) => i.name)).toEqual([]);
      const lowerCallsDuringFilter = lowerSpy.mock.calls.length;
      // 只允许 query.toLowerCase() 一次。
      expect(lowerCallsDuringFilter).toBe(1);
    } finally {
      lowerSpy.mockRestore();
    }
  });
});

// 命中字符下标(VSCode Quick Input 的 highlights):与打分同一贪心子序列,只为渲染的可见行计算,不参与排序。
describe('fuzzyMatchIndices', () => {
  it('子序列命中 → 每个查询字符在 target 里的下标(贪心最左,同打分)', () => {
    expect(fuzzyMatchIndices('sf', 'save file')).toEqual([0, 5]);
    expect(fuzzyMatchIndices('ats', 'a.ts')).toEqual([0, 2, 3]);
  });

  it('大小写不敏感', () => {
    expect(fuzzyMatchIndices('SAVE', 'Save File')).toEqual([0, 1, 2, 3]);
  });

  it('不命中 → null;空 query → []', () => {
    expect(fuzzyMatchIndices('xyz', 'save file')).toBeNull();
    expect(fuzzyMatchIndices('es', 'save')).toBeNull();
    expect(fuzzyMatchIndices('', 'save')).toEqual([]);
  });

  it('与 fuzzyScore 判定一致:有分 ⇔ 有下标', () => {
    for (const [q, t] of [['sf', 'save file'], ['zz', 'fizz'], ['abc', 'acb'], ['src/a', 'src/a.ts']] as const) {
      expect(fuzzyMatchIndices(q, t) !== null).toBe(fuzzyScore(q, t) !== null);
    }
  });
});
