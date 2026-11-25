// @vitest-environment jsdom
// 图片预览缩放(对齐 VSCode media-preview imagePreview):初始「适应」;单击放大、⌥单击缩小(按档位);⌘ / ⌃ 滚轮与
// 触控板捏合(ctrlKey wheel)连续缩放;0 / ⌘0 回适应,+ / - 按档位;放大超过 100% 像素化;比例 10%–2000%;
// 右下角显示当前比例(适应时为本地化的「整个图像」)。行为见同目录 README。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageViewer } from '../../panels/Editor/ImageViewer';
import { t } from '../../i18n';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const mocks = vi.hoisted(() => ({ readImage: vi.fn() }));
vi.mock('../../lib/co-api', () => ({ coApi: { fs: { readImage: mocks.readImage } } }));

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  mocks.readImage.mockResolvedValue({ ok: true, data: { dataUrl: DATA_URL, size: 2048 } });
});
afterEach(cleanup);

/** 渲染并加载一张 640x480 的图,适应时显示宽 320(适应比例 50%)。 */
async function loaded() {
  const { container } = render(<ImageViewer tabId="/w/a.png" filePath="/w/a.png" />);
  await act(async () => {
    await Promise.resolve();
  });
  const viewer = container.querySelector<HTMLElement>('[data-image-viewer]')!;
  const img = viewer.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 640 });
  Object.defineProperty(img, 'naturalHeight', { value: 480 });
  Object.defineProperty(img, 'clientWidth', { configurable: true, value: 320 });
  fireEvent.load(img);
  return { viewer, img };
}

const zoomLabel = () => screen.getByText(/640x480/).textContent ?? '';

describe('图片预览缩放', () => {
  it('初始为适应:按比例缩小适应(max-w/max-h),角落显示「整个图像」;光标为放大镜', async () => {
    const { viewer, img } = await loaded();
    expect(img.style.width).toBe('');
    expect(img.className).toContain('max-w-full');
    expect(zoomLabel()).toContain(t('editor.image.zoom_fit'));
    expect(viewer.style.cursor).toBe('zoom-in');
  });

  it('单击放大到下一档(从适应比例 50% 起 → 60%);⌥单击缩小一档(→ 50%)', async () => {
    const { viewer, img } = await loaded();
    fireEvent.click(img, { button: 0 });
    expect(img.style.width).toBe('384px');
    expect(img.style.height).toBe('288px');
    expect(zoomLabel()).toContain('60%');
    fireEvent.click(img, { button: 0, altKey: true });
    expect(zoomLabel()).toContain('50%');
    // 按住 ⌥ 时光标为缩小镜
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    expect(viewer.style.cursor).toBe('zoom-out');
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(viewer.style.cursor).toBe('zoom-in');
  });

  it('⌘ / ⌃ 滚轮(触控板捏合 = ctrlKey wheel)连续缩放;不带修饰键的滚轮不缩放(照常滚动)', async () => {
    const { viewer } = await loaded();
    fireEvent.wheel(viewer, { deltaY: 10 });
    expect(zoomLabel()).toContain(t('editor.image.zoom_fit'));
    const up = new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      viewer.dispatchEvent(up);
    });
    expect(up.defaultPrevented).toBe(true);
    expect(zoomLabel()).toMatch(/54%/); // 50% × 1.075
    act(() => {
      viewer.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(zoomLabel()).toMatch(/50%/);
  });

  it('键盘:+ / = 放大、- 缩小、0 与 ⌘0 回适应', async () => {
    const { viewer } = await loaded();
    fireEvent.keyDown(viewer, { key: '+' });
    expect(zoomLabel()).toContain('60%');
    fireEvent.keyDown(viewer, { key: '=' });
    expect(zoomLabel()).toContain('70%');
    fireEvent.keyDown(viewer, { key: '-' });
    expect(zoomLabel()).toContain('60%');
    fireEvent.keyDown(viewer, { key: '0' });
    expect(zoomLabel()).toContain(t('editor.image.zoom_fit'));
    fireEvent.keyDown(viewer, { key: '+' });
    fireEvent.keyDown(viewer, { key: '0', metaKey: true, ctrlKey: true });
    expect(zoomLabel()).toContain(t('editor.image.zoom_fit'));
  });

  it('超过 100% 像素化显示;比例封顶 2000%、下限 10%', async () => {
    const { viewer, img } = await loaded();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(viewer, { key: '+' }); // 60 70 80 90 100
    expect(zoomLabel()).toContain('100%');
    expect(img.style.imageRendering).not.toBe('pixelated');
    fireEvent.keyDown(viewer, { key: '+' });
    expect(zoomLabel()).toContain('150%');
    expect(img.style.imageRendering).toBe('pixelated');
    for (let i = 0; i < 20; i++) fireEvent.keyDown(viewer, { key: '+' });
    expect(zoomLabel()).toContain('2000%');
    for (let i = 0; i < 40; i++) fireEvent.keyDown(viewer, { key: '-' });
    expect(zoomLabel()).toContain('10%');
  });

  it('「整个图像」三语都有', () => {
    expect(en['editor.image.zoom_fit']).toBe('Whole Image');
    expect(zh['editor.image.zoom_fit']).toBe('整个图像');
    expect(ko['editor.image.zoom_fit']).toBe('전체 이미지');
  });
});
