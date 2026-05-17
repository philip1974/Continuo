// topic-15 unified-toast-notification: Provider + ToastViewport DOM rendering contract. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';

afterEach(() => cleanup());

describe('unified-toast-notification: DOM rendering', () => {
  it('T12 renders a status toast containing message and code without rendering full App', () => {
    render(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('rendered toast', { code: 'TEST' });
    });

    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('rendered toast');
    expect(toast.textContent).toContain('TEST');
  });
});
