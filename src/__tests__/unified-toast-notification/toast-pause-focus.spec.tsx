// @vitest-environment jsdom
// BDD:toast 悬停 / 焦点在内时暂停自动消失,离开后按剩余时间续算;toast 卸载时若焦点在其内,还给进入前的元素。见同目录 README T15-T17。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderApp() {
  return render(
    <NotificationsProvider>
      <button type="button">outside</button>
      <ToastViewport />
    </NotificationsProvider>,
  );
}

const toastEl = () => document.querySelector('.toast');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('toast 悬停暂停', () => {
  it('T15 悬停期间不消失,离开后按剩余时间续算', () => {
    renderApp();
    act(() => notify.info('long message'));
    advance(4000);
    fireEvent.mouseEnter(toastEl()!);
    advance(20000);
    expect(toastEl()).not.toBeNull();
    fireEvent.mouseLeave(toastEl()!);
    advance(999);
    expect(toastEl()).not.toBeNull();
    advance(1);
    expect(toastEl()).toBeNull();
  });

  it('T15b 暂停期间同源 notify 去重刷新,不会重新起计时', () => {
    renderApp();
    act(() => notify.info('same'));
    fireEvent.mouseEnter(toastEl()!);
    act(() => notify.info('same'));
    advance(20000);
    expect(screen.getAllByText('same')).toHaveLength(1);
    fireEvent.mouseLeave(toastEl()!);
    advance(4999);
    expect(toastEl()).not.toBeNull();
    advance(1);
    expect(toastEl()).toBeNull();
  });
});

describe('toast 焦点暂停与焦点还原', () => {
  it('T16 焦点在 toast 内时暂停;仅鼠标离开不恢复计时', () => {
    renderApp();
    act(() => notify.info('focus me'));
    const close = toastEl()!.querySelector<HTMLButtonElement>('.toast__dismiss')!;
    fireEvent.mouseEnter(toastEl()!);
    act(() => close.focus());
    fireEvent.mouseLeave(toastEl()!);
    advance(20000);
    expect(toastEl()).not.toBeNull();
    act(() => close.blur());
    advance(5000);
    expect(toastEl()).toBeNull();
  });

  it('T17 Tab 到 × 后关闭 → 焦点回到进入 toast 前的元素,而非 body', () => {
    renderApp();
    const outside = screen.getByText('outside');
    act(() => outside.focus());
    act(() => notify.error('boom'));
    const close = toastEl()!.querySelector<HTMLButtonElement>('.toast__dismiss')!;
    act(() => close.focus());
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(toastEl()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('T17b 焦点不在 toast 内时自动消失不抢焦点', () => {
    renderApp();
    const outside = screen.getByText('outside');
    act(() => notify.info('bye'));
    act(() => outside.focus());
    const spy = vi.spyOn(outside, 'focus');
    advance(5000);
    expect(toastEl()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
