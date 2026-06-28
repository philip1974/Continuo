import { describe, expect, it, vi } from 'vitest';
import { isMilkdownUnsafe } from '../../panels/Editor/milkdown-roundtrip-safety';

describe('isMilkdownUnsafe', () => {
  it('detects standard YAML frontmatter', () => {
    expect(isMilkdownUnsafe('---\nid: demo\n---\n# Title\n')).toBe(true);
  });

  it('detects BOM-prefixed frontmatter', () => {
    expect(isMilkdownUnsafe('\uFEFF---\nid: demo\n---\n# Title\n')).toBe(true);
  });

  it('detects CRLF frontmatter', () => {
    expect(isMilkdownUnsafe('---\r\nid: demo\r\n---\r\n# Title\r\n')).toBe(true);
  });

  it('detects EOF-terminated frontmatter', () => {
    expect(isMilkdownUnsafe('---\nid: demo\n---')).toBe(true);
  });

  it('detects wiki-links', () => {
    expect(isMilkdownUnsafe('See [[FLOW-orders-balance-checkout-refund]].')).toBe(
      true,
    );
  });

  it('detects hazards with character scanning instead of RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(isMilkdownUnsafe('---\nid: demo\n---\n# Title\n')).toBe(true);
      expect(isMilkdownUnsafe('See [[note]].')).toBe(true);
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('does not flag empty or broken wiki-link delimiters', () => {
    expect(isMilkdownUnsafe('[[]]')).toBe(false);
    expect(isMilkdownUnsafe('See [[note] tail')).toBe(false);
  });

  it('does not flag non-fence frontmatter-like lines', () => {
    expect(isMilkdownUnsafe('---\nid: demo\n--- trailing\n# Title\n')).toBe(false);
  });

  it('does not flag plain prose', () => {
    expect(isMilkdownUnsafe('# Title\nplain related_adr prose\n')).toBe(false);
  });
});
