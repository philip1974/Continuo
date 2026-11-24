// @vitest-environment jsdom
// BDD:toast 的读屏播报走常驻、视觉隐藏的 polite / assertive live region(VSCode 通知同款:创建时播报,与是否可见无关),
// toast 元素本身不是 live region。见同目录 README T25-T28。
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';

afterEach(() => cleanup());

function renderApp() {
  render(
    <NotificationsProvider>
      <ToastViewport />
    </NotificationsProvider>,
  );
}

const region = (politeness: 'polite' | 'assertive', doc: Document = document): HTMLElement => {
  const el = doc.querySelector<HTMLElement>(`[data-toast-announcer][aria-live="${politeness}"]`);
  expect(el, `缺少 ${politeness} live region`).not.toBeNull();
  return el!;
};
const spoken = (politeness: 'polite' | 'assertive'): string => region(politeness).textContent ?? '';

describe('toast 读屏播报(常驻 live region)', () => {
  it('T25 主窗常驻 polite / assertive 两个视觉隐藏的 live region(无通知时也在);toast 元素本身不是 live region', () => {
    renderApp();
    for (const p of ['polite', 'assertive'] as const) {
      const el = region(p);
      expect(el.getAttribute('aria-atomic')).toBe('true');
      expect(el.style.position).toBe('absolute');
      expect(el.style.width).toBe('1px');
      expect(el.textContent).toBe('');
    }
    act(() => {
      notify.error('boom');
      notify.info('hi');
    });
    for (const toast of document.querySelectorAll('.toast')) {
      expect(toast.getAttribute('role')).toBeNull();
      expect(toast.getAttribute('aria-live')).toBeNull();
      expect(toast.closest('[aria-live]')).toBeNull();
    }
  });

  it('T26 新通知创建时即播报正文:error → assertive,其余 → polite;不含 ×N / 关闭按钮文字', () => {
    renderApp();
    act(() => notify.info('saved'));
    expect(spoken('polite')).toBe('saved');
    act(() => notify.error('save failed', { code: 'E_SAVE' }));
    expect(spoken('assertive')).toBe('save failed');
    expect(spoken('assertive')).not.toContain(t('notifications.dismiss'));
    expect(spoken('assertive')).not.toContain('E_SAVE');
  });

  it('T26b 超出可见上限排队的通知创建时就播报;之后补位显示时不再重播', () => {
    renderApp();
    act(() => {
      notify.warn('w1');
      notify.warn('w2');
      notify.warn('w3');
    });
    act(() => notify.warn('w4'));
    expect([...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('w4'))).toBe(false);
    expect(spoken('polite')).toBe('w4');
    const node = region('polite').firstElementChild;

    fireEvent.click(document.querySelector('.toast__dismiss')!);
    expect([...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('w4'))).toBe(true);
    // 补位不产生新的播报节点
    expect(region('polite').firstElementChild).toBe(node);
  });

  it('T27 合并只以 polite 播一次简短的「正文 + 次数」(含 error、含排队项);不整条带 ×N 重读', () => {
    renderApp();
    act(() => notify.error('dup'));
    expect(spoken('assertive')).toBe('dup');
    act(() => notify.error('dup'));
    expect(spoken('polite')).toBe(t('notifications.repeat_announce', { message: 'dup', count: 2 }));
    expect(spoken('polite')).not.toContain('×');
    // 播报节点只在新播报时替换:assertive 里没有再插入 dup
    expect(spoken('assertive')).toBe('');

    act(() => {
      notify.info('a');
      notify.info('b');
      notify.info('c'); // 排队(第 4 条)
    });
    act(() => notify.info('c'));
    expect(spoken('polite')).toBe(t('notifications.repeat_announce', { message: 'c', count: 2 }));
  });

  it('T28 同一文本再次出现(关闭后重发)→ 插入新的播报节点,读屏会再读一次', () => {
    renderApp();
    act(() => notify.info('again'));
    const first = region('polite').firstElementChild;
    expect(first?.textContent).toBe('again');
    fireEvent.click(document.querySelector('.toast__dismiss')!);
    act(() => notify.info('again'));
    const second = region('polite').firstElementChild;
    expect(second?.textContent).toBe('again');
    expect(second).not.toBe(first);
  });
});
