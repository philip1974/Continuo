// @vitest-environment jsdom
// BDD:触发按钮弹出的菜单。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MenuItem } from '../../design';
import { DropdownMenu } from '../../lib/dropdown-menu';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function Harness({ onPick }: { onPick?: (how: 'close' | 'restore') => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button type="button" ref={triggerRef} onClick={() => setOpen((v) => !v)}>
        trigger
      </button>
      <button type="button">outside</button>
      <DropdownMenu open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
        {({ close, closeAndRestore }) => (
          <>
            <MenuItem
              onClick={() => {
                onPick?.('close');
                close();
              }}
            >
              first
            </MenuItem>
            <MenuItem
              onClick={() => {
                onPick?.('restore');
                closeAndRestore();
              }}
            >
              second
            </MenuItem>
          </>
        )}
      </DropdownMenu>
    </div>
  );
}

const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

afterEach(() => cleanup());

describe('DropdownMenu', () => {
  it('打开后 portal 到 body,role=menu,焦点进入首项', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    await frame();
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(document.activeElement?.textContent).toBe('first');
  });

  it('Escape 关闭并把焦点还给触发按钮', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    await frame();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement?.textContent).toBe('trigger');
  });

  it('菜单项 closeAndRestore → 关闭并还原焦点;close → 只关闭', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    await frame();
    fireEvent.click(screen.getByText('second'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement?.textContent).toBe('trigger');
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(screen.getByText('trigger'));
    await frame();
    fireEvent.click(screen.getByText('first'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement?.textContent).not.toBe('trigger');
  });

  it('在触发按钮与菜单之外按下指针 → 关闭', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    await frame();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('接线守卫', () => {
  it.each(['panels/Explorer/ExplorerHeader.tsx', 'shell/dock/HeaderActions.tsx'])('%s', (rel) => {
    const src = readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    expect(src).toContain('<DropdownMenu');
    expect(src).not.toMatch(/useMenuKeyboard\(|useMenuAnchor\(|createPortal\(/);
  });
});
