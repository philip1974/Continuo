// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useColumnResize } from '../../lib/use-column-resize';

beforeEach(() => {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

afterEach(() => cleanup());

function fireMouse(type: 'mousemove' | 'mouseup', x: number): void {
  document.dispatchEvent(
    new MouseEvent(type, { clientX: x, bubbles: true }),
  );
}

function makeMouseDown(clientX: number): React.MouseEvent {
  const preventDefault = vi.fn();
  return {
    clientX,
    preventDefault,
  } as unknown as React.MouseEvent;
}

describe('useColumnResize — left-to-right', () => {
  it('mousedown 后 mousemove → setCurrent 拿到新宽度;mouseup 移除监听', () => {
    let width = 280;
    const setCurrent = vi.fn((next: number) => {
      width = next;
    });
    const { result } = renderHook(() =>
      useColumnResize({
        getCurrent: () => width,
        setCurrent,
        min: 200,
        max: 500,
        direction: 'left-to-right',
      }),
    );
    const md = makeMouseDown(100);
    result.current(md);
    expect(md.preventDefault).toHaveBeenCalledTimes(1);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    fireMouse('mousemove', 150);
    expect(setCurrent).toHaveBeenLastCalledWith(330); // 280 + (150-100)

    fireMouse('mousemove', 50);
    expect(setCurrent).toHaveBeenLastCalledWith(230); // 280 + (50-100)

    fireMouse('mouseup', 50);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    // 上抬后再移动不应触发
    setCurrent.mockClear();
    fireMouse('mousemove', 200);
    expect(setCurrent).not.toHaveBeenCalled();
  });

  it('clamp 到 min/max', () => {
    let width = 280;
    const setCurrent = vi.fn((n: number) => {
      width = n;
    });
    const { result } = renderHook(() =>
      useColumnResize({
        getCurrent: () => width,
        setCurrent,
        min: 200,
        max: 500,
      }),
    );
    result.current(makeMouseDown(100));
    fireMouse('mousemove', 1000); // 280+900 = 1180 → 500
    expect(setCurrent).toHaveBeenLastCalledWith(500);

    fireMouse('mousemove', -1000); // 280-1100 = -820 → 200
    expect(setCurrent).toHaveBeenLastCalledWith(200);
    fireMouse('mouseup', 0);
  });
});

describe('useColumnResize — right-to-left', () => {
  it('右栏左边拖:右移 → 减宽', () => {
    let width = 300;
    const setCurrent = vi.fn((n: number) => {
      width = n;
    });
    const { result } = renderHook(() =>
      useColumnResize({
        getCurrent: () => width,
        setCurrent,
        min: 100,
        max: 600,
        direction: 'right-to-left',
      }),
    );
    result.current(makeMouseDown(200));
    fireMouse('mousemove', 250); // delta 50 → 300-50 = 250
    expect(setCurrent).toHaveBeenLastCalledWith(250);
    fireMouse('mouseup', 250);
  });
});

describe('useColumnResize — 多次拖拽', () => {
  it('每次 mousedown 重新读 getCurrent', () => {
    let width = 200;
    const setCurrent = vi.fn((n: number) => {
      width = n;
    });
    const { result } = renderHook(() =>
      useColumnResize({
        getCurrent: () => width,
        setCurrent,
        min: 100,
        max: 1000,
      }),
    );
    result.current(makeMouseDown(0));
    fireMouse('mousemove', 50);
    expect(setCurrent).toHaveBeenLastCalledWith(250);
    fireMouse('mouseup', 50);

    result.current(makeMouseDown(0));
    fireMouse('mousemove', 50);
    expect(setCurrent).toHaveBeenLastCalledWith(300); // 250 + 50
    fireMouse('mouseup', 50);
  });
});
