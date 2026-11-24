// 文件树键盘操作的纯逻辑(tree-keyboard.ts):键位匹配(平台感知)与键入跳转查找。
import { describe, expect, it } from 'vitest';
import { findTypeAheadIndex, matchTreeKeyCommand } from '../../panels/Explorer/tree-keyboard';

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe('matchTreeKeyCommand', () => {
  it('Enter → open;带修饰键的 Enter 不算', () => {
    expect(matchTreeKeyCommand(ev({ key: 'Enter' }), 'mac')).toBe('open');
    expect(matchTreeKeyCommand(ev({ key: 'Enter', metaKey: true }), 'mac')).toBeNull();
  });

  it('Delete 两平台都删;⌘⌫ 只在 mac 删;裸 Backspace 不删', () => {
    expect(matchTreeKeyCommand(ev({ key: 'Delete' }), 'other')).toBe('trash');
    expect(matchTreeKeyCommand(ev({ key: 'Delete' }), 'mac')).toBe('trash');
    expect(matchTreeKeyCommand(ev({ key: 'Backspace', metaKey: true }), 'mac')).toBe('trash');
    expect(matchTreeKeyCommand(ev({ key: 'Backspace', metaKey: true }), 'other')).toBeNull();
    expect(matchTreeKeyCommand(ev({ key: 'Backspace' }), 'mac')).toBeNull();
  });

  it('mod 键按平台:mac ⌘C / 其它 Ctrl+C;mac 上 Ctrl+C 不算复制', () => {
    expect(matchTreeKeyCommand(ev({ key: 'c', metaKey: true }), 'mac')).toBe('copy');
    expect(matchTreeKeyCommand(ev({ key: 'c', ctrlKey: true }), 'mac')).toBeNull();
    expect(matchTreeKeyCommand(ev({ key: 'c', ctrlKey: true }), 'other')).toBe('copy');
    expect(matchTreeKeyCommand(ev({ key: 'x', ctrlKey: true }), 'other')).toBe('cut');
    expect(matchTreeKeyCommand(ev({ key: 'v', ctrlKey: true }), 'other')).toBe('paste');
    expect(matchTreeKeyCommand(ev({ key: 'v', ctrlKey: true, shiftKey: true }), 'other')).toBeNull();
  });
});

describe('findTypeAheadIndex', () => {
  const names = ['alpha', 'Beta.ts', 'bravo.ts', 'charlie.ts'];

  it('单字母从下一项开始找(不分大小写),到尾环绕', () => {
    expect(findTypeAheadIndex(names, 0, 'b')).toBe(1);
    expect(findTypeAheadIndex(names, 1, 'b')).toBe(2);
    expect(findTypeAheadIndex(names, 2, 'b')).toBe(1);
    expect(findTypeAheadIndex(names, 3, 'a')).toBe(0);
  });

  it('多字符前缀从当前项开始(当前项仍匹配则留在原地)', () => {
    expect(findTypeAheadIndex(names, 1, 'be')).toBe(1);
    expect(findTypeAheadIndex(names, 1, 'br')).toBe(2);
  });

  it('同一字母重复(bb)按单字母循环', () => {
    expect(findTypeAheadIndex(names, 1, 'bb')).toBe(2);
  });

  it('无匹配 / 空列表 / 空前缀 → -1', () => {
    expect(findTypeAheadIndex(names, 0, 'z')).toBe(-1);
    expect(findTypeAheadIndex([], 0, 'a')).toBe(-1);
    expect(findTypeAheadIndex(names, 0, '')).toBe(-1);
  });
});
