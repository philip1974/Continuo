// @vitest-environment jsdom
// BDD:拖动 dock tab 到别的组分栏 / 叠放后,被拖的面板获焦(VSCode:拖放编辑器后它成为活动编辑器并获焦,可直接键入)。
// dockview 移动后只激活不移 DOM 焦点:按下 tab 时焦点在 tab 上,tab 随移动被摘下 → 焦点落 body。焦点原在别处
// (如 Explorer)不抢。见同目录 README 第 3 条。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi, type DockviewWillDropEvent } from 'dockview-react';
import { trackDropFocus } from '@/shell/dock/panel-focus';

// jsdom 无 DragEvent / DataTransfer,真实 drop 走不通:拦下 onWillDrop 的订阅,拖放时按 dockview 的次序 ——
// 先派发 onWillDrop、随后在同一次 drop 处理里同步移动面板 —— 手动重放(真机拖放见 e2e editor-group-order.spec.ts)。
let willDrop: ((e: DockviewWillDropEvent) => void) | null = null;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 真实 dockview;每个面板内容里放一个可编辑的 textarea(编辑器 / 终端输入区的替身);tab 根可聚焦(同 SharedTab)。 */
function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: (opts) => {
      const element = document.createElement('div');
      const editable = document.createElement('textarea');
      editable.dataset.panel = opts.id;
      element.appendChild(editable);
      return { element, init: () => {} };
    },
  });
  dock.api.onDidAddPanel((p) => {
    p.view.tab.element.tabIndex = 0;
  });
  Object.defineProperty(dock.api, 'onWillDrop', {
    value: (cb: (e: DockviewWillDropEvent) => void) => {
      willDrop = cb;
      return { dispose: () => (willDrop = null) };
    },
  });
  return dock.api;
}

const editableOf = (id: string) => document.querySelector<HTMLTextAreaElement>(`textarea[data-panel="${id}"]`)!;
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

/** 三组分栏:editor | editor:2 | editor:3,焦点在组 1 的编辑区。 */
function threeColumns(api: DockviewApi) {
  api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor 2', position: { referencePanel: 'editor', direction: 'right' } });
  api.addPanel({ id: 'editor:3', component: 'editor', title: 'Editor 3', position: { referencePanel: 'editor:2', direction: 'right' } });
  api.getPanel('editor')!.api.setActive();
  editableOf('editor').focus();
}

/** 松开拖放:dockview 先派发 onWillDrop,再同步移动面板(并激活)。 */
function drop(api: DockviewApi, id: string, position: 'right' | 'center', targetId: string) {
  willDrop?.({} as DockviewWillDropEvent);
  api.getPanel(id)!.api.moveTo({ group: api.getPanel(targetId)!.group, position });
}

/** 用户按下「编辑器 2」的 tab(dockview 激活它;按下即聚焦 tab,同 Chromium)拖到 target 松开。 */
function dragTab(api: DockviewApi, id: string, position: 'right' | 'center', targetId: string) {
  const panel = api.getPanel(id)!;
  panel.api.setActive();
  panel.view.tab.element.focus();
  drop(api, id, position, targetId);
}

afterEach(() => {
  willDrop = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('拖放 dock tab 后被拖的面板获焦', () => {
  it('拖到另一组右缘(分栏)→ 被拖的面板成为活动面板且其内容获焦', async () => {
    const api = createDock();
    threeColumns(api);
    const tracker = trackDropFocus(api);

    dragTab(api, 'editor:2', 'right', 'editor:3');
    await flushMicrotasks();

    expect(api.activePanel?.id).toBe('editor:2');
    expect(document.activeElement).toBe(editableOf('editor:2'));
    tracker.dispose();
  });

  it('拖进另一组叠放(center)→ 同样获焦', async () => {
    const api = createDock();
    threeColumns(api);
    const tracker = trackDropFocus(api);

    dragTab(api, 'editor:2', 'center', 'editor:3');
    await flushMicrotasks();

    expect(api.getPanel('editor:2')!.group).toBe(api.getPanel('editor:3')!.group);
    expect(api.activePanel?.id).toBe('editor:2');
    expect(document.activeElement).toBe(editableOf('editor:2'));
    tracker.dispose();
  });

  it('焦点没有丢失(如在 Explorer)→ 不抢焦点', async () => {
    const api = createDock();
    threeColumns(api);
    const tracker = trackDropFocus(api);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    outside.focus();
    drop(api, 'editor:2', 'right', 'editor:3');
    await flushMicrotasks();

    expect(document.activeElement).toBe(outside);
    tracker.dispose();
  });

  it('非拖放的程序化移动(如重置布局)不在这里补焦点(由调用方负责)', async () => {
    const api = createDock();
    threeColumns(api);
    const tracker = trackDropFocus(api);
    (document.activeElement as HTMLElement | null)?.blur();

    api.getPanel('editor:2')!.api.moveTo({ group: api.getPanel('editor:3')!.group, position: 'right' });
    await flushMicrotasks();

    expect(document.activeElement).toBe(document.body);
    tracker.dispose();
  });
});
