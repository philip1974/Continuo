// @vitest-environment jsdom
// BDD:模态打开期间(toast 在遮罩之下、看不到也无法悬停)所有可见 toast 暂停自动消失,全部模态关闭后按剩余时间续算。见同目录 README T24。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';
import { Modal } from '@/design';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function App({ modals }: { readonly modals: readonly boolean[] }) {
  return (
    <NotificationsProvider>
      {modals.map((visible, i) => (
        <Modal key={i} visible={visible}>
          <button type="button">ok {i}</button>
        </Modal>
      ))}
      <ToastViewport />
    </NotificationsProvider>
  );
}

const toastTexts = () => Array.from(document.querySelectorAll('.toast')).map((el) => el.textContent ?? '');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('toast 在模态打开期间暂停', () => {
  it('T24 模态打开期间出现的 error 不过期;关闭后从完整时长开始计时', () => {
    const { rerender } = render(<App modals={[true]} />);
    act(() => notify.error('behind modal'));
    advance(120_000); // Agent 授权弹窗最长挂 2 分钟
    expect(toastTexts().join()).toContain('behind modal');

    rerender(<App modals={[false]} />);
    advance(14_999);
    expect(toastTexts().join()).toContain('behind modal');
    advance(1);
    expect(toastTexts()).toEqual([]);
  });

  it('T24b 模态打开前已在计时的 toast 暂停,关闭后按剩余时间续算', () => {
    const { rerender } = render(<App modals={[false]} />);
    act(() => notify.info('before'));
    advance(3000);
    rerender(<App modals={[true]} />);
    advance(60_000);
    expect(toastTexts().join()).toContain('before');

    rerender(<App modals={[false]} />);
    advance(1999);
    expect(toastTexts().join()).toContain('before');
    advance(1);
    expect(toastTexts()).toEqual([]);
  });

  it('T24c 叠加的模态全部关闭后才续算;与悬停暂停计数共存', () => {
    const { rerender } = render(<App modals={[true, true]} />);
    act(() => notify.info('stacked'));
    rerender(<App modals={[false, true]} />);
    advance(10_000);
    expect(toastTexts().join()).toContain('stacked');

    // 模态还开着时悬停,然后模态关闭:仍在悬停 → 继续暂停
    fireEvent.mouseEnter(document.querySelector('.toast')!);
    rerender(<App modals={[false, false]} />);
    advance(10_000);
    expect(toastTexts().join()).toContain('stacked');

    fireEvent.mouseLeave(document.querySelector('.toast')!);
    advance(4999);
    expect(toastTexts().join()).toContain('stacked');
    advance(1);
    expect(toastTexts()).toEqual([]);
  });

  it('T24d Provider 挂载时已有打开的模态 → 新 toast 同样暂停', () => {
    const { rerender } = render(
      <>
        <Modal visible>
          <button type="button">pre</button>
        </Modal>
        <App modals={[]} />
      </>,
    );
    act(() => notify.info('late mount'));
    advance(30_000);
    expect(toastTexts().join()).toContain('late mount');
    rerender(
      <>
        <Modal visible={false}>
          <button type="button">pre</button>
        </Modal>
        <App modals={[]} />
      </>,
    );
    advance(5000);
    expect(toastTexts()).toEqual([]);
  });
});
