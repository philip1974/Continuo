// 47 · dockview StrictMode idempotent applyDefaultLayout
// 防回归: React 18 StrictMode 双 mount + DockShell restore callback 双调用
// 都不应 throw "panel with id editor already exists"。

import { describe, it, expect, vi } from 'vitest';
import { applyDefaultLayout } from '@/shell/dock/layout.default';

// Mock i18n translate to avoid initialization in test
vi.mock('@/i18n/translate', () => ({
  tWithFallback: (_key: string, fallback: string) => fallback,
}));

// Minimal DockviewApi mock: track addPanel calls + getPanel state
function makeMockApi() {
  const panels = new Map<string, { id: string; api: { setActive: () => void } }>();
  const setActiveCalls: string[] = [];
  return {
    panels,
    setActiveCalls,
    getPanel(id: string) {
      return panels.get(id) ?? null;
    },
    addPanel(spec: { id: string }) {
      if (panels.has(spec.id)) {
        // Mimic real dockview behavior: throw on duplicate id
        throw new Error(`dockview: panel with id ${spec.id} already exists`);
      }
      const panel = {
        id: spec.id,
        api: {
          setActive: () => {
            setActiveCalls.push(spec.id);
          },
        },
      };
      panels.set(spec.id, panel);
      return panel;
    },
  };
}

describe('applyDefaultLayout idempotent (topic 47)', () => {
  it('first call adds editor panel + setActive', () => {
    const mock = makeMockApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyDefaultLayout(mock as any);
    expect(mock.panels.size).toBe(1);
    expect(mock.panels.has('editor')).toBe(true);
    expect(mock.setActiveCalls).toEqual(['editor']);
  });

  it('second call is no-op on addPanel + setActive existing editor (StrictMode 双 mount 场景)', () => {
    const mock = makeMockApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyDefaultLayout(mock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => applyDefaultLayout(mock as any)).not.toThrow();
    expect(mock.panels.size).toBe(1); // still single editor
    expect(mock.setActiveCalls).toEqual(['editor', 'editor']); // active 复活 each call
  });

  it('triple call (StrictMode + restore from EmptyState) 仍 no-op', () => {
    const mock = makeMockApi();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyDefaultLayout(mock as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyDefaultLayout(mock as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyDefaultLayout(mock as any);
    }).not.toThrow();
    expect(mock.panels.size).toBe(1);
    expect(mock.setActiveCalls.length).toBe(3);
  });

  it('same panel ref returned on subsequent calls (idempotent contract)', () => {
    const mock = makeMockApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyDefaultLayout(mock as any);
    const firstPanel = mock.panels.get('editor');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyDefaultLayout(mock as any);
    const secondPanel = mock.panels.get('editor');
    expect(firstPanel).toBe(secondPanel); // 同 ref
  });
});
