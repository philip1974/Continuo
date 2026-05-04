import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  Button,
  IconButton,
  MenuItem,
  NavRailButton,
  SegmentedControl,
  TabNav,
  TabNavItem,
} from '../../design';

afterEach(() => cleanup());

describe('Button data-attr 契约', () => {
  it('默认 variant=primary size=md', () => {
    const { container } = render(<Button>OK</Button>);
    const btn = container.querySelector('button')!;
    expect(btn.dataset.variant).toBe('primary');
    expect(btn.dataset.size).toBe('md');
    expect(btn.className).toContain('wm-button');
  });

  it('variant=outlined(LM 扩展)正确写入 data-variant', () => {
    const { container } = render(<Button variant="outlined">Open</Button>);
    expect(container.querySelector('button')!.dataset.variant).toBe('outlined');
  });

  it('className 合并而非覆盖 wm-button', () => {
    const { container } = render(<Button className="extra">x</Button>);
    const cls = container.querySelector('button')!.className;
    expect(cls).toContain('wm-button');
    expect(cls).toContain('extra');
  });

  it('disabled + onClick:点击不触发', () => {
    const fn = vi.fn();
    const { container } = render(
      <Button disabled onClick={fn}>
        x
      </Button>,
    );
    fireEvent.click(container.querySelector('button')!);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('size=xs 写入 data-size', () => {
    const { container } = render(<IconButton size="xs">×</IconButton>);
    expect(container.querySelector('button')!.dataset.size).toBe('xs');
  });
});

describe('MenuItem', () => {
  it('role=menuitem,variant=danger 时 data-variant 正确', () => {
    const { container } = render(
      <MenuItem variant="danger" onClick={() => {}}>
        Delete
      </MenuItem>,
    );
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('role')).toBe('menuitem');
    expect(btn.dataset.variant).toBe('danger');
  });
});

describe('NavRailButton', () => {
  it('active=true 渲染 __active-bar 子元素 + aria-pressed=true', () => {
    const { container } = render(
      <NavRailButton title="Files" active onClick={() => {}}>
        F
      </NavRailButton>,
    );
    const btn = container.querySelector('button')!;
    expect(btn.dataset.active).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.wm-nav-rail-button__active-bar')).not.toBeNull();
  });

  it('active=false 不渲染 active-bar', () => {
    const { container } = render(
      <NavRailButton title="Files" onClick={() => {}}>
        F
      </NavRailButton>,
    );
    expect(container.querySelector('.wm-nav-rail-button__active-bar')).toBeNull();
  });
});

describe('SegmentedControl', () => {
  it('泛型 onChange 收到正确 id, active 段写 data-active=true', () => {
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons[0]?.dataset.active).toBe('true');
    expect(buttons[1]?.dataset.active).toBe('false');
    fireEvent.click(buttons[1]!);
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('TabNav + TabNavItem', () => {
  it('dirty=true 渲染 __dirty-dot;onClose 提供时渲染 __close 按钮', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem dirty onSelect={() => {}} onClose={() => {}}>
          file.md
        </TabNavItem>
      </TabNav>,
    );
    expect(container.querySelector('.wm-tab-nav-item__dirty-dot')).not.toBeNull();
    expect(container.querySelector('.wm-tab-nav-item__close')).not.toBeNull();
  });

  it('无 onClose 时不渲染 close 按钮', () => {
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={() => {}}>file.md</TabNavItem>
      </TabNav>,
    );
    expect(container.querySelector('.wm-tab-nav-item__close')).toBeNull();
  });

  it('close 按钮点击 stopPropagation,onSelect 不被触发', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <TabNav>
        <TabNavItem onSelect={onSelect} onClose={onClose}>
          file.md
        </TabNavItem>
      </TabNav>,
    );
    fireEvent.click(container.querySelector('.wm-tab-nav-item__close')!);
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
