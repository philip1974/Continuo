// @vitest-environment jsdom
// Milkdown 视图里点链接永远不走浏览器默认导航(否则整个应用窗口被导航到链接 URL)。见同目录 README。
import React from 'react';
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ writeText: vi.fn(), notifyError: vi.fn() }));
vi.mock('@/plugins/sandbox-sweep', () => ({
  getCachedClipboard: () => ({ readText: vi.fn(), writeText: h.writeText }),
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {},
  Crepe: vi.fn().mockImplementation(() => ({
    setReadonly: vi.fn(),
    on: () => {},
  })),
}));
vi.mock('@milkdown/react', () => ({
  Milkdown: () => <div data-testid="milkdown" />,
  MilkdownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEditor: (init: (root: HTMLElement) => unknown) => {
    init(document.createElement('div'));
  },
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

afterEach(() => cleanup());

function setup(readonly: boolean) {
  const onLinkClick = vi.fn();
  const { container } = render(
    <MilkdownEditor tabId="/t.md" defaultValue="x" readonly={readonly} onLinkClick={onLinkClick} />,
  );
  const wrapper = container.querySelector('.overflow-auto') as HTMLElement;
  const a = document.createElement('a');
  a.setAttribute('href', 'https://example.com/');
  a.textContent = 'link';
  wrapper.appendChild(a);
  // mermaid `click A "url"` 产出的 SVG 链接:href 在 xlink:href 上,点击目标是内部图形
  const svgNs = 'http://www.w3.org/2000/svg';
  const svgA = document.createElementNS(svgNs, 'a');
  svgA.setAttribute('xlink:href', 'https://example.com/diagram');
  const rect = document.createElementNS(svgNs, 'rect');
  svgA.appendChild(rect);
  const svg = document.createElementNS(svgNs, 'svg');
  svg.appendChild(svgA);
  wrapper.appendChild(svg);
  return { onLinkClick, a, rect };
}

function click(target: Element, init?: MouseEventInit): boolean {
  const event = createEvent.click(target, init);
  fireEvent(target, event);
  return event.defaultPrevented;
}

// 中键点链接在 Chromium 里不触发 click,而是 auxclick;默认行为是「在后台标签打开」→ Electron 交给
// windowOpenHandler。只拦 onClick 时中键会绕过 activateLink / resolveLink(安全 L1)。
function auxClick(target: Element, button: number): boolean {
  const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('Milkdown 链接点击不导航应用窗口', () => {
  it('Edit:普通点击不导航也不打开;Cmd/Ctrl+click 打开', () => {
    const { onLinkClick, a } = setup(false);

    expect(click(a)).toBe(true);
    expect(onLinkClick).not.toHaveBeenCalled();

    expect(click(a, { metaKey: true })).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/');
  });

  it('Preview:普通点击即打开,且不走默认导航', () => {
    const { onLinkClick, a } = setup(true);

    expect(click(a)).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/');
  });

  it('mermaid 图里的 SVG 链接(xlink:href)同样处理', () => {
    const { onLinkClick, rect } = setup(true);

    expect(click(rect)).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/diagram');
  });

  it('Edit:链接气泡里显示的地址(Crepe .link-display)普通点击即打开', () => {
    const { onLinkClick, a } = setup(false);
    a.classList.add('link-display');

    expect(click(a)).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/');
  });

  it('L1 Preview:中键点链接(auxclick)吞掉默认行为,与左键同语义交给 onLinkClick', () => {
    const { onLinkClick, a, rect } = setup(true);

    expect(auxClick(a, 1)).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/');

    expect(auxClick(rect, 1)).toBe(true);
    expect(onLinkClick).toHaveBeenCalledWith('https://example.com/diagram');
  });

  it('L1 Edit:中键点链接同样吞掉默认行为;与左键一样不带修饰键不打开', () => {
    const { onLinkClick, a } = setup(false);

    expect(auxClick(a, 1)).toBe(true);
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('L1 非中键的 auxclick(右键)不当作打开链接', () => {
    const { onLinkClick, a } = setup(true);

    auxClick(a, 2);
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('不在链接上的点击不受影响', () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <MilkdownEditor tabId="/t.md" defaultValue="x" readonly onLinkClick={onLinkClick} />,
    );
    const wrapper = container.querySelector('.overflow-auto') as HTMLElement;

    expect(click(wrapper)).toBe(false);
    expect(onLinkClick).not.toHaveBeenCalled();
  });
});

// 打包版(PROD)sandboxSweep 把 navigator.clipboard 置为 undefined;Crepe 链接气泡的复制按钮
// 直接用 navigator.clipboard,会静默无反应。应改走启动时缓存的剪贴板(getCachedClipboard)。
describe('链接气泡「复制链接」在 PROD 剪贴板被清洗后仍可用', () => {
  function setupTooltip(href = 'https://example.com/doc', text = href) {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    h.writeText.mockReset().mockResolvedValue(undefined);
    h.notifyError.mockReset();
    const { container } = render(<MilkdownEditor tabId="/t.md" defaultValue="x" />);
    const wrapper = container.querySelector('.overflow-auto') as HTMLElement;
    // 结构照 @milkdown/components link-tooltip 的 PreviewLink:Icon 是 span,处理器挂在 pointerdown 上
    const tooltip = document.createElement('div');
    tooltip.className = 'milkdown-link-preview';
    tooltip.innerHTML =
      '<div class="link-preview">' +
      '<span class="milkdown-icon button link-icon"><svg><path></path></svg></span>' +
      `<a href="${href}" target="_blank" class="link-display">${text}</a>` +
      '</div>';
    wrapper.appendChild(tooltip);
    const icon = tooltip.querySelector('.link-icon') as HTMLElement;
    const upstream = vi.fn();
    icon.addEventListener('pointerdown', upstream);
    return { icon, upstream, path: tooltip.querySelector('path') as Element };
  }

  function pointerDown(target: Element): boolean {
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('点复制图标(含内部 svg)→ 写入缓存剪贴板,不再走上游处理', async () => {
    const { upstream, path } = setupTooltip();

    expect(pointerDown(path)).toBe(true);
    expect(h.writeText).toHaveBeenCalledWith('https://example.com/doc');
    expect(upstream).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('复制的是链接原地址(气泡显示的文字),不是被上游 sanitize 清空的 DOM href', () => {
    // 上游 sanitizeLinkHref 对白名单外 scheme 把 <a href> 置空,气泡文字仍是 mark 的原地址
    const { icon } = setupTooltip('', 'obsidian://open?vault=x');

    pointerDown(icon);
    expect(h.writeText).toHaveBeenCalledWith('obsidian://open?vault=x');
  });

  it('写入失败 → 可见的失败提示,不静默', async () => {
    const { icon } = setupTooltip();
    h.writeText.mockRejectedValue(new Error('denied'));

    pointerDown(icon);
    await vi.waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
  });
});
