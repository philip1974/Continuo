// @vitest-environment jsdom
// BDD:toast 的读屏播报走常驻、视觉隐藏的 polite / assertive live region(VSCode 通知同款:创建时播报,与是否可见无关),
// toast 元素本身不是 live region。见同目录 README T25-T30。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NotificationsProvider, REPEAT_ANNOUNCE_THROTTLE_MS } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';
import { ANNOUNCE_PRIME_MS } from '@/lib/announce';
import { Modal } from '@/design';
import { t } from '@/i18n';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const el of document.querySelectorAll('[data-live-announcer]')) el.remove();
});

function renderApp(extra: ReactNode = null) {
  return render(
    <NotificationsProvider>
      <ToastViewport />
      {extra}
    </NotificationsProvider>,
  );
}

const region = (politeness: 'polite' | 'assertive', root: ParentNode = document): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[data-live-announcer] [aria-live="${politeness}"]`);
  expect(el, `缺少 ${politeness} live region`).not.toBeNull();
  return el!;
};
/** 区域里现存的播报节点文本(按插入顺序)。 */
const spoken = (politeness: 'polite' | 'assertive', root: ParentNode = document): string[] =>
  [...region(politeness, root).children].map((el) => el.textContent ?? '');

describe('toast 读屏播报(全局常驻 live region,见 live-announcer)', () => {
  it('T25 主窗常驻 polite / assertive 两个视觉隐藏的 live region(无通知时也在,只读新增);toast 元素本身不是 live region', () => {
    renderApp();
    for (const p of ['polite', 'assertive'] as const) {
      const el = region(p);
      expect(el.getAttribute('aria-atomic')).toBe('false');
      expect(el.parentElement!.style.position).toBe('absolute');
      expect(el.parentElement!.style.width).toBe('1px');
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
    expect(spoken('polite')).toEqual(['saved']);
    act(() => notify.error('save failed', { code: 'E_SAVE' }));
    expect(spoken('assertive')).toEqual(['save failed']);
    expect(region('assertive').textContent).not.toContain(t('notifications.dismiss'));
    expect(region('assertive').textContent).not.toContain('E_SAVE');
  });

  it('T26b 新通知立即显示并播报;被挤掉的旧通知在更新的消失后重新显示时不再重播', () => {
    renderApp();
    act(() => {
      notify.warn('w1');
      notify.warn('w2');
      notify.warn('w3');
    });
    act(() => notify.warn('w4'));
    const shown = () => [...document.querySelectorAll('.toast')].map((el) => el.querySelector('.toast__message')?.textContent);
    expect(shown()).toEqual(['w2', 'w3', 'w4']);
    expect(spoken('polite')).toEqual(['w1', 'w2', 'w3', 'w4']);

    // 关掉最新的 → 被挤掉的 w1 重新显示,不产生新的播报节点
    const toasts = document.querySelectorAll<HTMLElement>('.toast');
    fireEvent.click(toasts[toasts.length - 1]!.querySelector('.toast__dismiss')!);
    expect(shown()).toEqual(['w1', 'w2', 'w3']);
    expect(spoken('polite')).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('T27 合并只以 polite 播一次简短的「正文 + 次数」(含 error、含被挤到后面的);不整条带 ×N 重读', () => {
    vi.useFakeTimers();
    renderApp();
    act(() => notify.error('dup'));
    expect(spoken('assertive')).toEqual(['dup']);
    act(() => notify.error('dup'));
    act(() => vi.advanceTimersByTime(REPEAT_ANNOUNCE_THROTTLE_MS));
    expect(spoken('polite')).toEqual([t('notifications.repeat_announce', { message: 'dup', count: 2 })]);
    expect(region('polite').textContent).not.toContain('×');
    // assertive 里没有再插入 dup
    expect(spoken('assertive')).toEqual(['dup']);

    act(() => {
      notify.info('a');
      notify.info('b');
      notify.info('c'); // 第 4 条:最早的 dup 被挤到后面
    });
    act(() => notify.info('c'));
    act(() => vi.advanceTimersByTime(REPEAT_ANNOUNCE_THROTTLE_MS));
    expect(spoken('polite').at(-1)).toBe(t('notifications.repeat_announce', { message: 'c', count: 2 }));
  });

  it('T27b 同一消息跨多个 tick 连续合并 → 约 1 秒尾随节流,只播最后的计数一次', () => {
    vi.useFakeTimers();
    renderApp();
    act(() => notify.info('flood'));
    for (let i = 0; i < 3; i++) {
      act(() => notify.info('flood'));
      act(() => vi.advanceTimersByTime(200));
    }
    expect(spoken('polite')).toEqual(['flood']);
    act(() => vi.advanceTimersByTime(REPEAT_ANNOUNCE_THROTTLE_MS));
    expect(spoken('polite')).toEqual(['flood', t('notifications.repeat_announce', { message: 'flood', count: 4 })]);
    // 节流窗口过后再合并 → 新的一轮
    act(() => notify.info('flood'));
    act(() => vi.advanceTimersByTime(REPEAT_ANNOUNCE_THROTTLE_MS));
    expect(spoken('polite').at(-1)).toBe(t('notifications.repeat_announce', { message: 'flood', count: 5 }));
  });

  it('T28 同一文本再次出现(关闭后重发)→ 插入新的播报节点,读屏会再读一次', () => {
    renderApp();
    act(() => notify.info('again'));
    const first = region('polite').lastElementChild;
    expect(first?.textContent).toBe('again');
    fireEvent.click(document.querySelector('.toast__dismiss')!);
    act(() => notify.info('again'));
    const second = region('polite').lastElementChild;
    expect(second?.textContent).toBe('again');
    expect(second).not.toBe(first);
  });

  it('T29 同一 tick 先后多条通知都播报(不因 React 合批只剩最后一条);error 不被随后的 polite 清掉', () => {
    renderApp();
    act(() => {
      notify.info('one');
      notify.error('broken');
      notify.success('two');
    });
    expect(spoken('polite')).toEqual(['one', 'two']);
    expect(spoken('assertive')).toEqual(['broken']);
  });

  it('T30 模态框打开时(aria-modal 屏蔽框外节点)toast 播报写进顶层模态里的 live region;关闭后回到根部', () => {
    vi.useFakeTimers();
    const { rerender } = renderApp(<Modal visible data-testid="dlg">dialog</Modal>);
    act(() => notify.error('while modal'));
    act(() => vi.advanceTimersByTime(ANNOUNCE_PRIME_MS));
    const dialog = document.querySelector('[data-testid="dlg"]')!;
    const rootPair = [...document.body.children].find((el) => el.matches('[data-live-announcer]'))!;
    expect(spoken('assertive', dialog)).toEqual(['while modal']);
    expect(spoken('assertive', rootPair)).toEqual([]);
    rerender(
      <NotificationsProvider>
        <ToastViewport />
      </NotificationsProvider>,
    );
    act(() => notify.error('after modal'));
    expect(spoken('assertive', rootPair)).toEqual(['after modal']);
  });
});
