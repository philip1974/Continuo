// topic-15 unified-toast-notification: Provider + ToastViewport DOM rendering contract. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';

afterEach(() => cleanup());

describe('unified-toast-notification: DOM rendering', () => {
  // a11y(A114):toast 容器须 role=region + 命名,使 aria-label 生效形成可导航通知区域。
  it('T14 toast viewport 是命名的 role=region', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => {
      notify.info('hi');
    });
    const region = document.querySelector('.toast-viewport');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('region');
    expect((region!.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
  });

  it('T12 renders a toast containing message and code without rendering full App', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('rendered toast', { code: 'TEST' });
    });

    // a11y(A60):error toast 须 role=alert(assertive),非普通 status。
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('rendered toast');
    expect(toast.textContent).toContain('TEST');
  });

  // a11y(A60):非错误(info/success/warning)toast 仍 role=status(polite);error 是 alert。
  it('T13 non-error toast is role=status; error toast is role=alert', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => {
      notify.info('just info');
    });
    expect(screen.getByRole('status').textContent).toContain('just info');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      notify.error('boom');
    });
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });

  it('可见 toast 列表不通过 notifications.slice(-limit) 构建', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    const sliceSpy = vi.spyOn(Array.prototype, 'slice');

    try {
      act(() => {
        for (let i = 0; i < 6; i++) {
          notify.error(`boom-${i}`, { code: `E${i}` });
        }
      });
      const notificationSliceCalls = sliceSpy.mock.contexts.filter(
        (ctx) =>
          Array.isArray(ctx) &&
          ctx.length > 5 &&
          ctx.every(
            (item) =>
              typeof (item as { id?: unknown }).id === 'string' &&
              (item as { id: string }).id.startsWith('notif-'),
          ),
      ).length;

      expect(notificationSliceCalls).toBe(0);
      expect(screen.getAllByRole('alert')).toHaveLength(5);
      expect(screen.queryByText('boom-0')).toBeNull();
      expect(screen.getByText(/boom-5/)).toBeTruthy();
    } finally {
      sliceSpy.mockRestore();
    }
  });
});
