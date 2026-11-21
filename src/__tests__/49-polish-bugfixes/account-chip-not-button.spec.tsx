// topic 49 · 审计 P2-D: 账户菜单未实现前,AccountChip 不能是带 button 角色的死控件
// (会向屏幕阅读器谎报可点)。退化为非交互的展示性 chip(div + title)。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { IconSidebar } from '../../shell/IconSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useUpdateStore } from '../../marketplace/update-store';
import { coApp } from '../../plugins/co-app';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';

vi.mock('../../shell/dock/dock-api-ref', () => ({
  openOrFocusPanel: vi.fn(),
  setDockApi: vi.fn(),
  getDockApi: vi.fn(),
  focusPanel: vi.fn(),
}));
vi.mock('../../lib/toggle-settings-panel', () => ({
  toggleSettingsPanel: vi.fn(),
}));

const ACCOUNT_TITLE = 'Continuo Dev · PRO Plan';

beforeEach(() => {
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useUpdateStore.setState({
    available: [],
    remoteVersions: new Map(),
    checking: false,
    lastCheckedAt: null,
  });
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
});
afterEach(() => cleanup());

describe('topic 49 · AccountChip 非交互', () => {
  it('账户 chip 渲染为非 button 元素(有 title,无 button 角色)', () => {
    const { container } = render(<IconSidebar />);
    const chip = container.querySelector(`[title="${ACCOUNT_TITLE}"]`);
    expect(chip).not.toBeNull();
    expect(chip!.tagName).not.toBe('BUTTON');
    // 不存在以该 title 命名的 button(没有误导性可点控件)
    expect(
      container.querySelector(`button[title="${ACCOUNT_TITLE}"]`),
    ).toBeNull();
    expect(chip!.textContent).toBe('CD');
  });
});
