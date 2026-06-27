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

  it('T2 detects absolute paths cross-platform (POSIX + Windows drive/UNC)', () => {
    // POSIX
    expect(isAbsolutePath('/work/spec.ts')).toBe(true);
    // Windows 盘符(反斜杠 / 正斜杠都算绝对)
    expect(isAbsolutePath('C:\\work\\spec.ts')).toBe(true);
    expect(isAbsolutePath('C:/work/spec.ts')).toBe(true);
    expect(isAbsolutePath('d:\\x')).toBe(true);
    // UNC
    expect(isAbsolutePath('\\\\server\\share\\f.ts')).toBe(true);
    // 相对路径
    expect(isAbsolutePath('relative/spec.ts')).toBe(false);
    expect(isAbsolutePath('./spec.ts')).toBe(false);
    expect(isAbsolutePath('../spec.ts')).toBe(false);
    expect(isAbsolutePath('spec.ts')).toBe(false);
    // 盘符相对(无分隔符)不算绝对
    expect(isAbsolutePath('C:relative')).toBe(false);
  });

  // 可维护性 M12:EditorPanel(tab 标题)与 EditorHeader 共用的非空 basename 规则。
  it('T3 basenameForEditorPath 取展示用 basename(trim 尾斜杠 / 吃 / 与 \\)', () => {
    expect(basenameForEditorPath('/work/README.md')).toBe('README.md');
    expect(basenameForEditorPath('/work/sub/')).toBe('sub'); // trim 尾斜杠
    expect(basenameForEditorPath('C:\\work\\spec.ts')).toBe('spec.ts');
    expect(basenameForEditorPath('bare.txt')).toBe('bare.txt'); // 无分隔符
  });
});

