// topic-15 unified-toast-notification: renderer IPC bridge coApi ingress contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NotifyIpcBridge } from '@/notifications/NotifyIpcBridge';
import {
  isNotifyPushPayload,
  NOTIFY_PARAMS_MAX_KEYS,
} from '../../../electron/shared/notify-channels';

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

  // 边界(E168,IPC ingress 纵深防御):畸形 notify:push payload runtime 校验失败 → drop + warn,
  // 不进 notify 队列、不抛。
  it('E168 畸形 payload(null/非对象/非法 level/超长 message/畸形 params/非安全 windowId)→ drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<NotifyIpcBridge />);
    const bad: unknown[] = [
      null,
      'a string',
      42,
      [],
      { level: 'bogus', message: 'x' }, // 非法 level
      { level: 'info', message: 'x'.repeat(4097) }, // 超长 message
      { level: 'info', code: 'C'.repeat(257), message: 'ok' }, // 超长 code
      { level: 'info', message: 'ok', params: 'not-object' }, // 畸形 params
      { level: 'info', message: 'ok', params: { k: {} } }, // params 值非 string/number
      { level: 'info', message: 'ok', windowId: 1.5 }, // 非安全整数 windowId
      { level: 'info', message: 'ok', windowId: -1 }, // 负 windowId
    ];
    for (const p of bad) mocks.emit(p);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('E168 合规 params(string/number 值)→ 正常转发(回归)', () => {
    render(<NotifyIpcBridge />);
    mocks.emit({
      level: 'success',
      message: 'ok',
      code: 'OK',
      params: { path: '/x', count: 3 },
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  // 边界(E213,E197/E199 有界迭代族):isValidParams 单次 for...in 边计数边校验,不先 Object.keys 把
  // 畸形 notify:push params 全量物化再判 NOTIFY_PARAMS_MAX_KEYS。直接测导出的 isNotifyPushPayload。
  it('E213 params key 数超 NOTIFY_PARAMS_MAX_KEYS → false,且不 Object.keys 全量物化', () => {
    const params: Record<string, number> = {};
    for (let i = 0; i <= NOTIFY_PARAMS_MAX_KEYS; i++) params[`k${i}`] = 1; // MAX+1 keys
    const spy = vi.spyOn(Object, 'keys');
    const ok = isNotifyPushPayload({ level: 'info', params });
    // 只看以含 'k0' 的 params 对象为参的 Object.keys 调用(免并行污染)
    const materialized = spy.mock.calls.some(
      (c) => c[0] != null && typeof c[0] === 'object' && 'k0' in (c[0] as object),
    );
    spy.mockRestore();
    expect(ok).toBe(false); // 超上限 → drop
    expect(materialized).toBe(false); // for...in,不对 params 调 Object.keys(中和回 → true,失败)
  });

  it('E213 params 恰好 NOTIFY_PARAMS_MAX_KEYS 合法 → true(边界回归)', () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < NOTIFY_PARAMS_MAX_KEYS; i++) params[`k${i}`] = 1;
    expect(isNotifyPushPayload({ level: 'info', params })).toBe(true);
  });
});
