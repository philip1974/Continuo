// topic-15 unified-toast-notification: provider queue, timers, epoch, and de-dupe contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  NotificationsProvider,
  useNotify,
} from '@/notifications/NotificationsProvider';
import { notify } from '@/notifications/notify';

interface ProbeState {
  readonly count: number;
  readonly ids: readonly string[];
  readonly messages: readonly string[];
  readonly createdAt: readonly number[];
  readonly dismiss: (id: string) => void;
}

let latest: ProbeState | null = null;

function Probe() {
  const api = useNotify();
  latest = {
    count: api.notifications.length,
    ids: api.notifications.map((n) => n.id),
    messages: api.notifications.map((n) => n.message),
    createdAt: api.notifications.map((n) => n.createdAt),
    dismiss: api.dismiss,
  };
  return (
    <div data-testid="count">{api.notifications.length}</div>
  );
}

function renderProvider() {
  return render(
    <NotificationsProvider>
      <Probe />
    </NotificationsProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  latest = null;
  cleanup();
});

describe('unified-toast-notification: NotificationsProvider', () => {
  it('T1 queues notifications, dismisses by id, and clears timer state safely', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      notify.info('queued', { code: 'INFO_1' });
    });
    expect(latest?.count).toBe(1);
    const id = latest?.ids[0];
    expect(id).toBeTruthy();

    act(() => {
      latest?.dismiss(id!);
      vi.advanceTimersByTime(6000);
    });
    expect(latest?.count).toBe(0);
  });

  it('T1b old Provider unmount does not clear the newer Provider handle', () => {
    vi.useFakeTimers();
    const first = renderProvider();
    const firstId = latest?.ids[0] ?? 'none';

    const second = renderProvider();
    first.unmount();

    act(() => {
      notify.info('after-remount', { code: 'EPOCH' });
    });
    expect(latest?.messages).toContain('after-remount');
    expect(latest?.ids[0]).not.toBe(firstId);
    second.unmount();
  });

  it('T4 auto-dismisses info/warning/success after 5000ms and error after 15000ms', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      notify.info('info');
      notify.warn('warning');
      notify.success('success');
      notify.error('error');
    });
    expect(latest?.count).toBe(4);

    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(latest?.messages).toEqual(['error']);

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(latest?.count).toBe(0);
  });

  it('T5 de-dupes non-error code+message inside 1000ms, but never de-dupes error', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      notify.info('same', { code: 'SAME' });
    });
    const firstCreatedAt = latest?.createdAt[0];
    act(() => {
      vi.advanceTimersByTime(500);
      notify.info('same', { code: 'SAME' });
    });
    expect(latest?.count).toBe(1);
    expect(latest?.createdAt[0]).toBeGreaterThanOrEqual(firstCreatedAt ?? 0);

    act(() => {
      notify.error('same-error', { code: 'SAME_ERROR' });
      notify.error('same-error', { code: 'SAME_ERROR' });
    });
    expect(latest?.messages.filter((m) => m === 'same-error')).toHaveLength(2);
  });
});
