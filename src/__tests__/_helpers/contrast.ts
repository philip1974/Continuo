// WCAG 2.x 对比度计算(相对亮度 + (L1 + 0.05) / (L2 + 0.05)),给色板规范用。
// 支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba();半透明色先按 over 合成到给定底色上。

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  throw new Error(`unsupported color: ${value}`);
}

/** fg 以其 alpha(再乘 extraAlpha)合成到不透明 bg 上。 */
export function over(fg: string, bg: string, extraAlpha = 1): Rgba {
  const f = parseColor(fg);
  const b = parseColor(bg);
  const a = f.a * extraAlpha;
  return { r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a), a: 1 };
}

export function toHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(c: Rgba): number {
  const lin = (x: number): number => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** 对比度;fg 半透明时先合成到 bg 上。 */
export function contrastRatio(fg: string | Rgba, bg: string | Rgba): number {
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  const bgHex = toHex(b);
  const f = typeof fg === 'string' ? over(fg, bgHex) : fg;
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
