// 截图像素采样:计算样式只说明「规则生效」,看不到被别的层盖住(如强制颜色的文字底板)。按 CSS 像素截一块区域,
// 在 main 进程用 nativeImage 解码(不受渲染进程 CSP 限制),返回逐像素 RGB。
import type { ElectronApplication, Page } from '@playwright/test';

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** (x, y) 处的 [r, g, b]。 */
  at(x: number, y: number): readonly [number, number, number];
}

export async function capturePixels(
  app: ElectronApplication,
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Pixels> {
  const png = await page.screenshot({ clip, scale: 'css', animations: 'disabled' });
  const { width, height, data } = await app.evaluate(({ nativeImage }, b64) => {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    const size = img.getSize();
    return { ...size, data: img.toBitmap().toString('base64') };
  }, png.toString('base64'));
  const bgra = Buffer.from(data, 'base64');
  return {
    width,
    height,
    // toBitmap 为 BGRA
    at: (x, y) => {
      const i = (y * width + x) * 4;
      return [bgra[i + 2]!, bgra[i + 1]!, bgra[i]!] as const;
    },
  };
}

/** 'rgb(r, g, b)' → [r, g, b]。 */
export function parseRgb(css: string): readonly [number, number, number] {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`not an rgb color: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
}

export const colorDistance = (a: readonly number[], b: readonly number[]): number =>
  Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
