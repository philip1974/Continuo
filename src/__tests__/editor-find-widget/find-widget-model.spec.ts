// TDD:查找控件的纯逻辑(历史导航、计数文案)—— CodeMirror 查找面板用,Markdown 编辑模式的查找也可复用。
import { afterEach, describe, expect, it } from 'vitest';
import { FindHistory, FIND_MATCH_LIMIT, formatFindCount } from '../../panels/Editor/find-widget-model';
import { getLocale, setLocale, t } from '../../i18n';

describe('FindHistory', () => {
  it('去重:再次加入已有词移到最新,空串不收', () => {
    const h = new FindHistory();
    h.add('a');
    h.add('b');
    h.add('a');
    h.add('');
    expect(h.entries()).toEqual(['b', 'a']);
  });

  it('上限 50 条,超出丢最旧', () => {
    const h = new FindHistory();
    for (let i = 0; i < 60; i++) h.add(`t${i}`);
    expect(h.entries()).toHaveLength(50);
    expect(h.entries()[0]).toBe('t10');
    expect(h.entries()[49]).toBe('t59');
  });

  it('↑ 先把当前输入记入历史再往前翻;到最旧停住;↓ 往回,越过最新回到空', () => {
    const h = new FindHistory();
    h.add('a');
    h.add('b');
    expect(h.previous('draft')).toBe('b');
    expect(h.entries()).toEqual(['a', 'b', 'draft']);
    expect(h.previous('b')).toBe('a');
    expect(h.previous('a')).toBeUndefined();
    expect(h.next()).toBe('b');
    expect(h.next()).toBe('draft');
    expect(h.next()).toBe('');
    expect(h.next()).toBeUndefined();
  });

  it('当前输入就是最新一条时 ↑ 直接到上一条;resetCursor 后从最新重新开始', () => {
    const h = new FindHistory();
    h.add('a');
    h.add('b');
    expect(h.previous('b')).toBe('a');
    h.resetCursor();
    expect(h.previous('b')).toBe('a');
    h.resetCursor();
    expect(h.previous('')).toBe('b');
  });
});

describe('formatFindCount', () => {
  const locale = getLocale();
  afterEach(() => setLocale(locale));

  it('空查询无文案;0 → 无结果;无当前 → 总数(单复数);有当前 → 当前 / 总数;封顶显示 1000+', () => {
    setLocale('en');
    expect(formatFindCount({ total: 0, current: 0, capped: false, empty: true })).toBe('');
    expect(formatFindCount({ total: 0, current: 0, capped: false, empty: false })).toBe(t('editor.find.no_results'));
    expect(formatFindCount({ total: 1, current: 0, capped: false, empty: false })).toBe('1 match');
    expect(formatFindCount({ total: 7, current: 0, capped: false, empty: false })).toBe('7 matches');
    expect(formatFindCount({ total: 7, current: 3, capped: false, empty: false })).toBe('3 / 7');
    expect(formatFindCount({ total: FIND_MATCH_LIMIT, current: 0, capped: true, empty: false })).toBe('1000+ matches');
    expect(formatFindCount({ total: FIND_MATCH_LIMIT, current: 2, capped: true, empty: false })).toBe('2 / 1000+');
  });
});
