// 同名文件 tab 的区分后缀(对齐 VSCode「workbench.editor.labelFormat: default」:重名时在文件名后用弱化色显示
// 能区分彼此的最短父路径后缀;不重名的 tab 不显示)。
import { describe, expect, it } from 'vitest';
import { tabLabelDescriptions } from '../../panels/Editor/tab-label-description';

describe('tabLabelDescriptions — 同名 tab 的最短区分父路径', () => {
  it('basename 不重复 → 都不显示', () => {
    expect(tabLabelDescriptions(['/p/a.ts', '/p/b.ts'])).toEqual([null, null]);
  });

  it('父目录名即可区分 → 只显示父目录名', () => {
    expect(tabLabelDescriptions(['/p/a/index.ts', '/p/b/index.ts', '/p/c.ts'])).toEqual(['a', 'b', null]);
  });

  it('父目录同名 → 向上取到能区分的最短后缀', () => {
    expect(tabLabelDescriptions(['/w/a/src/index.ts', '/w/b/src/index.ts'])).toEqual(['a/src', 'b/src']);
  });

  it('各自取最短:三个同名里只与部分冲突的那个用更短后缀', () => {
    expect(
      tabLabelDescriptions(['/w/a/src/x.ts', '/w/b/src/x.ts', '/w/lib/x.ts']),
    ).toEqual(['a/src', 'b/src', 'lib']);
  });

  it('一个是另一个的后缀路径(父链用尽)→ 显示完整父路径', () => {
    expect(tabLabelDescriptions(['/a/x.md', '/z/a/x.md'])).toEqual(['/a', 'z/a']);
  });

  it('Windows 路径按 \\ 分段,后缀用原分隔符', () => {
    expect(tabLabelDescriptions(['C:\\p\\a\\x.ts', 'C:\\p\\b\\x.ts'])).toEqual(['a', 'b']);
    expect(tabLabelDescriptions(['C:\\w\\a\\src\\x.ts', 'C:\\w\\b\\src\\x.ts'])).toEqual(['a\\src', 'b\\src']);
  });

  it('同一路径出现两次(不应发生)不死循环,显示完整父路径', () => {
    expect(tabLabelDescriptions(['/p/x.ts', '/p/x.ts'])).toEqual(['/p', '/p']);
  });
});
