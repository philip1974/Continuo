// BDD: workspace-search / 2 查询 → 正则;3 包含 / 排除的文件 glob 语义
import { describe, expect, it } from 'vitest';
import {
  buildSearchRegExp,
  compileGlobList,
  compileSearchPathFilter,
  isSearchEvent,
  searchRegExpSource,
} from '../../../electron/shared/workspace-search';

const q = (pattern: string, o: Partial<{ isRegex: boolean; matchCase: boolean; wholeWord: boolean }> = {}) => ({
  pattern,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  ...o,
});
const hits = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0]);

describe('查询 → 正则', () => {
  it('字面量转义元字符;默认不区分大小写', () => {
    expect(hits(buildSearchRegExp(q('a.b(')), 'a.b( axb( A.B(')).toEqual(['a.b(', 'A.B(']);
  });
  it('区分大小写', () => {
    expect(hits(buildSearchRegExp(q('Foo', { matchCase: true })), 'Foo foo FOO')).toEqual(['Foo']);
  });
  it('全词:首 / 尾是单词字符时加 \\b(VSCode createRegExp)', () => {
    expect(hits(buildSearchRegExp(q('foo', { wholeWord: true })), 'foo food _foo foo.')).toEqual(['foo', 'foo']);
    expect(searchRegExpSource(q('.foo', { wholeWord: true }))).toBe('\\.foo\\b');
    expect(searchRegExpSource(q('foo(', { wholeWord: true }))).toBe('\\bfoo\\(');
  });
  it('正则模式原样使用;非法正则构建时抛错', () => {
    expect(hits(buildSearchRegExp(q('ab+c', { isRegex: true })), 'ac abc abbbc')).toEqual(['abc', 'abbbc']);
    expect(() => buildSearchRegExp(q('a(', { isRegex: true }))).toThrow();
  });
});

describe('包含 / 排除的文件', () => {
  const m = (glob: string) => compileGlobList(glob)!;
  it('空输入 → 不过滤', () => {
    expect(compileGlobList('')).toBeNull();
    expect(compileGlobList(' , ')).toBeNull();
    expect(compileSearchPathFilter('', '')).toBeNull();
  });
  it('不以 ./ 开头 → 任意层级;匹配目录即含其下所有文件', () => {
    expect(m('src')('src/a.ts')).toBe(true);
    expect(m('src')('pkg/src/deep/a.ts')).toBe(true);
    expect(m('src')('srcx/a.ts')).toBe(false);
    expect(m('*.ts')('a.ts')).toBe(true);
    expect(m('*.ts')('x/y/a.ts')).toBe(true);
    expect(m('*.ts')('a.tsx')).toBe(false);
  });
  it('./ 开头 → 相对工作区根', () => {
    expect(m('./src')('src/a.ts')).toBe(true);
    expect(m('./src')('pkg/src/a.ts')).toBe(false);
    expect(m('./src/**/*.md')('src/a/b/c.md')).toBe(true);
    expect(m('./src/**/*.md')('src/c.md')).toBe(true);
  });
  it('* 不跨目录、** 跨目录、?、{a,b}、[...];逗号分隔多个;大小写不敏感;\\ 视作 /', () => {
    expect(m('./a/*.ts')('a/b/c.ts')).toBe(false);
    expect(m('./a/**')('a/b/c.ts')).toBe(true);
    expect(m('?.ts')('x.ts')).toBe(true);
    expect(m('?.ts')('xy.ts')).toBe(false);
    expect(m('*.{ts,md}')('a.md')).toBe(true);
    expect(m('*.{ts,md}')('a.js')).toBe(false);
    expect(m('[ab].ts')('b.ts')).toBe(true);
    expect(m('[!ab].ts')('b.ts')).toBe(false);
    expect(m('*.js, docs')('docs/x.md')).toBe(true);
    expect(m('*.js, docs')('a.JS')).toBe(true);
    expect(m('.\\src\\a.ts')('src/a.ts')).toBe(true);
  });
  it('排除优先于包含', () => {
    const f = compileSearchPathFilter('src', '*.test.ts')!;
    expect(f('src/a.ts')).toBe(true);
    expect(f('src/a.test.ts')).toBe(false);
    expect(f('lib/a.ts')).toBe(false);
    expect(compileSearchPathFilter('', 'vendor')!('vendor/x.js')).toBe(false);
  });
});

describe('推送事件形态守卫', () => {
  const match = { line: 1, column: 1, length: 1, preview: 'a', previewStart: 0, previewLength: 1 };
  it('合法事件放行', () => {
    expect(isSearchEvent({ searchId: 's', kind: 'files', files: [{ path: '/w/a', relPath: 'a', matches: [match] }] })).toBe(true);
    expect(isSearchEvent({ searchId: 's', kind: 'done', limitHit: false, filesLimitHit: false })).toBe(true);
    expect(isSearchEvent({ searchId: 's', kind: 'error', code: 'X', message: 'm' })).toBe(true);
  });
  it('畸形事件丢弃', () => {
    expect(isSearchEvent(null)).toBe(false);
    expect(isSearchEvent({ searchId: 1, kind: 'done', limitHit: false, filesLimitHit: false })).toBe(false);
    expect(isSearchEvent({ searchId: 's', kind: 'nope' })).toBe(false);
    expect(isSearchEvent({ searchId: 's', kind: 'files', files: [{ path: '/w/a', relPath: 'a', matches: [{ ...match, line: -1 }] }] })).toBe(false);
    expect(isSearchEvent({ searchId: 'x'.repeat(65), kind: 'done', limitHit: false, filesLimitHit: false })).toBe(false);
  });
});
