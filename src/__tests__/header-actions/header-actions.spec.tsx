// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';
import { t } from '../../i18n';
import { HeaderActions } from '../../shell/dock/HeaderActions';
import { coApp } from '../../plugins/co-app';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';

const notifyError = vi.fn();
vi.mock('../../notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

interface FakeApi {
  addPanel: ReturnType<typeof vi.fn>;
  addPopoutGroup: ReturnType<typeof vi.fn>;
}

interface TestProps {
  containerApi: FakeApi;
  group: { id: string };
  activePanel: { id: string } | null;
}

function makeProps(over: {
  containerApi?: Partial<FakeApi>;
  activePanel?: { id: string } | null;
  group?: { id: string };
} = {}): TestProps {
  const containerApi: FakeApi = {
    addPanel: vi.fn(),
    // addPopoutGroup 真实返回 Promise<boolean>(A50:调用点 .catch 失败反馈),默认 resolve。
    addPopoutGroup: vi.fn(() => Promise.resolve(true)),
    ...over.containerApi,
  };
  return {
    containerApi,
    group: over.group ?? { id: 'g1' },
    activePanel: over.activePanel ?? null,
  };
}

beforeEach(() => {
  (coApp as { panels: PanelRegistry }).panels = new PanelRegistry();
});

afterEach(() => cleanup());

describe('HeaderActions — popout', () => {
  it('activePanel=null → popout 按钮 disabled', () => {
    const props = makeProps({ activePanel: null });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const popoutBtn = container.querySelector(
      `button[aria-label="${t('shell.dock.popout_title')}"]`,
    ) as HTMLButtonElement;
    expect(popoutBtn.disabled).toBe(true);
  });

  it('activePanel 有 → 点击调 addPopoutGroup', () => {
    const props = makeProps({ activePanel: { id: 'p1' } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const popoutBtn = container.querySelector(
      `button[aria-label="${t('shell.dock.popout_title')}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(popoutBtn);
    expect(props.containerApi.addPopoutGroup).toHaveBeenCalledTimes(1);
    expect(props.containerApi.addPopoutGroup).toHaveBeenCalledWith(
      props.activePanel,
      expect.objectContaining({ popoutUrl: expect.any(String) }),
    );
  });

  // a11y(A50,A46-A49 同族):popout 失败(addPopoutGroup reject)须 notify.error 反馈,不静默。
  it('a11y · addPopoutGroup reject → notify.error', async () => {
    notifyError.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const props = makeProps({
      activePanel: { id: 'p1' },
      containerApi: {
        addPopoutGroup: vi.fn(() => Promise.reject(new Error('no window'))),
      },
    });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('shell.dock.popout_title')}"]`,
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

describe('HeaderActions — 更多操作菜单', () => {
  it('默认 open=false → 不渲染 menu', () => {
    const props = makeProps();
    render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  // a11y(A7,A6 同族):Dock 菜单触发按钮须 aria-haspopup=menu + aria-expanded 随开合切换。
  it('a11y · 「更多」按钮有 aria-haspopup=menu + aria-expanded 切换', () => {
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const moreBtn = container.querySelector(
      `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
    ) as HTMLButtonElement;
    expect(moreBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('点击「更多」→ 渲染 menu,列出 PanelRegistry 全部 type', () => {
    coApp.panels.register({
      type: 'explorer',
      title: 'Explorer',
      factory: () => null,
    });
    coApp.panels.register({
      type: 'terminal',
      title: 'Terminal',
      factory: () => null,
    });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const menu = document.querySelector('[role=menu]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('Explorer');
    expect(menu!.textContent).toContain('Terminal');
  });

  it('点 menu item → addPanel({id,component,title,position}) + 关菜单', () => {
    coApp.panels.register({
      type: 'explorer',
      title: 'Explorer',
      factory: () => null,
    });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const item = document.querySelector('[role=menuitem]') as HTMLElement;
    fireEvent.click(item);

    expect(props.containerApi.addPanel).toHaveBeenCalledTimes(1);
    const arg = props.containerApi.addPanel.mock.calls[0]![0] as {
      id: string;
      component: string;
      title: string;
    };
    expect(arg.component).toBe('explorer');
    expect(arg.title).toBe('Explorer');
    expect(arg.id).toMatch(/^explorer-\d+$/);

    // menu 关闭
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  // race(R60,R59 同族):菜单打开期间该 panel type 被插件 unregister(快照仍渲染该项,但 live
  // get 返 undefined)→ 点击不创建已不存在 component 的 panel,关菜单。
  it('R60 菜单打开期 panel type 已 unregister(live get=undefined)→ 不 addPanel + 关菜单', () => {
    coApp.panels.register({ type: 'explorer', title: 'Explorer', factory: () => null });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const item = document.querySelector('[role=menuitem]') as HTMLElement;
    // 模拟菜单打开期间该 type 被 unregister:snapshot 仍渲染该项,但 live get 返 undefined。
    vi.spyOn(coApp.panels, 'get').mockReturnValue(undefined);
    fireEvent.click(item);

    expect(props.containerApi.addPanel).not.toHaveBeenCalled();
    expect(document.querySelector('[role=menu]')).toBeNull(); // 关菜单
  });

  it('文档 pointerdown 在 ref 之外 → 关菜单', () => {
    coApp.panels.register({
      type: 'x',
      title: 'X',
      factory: () => null,
    });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('subscribe → 后注册的 panel 立即出现在 menu', () => {
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')!.textContent).not.toContain(
      'NewType',
    );

    act(() => {
      coApp.panels.register({
        type: 'newtype',
        title: 'NewType',
        factory: () => null,
      });
    });
    expect(document.querySelector('[role=menu]')!.textContent).toContain(
      'NewType',
    );
  });
});
