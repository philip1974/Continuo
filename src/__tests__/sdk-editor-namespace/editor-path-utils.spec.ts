import { describe, expect, it } from 'vitest';
import {
  basenameForEditorPath,
  isAbsolutePath,
  isMarkdownPath,
} from '@/panels/Editor/editor-path-utils';

describe('editor path utils', () => {
  it('T1 detects markdown paths by extension', () => {
    expect(isMarkdownPath('/work/README.md')).toBe(true);
    expect(isMarkdownPath('/work/spec.markdown')).toBe(true);
    expect(isMarkdownPath('/work/spec.md.bak')).toBe(false);
    expect(isMarkdownPath('/work/spec.ts')).toBe(false);
  });

  it('T2 detects POSIX absolute paths', () => {
    expect(isAbsolutePath('/work/spec.ts')).toBe(true);
    expect(isAbsolutePath('relative/spec.ts')).toBe(false);
    expect(isAbsolutePath('C:\\work\\spec.ts')).toBe(false);
  });

  // 可维护性 M12:EditorPanel(tab 标题)与 EditorHeader 共用的非空 basename 规则。
  it('T3 basenameForEditorPath 取展示用 basename(trim 尾斜杠 / 吃 / 与 \\)', () => {
    expect(basenameForEditorPath('/work/README.md')).toBe('README.md');
    expect(basenameForEditorPath('/work/sub/')).toBe('sub'); // trim 尾斜杠
    expect(basenameForEditorPath('C:\\work\\spec.ts')).toBe('spec.ts');
    expect(basenameForEditorPath('bare.txt')).toBe('bare.txt'); // 无分隔符
  });
});

