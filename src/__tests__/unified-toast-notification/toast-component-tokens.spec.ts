// topic-15 unified-toast-notification: Toast component design-token-only static guards. BDD 先行,源实现 Op3-Op11 落地后才会通过。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('unified-toast-notification: Toast token usage', () => {
  it('T11 Toast.tsx className does not use default Tailwind colors or hex literals', () => {
    const body = read('src/notifications/Toast.tsx');
    const forbidden = [
      /bg-neutral-/,
      /text-neutral-/,
      /border-neutral-/,
      /ring-sky-/,
      /bg-sky-/,
      /text-sky-/,
      /border-sky-/,
      /bg-\[#/,
      /text-\[#/,
      /border-\[#/,
      /#[0-9a-fA-F]{3,8}/,
    ];
    for (const re of forbidden) {
      expect(body, `forbidden token ${re}`).not.toMatch(re);
    }
  });

  it('T11b Toast.css uses CSS variables/currentColor/transparent instead of naked colors', () => {
    const body = read('src/notifications/Toast.css');
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(body).not.toMatch(/\brgba?\(/);
    expect(body).not.toMatch(/bg-neutral-|text-sky-|border-neutral-/);
    expect(body).toMatch(/var\(--md-/);
  });
});
