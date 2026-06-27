import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/stores/editor.store';

const viewA = { id: 'a' };
const viewB = { id: 'b' };

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    mode: 'edit',
    viewRefs: new Map(),
  } as Partial<ReturnType<typeof useEditorStore.getState>>);
});

describe('editor store CodeMirror view refs', () => {
  it('T1 registers a view by tab id', () => {
    useEditorStore.getState().registerView('/work/a.ts', viewA as never);

    expect(useEditorStore.getState().viewRefs.get('/work/a.ts')).toBe(viewA);
  });

  it('registerView 重复登记同一个 view 时不复制 Map 且不通知订阅者', () => {
    const viewRefs = new Map([['/work/a.ts', viewA as never]]);
    useEditorStore.setState({ viewRefs });
    const listener = vi.fn();
    const unsubscribe = useEditorStore.subscribe(listener);

    try {
      useEditorStore.getState().registerView('/work/a.ts', viewA as never);

      expect(useEditorStore.getState().viewRefs).toBe(viewRefs);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('T2 unregisters only when the expected view matches', () => {
    const store = useEditorStore.getState();
    store.registerView('/work/a.ts', viewA as never);
    store.unregisterView('/work/a.ts', viewB as never);
    expect(useEditorStore.getState().viewRefs.get('/work/a.ts')).toBe(viewA);

    useEditorStore.getState().unregisterView('/work/a.ts', viewA as never);
    expect(useEditorStore.getState().viewRefs.has('/work/a.ts')).toBe(false);
  });

  it('T3 waitForViewRef resolves when a view is registered later', async () => {
    const pending = useEditorStore.getState().waitForViewRef('/work/a.ts', 100);

    useEditorStore.getState().registerView('/work/a.ts', viewA as never);

    await expect(pending).resolves.toBe(viewA);
  });

  it('T4 waitForViewRef returns null after timeout', async () => {
    vi.useFakeTimers();
    const pending = useEditorStore.getState().waitForViewRef('/work/a.ts', 100);

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});
