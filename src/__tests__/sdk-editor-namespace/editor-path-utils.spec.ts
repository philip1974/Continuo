import { describe, expect, it } from 'vitest';
import { isAbsolutePath, isMarkdownPath } from '@/panels/Editor/editor-path-utils';

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
});

