// @vitest-environment jsdom
// 打磨 R37(codex 一致性/a11y/i18n):Toast 关闭按钮原先 aria-label="dismiss" 硬编码
// 英文,zh/ko 下屏幕阅读器读到英文。补 notifications.dismiss 到 en/zh/ko + 走 useT()。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import { NotificationsProvider } from '../../notifications/NotificationsProvider';
import { ToastViewport } from '../../notifications/ToastViewport';
import { notify } from '../../notifications/notify';
import { setLocale } from '../../i18n';

afterEach(() => {
  setLocale('en');
  cleanup();
  vi.restoreAllMocks();
});

describe('打磨 R37 — Toast 关闭按钮 a11y i18n', () => {
  it('zh locale → aria-label 为「关闭」,非 dismiss', () => {
    setLocale('zh');
    const { container } = render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => notify.info('hi'));
    const btn = container.querySelector('.toast__dismiss')!;
    expect(btn.getAttribute('aria-label')).toBe('关闭');
  });

  it('en locale → aria-label 为「Dismiss」', () => {
    setLocale('en');
    const { container } = render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => notify.info('hi'));
    const btn = container.querySelector('.toast__dismiss')!;
    expect(btn.getAttribute('aria-label')).toBe('Dismiss');
  });
});
