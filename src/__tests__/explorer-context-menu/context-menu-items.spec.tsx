// @vitest-environment jsdom
// 资源管理器右键菜单的菜单项与 design MenuItem 同一实现(与 DropdownMenu 一致):Radix ContextMenu.Item asChild 包
// design MenuItem,键盘漫游 / 选中 / 焦点还原仍由 Radix 负责;浮层阴影用 shadow-popover。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ContextMenu, type ContextMenuActions } from '../../panels/Explorer/ContextMenu';
import type { FileEntry } from '../../lib/fs/types';

function makeActions(): ContextMenuActions {
  return {
    onRename: vi.fn(),
    onNewFile: vi.fn(),
    onNewDir: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelativePath: vi.fn(),
    onRevealInFinder: vi.fn(),
    onOpenInTerminal: vi.fn(),
    onTrash: vi.fn(),
    onCut: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
  };
}

const file = { path: '/work/a.ts', name: 'a.ts', isDirectory: false } as FileEntry;

function openMenu(actions: ContextMenuActions) {
  const r = render(
    <ContextMenu
      target={file}
      selectedPaths={new Set(['/work/a.ts'])}
      rootPath="/work"
      actions={actions}
      hasClipboard={false}
      pluginItems={[{ id: 'p1', label: 'Plugin Item', fn: vi.fn() }]}
    >
      <div data-testid="trigger">row</div>
    </ContextMenu>,
  );
  fireEvent.contextMenu(r.getByTestId('trigger'));
  return r;
}

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));

afterEach(() => cleanup());

describe('Explorer 右键菜单 — design MenuItem + shadow-popover', () => {
  it('所有菜单项(含插件项)都是 design MenuItem(.wm-menu-item),菜单容器用 shadow-popover', () => {
    openMenu(makeActions());
    const all = items();
    expect(all.length).toBeGreaterThan(5);
    for (const el of all) expect(el.classList.contains('wm-menu-item')).toBe(true);
    const content = document.querySelector('[role=menu]')!;
    expect(content.className).toContain('shadow-popover');
    expect(content.className).not.toMatch(/\bshadow-xl\b/);
  });

  it('重命名项快捷键 F2 走 shortcut 槽;移到废纸篓是 danger 变体', () => {
    openMenu(makeActions());
    const rename = items().find((el) => el.querySelector('.wm-menu-item__shortcut')?.textContent === 'F2');
    expect(rename).toBeDefined();
    const trash = items().filter((el) => el.dataset.variant === 'danger');
    expect(trash).toHaveLength(1);
  });

  it('点击菜单项 → 触发对应 action 并关闭菜单', () => {
    const actions = makeActions();
    openMenu(actions);
    const cut = items().find((el) => el.textContent?.includes('Cut') || el.textContent?.includes('剪切'))!;
    fireEvent.click(cut);
    expect(actions.onCut).toHaveBeenCalledWith(['/work/a.ts']);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('键盘:菜单项可经 Radix 高亮(data-highlighted)并由 Enter 选中', () => {
    const actions = makeActions();
    openMenu(actions);
    const cut = items().find((el) => el.textContent?.includes('Cut') || el.textContent?.includes('剪切'))!;
    act(() => {
      fireEvent.pointerMove(cut, { pointerType: 'mouse' });
      cut.focus();
    });
    expect(document.activeElement).toBe(cut);
    expect(cut.hasAttribute('data-highlighted')).toBe(true);
    fireEvent.keyDown(cut, { key: 'Enter' });
    expect(actions.onCut).toHaveBeenCalledTimes(1);
  });

  // 「移到废纸篓」可能打开删除确认框(自聚焦):Radix 关闭后的焦点还原(setTimeout)若照常执行,会把焦点抢回遮罩后的
  // 触发行。故该项跳过还原,焦点由 onTrash 的实现方负责;普通项(剪切等)仍还原到触发行。
  it('选「移到废纸篓」→ 跳过 Radix 焦点还原(不把焦点还给触发行);选「剪切」→ 照常还原', async () => {
    const actions = makeActions();
    const r = render(
      <ContextMenu
        target={file}
        selectedPaths={new Set(['/work/a.ts'])}
        rootPath="/work"
        actions={actions}
        hasClipboard={false}
        pluginItems={[]}
      >
        <div data-testid="trigger" tabIndex={0}>
          row
        </div>
      </ContextMenu>,
    );
    const trigger = r.getByTestId('trigger');
    // 右键前焦点在该行(Radix 关闭时还原到打开前的焦点)
    trigger.focus();
    fireEvent.contextMenu(trigger);
    const trash = items().find((el) => el.dataset.variant === 'danger')!;
    fireEvent.click(trash);
    expect(actions.onTrash).toHaveBeenCalledWith(['/work/a.ts']);
    await new Promise((res) => setTimeout(res, 20));
    expect(document.activeElement).not.toBe(trigger);

    trigger.focus();
    fireEvent.contextMenu(trigger);
    const cut = items().find((el) => el.textContent?.includes('Cut') || el.textContent?.includes('剪切'))!;
    fireEvent.click(cut);
    await new Promise((res) => setTimeout(res, 20));
    expect(document.activeElement).toBe(trigger);
  });
});
