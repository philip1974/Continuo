// BDD: explorer-git-decorations / 快照 → 每行装饰:文件字母、文件夹继承颜色(无字母)、删除 / 忽略不传播、整目录未跟踪 / 忽略
import { describe, expect, it } from 'vitest';
import {
  buildGitDecorationIndex,
  gitDecorationOf,
  gitRelPath,
} from '../../panels/Explorer/git-decorations';
import type { GitStatusEntry } from '../../../electron/shared/git-status';

const idx = (entries: GitStatusEntry[]) => buildGitDecorationIndex(entries);

describe('文件', () => {
  it('按状态给种类与字母;无记录 → null', () => {
    const i = idx([
      ['src/a.ts', 'modified', 'M'],
      ['b.ts', 'untracked', 'U'],
      ['c.log', 'ignored', ''],
    ]);
    expect(gitDecorationOf(i, 'src/a.ts', false)).toEqual({ kind: 'modified', letter: 'M' });
    expect(gitDecorationOf(i, 'b.ts', false)).toEqual({ kind: 'untracked', letter: 'U' });
    expect(gitDecorationOf(i, 'c.log', false)).toEqual({ kind: 'ignored', letter: '' });
    expect(gitDecorationOf(i, 'src/clean.ts', false)).toBeNull();
  });
});

describe('文件夹继承子项颜色(不显示字母)', () => {
  it('各级祖先目录都继承;取优先级最高者:冲突 > 修改 > 新增 > 重命名 > 未跟踪', () => {
    const i = idx([
      ['src/deep/a.ts', 'untracked', 'U'],
      ['src/b.ts', 'modified', 'M'],
      ['lib/x.ts', 'added', 'A'],
      ['lib/y.ts', 'conflict', '!'],
    ]);
    expect(gitDecorationOf(i, 'src', true)).toEqual({ kind: 'modified', letter: '' });
    expect(gitDecorationOf(i, 'src/deep', true)).toEqual({ kind: 'untracked', letter: '' });
    expect(gitDecorationOf(i, 'lib', true)).toEqual({ kind: 'conflict', letter: '' });
    expect(gitDecorationOf(i, 'other', true)).toBeNull();
  });

  it('已删除、已忽略不向上传播(VSCode propagate 同款)', () => {
    const i = idx([
      ['src/gone.ts', 'deleted', 'D'],
      ['src/x.log', 'ignored', ''],
    ]);
    expect(gitDecorationOf(i, 'src', true)).toBeNull();
  });
});

describe('整目录条目(`dir/`)', () => {
  it('未跟踪目录:目录本身着色无字母,其下文件 U,其下子目录着色;祖先继承', () => {
    const i = idx([['a/fresh/', 'untracked', 'U']]);
    expect(gitDecorationOf(i, 'a/fresh', true)).toEqual({ kind: 'untracked', letter: '' });
    expect(gitDecorationOf(i, 'a/fresh/f.ts', false)).toEqual({ kind: 'untracked', letter: 'U' });
    expect(gitDecorationOf(i, 'a/fresh/sub', true)).toEqual({ kind: 'untracked', letter: '' });
    expect(gitDecorationOf(i, 'a', true)).toEqual({ kind: 'untracked', letter: '' });
    expect(gitDecorationOf(i, 'a/freshness', false)).toBeNull();
  });

  it('忽略目录:目录及其下各项置灰,不向上传播', () => {
    const i = idx([['dist/', 'ignored', '']]);
    expect(gitDecorationOf(i, 'dist', true)).toEqual({ kind: 'ignored', letter: '' });
    expect(gitDecorationOf(i, 'dist/js/out.js', false)).toEqual({ kind: 'ignored', letter: '' });
    expect(gitDecorationOf(i, 'dist/js', true)).toEqual({ kind: 'ignored', letter: '' });
  });

  it("工作区根本身被忽略('')→ 全部置灰", () => {
    const i = idx([['', 'ignored', '']]);
    expect(gitDecorationOf(i, 'x.ts', false)).toEqual({ kind: 'ignored', letter: '' });
    expect(gitDecorationOf(i, 'src', true)).toEqual({ kind: 'ignored', letter: '' });
  });
});

describe('树行路径 → 相对路径', () => {
  it('posix 与 Windows 分隔符都归一到 /', () => {
    expect(gitRelPath('/w', '/w/src/a.ts')).toBe('src/a.ts');
    expect(gitRelPath('C:\\w', 'C:\\w\\src\\a.ts')).toBe('src/a.ts');
  });

  it('NFC 归一:磁盘上 NFD 的名字(如韩文)与 git 输出的 NFC 键对得上(文件、文件夹继承、整目录)', () => {
    const nfd = '\u1112\u1161\u11ab'; // 한(NFD:初声 + 中声 + 终声)
    const nfc = nfd.normalize('NFC');
    expect(gitRelPath('/w', `/w/${nfd}/${nfd}.ts`)).toBe(`${nfc}/${nfc}.ts`);
    const i = idx([
      [`${nfc}/${nfc}.ts`, 'modified', 'M'],
      [`new-${nfc}/`, 'untracked', 'U'],
    ]);
    expect(gitDecorationOf(i, gitRelPath('/w', `/w/${nfd}/${nfd}.ts`), false)).toEqual({ kind: 'modified', letter: 'M' });
    expect(gitDecorationOf(i, gitRelPath('/w', `/w/${nfd}`), true)).toEqual({ kind: 'modified', letter: '' });
    expect(gitDecorationOf(i, gitRelPath('/w', `/w/new-${nfd}/x.ts`), false)).toEqual({ kind: 'untracked', letter: 'U' });
  });
});
