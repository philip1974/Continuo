import { describe, expect, it, vi } from 'vitest';
import {
  basenameForEditorPath,
  isAbsolutePath,
  isMarkdownPath,
} from '@/panels/Editor/editor-path-utils';

describe('editor path utils', () => {
  it('T1 detects markdown paths by extension', () => {
    expect(isMarkdownPath('/work/README.md')).toBe(true);
    expect(isMarkdownPath('/work/spec.markdown')).toBe(true);
    expect(isMarkdownPath('/work/README.MD')).toBe(true);
    expect(isMarkdownPath('/work/spec.Markdown')).toBe(true);
    expect(isMarkdownPath('/work/spec.md.bak')).toBe(false);
    expect(isMarkdownPath('/work/spec.ts')).toBe(false);
  });

  it('T1.b isMarkdownPath 不走正则 test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(isMarkdownPath('/work/README.md')).toBe(true);
      expect(isMarkdownPath('/work/spec.markdown')).toBe(true);
      expect(isMarkdownPath('/work/spec.ts')).toBe(false);
      const markdownRegexCalls = testSpy.mock.contexts.filter(
        (context) =>
          context instanceof RegExp && context.source === '\\.(md|markdown)$',
      );
      expect(markdownRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
    }
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

  it('T2.b isAbsolutePath 不走正则 test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(isAbsolutePath('/work/spec.ts')).toBe(true);
      expect(isAbsolutePath('C:\\work\\spec.ts')).toBe(true);
      expect(isAbsolutePath('relative/spec.ts')).toBe(false);
      const absolutePathRegexCalls = testSpy.mock.contexts.filter(
        (context) =>
          context instanceof RegExp &&
          context.source === '^(\\/|[a-zA-Z]:[\\\\/]|\\\\\\\\)',
      );
      expect(absolutePathRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
    }
  });

  // 可维护性 M12:EditorPanel(tab 标题)与 EditorHeader 共用的非空 basename 规则。
  it('T3 basenameForEditorPath 取展示用 basename(trim 尾斜杠 / 吃 / 与 \\)', () => {
    expect(basenameForEditorPath('/work/README.md')).toBe('README.md');
    expect(basenameForEditorPath('/work/sub/')).toBe('sub'); // trim 尾斜杠
    expect(basenameForEditorPath('C:\\work\\spec.ts')).toBe('spec.ts');
    expect(basenameForEditorPath('bare.txt')).toBe('bare.txt'); // 无分隔符
  });

  it('T4 basenameForEditorPath 去尾部分隔符不走 replace 正则', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace');

    try {
      expect(basenameForEditorPath('/work/sub///')).toBe('sub');
      expect(basenameForEditorPath('C:\\work\\spec.ts\\\\')).toBe('spec.ts');
      const trimRegexCalls = replaceSpy.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '[\\\\/]+$',
      );
      expect(trimRegexCalls).toHaveLength(0);
    } finally {
      replaceSpy.mockRestore();
    }
  });
});
