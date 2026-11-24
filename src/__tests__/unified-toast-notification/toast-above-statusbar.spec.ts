// @vitest-environment jsdom
// Toast 不盖住底部状态栏:主窗(有状态栏)toast 放在状态栏上方 8px;popout 子窗没有状态栏,贴底 12px 不留空白。
// 状态栏高度是共用 token(--wm-statusbar-height → Tailwind h-statusbar),StatusBar 与 ToastViewport.css 同源。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf-8');
const VIEWPORT_CSS = read('src/notifications/ToastViewport.css');

/** 在当前文档装上 ToastViewport.css(可选加一个状态栏),返回 toast 容器的 computed bottom。 */
function toastBottom(withStatusBar: boolean): string {
  const style = document.createElement('style');
  style.textContent = VIEWPORT_CSS;
  document.head.appendChild(style);
  if (withStatusBar) {
    const footer = document.createElement('footer');
    footer.setAttribute('data-statusbar', '');
    document.body.appendChild(footer);
  }
  const viewport = document.createElement('div');
  viewport.className = 'toast-viewport';
  document.body.appendChild(viewport);
  return getComputedStyle(viewport).bottom;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('ToastViewport 与状态栏', () => {
  it('文档里有状态栏 → bottom = 状态栏高度 + 8px', () => {
    expect(toastBottom(true).replace(/\s+/g, ' ')).toBe('calc(var(--wm-statusbar-height) + 8px)');
  });

  it('文档里没有状态栏(popout 子窗)→ 贴底 12px,不留状态栏空白', () => {
    expect(toastBottom(false)).toBe('12px');
  });

  it('状态栏高度 token:theme.css :root 定义 24px,并经 @theme 暴露为 h-statusbar', () => {
    const theme = read('src/styles/theme.css');
    expect(theme).toMatch(/--wm-statusbar-height:\s*24px;/);
    expect(theme).toMatch(/--spacing-statusbar:\s*var\(--wm-statusbar-height\);/);
  });

  it('StatusBar 用 h-statusbar + data-statusbar(不再写死 h-6)', () => {
    const src = read('src/shell/StatusBar.tsx');
    const footer = src.slice(src.indexOf('<footer'), src.indexOf('>', src.indexOf('className=', src.indexOf('<footer'))));
    expect(footer).toContain('data-statusbar');
    expect(footer).toContain('h-statusbar');
    expect(footer).not.toMatch(/\bh-6\b/);
  });
});
