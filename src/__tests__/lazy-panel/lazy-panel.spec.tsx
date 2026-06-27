import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lazyPanel', () => {
  it('缺省 props 复用稳定空对象,避免 render 时分配裸 {}', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/lazy-panel.tsx'),
      'utf-8',
    );

    expect(src).toContain('EMPTY_LAZY_PANEL_PROPS');
    expect(src).not.toContain('props ?? {}');
  });
});
