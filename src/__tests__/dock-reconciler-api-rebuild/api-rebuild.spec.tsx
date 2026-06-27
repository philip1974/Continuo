// @vitest-environment jsdom
// race(R26):useDockReconciler 的 [api] effect 在 api 变更(dockview 重建 / onReady 重入 /
// HMR / StrictMode)时,必须把新 api 当作全新空 dock 重建现有 terminal session。
// 否则用上个 api 的旧 previousSessionsRef 做 diff → 现有 session 被判「非新增」→ 不补建 →
// 终端从新 dock 消失,直到 sessions 再变化才恢复。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import {
  useDockReconciler,
  __resetReconcilerForTest,
} from '@/shell/dock/DockReconciler';
import { useTerminalStore } from '@/stores/terminal.store';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';

function makeApi() {
  const panels: Record<string, { id: string; api: { id: string; setActive: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> } }> = {};
  const api = {
    activePanel: undefined as unknown,
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn((opts: { id: string }) => {
      const p = {
        id: opts.id,
        api: { id: opts.id, setActive: vi.fn(), close: vi.fn(), setTitle: vi.fn() },
      };
      panels[opts.id] = p;
      api.activePanel = p;
      return p;
    }),
    panels,
  };
  return api;
}

beforeEach(() => {
  __resetReconcilerForTest();
  useTerminalStore.setState({ sessions: [], customTitles: new Map() });
});

describe('race(R26) — dock api 重建后终端须全量重建', () => {
  it('api 变更(新空 dock)+ store sessions 不变 → 现有 session 在新 api 重建', () => {
    const s = makeSession('user-1', { originHint: 'user', createdAt: 1 });
    useTerminalStore.setState({ sessions: [s], customTitles: new Map() });

    const api1 = makeApi();
    const { rerender } = renderHook(
      ({ api }: { api: DockviewApi }) => useDockReconciler(api),
      { initialProps: { api: api1 as unknown as DockviewApi } },
    );
    // 首次挂载:api1 建出 terminal-user-1。
    expect(api1.getPanel('terminal-user-1')).toBeTruthy();

    // api 重建为全新空 dock(dockview rebuild),store sessions 未变。
    const api2 = makeApi();
    rerender({ api: api2 as unknown as DockviewApi });

    // 修复前:previousSessionsRef 仍含 s → diff 判非新增 → api2 不补建(终端消失)。
    // 修复后:新 api 视作空 → previousSessions=[] → 现有 session 在 api2 重建。
    expect(api2.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-user-1' }),
    );
    expect(api2.getPanel('terminal-user-1')).toBeTruthy();
  });

  it('多个现有 session 全部在新 api 重建', () => {
    useTerminalStore.setState({
      sessions: [
        makeSession('a', { createdAt: 1 }),
        makeSession('b', { createdAt: 2 }),
      ],
      customTitles: new Map(),
    });
    const api1 = makeApi();
    const { rerender } = renderHook(
      ({ api }: { api: DockviewApi }) => useDockReconciler(api),
      { initialProps: { api: api1 as unknown as DockviewApi } },
    );
    const api2 = makeApi();
    rerender({ api: api2 as unknown as DockviewApi });
    expect(api2.getPanel('terminal-a')).toBeTruthy();
    expect(api2.getPanel('terminal-b')).toBeTruthy();
  });

  it('首次挂载行为不变:空 store → 不建 panel', () => {
    const api1 = makeApi();
    renderHook(() => useDockReconciler(api1 as unknown as DockviewApi));
    expect(api1.addPanel).not.toHaveBeenCalled();
  });
});
