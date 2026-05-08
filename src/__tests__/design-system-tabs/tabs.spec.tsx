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
});
