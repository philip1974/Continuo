import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = join(process.cwd(), 'src/styles/fonts.css');

describe('终端内置字体以完整 glyph 的 WOFF2 加载', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');

  it("MesloLGS NF 只引用 .woff2 + format('woff2'),不再引用 TTF", () => {
    expect(css).toContain("font-family: 'MesloLGS NF'");
    expect(css).toMatch(/url\('[^']+\.woff2'\)\s*format\('woff2'\)/);
    expect(css).not.toMatch(/\.ttf'|format\('truetype'\)/);
    expect(css).toContain('font-display: block');
  });

  it('引用的字体文件存在且为 WOFF2 容器', () => {
    const rel = /url\('([^']+\.woff2)'\)/.exec(css)![1]!;
    const buf = readFileSync(resolve(dirname(CSS_PATH), rel));
    expect(buf.subarray(0, 4).toString('latin1')).toBe('wOF2');
  });
});
