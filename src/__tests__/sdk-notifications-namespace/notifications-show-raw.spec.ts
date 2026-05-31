import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock('@/notifications/notify', () => ({
  notify: notifyMock,
}));

import { coApp } from '../../plugins/co-app';

beforeEach(() => {
  notifyMock.mockClear();
});

describe('app.notifications.show raw namespace', () => {
  it('T5 dispatches all supported notification kinds to notify()', () => {
    const kinds = ['info', 'warning', 'error', 'success'] as const;

    for (const kind of kinds) {
      coApp.notifications.show({ kind, message: `${kind} message` });
    }

    expect(notifyMock).toHaveBeenCalledTimes(4);
    expect(notifyMock).toHaveBeenNthCalledWith(
      1,
      'info message',
      'info',
      undefined,
    );
    expect(notifyMock).toHaveBeenNthCalledWith(
      2,
      'warning message',
      'warning',
      undefined,
    );
    expect(notifyMock).toHaveBeenNthCalledWith(
      3,
      'error message',
      'error',
      undefined,
    );
    expect(notifyMock).toHaveBeenNthCalledWith(
      4,
      'success message',
      'success',
      undefined,
    );
  });

  it('T6 forwards code as notify opts when present', () => {
    coApp.notifications.show({
      kind: 'error',
      message: 'X failed',
      code: 'X_FAIL',
    });

    expect(notifyMock).toHaveBeenCalledWith('X failed', 'error', {
      code: 'X_FAIL',
    });
  });

  it('T7 falls back to info for an unknown runtime kind', () => {
    coApp.notifications.show({
      kind: 'bogus' as never,
      message: 'runtime input',
    });

    expect(notifyMock).toHaveBeenCalledWith(
      'runtime input',
      'info',
      undefined,
    );
  });

  it('T8 does not allocate notify opts when code is undefined', () => {
    coApp.notifications.show({
      kind: 'info',
      message: 'plain',
      code: undefined,
    });

    expect(notifyMock).toHaveBeenCalledWith('plain', 'info', undefined);
  });
});
