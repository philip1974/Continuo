import { describe, expect, it } from 'vitest';
import { filterQuickOpenFiles, QUICK_OPEN_MAX_RESULTS } from '../../plugins/quick-open/quick-open-filter';
import type { QuickOpenFile } from '../../plugins/quick-open/store';

function file(relPath: string): QuickOpenFile {
  return {
    absPath: `/proj/${relPath}`,
    relPath,
    relPathLower: relPath.toLowerCase(),
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
  };
}

// 截图审计里的真实路径(Continuo 仓库)
const FILES = [
  'src/__tests__/editor-tab-git/editor-tab-git.spec.tsx',
  'src/__tests__/code-editor/code-editor-theme.spec.tsx',
  'src/panels/Editor/CodeEditorPane.tsx',
  'src/panels/Editor/CodeEditor.tsx',
  'src/panels/Editor/code-editor-utils.ts',
  'src/stores/workspace.store.ts',
  'src/plugins/quick-open/store.ts',
  'src/plugins/quick-open/QuickOpenModal.tsx',
  'src/plugins/command-palette/store.ts',
  'src/__tests__/quick-open-modal/quick-open-modal.spec.tsx',
  'src/panels/Terminal/useTerminal.ts',
  'src/panels/Terminal/use-terminal-theme.ts',
  'src/__tests__/terminal/useTerminal.spec.ts',
  'src/panels/Explorer/index.ts',
  'src/index.ts',
  'electron/main/index.ts',
  'README.md',
].map(file);

const rel = (query: string, recentCount = 0, items: readonly QuickOpenFile[] = FILES) =>
  filterQuickOpenFiles(items, recentCount, query).files.map((f) => f.relPath);

describe('Quick Open 打分:文件名优先(VSCode scoreItemFuzzy)', () => {
  it('输入完整文件名 → 该文件排第一', () => {
    expect(rel('CodeEditor.tsx')[0]).toBe('src/panels/Editor/CodeEditor.tsx');
    expect(rel('useTerminal.ts')[0]).toBe('src/panels/Terminal/useTerminal.ts');
    expect(rel('QuickOpenModal')[0]).toBe('src/plugins/quick-open/QuickOpenModal.tsx');
  });

  it('不分大小写的文件名片段 → 文件名前缀命中在前,同前缀时短文件名在前', () => {
    const r = rel('codeeditor');
    expect(r.slice(0, 2)).toEqual(['src/panels/Editor/CodeEditor.tsx', 'src/panels/Editor/CodeEditorPane.tsx']);
  });

  it('多个同名文件 → 路径更短的在前', () => {
    expect(rel('index.ts').slice(0, 3)).toEqual(['src/index.ts', 'electron/main/index.ts', 'src/panels/Explorer/index.ts']);
    expect(rel('store.ts').slice(0, 3)).toEqual([
      'src/plugins/quick-open/store.ts',
      'src/plugins/command-palette/store.ts',
      'src/stores/workspace.store.ts',
    ]);
  });

  it('查询含 / → 按「目录 / 文件名」打分', () => {
    expect(rel('quick-open/store')[0]).toBe('src/plugins/quick-open/store.ts');
  });

  it('不是子序列 → 不命中', () => {
    expect(rel('zzzz')).toEqual([]);
  });
});

describe('Quick Open 打分:空格拆段(VSCode prepareQuery values)', () => {
  it('每段都要命中,段序无关', () => {
    expect(rel('quick open')).toContain('src/plugins/quick-open/QuickOpenModal.tsx');
    expect(rel('open quick')).toContain('src/plugins/quick-open/QuickOpenModal.tsx');
    expect(rel('quick open')[0]).toBe('src/plugins/quick-open/QuickOpenModal.tsx');
  });

  it('目录段 + 文件名段', () => {
    expect(rel('Editor CodeEditor')[0]).toBe('src/panels/Editor/CodeEditor.tsx');
  });

  it('任一段不命中 → 不显示', () => {
    expect(rel('quick zzzz')).toEqual([]);
  });

  it('多余空格不影响', () => {
    expect(rel('quick   open')[0]).toBe('src/plugins/quick-open/QuickOpenModal.tsx');
  });
});

describe('Quick Open 打分:最近打开与命中区段', () => {
  it('同分时最近打开的在前', () => {
    const a = file('a/store.ts');
    const b = file('b/store.ts');
    expect(rel('store.ts', 0, [a, b])).toEqual(['a/store.ts', 'b/store.ts']);
    // b 是最近打开(orderByRecent 已排到前面,recentCount=1)
    expect(rel('store.ts', 1, [b, a])).toEqual(['b/store.ts', 'a/store.ts']);
  });

  it('最近打开不压过明显更好的匹配', () => {
    const recent = file('src/panels/Editor/CodeEditorPane.tsx');
    const exact = file('src/panels/Editor/CodeEditor.tsx');
    expect(rel('CodeEditor.tsx', 1, [recent, exact])[0]).toBe('src/panels/Editor/CodeEditor.tsx');
  });

  it('命中区段:文件名命中只落在文件名;多段时目录与文件名各自有区段', () => {
    const f = file('src/panels/Editor/CodeEditor.tsx');
    const one = filterQuickOpenFiles([f], 0, 'CodeEditor').scores.get(f)!;
    expect(one.labelMatch).toEqual([{ start: 0, end: 10 }]);
    expect(one.descriptionMatch).toBeUndefined();
    const two = filterQuickOpenFiles([f], 0, 'panels CodeEditor').scores.get(f)!;
    expect(two.labelMatch).toEqual([{ start: 0, end: 10 }]);
    expect(two.descriptionMatch).toEqual([{ start: 4, end: 10 }]);
  });

  it('有查询时最多列出 QUICK_OPEN_MAX_RESULTS(512,VSCode MAX_RESULTS)个分数最高的结果', () => {
    const many = Array.from({ length: 2000 }, (_, i) => file(`d${i}/note-${i}.md`));
    many.push(file('z/note.md'));
    const r = rel('note', 0, many);
    expect(r).toHaveLength(QUICK_OPEN_MAX_RESULTS);
    expect(r[0]).toBe('z/note.md'); // 最短的文件名在前,即便排在候选末尾
  });

  it('空查询 → 原样返回', () => {
    expect(filterQuickOpenFiles(FILES, 0, '').files).toBe(FILES);
  });
});
