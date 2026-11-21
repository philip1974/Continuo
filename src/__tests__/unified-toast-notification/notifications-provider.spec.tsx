// topic-15 unified-toast-notification: provider queue, timers, epoch, and de-dupe contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
let slimApi: ReturnType<typeof useNotify> | null = null;

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

function SlimProbe() {
  const api = useNotify();
  slimApi = api;
  return <div data-testid="count">{api.notifications.length}</div>;
}

function renderSlimProvider() {
  return render(
    <NotificationsProvider>
      <SlimProbe />
    </NotificationsProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  latest = null;
  slimApi = null;
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

  it('dismiss 唯一通知回到空队列时复用稳定空列表', () => {
    vi.useFakeTimers();
    renderSlimProvider();

    act(() => {
      notify.info('first');
    });
    const firstId = slimApi?.notifications[0]?.id;
    expect(firstId).toBeTruthy();

    act(() => {
      slimApi?.dismiss(firstId!);
    });
    const emptyAfterFirstDismiss = slimApi?.notifications;
    expect(emptyAfterFirstDismiss).toEqual([]);

    act(() => {
      notify.info('second');
    });
    const secondId = slimApi?.notifications[0]?.id;
    expect(secondId).toBeTruthy();

    act(() => {
      slimApi?.dismiss(secondId!);
    });
    expect(slimApi?.notifications).toBe(emptyAfterFirstDismiss);
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

  // race(R13):同一事件循环内连续两次同源非 error notify 也须去重 —— 去重读 notificationsRef,
  // 此前 ref 仅在 setNotifications updater(延迟到 render)才更新,同 tick 第二次看不到第一条
  // pending → 绕过去重各自入队。修复后 notify 同步更新 ref,同 tick 也去重。
  it('R13 同一 tick 连续两次同源 notify → 去重为 1(不绕过 DEDUPE)', () => {
    vi.useFakeTimers();
    renderProvider();

    // 关键:两次 notify 在同一个 act/tick 内,中间不 flush re-render(ref 未经 updater 更新)。
    act(() => {
      notify.success('dup-same', { code: 'DUP' });
      notify.success('dup-same', { code: 'DUP' });
    });

    expect(latest?.messages.filter((m) => m === 'dup-same')).toHaveLength(1);
    expect(latest?.count).toBe(1);
  });

  // race(R104,R13 对偶):同一 tick 内 dismiss(id) 后紧接同源 non-error notify。dismiss 此前只在
  // setNotificationList 的 updater(延迟)里更新 ref,同 tick 第二次 notify 的 dedupe 从旧 ref 仍看到
  // 那条「已关闭」通知 → 走 dedupe 分支,新通知既不新增也不复活(map updater 在 filter updater 后跑,
  // existing.id 已不在 prev → no-op)被吞掉。修复后 dismiss 同步更新 ref,新通知正常入队。
  it('R104 同 tick 内 dismiss 后再同源 notify → 新通知不被吞(dismiss 同步更新 ref)', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      notify.success('reopen', { code: 'RE' });
    });
    expect(latest?.count).toBe(1);
    const firstId = latest?.ids[0];
    expect(firstId).toBeTruthy();

    // 关键:dismiss + 同源 notify 在同一 act/tick 内,中间不 flush(ref 未经 updater 更新)。
    act(() => {
      latest?.dismiss(firstId!);
      notify.success('reopen', { code: 'RE' });
    });

    // 新通知必须存在且是新 id —— 未被旧 ref 里已关闭通知 dedupe 吞掉。
    expect(latest?.messages).toContain('reopen');
    expect(latest?.count).toBe(1);
    expect(latest?.ids[0]).not.toBe(firstId);
  });

  it('dismiss / auto-dismiss 不通过 filter 复制通知数组', () => {
    vi.useFakeTimers();
    renderSlimProvider();
    act(() => {
      notify.info('a');
      notify.info('b');
    });
    const firstId = slimApi?.notifications[0]?.id;
    expect(firstId).toBeTruthy();
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      act(() => {
        slimApi?.dismiss(firstId!);
        vi.advanceTimersByTime(5001);
      });
      const notificationFilterCalls = filterSpy.mock.contexts.filter(
        (ctx) =>
          Array.isArray(ctx) &&
          ctx.every(
            (item) =>
              typeof (item as { id?: unknown }).id === 'string' &&
              (item as { id: string }).id.startsWith('notif-'),
          ),
      ).length;

      expect(notificationFilterCalls).toBe(0);
      expect(readFileSync('src/notifications/NotificationsProvider.tsx', 'utf-8')).not.toContain(
        'next.push(',
      );
      expect(slimApi?.notifications.length).toBe(0);
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('dedupe 刷新 createdAt 不通过 map 复制通知数组', () => {
    vi.useFakeTimers();
    renderSlimProvider();
    act(() => {
      notify.info('same', { code: 'SAME' });
    });
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      act(() => {
        vi.advanceTimersByTime(500);
        notify.info('same', { code: 'SAME' });
      });
      const notificationMapCalls = mapSpy.mock.contexts.filter(
        (ctx) =>
          Array.isArray(ctx) &&
          ctx.every(
            (item) =>
              typeof (item as { id?: unknown }).id === 'string' &&
              (item as { id: string }).id.startsWith('notif-'),
          ),
      ).length;

      // React/test rendering may inspect the notification array; the old provider
      // dedupe path added one extra prev.map call on top of that baseline.
      expect(notificationMapCalls).toBeLessThanOrEqual(2);
      expect(readFileSync('src/notifications/NotificationsProvider.tsx', 'utf-8')).not.toContain(
        'next.push(',
      );
      expect(slimApi?.notifications.length).toBe(1);
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('dedupe 命中但 createdAt 未变化时复用通知列表引用', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    renderSlimProvider();

    act(() => {
      notify.info('same-tick', { code: 'SAME_TICK' });
    });
    const firstRef = slimApi?.notifications;

    act(() => {
      notify.info('same-tick', { code: 'SAME_TICK' });
    });

    expect(slimApi?.notifications).toBe(firstRef);
    expect(slimApi?.notifications.length).toBe(1);
  });
});
