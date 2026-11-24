// topic-15 unified-toast-notification: Provider + ToastViewport DOM rendering contract. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import {
  ToastViewport,
  selectVisibleNotifications,
} from '@/notifications/ToastViewport';
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

  it('dismiss label 在 viewport 计算一次并传给每条 toast', () => {
    const viewportSrc = readFileSync('src/notifications/ToastViewport.tsx', 'utf8');
    const toastSrc = readFileSync('src/notifications/Toast.tsx', 'utf8');

    expect(viewportSrc).toContain("const dismissLabel = t('notifications.dismiss');");
    expect(viewportSrc).toContain('dismissLabel={dismissLabel}');
    expect(toastSrc).toContain('readonly dismissLabel: string;');
    expect(toastSrc).toContain('aria-label={dismissLabel}');
    expect(toastSrc).not.toContain("useT");
    expect(toastSrc).not.toContain("aria-label={t('notifications.dismiss')}");
  });

  it('空通知视口不渲染 toast 容器,外壳不订阅 i18n 翻译 hook(常驻的只有播报 live region)', () => {
    const viewportSrc = readFileSync('src/notifications/ToastViewport.tsx', 'utf8');
    const shellStart = viewportSrc.indexOf('export function ToastViewport()');
    const contentStart = viewportSrc.indexOf('function ToastViewportContent');
    const shellSrc = viewportSrc.slice(shellStart, contentStart);

    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(contentStart).toBeGreaterThan(shellStart);
    expect(shellSrc).toContain('notifications.length === 0 ? null');
    expect(shellSrc).not.toContain('useT(');
    expect(viewportSrc.indexOf('const t = useT();')).toBeGreaterThan(contentStart);

    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    expect(document.querySelector('.toast-viewport')).toBeNull();
  });

  // 错误码不作为正文显示(此前「已存在 [FS_EEXIST]」);保留在 title(悬停可见)与 data-code,供支持排错。
  it('T12 正文只显示 message;错误码在 title / data-code,不进正文', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('rendered toast', { code: 'TEST' });
    });

    const toast = document.querySelector<HTMLElement>('.toast')!;
    expect(toast.textContent).toContain('rendered toast');
    expect(toast.textContent).not.toContain('TEST');
    expect(toast.querySelector('.toast__code')).toBeNull();
    expect(toast.dataset.code).toBe('TEST');
    expect(toast.querySelector<HTMLElement>('.toast__message')!.title).toBe('rendered toast (TEST)');
  });

  it('T22 合并的 toast 显示次数(×N);只有一次时不显示', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => {
      notify.error('dup');
    });
    expect(document.querySelector('.toast__count')).toBeNull();
    act(() => {
      notify.error('dup');
      notify.error('dup');
    });
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
    expect(document.querySelector('.toast__count')!.textContent).toBe('×3');
  });

  // a11y(A60):级别语义由播报的 live region 承担(error → assertive,其余 → polite,见 toast-live-announcer T26);
  // toast 元素本身不再是 role=alert / status(否则合并时整条带「×N 关闭」重读、排队项不播报)。
  it('T13 toast 以 data-level 标级别,自身不是 live region', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => {
      notify.info('just info');
      notify.error('boom');
    });
    const toasts = [...document.querySelectorAll<HTMLElement>('.toast')];
    expect(toasts.map((el) => el.dataset.level)).toEqual(['info', 'error']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('可见 toast 列表不通过 notifications.slice 构建', () => {
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
      expect(readFileSync('src/notifications/ToastViewport.tsx', 'utf-8')).not.toContain(
        'visible.push(',
      );
      // 同时最多显示 3 条(VSCode 同款),其余排队:先显示最早的三条
      expect(document.querySelectorAll('.toast')).toHaveLength(3);
      expect(screen.getByText('boom-0')).toBeTruthy();
      expect(screen.queryByText('boom-3')).toBeNull();
    } finally {
      sliceSpy.mockRestore();
    }
  });

  it('通知数未超过可见上限 → 复用原数组引用', () => {
    const notifications = [
      { id: 'notif-1' },
      { id: 'notif-2' },
    ];

    expect(selectVisibleNotifications(notifications)).toBe(notifications);
  });
});
