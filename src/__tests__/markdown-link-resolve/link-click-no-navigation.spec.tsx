// @vitest-environment jsdom
// Milkdown 视图里点链接永远不走浏览器默认导航(否则整个应用窗口被导航到链接 URL)。见同目录 README。
import React from 'react';
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    <MilkdownEditor defaultValue="x" readonly={readonly} onLinkClick={onLinkClick} />,
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

  it('不在链接上的点击不受影响', () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <MilkdownEditor defaultValue="x" readonly onLinkClick={onLinkClick} />,
    );
    const wrapper = container.querySelector('.overflow-auto') as HTMLElement;

    expect(click(wrapper)).toBe(false);
    expect(onLinkClick).not.toHaveBeenCalled();
  });
});
