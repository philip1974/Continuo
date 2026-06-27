// topic 49 · 审计 P2-C: NotificationsProvider 底层数组硬上限。
// error 级不 dedupe + 存活 15s,突发会无界堆积;push 时超上限丢最旧。
// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  NotificationsProvider,
  MAX_NOTIFICATIONS,
  useNotify,
} from '@/notifications/NotificationsProvider';
import { notify } from '@/notifications/notify';

let snapshot: { count: number; messages: readonly string[] } | null = null;

function Probe(): React.ReactElement {
  const api = useNotify();
  snapshot = {
    count: api.notifications.length,
    messages: api.notifications.map((n) => n.message),
  };
  return <div>{api.notifications.length}</div>;
}

afterEach(() => {
  vi.useRealTimers();
  snapshot = null;
  cleanup();
});

describe('topic 49 · notifications 底层数组上限', () => {
  it('error 突发超过上限 → 数组截断到 MAX_NOTIFICATIONS,保留最新', () => {
    vi.useFakeTimers();
    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );

    const total = MAX_NOTIFICATIONS + 20;
    act(() => {
      for (let i = 0; i < total; i++) {
        // error 级不参与 dedupe,且 message 各不相同 → 每条都是新条目
        notify.error(`err-${i}`, { code: `E${i}` });
      }
    });

    expect(snapshot?.count).toBe(MAX_NOTIFICATIONS);
    // 保留的是最新的 MAX_NOTIFICATIONS 条,最旧的 err-0 已被丢弃
    expect(snapshot?.messages).toContain(`err-${total - 1}`);
    expect(snapshot?.messages).not.toContain('err-0');
  });

  it('超过上限时不通过 slice 复制截断通知数组', () => {
    vi.useFakeTimers();
    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );
    const sliceSpy = vi.spyOn(Array.prototype, 'slice');

    try {
      act(() => {
        for (let i = 0; i < MAX_NOTIFICATIONS + 3; i++) {
          notify.error(`err-${i}`, { code: `E${i}` });
        }
      });
      const notificationSliceCalls = sliceSpy.mock.contexts.filter(
        (ctx) =>
          Array.isArray(ctx) &&
          ctx.length > MAX_NOTIFICATIONS &&
          ctx.every(
            (item) =>
              typeof (item as { id?: unknown }).id === 'string' &&
              ((item as { id: string }).id).startsWith('notif-'),
          ),
      ).length;

      expect(notificationSliceCalls).toBe(0);
      expect(snapshot?.count).toBe(MAX_NOTIFICATIONS);
    } finally {
      sliceSpy.mockRestore();
    }
  });
});
