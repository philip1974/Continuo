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

// toast 层在模态遮罩之下(VSCode:模态对话框盖住通知):z-index 用 token --z-toast,且低于 --z-modal;
// 此前写死 9999,未保存确认框打开时 toast 浮在变暗遮罩之上。
describe('ToastViewport 层级', () => {
  const THEME = read('src/styles/theme.css');
  const TOKENS = read('src/styles/design-tokens.css');
  const num = (src: string, name: string): number => {
    const m = src.match(new RegExp(`${name}:\\s*(\\d+)\\s*;`));
    if (!m) throw new Error(`${name} not found`);
    return Number(m[1]);
  };

  it('z-index 走 --z-toast token(不写字面数字)', () => {
    expect(VIEWPORT_CSS).toMatch(/z-index:\s*var\(--z-toast\)/);
    expect(VIEWPORT_CSS).not.toMatch(/z-index:\s*\d/);
  });

  it('--z-toast 低于模态层 --wm-z-modal(Modal 遮罩),高于普通浮层 --z-overlay', () => {
    const toast = num(THEME, '--z-toast');
    expect(toast).toBeLessThan(num(TOKENS, '--wm-z-modal'));
    expect(toast).toBeGreaterThan(num(THEME, '--z-overlay'));
  });
});
