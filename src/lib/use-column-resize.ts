// 侧栏宽度拖拽。借鉴 Lokus useColumnResize 模式,纯函数 + 薄壳 hook。
// computeNewWidth / clampWidth 单测,hook 真行为留 E2E。

import { useCallback, useRef } from 'react';

export function clampWidth(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * 由起始 X 与起始宽度算出新宽度(左侧栏的右边拖:向右拖 → 宽度增)。
 */
export function computeNewWidth(
  startX: number,
  startW: number,
  currentX: number,
  min: number,
  max: number,
): number {
  return clampWidth(startW + (currentX - startX), min, max);
}

export interface ColumnResizeOptions {
  /** 起拖时读当前宽度. */
  getCurrent: () => number;
  /** mousemove 写新宽度. */
  setCurrent: (next: number) => void;
  min: number;
  max: number;
}

/**
 * 返回 mousedown handler,绑到拖拽 div。
 * 内部注册 document mousemove/mouseup,设 body cursor=col-resize 防误选文本。
 */
export function useColumnResize(opts: ColumnResizeOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { getCurrent, setCurrent, min, max } = optsRef.current;
    const startX = e.clientX;
    const startW = getCurrent();

    const onMove = (ev: MouseEvent) => {
      setCurrent(computeNewWidth(startX, startW, ev.clientX, min, max));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
}
