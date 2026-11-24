// @vitest-environment jsdom
// BDD:弹出菜单点外部即关闭。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDismissOnOutsidePointer } from '../../lib/use-dismiss-on-outside-pointer';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function setup() {
  const inner = document.createElement('div');
  const child = document.createElement('span');
  inner.appendChild(child);
  const outside = document.createElement('div');
  document.body.append(inner, outside);
  return { inner, child, outside, ref: { current: inner } };
}
const press = (el: Element) => el.dispatchEvent(new Event('pointerdown', { bubbles: true }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useDismissOnOutsidePointer', () => {
  it('未打开 → 点外部也不关', () => {
    const { outside, ref } = setup();
    const close = vi.fn();
    renderHook(() => useDismissOnOutsidePointer(false, [ref], close));
    press(outside);
    expect(close).not.toHaveBeenCalled();
  });

  it('打开:点内部(含子孙)不关,点外部关', () => {
    const { inner, child, outside, ref } = setup();
    const close = vi.fn();
    renderHook(() => useDismissOnOutsidePointer(true, [{ current: null }, ref], close));
    press(inner);
    press(child);
    expect(close).not.toHaveBeenCalled();
    press(outside);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('关闭 / 卸载后移除监听', () => {
    const { outside, ref } = setup();
    const close = vi.fn();
    const { rerender, unmount } = renderHook(({ open }) => useDismissOnOutsidePointer(open, [ref], close), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    press(outside);
    rerender({ open: true });
    unmount();
    press(outside);
    expect(close).not.toHaveBeenCalled();
  });
});

describe('接线守卫', () => {
  it.each(['panels/Explorer/ExplorerHeader.tsx', 'shell/dock/HeaderActions.tsx'])('%s', (rel) => {
    const src = readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    expect(src).toContain('useDismissOnOutsidePointer(');
    expect(src).not.toContain("addEventListener('pointerdown'");
  });
});
