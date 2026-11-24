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

  // 边界(E52,插件 API 输入校验):非字符串 / 空 message 不渲染、非字符串 code 丢弃。限长(超长 message 截断、超长 /
  // 空 code 丢弃)统一在 notify 唯一入口 notifyCore(见 unified-toast-notification 的 E311 规范),此处原样转交 ——
  // 此前 co-app 另有一份限长且超长 code 规则与 notifyCore 相反(丢弃 vs 截断)。
  describe('E52 · 输入校验', () => {
    it('超长 message / code → 原样交给 notify(限长由 notifyCore 统一处理)', () => {
      coApp.notifications.show({ kind: 'info', message: 'x'.repeat(5000), code: 'c'.repeat(257) });
      expect(notifyMock).toHaveBeenCalledWith('x'.repeat(5000), 'info', { code: 'c'.repeat(257) });
    });

    it('非字符串 message → 不调 notify', () => {
      coApp.notifications.show({
        kind: 'info',
        message: { evil: true } as never,
      });
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it('空 message → 不调 notify', () => {
      coApp.notifications.show({ kind: 'info', message: '' });
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it('非字符串 code → 丢弃', () => {
      coApp.notifications.show({
        kind: 'error',
        message: 'ok',
        code: 123 as never,
      });
      expect(notifyMock).toHaveBeenCalledWith('ok', 'error', undefined);
    });
  });

  // 边界(E271,E52 续 / 对象形态守卫):opts 为插件直传,JS 插件可传 null/undefined/非对象。解构前必先
  // 判对象形态,否则 `{ kind, message, code }` 解构 null/非对象抛 TypeError 冒泡到插件激活/命令执行。
  describe('E271 · 非对象 opts 守卫', () => {
    it.each([null, undefined, 42, 'str', true, [1, 2]])(
      '非对象 opts(%s)→ 静默丢弃,不抛、不调 notify',
      (bad) => {
        expect(() =>
          coApp.notifications.show(bad as never),
        ).not.toThrow();
        expect(notifyMock).not.toHaveBeenCalled();
      },
    );

    it('合法对象 opts 仍正常(回归)', () => {
      coApp.notifications.show({ kind: 'info', message: 'ok' });
      expect(notifyMock).toHaveBeenCalledWith('ok', 'info', undefined);
    });
  });
});
