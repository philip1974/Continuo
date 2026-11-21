// topic-15 unified-toast-notification: public notify API mirror and no-provider contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  NotificationsProvider,
  useNotify,
} from '@/notifications/NotificationsProvider';
import { notify } from '@/notifications/notify';
import {
  NOTIFY_MESSAGE_MAX,
  NOTIFY_CODE_MAX,
} from '../../../electron/shared/notify-channels';

let seenLevels: string[] = [];
let seenCount = 0;
let seenMessages: string[] = [];

function Probe() {
  const api = useNotify();
  seenLevels = api.notifications.map((n) => n.level);
  seenCount = api.notifications.length;
  seenMessages = api.notifications.map((n) => n.message);
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  seenLevels = [];
  seenCount = 0;
  seenMessages = [];
  cleanup();
});

describe('unified-toast-notification: notify public API', () => {
  it("T2 exposes four sugar functions and maps warn to internal 'warning'", () => {
    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('e');
      notify.warn('w');
      notify.info('i');
      notify.success('s');
    });

    expect(seenLevels).toEqual(['error', 'warning', 'info', 'success']);
  });

  it('T3 mirrors to console by default based on notification level', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('e', { code: 'E' });
      notify.warn('w', { code: 'W' });
      notify.info('i', { code: 'I' });
      notify.success('s', { code: 'S' });
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0]?.join(' ')).toContain('e');
  });

  it('T3b mirror=false suppresses console output but still enqueues', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('quiet', { code: 'QUIET', mirror: false });
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(seenCount).toBe(1);
  });

  // 边界(E311):本地 notify 路径与 IPC-push / SDK 对称限长 —— 超长 message/code 截断到
  // NOTIFY_MESSAGE_MAX/NOTIFY_CODE_MAX,防 err.message 等超长串进 console mirror + Toast DOM 放大。
  it('E311 超长 message/code → 截断到上限(console mirror + 入队 Toast 均截断)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );

    act(() => {
      notify.error('x'.repeat(NOTIFY_MESSAGE_MAX + 1000), {
        code: 'c'.repeat(NOTIFY_CODE_MAX + 100),
      });
    });

    // console mirror:console.error(prefix, message) —— message 截断到 NOTIFY_MESSAGE_MAX,prefix=[code] 截断。
    const [prefix, message] = errorSpy.mock.calls[0] as [string, string];
    // neutralize 敏感:去 notifyCore 截断则 message.length = MAX+1000。
    expect(message.length).toBe(NOTIFY_MESSAGE_MAX);
    expect(prefix.length).toBe(NOTIFY_CODE_MAX + 2); // "[" + code(截断) + "]"
    // 入队 Toast 的 message 同样截断。
    expect(seenMessages[0]?.length).toBe(NOTIFY_MESSAGE_MAX);
  });

  it('E311 上限内 message → 原样(回归)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );
    act(() => {
      notify.error('short msg', { code: 'OK' });
    });
    expect(seenMessages[0]).toBe('short msg');
    expect(errorSpy.mock.calls[0]?.[1]).toBe('short msg');
  });

  it('T3c before provider mount: does not throw, mirrors console, and does not buffer stale messages', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => notify.error('pre-mount', { code: 'PRE' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    render(
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>,
    );
    expect(seenCount).toBe(0);

    act(() => {
      notify.error('post-mount', { code: 'POST', mirror: false });
    });
    expect(seenCount).toBe(1);
  });
});
