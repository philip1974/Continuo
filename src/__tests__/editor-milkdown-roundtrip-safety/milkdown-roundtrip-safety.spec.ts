import { describe, expect, it } from 'vitest';
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

  it('does not flag plain prose', () => {
    expect(isMilkdownUnsafe('# Title\nplain related_adr prose\n')).toBe(false);
  });
});
