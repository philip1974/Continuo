// BDD: 22-pane-zoom-toggle / SharedTab maximize indicator icon
//
// iTerm2 风:tab title 旁加 "exit zoom" 图标,仅在该 tab 所属 group 处于 maximized
// 状态时显示。点击 → containerApi.exitMaximizedGroup()。
//
// 验证:
//   - 初始 group.api.isMaximized()=false → 不渲染图标
//   - onDidMaximizedGroupChange 把 evt.group === api.group + isMaximized=true 推过来 → 渲染图标
//   - 其它 group 的 maximize 事件 → 本 tab 不渲染
//   - 点击图标 → containerApi.exitMaximizedGroup() 被调
//   - aria-label 走 i18n catalog (shell.tab.exit_zoom)

/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SharedTab } from '@/shell/motion/SharedTab';
import { en } from '../../../electron/shared/i18n-locales/en';

type SharedTabProps = Parameters<typeof SharedTab>[0];

// Minimal fake disposable
const makeDisposable = () => ({ dispose: vi.fn() });

// Minimal fake event emitter for onDid* callbacks
function makeEmitter<T>() {
  const listeners: Array<(e: T) => void> = [];
  return {
    on: (cb: (e: T) => void) => {
      listeners.push(cb);
      return makeDisposable();
    },
    fire: (e: T) => listeners.forEach((l) => l(e)),
  };
}

interface TestEnv {
  groupRef: { id: string };
  panelApi: SharedTabProps['api'];
  containerApi: SharedTabProps['containerApi'];
  maxChangeEmitter: ReturnType<typeof makeEmitter<{ group: { id: string }; isMaximized: boolean }>>;
  exitMaxSpy: ReturnType<typeof vi.fn>;
}

function buildEnv(initialMaxed = false): TestEnv {
  const groupRef = { id: 'g1' };
  const activeEmitter = makeEmitter<{ isActive: boolean }>();
  const titleEmitter = makeEmitter<{ title: string | undefined }>();
  const maxChangeEmitter = makeEmitter<{
    group: { id: string };
    isMaximized: boolean;
  }>();
  const exitMaxSpy = vi.fn();
  const panelApi = {
    id: 'panel-1',
    isActive: true,
    title: 'Terminal 1',
    group: {
      id: groupRef.id,
      api: { isMaximized: () => initialMaxed },
      // identity-equal check 在 onDidMaximizedGroupChange handler 里用 ===
    },
    onDidActiveChange: (cb: (e: { isActive: boolean }) => void) =>
      activeEmitter.on(cb),
    onDidTitleChange: (cb: (e: { title: string | undefined }) => void) =>
      titleEmitter.on(cb),
    close: vi.fn(),
  } as unknown as SharedTabProps['api'];
  const containerApi = {
    onDidMaximizedGroupChange: (cb: (e: { group: { id: string }; isMaximized: boolean }) => void) =>
      maxChangeEmitter.on(cb),
    exitMaximizedGroup: exitMaxSpy,
  } as unknown as SharedTabProps['containerApi'];
  return { groupRef, panelApi, containerApi, maxChangeEmitter, exitMaxSpy };
}

function renderTab(env: TestEnv) {
  return render(
    <SharedTab
      api={env.panelApi}
      containerApi={env.containerApi}
      tabLocation="header"
      params={{}}
    />,
  );
}

describe('SharedTab maximize indicator', () => {
  beforeEach(() => {
    cleanup();
  });

  it('group.isMaximized()=false → indicator not rendered', () => {
    const env = buildEnv(false);
    renderTab(env);
    expect(screen.queryByTestId('tab-maximize-indicator')).toBeNull();
  });

  it('group.isMaximized()=true initial → indicator rendered with aria-label (i18n)', async () => {
    const env = buildEnv(true);
    renderTab(env);
    const btn = screen.getByTestId('tab-maximize-indicator');
    expect(btn).toBeTruthy();
    // aria-label 应非空,且匹配 en/zh/ko 三套之一 (运行时 locale 决定)
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    const label = btn.getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect([en['shell.tab.exit_zoom'], zh['shell.tab.exit_zoom'], ko['shell.tab.exit_zoom']]).toContain(label);
  });

  it('onDidMaximizedGroupChange same group isMaximized=true → indicator appears', () => {
    const env = buildEnv(false);
    renderTab(env);
    expect(screen.queryByTestId('tab-maximize-indicator')).toBeNull();
    act(() => {
      env.maxChangeEmitter.fire({ group: env.panelApi.group, isMaximized: true });
    });
    expect(screen.getByTestId('tab-maximize-indicator')).toBeTruthy();
  });

  it('onDidMaximizedGroupChange OTHER group → 本 tab indicator 不出现', () => {
    const env = buildEnv(false);
    renderTab(env);
    act(() => {
      env.maxChangeEmitter.fire({
        group: { id: 'other-group' },
        isMaximized: true,
      });
    });
    expect(screen.queryByTestId('tab-maximize-indicator')).toBeNull();
  });

  it('点击 indicator → containerApi.exitMaximizedGroup() 被调', () => {
    const env = buildEnv(true);
    renderTab(env);
    const btn = screen.getByTestId('tab-maximize-indicator');
    fireEvent.click(btn);
    expect(env.exitMaxSpy).toHaveBeenCalledTimes(1);
  });

  it('i18n catalog en/zh/ko 三套 shell.tab.exit_zoom 都有非空值', async () => {
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    expect(en['shell.tab.exit_zoom']).toBe('Exit zoom');
    expect(zh['shell.tab.exit_zoom']).toBe('退出缩放');
    expect(ko['shell.tab.exit_zoom']).toBe('확대 종료');
  });
});
