// @vitest-environment jsdom
// BDD:Markdown Edit 模式的斜杠菜单在窄窗口(如 640 宽)里不越出窗口右边被裁。
// Crepe 7.23 的斜杠菜单(@milkdown/plugin-slash)只挂 flip + offset,没有 shift;本项目经
// featureConfigs[BlockEdit].slashMenu.middleware 追加一个「水平夹回视口」中间件,并在 CSS 给菜单 / 工具条 /
// 链接气泡 max-width: calc(100vw - 16px) 兜底(工具条与链接气泡走 plugin-tooltip,已自带 shift)。
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import {
  clampFloatingToViewport,
  FLOATING_VIEWPORT_PADDING,
} from '../../panels/Editor/milkdown-floating-clamp';

const harness = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {
    CodeMirror: 'CodeMirror',
    ListItem: 'ListItem',
    LinkTooltip: 'LinkTooltip',
    Cursor: 'Cursor',
    ImageBlock: 'ImageBlock',
    BlockEdit: 'BlockEdit',
    Toolbar: 'Toolbar',
    Placeholder: 'Placeholder',
    Table: 'Table',
    Latex: 'Latex',
  },
  Crepe: vi.fn().mockImplementation((options: unknown) => {
    harness.options.push(options);
    return { setReadonly: vi.fn(), editor: { config: () => {}, use: () => {}, remove: async () => {} }, on: vi.fn(), create: async () => ({}), destroy: async () => {} };
  }),
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

afterEach(() => {
  cleanup();
  harness.options.length = 0;
});

/**
 * floating-ui 中间件入参的最小形状:x 与 rects.* 同在 offsetParent 坐标系;reference 的
 * getBoundingClientRect 是视口坐标(插件传入的虚拟元素 = 光标处 DOMRect)。
 */
function state(opts: { x: number; refX: number; refViewportX: number; width: number }) {
  return {
    x: opts.x,
    y: 40,
    rects: {
      reference: { x: opts.refX, y: 0, width: 1, height: 20 },
      floating: { x: 0, y: 0, width: opts.width, height: 300 },
    },
    elements: {
      reference: { getBoundingClientRect: () => ({ x: opts.refViewportX, left: opts.refViewportX }) },
      floating: {},
    },
  };
}

describe('斜杠菜单夹回视口', () => {
  const innerWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });
  const setViewport = (w: number) =>
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });

  it('放得下 → x 不变', () => {
    setViewport(1280);
    const mw = clampFloatingToViewport();
    // 光标视口 x=300,offsetParent 坐标 x=100(offsetParent 在视口 200 处);菜单 400 宽
    expect(mw.fn(state({ x: 100, refX: 100, refViewportX: 300, width: 400 }) as never)).toEqual({ x: 100 });
  });

  it('右侧越界 → 左移到距视口右边 padding 处', () => {
    setViewport(640);
    const mw = clampFloatingToViewport();
    // 菜单视口左 = 420,宽 400 → 右边 820 > 640-8;应左移 820-632 = 188
    const r = mw.fn(state({ x: 100, refX: 100, refViewportX: 420, width: 400 }) as never);
    expect(r).toEqual({ x: 100 - (420 + 400 - (640 - FLOATING_VIEWPORT_PADDING)) });
  });

  // 编辑器弹出到 popout 子窗:菜单挂在子窗文档里,应按子窗视口(而非主窗)夹回。
  it('浮层在 popout 子窗文档里 → 按该文档视口宽度夹回', () => {
    setViewport(1280);
    const childView = { innerWidth: 640 };
    const mw = clampFloatingToViewport();
    const st = state({ x: 100, refX: 100, refViewportX: 420, width: 400 });
    const r = mw.fn({ ...st, elements: { ...st.elements, floating: { ownerDocument: { defaultView: childView } } } } as never);
    expect(r).toEqual({ x: 100 - (420 + 400 - (640 - FLOATING_VIEWPORT_PADDING)) });
  });

  it('菜单比视口还宽 → 贴左边 padding,不越出左边', () => {
    setViewport(300);
    const mw = clampFloatingToViewport();
    const r = mw.fn(state({ x: 50, refX: 50, refViewportX: 250, width: 400 }) as never) as { x: number };
    // 视口左 = 250 + (r.x - 50) 应等于 padding
    expect(250 + (r.x - 50)).toBe(FLOATING_VIEWPORT_PADDING);
  });

  it('MilkdownEditor 把夹回中间件接到 BlockEdit.slashMenu.middleware', async () => {
    render(<MilkdownEditor tabId="/t.md" defaultValue="# T" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const o = harness.options.at(-1) as {
      featureConfigs: Record<string, { slashMenu?: { middleware?: Array<{ name: string }> } }>;
    };
    const names = (o.featureConfigs['BlockEdit']?.slashMenu?.middleware ?? []).map((m) => m.name);
    expect(names).toContain(clampFloatingToViewport().name);
  });
});

describe('浮层 CSS 兜底:宽度不超过视口', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/milkdown-font-override.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  for (const cls of ['milkdown-slash-menu', 'milkdown-toolbar', 'milkdown-link-preview', 'milkdown-link-edit']) {
    it(`.${cls} max-width: calc(100vw - 16px)`, () => {
      const re = new RegExp(`\\.milkdown \\.${cls}[^{]*\\{[^}]*max-width:\\s*calc\\(100vw - 16px\\)`);
      expect(css).toMatch(re);
    });
  }
});
