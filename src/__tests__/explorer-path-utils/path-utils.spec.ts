// 可维护性 M4(codex 协作):Explorer 的跨平台 dirname 曾在 tree-config / FolderTree /
// drop-handlers / mutate-actions 四处字面复制,收敛到 src/panels/Explorer/path-utils.ts。
// 本规范锁定 dirname 的跨平台行为契约(单一来源,改路径规则只改一处 + 看这一份测试)。
import { describe, it, expect } from 'vitest';
import {
  basename,
  basenamePreserveTrailing,
  dirname,
} from '@/panels/Explorer/path-utils';

describe('Explorer path-utils · dirname(跨平台)', () => {
  it('普通父目录', () => {
    expect(dirname('/a/b')).toBe('/a');
    expect(dirname('/a/b/c')).toBe('/a/b');
  });

  it('去尾部分隔符后再取父目录', () => {
    expect(dirname('/a/b/')).toBe('/a');
    expect(dirname('/a/b///')).toBe('/a');
  });

  it('根下直接项 → "/"', () => {
    expect(dirname('/a')).toBe('/');
    expect(dirname('/a/')).toBe('/');
  });

  it('裸文件名(无分隔符)→ ""', () => {
    expect(dirname('a')).toBe('');
    expect(dirname('file.txt')).toBe('');
  });

  it('Windows 反斜杠', () => {
    expect(dirname('C:\\x\\y')).toBe('C:\\x');
    expect(dirname('C:\\x\\y\\')).toBe('C:\\x');
  });

  // 跨平台(codex 复查 P2):Windows 盘根下直接项的父=盘根 `C:\`,不是 drive-relative
  // `C:`(后者=该盘当前目录,会被 listDir/invalidateChildrenIds 当成另一路径 → 读错目录/
  // UI 不刷新)。与 POSIX `/a → /` 同等。盘符大小写均覆盖。
  it('Windows 盘根下直接项 → 盘根 "X:\\"(非 drive-relative "X:")', () => {
    expect(dirname('C:\\foo')).toBe('C:\\');
    expect(dirname('C:\\foo\\')).toBe('C:\\');
    expect(dirname('d:\\bar')).toBe('d:\\');
    // 盘根再往上仍是盘根本身(已 trim 尾分隔符 → 无父分隔符 → 裸 "C:" 无分隔符返 "")
    expect(dirname('C:\\')).toBe('');
  });

  it('混合分隔符取最后一个', () => {
    expect(dirname('/a\\b')).toBe('/a');
    expect(dirname('a/b\\c')).toBe('a/b');
  });
});

describe('Explorer path-utils · basename(trim 尾部分隔符)', () => {
  it('普通 / 尾斜杠 / 裸名 / Windows', () => {
    expect(basename('/a/b')).toBe('b');
    expect(basename('/a/b/')).toBe('b'); // trim 尾斜杠
    expect(basename('/a/b///')).toBe('b');
    expect(basename('file.txt')).toBe('file.txt');
    expect(basename('C:\\x\\y')).toBe('y');
  });
});

describe('Explorer path-utils · basenamePreserveTrailing(不 trim,FolderTree 唯一名 picker)', () => {
  it('无尾斜杠时与 basename 一致(实际输入恒无尾斜杠)', () => {
    expect(basenamePreserveTrailing('/a/b')).toBe('b');
    expect(basenamePreserveTrailing('file.txt')).toBe('file.txt');
    expect(basenamePreserveTrailing('C:\\x\\y')).toBe('y');
  });
  it('与 basename 的语义差异:尾斜杠**不** trim → 空段', () => {
    expect(basenamePreserveTrailing('/a/b/')).toBe(''); // 不 trim
    expect(basename('/a/b/')).toBe('b'); // 对照
  });
});
