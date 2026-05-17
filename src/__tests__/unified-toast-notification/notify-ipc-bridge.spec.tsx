// topic-15 unified-toast-notification: renderer IPC bridge coApi ingress contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NotifyIpcBridge } from '@/notifications/NotifyIpcBridge';

const mocks = vi.hoisted(() => {
  let listener: ((payload: unknown) => void) | null = null;
  return {
    windowId: 7,
    notify: vi.fn(),
    unsubscribe: vi.fn(),
    onPush: vi.fn((cb: (payload: unknown) => void) => {
      listener = cb;
      return mocks.unsubscribe;
    }),
    emit(payload: unknown) {
      listener?.(payload);
    },
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: {
      get windowId() {
        return mocks.windowId;
      },
    },
    notify: {
      onPush: mocks.onPush,
    },
  },
}));

vi.mock('@/notifications/notify', () => ({
  notify: Object.assign(mocks.notify, {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  mocks.notify.mockClear();
  mocks.unsubscribe.mockClear();
  mocks.onPush.mockClear();
  mocks.windowId = 7;
});

describe('unified-toast-notification: NotifyIpcBridge', () => {
  it('T6 subscribes through coApi.notify.onPush and forwards payload with mirror=false', () => {
    const { unmount } = render(<NotifyIpcBridge />);

    expect(mocks.onPush).toHaveBeenCalledTimes(1);
    mocks.emit({
      level: 'error',
      message: 'from main',
      code: 'MAIN_FAIL',
    });

    expect(mocks.notify).toHaveBeenCalledWith('from main', 'error', {
      code: 'MAIN_FAIL',
      mirror: false,
    });

    unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('T6b passes matched windowId payloads', () => {
    render(<NotifyIpcBridge />);
    mocks.emit({
      level: 'warning',
      message: 'mine',
      code: 'MINE',
      windowId: 7,
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('T6b drops mismatched windowId payloads', () => {
    render(<NotifyIpcBridge />);
    mocks.emit({
      level: 'warning',
      message: 'other window',
      code: 'OTHER',
      windowId: 99,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('T6b passes broadcast payloads without windowId', () => {
    render(<NotifyIpcBridge />);
    mocks.emit({
      level: 'info',
      message: 'broadcast',
      code: 'ALL',
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
});
