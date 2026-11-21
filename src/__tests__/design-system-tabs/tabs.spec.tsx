// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { Tabs } from '../../design/Tabs';

afterEach(() => cleanup());

describe('Tabs', () => {
  const items = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];

  it('渲染 nav role=tablist + 每条 button role=tab', () => {
    const { container } = render(
      <Tabs items={items} activeId="a" onSelect={vi.fn()} />,
    );
    expect(container.querySelector('nav.wm-tabs')!.getAttribute('role')).toBe(
      'tablist',
    );
    const tabs = container.querySelectorAll('button[role=tab]');
    expect(tabs.length).toBe(3);
  });

  // a11y(A108,A107 同型):tablist 须可有 caller 注入的可访问名;未提供则无 aria-label。
  it('a11y · ariaLabel prop → role=tablist 有可访问名;未提供则无', () => {
    const withLabel = render(
      <Tabs items={items} activeId="a" onSelect={vi.fn()} ariaLabel="视图切换" />,
    );
    expect(
      withLabel.container.querySelector('[role=tablist]')!.getAttribute('aria-label'),
    ).toBe('视图切换');
    cleanup();
    const without = render(<Tabs items={items} activeId="a" onSelect={vi.fn()} />);
    expect(
      without.container.querySelector('[role=tablist]')!.getAttribute('aria-label'),
    ).toBeNull();
  });

  it('activeId=a → 第一条 data-active=true,其它 false', () => {
    const { container } = render(
      <Tabs items={items} activeId="a" onSelect={vi.fn()} />,
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>(
      'button[role=tab]',
    );
    expect(tabs[0]!.getAttribute('data-active')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.getAttribute('data-active')).toBe('false');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false');
  });

  it('点击 → onSelect(id)', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Tabs items={items} activeId="a" onSelect={onSelect} />,
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>(
      'button[role=tab]',
    );
    fireEvent.click(tabs[2]!);
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  // a11y(A28,A23 同族):tablist 须 roving tabindex(仅 active 可 Tab)+ 方向键移焦。
  it('a11y · roving tabindex + 方向键导航', () => {
    const { container } = render(
      <Tabs items={items} activeId="a" onSelect={vi.fn()} />,
    );
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role=tab]'),
    );
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]); // 仅 active 可 Tab
    const tablist = container.querySelector('[role=tablist]')!;
    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: 'ArrowDown' }); // 纵向:Down=next
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tablist, { key: 'ArrowDown' }); // 末→首循环
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tablist, { key: 'ArrowUp' }); // 首→末循环
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
  });
});
