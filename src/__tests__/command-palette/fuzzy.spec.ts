import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzyFilter } from '../../plugins/command-palette/fuzzy';

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
    expect(fuzzyScore('SAVE', 'save file')).toEqual(
      fuzzyScore('save', 'save file'),
    );
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
});

describe('fuzzyFilter', () => {
  it('按 score 降序,过滤掉不匹配项', () => {
    const items = [
      { id: 'a', name: 'save file' },
      { id: 'b', name: 'open folder' },
      { id: 'c', name: 'save all' },
      { id: 'd', name: 'reload' },
    ];
    const r = fuzzyFilter(items, 'save', (i) => i.name);
    expect(r.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('空 query → 原序返回全部', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const r = fuzzyFilter(items, '', (i) => i.id);
    expect(r).toEqual(items);
  });
});
