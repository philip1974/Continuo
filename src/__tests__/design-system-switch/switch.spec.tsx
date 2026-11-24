// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Switch } from '@/design';

afterEach(() => cleanup());

describe('Switch — 语义与受控行为', () => {
  it('原生 button[type=button][role=switch],aria-checked / data-checked 反映 checked', () => {
    const { container, rerender } = render(
      <Switch checked={false} onCheckedChange={() => {}} aria-label="显示行号" />,
    );
    const sw = container.querySelector('button')!;
    expect(sw.getAttribute('type')).toBe('button');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.dataset.checked).toBe('false');
    expect(sw.getAttribute('aria-label')).toBe('显示行号');

    rerender(<Switch checked onCheckedChange={() => {}} aria-label="显示行号" />);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.dataset.checked).toBe('true');
  });

  it('点击 → onCheckedChange(!checked)', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Switch checked={false} onCheckedChange={onChange} />);
    fireEvent.click(container.querySelector('button')!);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Switch checked onCheckedChange={onChange} />);
    fireEvent.click(container.querySelector('button')!);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('disabled → 原生 disabled,点击不回调', () => {
    const onChange = vi.fn();
    const { container } = render(<Switch checked={false} disabled onCheckedChange={onChange} />);
    const sw = container.querySelector('button')!;
    expect(sw.disabled).toBe(true);
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('className 合并到 wm-switch 后;调用方 onClick 仍被调用', () => {
    const onClick = vi.fn();
    const onChange = vi.fn();
    const { container } = render(
      <Switch checked={false} onCheckedChange={onChange} onClick={onClick} className="extra" />,
    );
    const sw = container.querySelector('button')!;
    expect(sw.className).toBe('wm-switch extra');
    fireEvent.click(sw);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Switch — 样式契约(Switch.css 源码钉)', () => {
  const CSS = readFileSync(join(process.cwd(), 'src/design/Switch.css'), 'utf8');
  const rule = (sel: string): string => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return CSS.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  };

  it('键盘焦点环:2px --md-focus-ring', () => {
    expect(rule('.wm-switch:focus-visible')).toMatch(/outline:\s*2px solid var\(--md-focus-ring\)/);
  });

  it('打开态:轨道 --md-primary、滑块 --md-on-primary(两主题对比 ≥ 3:1)', () => {
    expect(rule('.wm-switch[data-checked="true"]')).toMatch(/background-color:\s*var\(--md-primary\)/);
    expect(rule('.wm-switch[data-checked="true"] .wm-switch__thumb')).toMatch(
      /background-color:\s*var\(--md-on-primary\)/,
    );
  });

  it('关闭态:轨道带 --md-outline 描边、滑块 --md-outline', () => {
    expect(rule('.wm-switch')).toMatch(/border:\s*1px solid var\(--md-outline\)/);
    expect(rule('.wm-switch__thumb')).toMatch(/background-color:\s*var\(--md-outline\)/);
  });

  it('只用 token,不出现字面颜色', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
  });
});
