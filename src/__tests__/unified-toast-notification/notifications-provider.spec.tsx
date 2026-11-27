// topic-15 unified-toast-notification: provider queue, timers, epoch, and de-dupe contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import {
  MAX_VISIBLE_NOTIFICATIONS,
  NotificationsProvider,
  useNotify,
} from '@/notifications/NotificationsProvider';
import { notify } from '@/notifications/notify';

interface ProbeState {
  readonly count: number;
  readonly ids: readonly string[];
  readonly messages: readonly string[];
  readonly createdAt: readonly number[];
  readonly counts: readonly number[];
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
    counts: api.notifications.map((n) => n.count ?? 1),
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

    // 同时可见上限 3(T21),每批不超过 3 条,各自从出现起计时。
    act(() => {
      notify.info('info');
      notify.warn('warning');
      notify.success('success');
    });
    expect(latest?.count).toBe(3);
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(latest?.count).toBe(0);

    act(() => {
      notify.error('error');
    });
    act(() => {
      vi.advanceTimersByTime(14_998);
    });
    expect(latest?.messages).toEqual(['error']);
    act(() => {
      vi.advanceTimersByTime(3);
    });
    expect(latest?.count).toBe(0);
  });

  // VSCode 通知同款:相同内容(同 level + 同 message)不再堆出多条 —— 只要还在列表里(显示中或排队中)就合并为一条、
  // 计数 +1 并刷新自动消失计时;error 同样合并(重命名冲突连按 5 次此前堆出 5 条相同 toast)。
  it('T5 同 level + 同 message 合并为一条:计数 +1、刷新计时(含 error);不同 level / message 不合并', () => {
    vi.useFakeTimers();
    renderProvider();

    act(() => {
      notify.error('dup', { code: 'FS_EEXIST' });
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
      notify.error('dup', { code: 'FS_EEXIST' });
      notify.error('dup', { code: 'FS_EEXIST' });
    });
    expect(latest?.messages).toEqual(['dup']);
    expect(latest?.counts).toEqual([3]);
    // 计时从最后一次合并起重新算:原本 15s 到期的时刻(再过 5s)仍在
    act(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(latest?.counts).toEqual([3]);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(latest?.count).toBe(0);

    act(() => {
      notify.info('same');
      notify.warn('same');
      notify.info('other');
    });
    expect(latest?.messages).toEqual(['same', 'same', 'other']);
    expect(latest?.counts).toEqual([1, 1, 1]);
  });

  // VSCode notificationsToasts:同时最多显示最新的 3 条;计时与是否可见无关(被挤到后面的照常到期,不等前面消失后再冒出来)。
  it('T21 计时从创建起算、与是否可见无关:第 4 条与前 3 条同时到期,不顺延', () => {
    vi.useFakeTimers();
    renderProvider();
    act(() => {
      notify.info('a');
      notify.info('b');
      notify.info('c');
      notify.info('d');
    });
    expect(MAX_VISIBLE_NOTIFICATIONS).toBe(3);
    expect(latest?.messages).toEqual(['a', 'b', 'c', 'd']);
    act(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(latest?.count).toBe(0);
  });

  it('T21b 被挤到后面的错误到期前,前面更新的消失 → 它仍在列表里(重新可见),到自己的时刻才消失', () => {
    vi.useFakeTimers();
    renderProvider();
    act(() => {
      notify.error('e1');
      notify.info('i1');
      notify.info('i2');
      notify.info('i3');
    });
    act(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(latest?.messages).toEqual(['e1']);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(latest?.count).toBe(0);
  });

  it('T21c 带按钮的通知常驻:被更新的挤掉也不计时、不丢失', () => {
    vi.useFakeTimers();
    renderProvider();
    act(() => {
      notify.error('save failed', { actions: [{ label: 'Retry', run: () => {} }] });
      notify.info('i1');
      notify.info('i2');
      notify.info('i3');
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(latest?.messages).toEqual(['save failed']);
  });

  it('T21d 合并的重复通知移到最新(被挤掉的重复报错重新可见)', () => {
    vi.useFakeTimers();
    renderProvider();
    act(() => {
      notify.error('dup');
      notify.info('a');
      notify.info('b');
      notify.info('c');
    });
    act(() => {
      notify.error('dup');
    });
    expect(latest?.messages).toEqual(['a', 'b', 'c', 'dup']);
    expect(latest?.counts).toEqual([1, 1, 1, 2]);
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
});
