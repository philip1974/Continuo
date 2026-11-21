// 批量粘贴/拖放的唯一目标名选择按大小写不敏感(+NFC)比较已存在名。
//
// 根因:makeNamePicker 用大小写敏感的 Set 判重。macOS 默认 / Windows 大小写不敏感盘上目标目录
// 已有 Readme.md,粘贴 README.md 会选原名 → main 报 FS_EEXIST 中止整批。修:existing 按
// 大小写折叠 + NFC 比较;返回的实际文件名保持原大小写(大小写敏感的 Linux 上多一个 " copy"
// 后缀是可接受的保守行为)。
import { describe, expect, it } from 'vitest';
import { makeNamePicker } from '../../panels/Explorer/FolderTree';

describe('makeNamePicker — 大小写不敏感判重', () => {
  it('目标已有 Readme.md,粘贴 README.md → 选 "README copy.md"(保留原大小写)', () => {
    const pick = makeNamePicker('/d', new Set(['Readme.md']));
    expect(pick('README.md')).toBe('/d/README copy.md');
  });

  it('已有名的 copy 候选也按大小写不敏感跳过', () => {
    const pick = makeNamePicker('/d', new Set(['readme.md', 'readme copy.md']));
    expect(pick('README.md')).toBe('/d/README copy 2.md');
  });

  it('同批次 a.md 与 A.md → 第二个自动 copy', () => {
    const pick = makeNamePicker('/d', new Set());
    expect(pick('a.md')).toBe('/d/a.md');
    expect(pick('A.md')).toBe('/d/A copy.md');
  });

  it('Unicode 规范化不同(NFD vs NFC)视为同名', () => {
    const pick = makeNamePicker('/d', new Set(['é.md']));
    expect(pick('é.md')).toBe('/d/é copy.md');
  });

  it('不冲突 → 原名原样返回', () => {
    const pick = makeNamePicker('/d', new Set(['other.md']));
    expect(pick('README.md')).toBe('/d/README.md');
  });
});
