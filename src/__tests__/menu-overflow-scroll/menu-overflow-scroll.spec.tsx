// @vitest-environment jsdom
// BDD:矮窗口里菜单限高 + 纵向滚动。见同目录 README。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MenuItem } from '../../design';
import { DropdownMenu } from '../../lib/dropdown-menu';
import { TabContextMenu } from '../../lib/TabContextMenu';
import { TerminalContextMenu } from '../../panels/Terminal/TerminalContextMenu';
import { CONTEXT_MENU_CONTENT_CLASS_NAME, menuMaxHeightBelow } from '../../lib/menu-surface';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => cleanup());

const expectScrollableRadixMenu = (menu: HTMLElement) => {
  expect(menu.className).toContain('max-h-[var(--radix-context-menu-content-available-height)]');
  expect(menu.className).toContain('overflow-y-auto');
  expect(menu.className).not.toMatch(/(^|\s)overflow-hidden(\s|$)/);
};

describe('Radix 右键菜单限高 + 滚动', () => {
  it('TabContextMenu(tab / 列表行)', () => {
    const entries = () => Array.from({ length: 30 }, (_, i) => ({ label: `item ${i}`, onSelect: () => {} }));
    render(
      <TabContextMenu entries={entries}>
        <div data-testid="trigger">tab</div>
      </TabContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId('trigger'));
    expectScrollableRadixMenu(screen.getByRole('menu'));
  });

  it('TerminalContextMenu', () => {
    const noop = () => {};
    render(
      <TerminalContextMenu
        actions={{ hasSelection: () => false, copy: noop, paste: noop, selectAll: noop, clear: noop, focus: noop }}
        onSplit={noop}
      >
        <div data-testid="term">term</div>
      </TerminalContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId('term'));
    expectScrollableRadixMenu(screen.getByRole('menu'));
  });

  it('源码守护:src 下每个 ContextMenu.Content 都用共享限高类名', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === '__tests__' || name === 'node_modules') continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx$/.test(name)) files.push(full);
      }
    };
    walk(SRC_ROOT);
    const users = files.filter((f) => readFileSync(f, 'utf8').includes("@radix-ui/react-context-menu"));
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const f of users) {
      const src = readFileSync(f, 'utf8');
      const contents = src.match(/<Menu\.Content\b[^>]*?className=\{([^}]*)\}/gs) ?? [];
      expect(contents.length, f).toBeGreaterThan(0);
      for (const c of contents) expect(c, f).toContain('CONTEXT_MENU_CONTENT_CLASS_NAME');
    }
    expect(CONTEXT_MENU_CONTENT_CLASS_NAME).toContain('overflow-y-auto');
  });
});

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button type="button" ref={triggerRef} onClick={() => setOpen((v) => !v)}>
        trigger
      </button>
      <DropdownMenu open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
        {() => Array.from({ length: 20 }, (_, i) => <MenuItem key={i}>{`row ${i}`}</MenuItem>)}
      </DropdownMenu>
    </div>
  );
}

describe('DropdownMenu 限高 + 滚动', () => {
  it('最大高 = 视口高 − 顶边 − 4,窗口变矮随之重算;菜单纵向滚动', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.getBoundingClientRect = () => new DOMRect(100, 20, 24, 24); // bottom 44 → 菜单顶 48
    const innerHeight = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
      fireEvent.click(trigger);
      const menu = screen.getByRole('menu');
      expect(menu.style.top).toBe('48px');
      expect(menu.style.maxHeight).toBe(`${300 - 48 - 4}px`);
      expect(menu.className).toContain('overflow-y-auto');
      act(() => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
        window.dispatchEvent(new Event('resize'));
      });
      expect(menu.style.maxHeight).toBe(`${200 - 48 - 4}px`);
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('menuMaxHeightBelow 不为负', () => {
    expect(menuMaxHeightBelow(48, 300)).toBe(248);
    expect(menuMaxHeightBelow(400, 300)).toBe(0);
  });
});
