import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coApp } from '../../plugins/co-app';
import type { Disposable } from '../../plugins/types';
import { setDockApi } from '../../shell/dock/dock-api-ref';

interface FakePanel {
  api: { setActive: ReturnType<typeof vi.fn> };
}

interface FakeApi {
  getPanel: ReturnType<typeof vi.fn>;
  addPanel: ReturnType<typeof vi.fn>;
}

function fakeApi(panels: Record<string, FakePanel> = {}): FakeApi {
  return {
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn(),
  };
}

let disposables: Disposable[] = [];

function registerPanel(type: string, title = 'SDK Panel'): void {
  disposables.push(
    coApp.panels.register({
      type,
      title,
      titleKey: `${type}.title`,
      factory: () => null,
    }),
  );
}

beforeEach(() => {
  setDockApi(null);
  disposables = [];
});

afterEach(() => {
  for (const disposable of disposables) disposable.dispose();
  disposables = [];
  setDockApi(null);
});

describe('app.dock.openPanel raw namespace', () => {
  it('T1 focuses an existing open registered panel', () => {
    const setActive = vi.fn();
    const api = fakeApi({
      'sdk-dock-existing': { api: { setActive } },
    });
    registerPanel('sdk-dock-existing', 'Existing');
    setDockApi(api as never);

    coApp.dock.openPanel('sdk-dock-existing');

    expect(api.getPanel).toHaveBeenCalledWith('sdk-dock-existing');
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it('T1.5 opens a registered panel that is not mounted yet', () => {
    const api = fakeApi();
    registerPanel('sdk-dock-unopened', 'Unopened');
    setDockApi(api as never);

    coApp.dock.openPanel('sdk-dock-unopened');

    expect(api.addPanel).toHaveBeenCalledWith({
      id: 'sdk-dock-unopened',
      component: 'sdk-dock-unopened',
      title: 'Unopened',
      params: { titleKey: 'sdk-dock-unopened.title' },
    });
  });

  it('T1.6 silently no-ops when Dockview is not ready', () => {
    registerPanel('sdk-dock-not-ready', 'Not Ready');

    expect(() => coApp.dock.openPanel('sdk-dock-not-ready')).not.toThrow();
  });

  it('T1.7 does not add a duplicate panel when the registered panel is already open', () => {
    const setActive = vi.fn();
    const api = fakeApi({
      'sdk-dock-open-no-dup': { api: { setActive } },
    });
    registerPanel('sdk-dock-open-no-dup', 'No Duplicate');
    setDockApi(api as never);

    coApp.dock.openPanel('sdk-dock-open-no-dup');

    expect(setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it('T2 silently no-ops for an unknown panel id', () => {
    const api = fakeApi();
    setDockApi(api as never);

    expect(() => coApp.dock.openPanel('sdk-dock-unknown')).not.toThrow();
    expect(api.getPanel).not.toHaveBeenCalled();
    expect(api.addPanel).not.toHaveBeenCalled();
  });
});
