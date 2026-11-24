// @vitest-environment jsdom
// BDD:全局读屏播报(VSCode aria.alert / aria.status;节点队列参考 react-aria LiveAnnouncer)。见同目录 README A1-A5。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  ANNOUNCE_CLEAR_MS,
  ANNOUNCE_MAX_NODES,
  ANNOUNCE_PRIME_MS,
  ANNOUNCE_REHOME_CHECK_MS,
  announce,
  prepareAnnouncer,
} from '@/lib/announce';
import { Modal } from '@/design';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const el of document.querySelectorAll('[data-live-announcer]')) el.remove();
});

const regionsIn = (root: ParentNode, politeness: 'polite' | 'assertive') =>
  [...root.querySelectorAll<HTMLElement>(`[data-live-announcer] [aria-live="${politeness}"]`)];
const spokenIn = (root: ParentNode, politeness: 'polite' | 'assertive') =>
  regionsIn(root, politeness).flatMap((r) => [...r.children].map((c) => c.textContent ?? ''));

describe('全局读屏播报 announce()', () => {
  it('A1 每文档一对常驻、视觉隐藏的 polite / assertive live region:只读新增(aria-atomic=false、aria-relevant=additions)', () => {
    prepareAnnouncer(document);
    prepareAnnouncer(document); // 幂等
    for (const p of ['polite', 'assertive'] as const) {
      const regions = regionsIn(document, p);
      expect(regions).toHaveLength(1);
      const el = regions[0]!;
      expect(el.getAttribute('aria-atomic')).toBe('false');
      expect(el.getAttribute('aria-relevant')).toBe('additions');
      expect(el.parentElement!.style.position).toBe('absolute');
      expect(el.parentElement!.style.width).toBe('1px');
      expect(el.textContent).toBe('');
    }
  });

  it('A2 同一 tick 连续播报都保留(各 politeness 独立,不互相清空);相同文本是新节点(会再读)', () => {
    prepareAnnouncer(document);
    announce('first');
    announce('boom', { politeness: 'assertive' });
    announce('second');
    announce('second');
    expect(spokenIn(document, 'polite')).toEqual(['first', 'second', 'second']);
    expect(spokenIn(document, 'assertive')).toEqual(['boom']);
    const [, a, b] = regionsIn(document, 'polite')[0]!.children;
    expect(a).not.toBe(b);
  });

  it('A2b 每区只留最近 ANNOUNCE_MAX_NODES 条;每条数秒后清理(ANNOUNCE_CLEAR_MS)', () => {
    vi.useFakeTimers();
    prepareAnnouncer(document);
    for (let i = 0; i < ANNOUNCE_MAX_NODES + 2; i++) announce(`m${String(i)}`);
    const polite = spokenIn(document, 'polite');
    expect(polite).toHaveLength(ANNOUNCE_MAX_NODES);
    expect(polite.at(-1)).toBe(`m${String(ANNOUNCE_MAX_NODES + 1)}`);
    vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS);
    expect(spokenIn(document, 'polite')).toEqual([]);
  });

  it('A2c 区域尚不存在时先建区域,首条稍后(ANNOUNCE_PRIME_MS)再插入 —— live region 须先于内容存在,读屏才会播', () => {
    vi.useFakeTimers();
    announce('late');
    announce('later', { politeness: 'assertive' });
    expect(regionsIn(document, 'polite')).toHaveLength(1);
    expect(spokenIn(document, 'polite')).toEqual([]);
    vi.advanceTimersByTime(ANNOUNCE_PRIME_MS);
    expect(spokenIn(document, 'polite')).toEqual(['late']);
    expect(spokenIn(document, 'assertive')).toEqual(['later']);
  });

  it('A3 该文档有打开的 design Modal(aria-modal 屏蔽对话框外节点)→ 播报进顶层模态内容里的一对 live region;关闭后回到根部', () => {
    vi.useFakeTimers();
    prepareAnnouncer(document);
    const { rerender } = render(
      <>
        <Modal visible data-testid="m1">a</Modal>
        <Modal visible data-testid="m2">b</Modal>
      </>,
    );
    announce('in modal', { politeness: 'assertive' });
    vi.advanceTimersByTime(ANNOUNCE_PRIME_MS);
    const top = document.querySelector('[data-testid="m2"]')!;
    expect(spokenIn(top, 'assertive')).toEqual(['in modal']);
    expect(spokenIn(document.querySelector('[data-testid="m1"]')!, 'assertive')).toEqual([]);
    const bodyRegion = [...document.body.children].find((c) => c.matches('[data-live-announcer]'))!;
    expect(spokenIn(bodyRegion, 'assertive')).toEqual([]);

    rerender(<Modal visible={false}>a</Modal>);
    announce('after close', { politeness: 'assertive' });
    expect(spokenIn(bodyRegion, 'assertive')).toEqual(['after close']);
  });

  it('A4 doc 选项写进指定文档(popout 子窗),不写主窗', () => {
    const child = document.implementation.createHTMLDocument('popout');
    prepareAnnouncer(child);
    prepareAnnouncer(document);
    announce('popout only', { doc: child });
    expect(spokenIn(child, 'polite')).toEqual(['popout only']);
    expect(spokenIn(document, 'polite')).toEqual([]);
  });

  it('A5 区域被移出文档(如测试清理 / 子窗关闭)后再播报 → 重建一对新的', () => {
    vi.useFakeTimers();
    prepareAnnouncer(document);
    for (const el of document.querySelectorAll('[data-live-announcer]')) el.remove();
    announce('again');
    vi.advanceTimersByTime(ANNOUNCE_PRIME_MS);
    expect(spokenIn(document, 'polite')).toEqual(['again']);
  });

  // 同一事件里先关模态、再同步播报(如命令面板执行命令:execute 先 close,命令随即同步 notify 失败):关闭要等事件处理
  // 结束才提交,播报时顶层模态仍在 → 写进即将卸载的模态里。须改投回落后的宿主,不能整条丢失。
  it('A6 播报写进随后卸载的模态 → 改投到当前宿主(未预热 / 已预热两种)', () => {
    vi.useFakeTimers();
    prepareAnnouncer(document);
    const bodyRegion = () => [...document.body.children].find((c) => c.matches('[data-live-announcer]'))!;
    // 未预热:模态里新建区域、播报排队,等待期间模态卸载
    const { rerender } = render(<Modal visible>a</Modal>);
    announce('lost-1', { politeness: 'assertive' });
    rerender(<Modal visible={false}>a</Modal>);
    vi.advanceTimersByTime(ANNOUNCE_PRIME_MS);
    expect(spokenIn(bodyRegion(), 'assertive')).toContain('lost-1');
    // 已预热:模态区域已存在、节点立即插入,随后模态卸载
    rerender(<Modal visible>b</Modal>);
    announce('warm', { politeness: 'polite' });
    vi.advanceTimersByTime(ANNOUNCE_PRIME_MS);
    announce('lost-2', { politeness: 'assertive' });
    rerender(<Modal visible={false}>b</Modal>);
    vi.advanceTimersByTime(ANNOUNCE_REHOME_CHECK_MS);
    expect(spokenIn(bodyRegion(), 'assertive')).toContain('lost-2');
  });
});

