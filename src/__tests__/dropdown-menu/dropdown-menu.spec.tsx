// @vitest-environment jsdom
// BDD:触发按钮弹出的菜单。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MenuItem } from '../../design';
import { DropdownMenu } from '../../lib/dropdown-menu';
import { HeaderActions } from '../../shell/dock/HeaderActions';
import { t } from '../../i18n';

vi.mock('../../shell/dock/create-user-terminal', () => ({ createUserTerminal: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

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

// dock 面板头部:「⋯」与「弹出到独立窗口」同在 header 工具栏。VSCode:菜单开着时点菜单外任何位置(含相邻工具栏
// 按钮)都先关闭菜单。此前整个 header 被当作「内部」,点弹出按钮后面板弹走、菜单留在主窗。
describe('dock 面板头部「⋯」菜单', () => {
  const props = () =>
    ({
      containerApi: { addPanel: vi.fn(), getPanel: vi.fn(() => undefined), addPopoutGroup: vi.fn(() => Promise.resolve(true)) },
      group: { id: 'g1', api: { location: { type: 'grid' } } },
      activePanel: { id: 'p1', api: { isActive: false } },
    }) as unknown as Parameters<typeof HeaderActions>[0];
  const openMenu = async () => {
    render(<HeaderActions {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: t('panels.explorer.btn.more_actions') }));
    await frame();
    expect(screen.queryByRole('menu')).not.toBeNull();
    return screen.getByRole('button', { name: t('shell.dock.popout_title') });
  };

  it('菜单开着时在同组弹出按钮上按下指针 → 菜单关闭', async () => {
    const popout = await openMenu();
    fireEvent.pointerDown(popout);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('焦点从菜单移到同组弹出按钮 → 菜单关闭', async () => {
    const popout = await openMenu();
    fireEvent.blur(screen.getByRole('menu'), { relatedTarget: popout });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('键盘 / 程序触发弹出按钮(无 pointerdown)→ 弹出前先关菜单', async () => {
    const popout = await openMenu();
    fireEvent.click(popout);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点触发按钮本身仍是切换(按下不关,点击关)', async () => {
    await openMenu();
    const trigger = screen.getByRole('button', { name: t('panels.explorer.btn.more_actions') });
    fireEvent.pointerDown(trigger);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(trigger);
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
