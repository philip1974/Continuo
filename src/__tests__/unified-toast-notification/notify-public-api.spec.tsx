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

let seenLevels: string[] = [];
let seenCount = 0;

function Probe() {
  const api = useNotify();
  seenLevels = api.notifications.map((n) => n.level);
  seenCount = api.notifications.length;
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  seenLevels = [];
  seenCount = 0;
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
