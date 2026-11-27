// @vitest-environment jsdom
// BDD:popout 子窗里的 dock 组 header。见同目录 README。
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { MenuItem } from '../../design';
import { DropdownMenu } from '../../lib/dropdown-menu';
import { HeaderActions } from '../../shell/dock/HeaderActions';
import { coApp } from '../../plugins/co-app';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { t, setLocale, notifyLocaleChange } from '../../i18n';
import { makeChildDocument, keydown, type ChildDocument } from '../_helpers/child-document';

vi.mock('../../shell/dock/create-user-terminal', () => ({ createUserTerminal: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

let child: ChildDocument;
beforeEach(() => {
  child = makeChildDocument();
  (coApp as { panels: PanelRegistry }).panels = new PanelRegistry();
});
afterEach(() => {
  cleanup();
  child.dispose();
});

const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

function headerProps(locationType: 'grid' | 'popout') {
  return {
    containerApi: {
      addPanel: vi.fn(),
      getPanel: vi.fn(() => undefined),
      addPopoutGroup: vi.fn(() => Promise.resolve(true)),
    },
    group: { id: 'g1', api: { location: { type: locationType } } },
    activePanel: { id: 'p1' },
  } as unknown as Parameters<typeof HeaderActions>[0];
}

describe('弹出按钮按组位置显隐', () => {
  const popoutBtn = (root: HTMLElement) =>
    root.querySelector(`button[aria-label="${t('shell.dock.popout_title')}"]`);

  it('组在 popout 子窗 → 不显示弹出按钮(即使主窗 URL 不带 ?popout=1)', () => {
    const { container } = render(<HeaderActions {...headerProps('popout')} />, {
      container: child.host,
    });
    expect(popoutBtn(container)).toBeNull();
  });

  it('组在主窗 grid → 显示弹出按钮', () => {
    const { container } = render(<HeaderActions {...headerProps('grid')} />);
    expect(popoutBtn(container)).not.toBeNull();
  });
});

// 面板全弹出到子窗后,主窗留下的空 dock 组没有任何 tab(SharedTab 不渲染),只有组级 header actions 仍渲染。
// tab 条的 tablist 名称须由组级更新,切语言后不停留旧语言。
describe('空组 tab 条的 tablist 名称随语言更新', () => {
  it('组内无 tab → header actions 给本组 .dv-tabs-container 补 role=tablist,切语言后名称更新', () => {
    // 照 dockview header 结构:.dv-tabs-and-actions-container > .dv-tabs-container(空)+ .dv-right-actions-container
    const header = document.body.appendChild(document.createElement('div'));
    header.className = 'dv-tabs-and-actions-container';
    const strip = header.appendChild(document.createElement('div'));
    strip.className = 'dv-tabs-container';
    const actions = header.appendChild(document.createElement('div'));
    actions.className = 'dv-right-actions-container';
    try {
      setLocale('en');
      render(<HeaderActions {...headerProps('grid')} />, { container: actions });
      expect(strip.getAttribute('role')).toBe('tablist');
      expect(strip.getAttribute('aria-label')).toBe('Panel tabs');
      act(() => {
        setLocale('zh');
        notifyLocaleChange();
      });
      expect(strip.getAttribute('aria-label')).toBe('面板标签');
    } finally {
      setLocale('zh');
      cleanup();
      header.remove();
    }
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
      <button type="button">outside</button>
      <DropdownMenu open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
        {() => (
          <>
            <MenuItem onClick={() => {}}>first</MenuItem>
            <MenuItem onClick={() => {}}>second</MenuItem>
          </>
        )}
      </DropdownMenu>
    </div>
  );
}

async function openInChild() {
  render(<Harness />, { container: child.host });
  const q = within(child.doc.body);
  const trigger = q.getByText('trigger');
  trigger.getBoundingClientRect = () =>
    ({ top: 10, bottom: 30, left: 360, right: 400, width: 40, height: 20, x: 360, y: 10 }) as DOMRect;
  Object.defineProperty(child.win, 'innerWidth', { value: 500, configurable: true });
  fireEvent.click(trigger);
  await frame();
  return q;
}

describe('「⋯」菜单在子窗内', () => {
  it('portal 到子窗 body,不出现在主窗;按子窗 viewport 定位', async () => {
    const q = await openInChild();
    const menu = q.getByRole('menu');
    expect(menu.parentElement).toBe(child.doc.body);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(menu.style.top).toBe('34px');
    expect(menu.style.right).toBe('100px');
  });

  it('子窗里点菜单外 → 关闭;点菜单内 → 不关', async () => {
    const q = await openInChild();
    fireEvent.pointerDown(q.getByText('first'));
    expect(q.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerDown(q.getByText('outside'));
    expect(q.queryByRole('menu')).toBeNull();
  });

  it('方向键按子窗焦点漫游', async () => {
    const q = await openInChild();
    expect(child.doc.activeElement?.textContent).toBe('first');
    act(() => {
      keydown(q.getByRole('menu'), { key: 'ArrowDown' });
    });
    expect(child.doc.activeElement?.textContent).toBe('second');
  });
});
